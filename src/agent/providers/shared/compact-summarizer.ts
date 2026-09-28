/**
 * Cross-provider compact summarizer resolver.
 *
 * When `AFK_COMPACT_MODEL` names a model on the SAME provider family as the
 * current session, the session's own summarize closure is returned unchanged —
 * it already carries the right credentials, endpoint, and wire (responses vs.
 * chat-completions). When the model is on a DIFFERENT provider, this module
 * builds a foreign one-shot call and wraps it as a summarize closure.
 *
 * Supported foreign paths:
 *   - anthropic → the Anthropic one-shot helper (oneShotCompletion).
 *   - openai (api-key mode) → Chat Completions via oneShotChatCompletion.
 *   - openai (chatgpt-oauth mode) → Responses wire via a purpose-built client
 *     constructed from the ChatGPT backend URL + auth headers, then oneShotResponses.
 *   - xai (api-key) → Chat Completions via oneShotChatCompletion + xAI endpoint.
 *   - xai (oauth) → Chat Completions via oneShotChatCompletion + xAI OAuth endpoint.
 *
 * Failure semantics (required by spec):
 *   - No silent fallback to the session model — on a non-abort cross-provider
 *     error the exception propagates and runCompactionCore records
 *     `summarization-failed: …`, leaving history untouched.
 *   - A one-time-per-process warning is emitted when a foreign summarize first
 *     succeeds (privacy: the transcript is sent to a second vendor) and when the
 *     first cross-provider failure occurs.
 *   - Aborts propagate as AbortErrors and are never swallowed.
 *
 * @module agent/providers/shared/compact-summarizer
 */

import OpenAI from 'openai';
import { oneShotCompletion } from '../anthropic-direct/oneshot.js';
import {
  oneShotChatCompletion,
  oneShotResponses,
} from '../openai-compatible/oneshot.js';
import { resolveOpenAIAuth } from '../openai-compatible/auth.js';
import {
  buildChatGptOAuthHeaders,
  CHATGPT_BACKEND_BASE_URL,
} from '../openai-compatible/responses-config.js';
import { resolveXaiAuth } from '../xai/auth.js';
import { resolveXaiEndpoint } from '../xai/endpoints.js';
import { loadAnthropicCredential } from '../../auth/credential-resolver.js';
import { providerForModel } from '../index.js';
import { resolveBinding } from '../../session/model-slots.js';
import { COMPACT_SYSTEM_PROMPT, wrapTranscriptForSummary } from './compaction.js';
import type { BundledProviderName } from '../index.js';

// Contract: maxTokens for the summarize call. Matches the default in
// anthropic-direct/query/compact-handler.ts and openai-compatible/query.ts.
const COMPACT_MAX_TOKENS = 1024;

// Invariant: one-time-per-process warnings — never more than once per target
// even if the session compacts repeatedly. Two distinct sets: the privacy
// notice (first use) and the failure notice (first failure per target id).
const warnedPrivacyFor = new Set<string>();
const warnedFailureFor = new Set<string>();

/** Summarize closure shape used by both compact-handler and openai-compatible query. */
export type SummarizeFn = (transcript: string, signal?: AbortSignal) => Promise<string>;

/**
 * Resolve the summarize function for a compaction pass.
 *
 * Contract:
 *   - When AFK_COMPACT_MODEL is unset, empty, or resolves to the same provider
 *     family as `sessionFamily`, returns `sessionSummarize` unchanged.
 *   - When the resolved model is on a foreign family, returns a wrapper that:
 *       1. Emits a one-time privacy warning (transcript crosses providers).
 *       2. Calls the appropriate one-shot helper.
 *       3. On a non-abort failure, emits a one-time failure warning and re-throws.
 *       4. On abort, re-throws unchanged.
 *
 * @param sessionFamily - The bundled provider name for the current session
 *   (e.g. `'anthropic-direct'`, `'openai-compatible'`, `'xai'`).
 * @param sessionSummarize - The session's own summarize closure (used for
 *   same-provider compaction and returned unchanged on no foreign target).
 * @param compactModelRaw - The raw AFK_COMPACT_MODEL value (may be a slot alias).
 *   Pass `undefined` to disable cross-provider logic (returns sessionSummarize).
 */
