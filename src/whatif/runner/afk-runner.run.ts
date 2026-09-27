/**
 * Episode child-process execution for the AFK runner.
 *
 * Extracted from `afk-runner.ts` to keep that file within the 350-line
 * ceiling. Owns spawn, stdout capture, NDJSON parsing, timeout/signal
 * enforcement, and stderr tail collection.
 *
 * Output format: `afk chat --format stream-json` (NDJSON, one OutputEvent per
 * line). This gives the judge ALL assistant text — including narration written
 * between tool calls — not just the final message. Text segments are joined
 * with lightweight `[tool: <name>]` markers where tool calls occurred so the
 * judge can see the full reasoning flow in order.
 *
 * The `done` event carries cumulative cost/token metadata across all turns.
 *
 * @module whatif/runner/afk-runner.run
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import type { EpisodeTrace } from '../types.js';

export type SpawnFn = typeof nodeSpawn;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max stderr bytes kept for error messages (redacted). */
const STDERR_TAIL_BYTES = 500;

/** Delay between SIGTERM and SIGKILL on timeout. */
const SIGKILL_DELAY_MS = 5_000;

/** Regex that matches Anthropic API key patterns for redaction. */
const SK_ANT_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Redact Anthropic credentials from error strings. */
function redactSecrets(text: string): string {
  return text.replace(SK_ANT_PATTERN, '[REDACTED]');
}

// ---------------------------------------------------------------------------
// NDJSON stream accumulator
// ---------------------------------------------------------------------------

/**
 * Parsed metadata from the stream-json `done` event.
 */
interface StreamDoneMeta {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number;
}

/**
 * Parse the NDJSON stdout of `afk chat --format stream-json` into:
 *   - `text`: all assistant text segments joined, with `[tool: <name>]`
 *     markers inserted where tool calls occurred (in document order).
 *   - `meta`: cost and token counts from the terminal `done` event.
 *
 * Design: track whether a tool-use detail chunk was seen since the last
 * text segment so we only emit one marker per tool boundary, not one per
 * chunk. Text segments AFTER a tool boundary are appended after the marker.
 *
 * Robustness: malformed lines are skipped; missing `done` → zero meta.
 *
 * Exported for unit testing.
 */
export function accumulateStreamJson(stdout: string): { text: string; meta: StreamDoneMeta } {
  const lines = stdout.split('\n');
  const textParts: string[] = [];
  let pendingToolMarker: string | null = null;
  let meta: StreamDoneMeta = { costUsd: 0, inputTokens: 0, outputTokens: 0 };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== 'object') continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = event['type'];

    if (type === 'chunk') {
      const chunk = event['chunk'];
      if (chunk === null || typeof chunk !== 'object') continue;
      const c = chunk as Record<string, unknown>;
      const chunkType = c['type'];

      if (chunkType === 'content' && typeof c['content'] === 'string') {
        // Flush any pending tool marker before the next text segment.
        if (pendingToolMarker !== null) {
          textParts.push(pendingToolMarker);
          pendingToolMarker = null;
        }
        textParts.push(c['content'] as string);
      } else if (chunkType === 'tool_use_detail' && typeof c['toolName'] === 'string') {
        // One marker per tool call — overwrite so only the last pending name
        // shows if somehow two arrive without intervening text.
        pendingToolMarker = `[tool: ${c['toolName'] as string}]`;
      } else if (chunkType === 'tool_use' && typeof c['content'] === 'string') {
        // Fallback: tool_use summary chunk (no toolName field).
        if (pendingToolMarker === null) {
          pendingToolMarker = `[tool: ${c['content'] as string}]`;
        }
      }
    } else if (type === 'done') {
      const rawMeta = event['metadata'];
      if (rawMeta !== null && typeof rawMeta === 'object') {
        const m = rawMeta as Record<string, unknown>;
        const usage = m['usage'];
        let inputTokens = 0;
        let outputTokens = 0;
        if (usage !== null && typeof usage === 'object') {
          const u = usage as Record<string, unknown>;
          inputTokens = typeof u['input_tokens'] === 'number' ? u['input_tokens'] : 0;
          outputTokens = typeof u['output_tokens'] === 'number' ? u['output_tokens'] : 0;
        }
        meta = {
          costUsd: typeof m['totalCostUsd'] === 'number' ? m['totalCostUsd'] : 0,
          inputTokens,
          outputTokens,
          durationMs: typeof m['durationMs'] === 'number' ? m['durationMs'] : undefined,
        };
      }
    }
  }

  // Any trailing tool marker with no follow-on text is still appended.
  if (pendingToolMarker !== null) {
    textParts.push(pendingToolMarker);
  }

  return { text: textParts.join(''), meta };
}