export function resolveCrossProviderSummarize(
  sessionFamily: BundledProviderName,
  sessionSummarize: SummarizeFn,
  compactModelRaw: string | undefined,
): SummarizeFn {
  if (!compactModelRaw || compactModelRaw.trim().length === 0) {
    return sessionSummarize;
  }

  // Resolve slot aliases / custom names to the concrete binding so we can
  // inspect the provider family without instantiating a full AgentSession.
  const binding = resolveBinding(compactModelRaw.trim());
  const targetModel = binding.id || compactModelRaw.trim();
  const targetProvider = providerForModel(targetModel, {
    ...(binding.provider ? { explicit: binding.provider } : {}),
    ...(binding.baseUrl ? { openaiBaseUrl: binding.baseUrl } : {}),
  });

  // Normalize the session family so both `anthropic` and `anthropic-direct`
  // compare equal (providerForModel returns `'anthropic-direct'` but callers
  // may pass `'anthropic'`).
  const normalizedSession =
    sessionFamily === 'anthropic' ? 'anthropic-direct' :
    sessionFamily === 'openai-codex' ? 'openai-compatible' :
    sessionFamily;
  const normalizedTarget =
    targetProvider === 'anthropic' ? 'anthropic-direct' :
    targetProvider === 'openai-codex' ? 'openai-compatible' :
    targetProvider;

  if (normalizedTarget === normalizedSession) {
    // Same family — let the session summarize (it has the right client, wire,
    // credentials). Do not rebuild auth or construct a foreign client.
    return sessionSummarize;
  }

  // Foreign family — build a cross-provider summarize closure.
  return buildForeignSummarize(targetModel, targetProvider, binding);
}

/** Inputs captured from the resolved binding for one foreign summarize closure. */
interface ForeignBinding {
  apiKey?: string;
  baseUrl?: string;
  provider?: string;
}

/**
 * Build a cross-provider summarize closure for `targetModel` on `targetProvider`.
 * The returned function emits privacy/failure warnings exactly once per model id.
 */
function buildForeignSummarize(
  targetModel: string,
  targetProvider: BundledProviderName,
  binding: ForeignBinding,
): SummarizeFn {
  return async (transcript: string, signal?: AbortSignal): Promise<string> => {
    // Privacy notice: one-time-per-target, before the request fires.
    if (!warnedPrivacyFor.has(targetModel)) {
      warnedPrivacyFor.add(targetModel);
      // eslint-disable-next-line no-console
      console.warn(
        `[afk/compact] Cross-provider compaction: transcript will be sent to ` +
        `${targetProvider} (model: ${targetModel}). ` +
        `Ensure you consent to sharing conversation history with this provider.`,
      );
    }

    try {
      const system = COMPACT_SYSTEM_PROMPT;
      const user = wrapTranscriptForSummary(transcript);

      if (targetProvider === 'anthropic-direct' || targetProvider === 'anthropic') {
        return await summarizeViaAnthropic(targetModel, binding, system, user, signal);
      }
      if (targetProvider === 'openai-compatible' || targetProvider === 'openai-codex') {
        return await summarizeViaOpenAI(targetModel, binding, system, user, signal);
      }
      if (targetProvider === 'xai' || targetProvider === 'xai-oauth') {
        return await summarizeViaXai(targetModel, targetProvider, binding, system, user, signal);
      }
      // Unknown provider family: let it fall through as an error rather than
      // silently billing the session model.
      throw new Error(
        `[afk/compact] Unsupported cross-provider target: ${targetProvider}. ` +
        `Set AFK_COMPACT_MODEL to a model on anthropic, openai, or xai.`,
      );
    } catch (err) {
      // Aborts must propagate as-is so the compaction core records 'aborted'.
      const isAbort =
        (err instanceof Error && err.name === 'AbortError') ||
        (signal !== undefined && signal.aborted);
      if (isAbort) throw err;

      // One-time failure warning per target model id.
      if (!warnedFailureFor.has(targetModel)) {
        warnedFailureFor.add(targetModel);
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `[afk/compact] Cross-provider summarization failed for ${targetProvider}/${targetModel}: ` +
          `${msg}. History unchanged. Check credentials for this provider.`,
        );
      }
      throw err;
    }
  };
}

/** Reset one-time warning state — used by tests only (vitest imports via __test-utils__). */
export function __resetCrossProviderWarnState(): void {
  warnedPrivacyFor.clear();
  warnedFailureFor.clear();
}