// ---------------------------------------------------------------------------
// Spawn and wait
// ---------------------------------------------------------------------------

export interface RunEpisodeChildArgs {
  command: string;
  spawnArgs: string[];
  spawnOptions: SpawnOptions;
  spawnImpl: SpawnFn;
  episodeId: string;
  envLabel: 'baseline' | 'candidate';
  sample: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface ChildResult {
  stdout: string;
  stderrTail: string;
  exitCode: number;
  timedOut: boolean;
}

/** Spawn the child and wait for it to exit, enforcing timeout and signal. */
async function waitForChild(
  child: ChildProcess,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    // killTimer tracks whichever timer is currently live: initially the SIGTERM
    // deadline; reassigned to the SIGKILL follow-up once SIGTERM fires so that
    // settle() always clears the right timer regardless of when the child exits.
    let killTimer: ReturnType<typeof setTimeout>;

    const settle = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderrRaw = Buffer.concat(stderrChunks).toString('utf-8');
      const tail = stderrRaw.slice(-STDERR_TAIL_BYTES);
      resolve({ stdout, stderrTail: tail, exitCode, timedOut });
    };

    const sendSigterm = (): void => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
    };
    const sendSigkill = (): void => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    };

    killTimer = setTimeout(() => {
      sendSigterm();
      // Track the SIGKILL follow-up so settle() can clear it if the child
      // exits after SIGTERM but before SIGKILL_DELAY_MS elapses.
      clearTimeout(killTimer);
      killTimer = setTimeout(sendSigkill, SIGKILL_DELAY_MS);
    }, timeoutMs);

    // AbortSignal support.
    const onAbort = (): void => {
      // Cancel the SIGTERM deadline timer (or the SIGKILL follow-up, if the
      // timeout path already fired) so only one SIGKILL timer is ever live.
      clearTimeout(killTimer);
      sendSigterm();
      killTimer = setTimeout(sendSigkill, SIGKILL_DELAY_MS);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < STDERR_TAIL_BYTES * 4) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      settle(code ?? 1);
    });
    child.on('error', () => {
      signal?.removeEventListener('abort', onAbort);
      settle(1);
    });
  });
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Spawn the chat child (using `--format stream-json`), wait for it to finish,
 * and parse the NDJSON output into an {@link EpisodeTrace}.
 *
 * `EpisodeTrace.text` contains ALL assistant text in document order, with
 * lightweight `[tool: <name>]` markers inserted where tool calls occurred.
 * This gives the judge full narration, not just the final assistant message.
 *
 * On timeout, nonzero exit, or completely unparsable output the returned
 * trace has `error` set instead of throwing.
 */
export async function runEpisodeChild(args: RunEpisodeChildArgs): Promise<EpisodeTrace> {
  const { command, spawnArgs, spawnOptions, spawnImpl, episodeId, envLabel, sample, timeoutMs, signal } = args;

  const startMs = Date.now();
  const child = spawnImpl(command, spawnArgs, spawnOptions);
  const { stdout, stderrTail, exitCode, timedOut } = await waitForChild(child, timeoutMs, signal);
  const durationMs = Date.now() - startMs;

  if (timedOut) {
    return {
      episodeId,
      env: envLabel,
      sample,
      text: '',
      tools: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs,
      error: `Episode timed out after ${timeoutMs}ms. stderr: ${redactSecrets(stderrTail)}`,
    };
  }

  if (exitCode !== 0) {
    return {
      episodeId,
      env: envLabel,
      sample,
      text: '',
      tools: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs,
      error: `afk chat exited ${exitCode}. stderr: ${redactSecrets(stderrTail)}`,
    };
  }

  const { text, meta } = accumulateStreamJson(stdout);

  return {
    episodeId,
    env: envLabel,
    sample,
    text,
    tools: [],
    costUsd: meta.costUsd,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    durationMs: meta.durationMs ?? durationMs,
  };
}