// ---------------------------------------------------------------------------
// Per-provider one-shot helpers
// ---------------------------------------------------------------------------

async function summarizeViaAnthropic(
  model: string,
  binding: ForeignBinding,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const token = binding.apiKey ?? loadAnthropicCredential();
  if (!token) {
    throw new Error(
      `[afk/compact] No Anthropic credential for cross-provider compaction. ` +
      `Set ANTHROPIC_API_KEY or authenticate via Claude Code.`,
    );
  }
  return oneShotCompletion({
    token,
    model,
    system,
    user,
    maxTokens: COMPACT_MAX_TOKENS,
    signal,
  });
}

async function summarizeViaOpenAI(
  model: string,
  binding: ForeignBinding,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  // Resolve OpenAI auth from the binding's explicit key, or via the standard
  // chain (OPENAI_API_KEY → CODEX_API_KEY → ~/.codex/auth.json including
  // ChatGPT-subscription OAuth when AFK_OPENAI_CHATGPT_OAUTH is set).
  const auth = resolveOpenAIAuth(
    binding.apiKey,
    {},
    binding.provider === 'chatgpt-oauth',
  );

  if (auth.apiKey === null) {
    throw new Error(
      `[afk/compact] No OpenAI credential for cross-provider compaction (source: ${auth.source}). ` +
      `Set OPENAI_API_KEY or authenticate via ChatGPT OAuth.`,
    );
  }

  // ChatGPT-subscription OAuth requires the Responses wire (the private
  // ChatGPT backend rejects Chat Completions requests). Build the client the
  // same way the session does — same base URL and account-id header — and
  // delegate to oneShotResponses with isChatGptBackend: true.
  if (auth.source === 'chatgpt-oauth') {
    return summarizeViaChatGptOAuth(model, auth.apiKey, auth.accountId, system, user, signal);
  }

  // Standard API-key path: Chat Completions.
  return oneShotChatCompletion({
    apiKey: auth.apiKey,
    baseURL: binding.baseUrl,
    model,
    system,
    user,
    maxTokens: COMPACT_MAX_TOKENS,
    signal,
  });
}

/**
 * Summarize via the ChatGPT-subscription Responses wire.
 *
 * Contract: constructs the OpenAI client exactly as the session does
 * (CHATGPT_BACKEND_BASE_URL + buildChatGptOAuthHeaders) and delegates to
 * oneShotResponses with isChatGptBackend:true. This mirrors
 * OpenAICompatibleQuery.summarizeViaResponses without requiring a live session.
 */
async function summarizeViaChatGptOAuth(
  model: string,
  apiKey: string,
  accountId: string | undefined,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const headers = buildChatGptOAuthHeaders(accountId);
  const client = new OpenAI({
    apiKey,
    baseURL: CHATGPT_BACKEND_BASE_URL,
    defaultHeaders: headers,
  });
  return oneShotResponses({
    client,
    model,
    system,
    user,
    isChatGptBackend: true,
    maxTokens: COMPACT_MAX_TOKENS,
    signal,
  });
}

async function summarizeViaXai(
  model: string,
  targetProvider: BundledProviderName,
  binding: ForeignBinding,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  // Resolve xAI auth: forced to 'oauth' when the slot or provider name says so,
  // 'apikey' otherwise (matches xai/index.ts complete() behaviour).
  const forceMode = targetProvider === 'xai-oauth' ? 'oauth' : 'apikey';
  const resolution = resolveXaiAuth(binding.apiKey, forceMode);
  if (!resolution.apiKey || !resolution.mode) {
    throw new Error(
      `[afk/compact] No xAI credential for cross-provider compaction. ` +
      `Set XAI_API_KEY or authenticate via SuperGrok OAuth.`,
    );
  }

  const endpoint = resolveXaiEndpoint(resolution.mode, {
    ...(binding.baseUrl ? { baseUrlOverride: binding.baseUrl } : {}),
  });

  return oneShotChatCompletion({
    apiKey: resolution.apiKey,
    baseURL: endpoint.baseURL,
    defaultHeaders: endpoint.defaultHeaders,
    model,
    system,
    user,
    maxTokens: COMPACT_MAX_TOKENS,
    signal,
  });
}
