/**
 * journal-adapter.ts — convert raw journal records into the ToolEventInput[]
 * shape that derive.ts already knows how to aggregate.
 *
 * Design:
 *   - Scans ALL `append` records (so compacted-away calls still count).
 *   - Pairs tool_use blocks with their tool_result blocks by id, first-seen
 *     order of the tool_use (preserves call order even after compaction).
 *   - Result text = concatenated text/text_ref preview parts, capped at
 *     `resultTextCap` characters total (default 2000) to bound memory.
 *   - Unpaired tool_use blocks (result not yet written, or pruned) are
 *     included with no result / isError.
 *   - Deduplicated by toolUseId using last-write-wins (same invariant as
 *     derive.ts's `dedupeToolEvents`).
 *   - `extractRawToolInput` projects the tool_use input down to the
 *     whitelisted non-sensitive scalar fields (file_path, name, id_prefix) —
 *     same contract as the sidecar writer; full input is NOT persisted.
 *
 * Security: this module is pure + in-memory; nothing is written to disk.
 * Full tool inputs are never passed through; only the RAW_INPUT_FIELDS
 * whitelist is extracted (via extractRawToolInput).
 */

import { extractRawToolInput } from './raw-input.js';
import type { ToolEventInput } from './schema.js';
import type { JournalBlock, JournalRecord, JournalResultPart } from '../journal/types.js';

export interface JournalAdapterOptions {
  /**
   * Maximum characters of concatenated result text to include per event.
   * Caps memory and error-classification text scanning.
   * @default 2000
   */
  resultTextCap?: number;
}

/** Subagent-level tool call totals for the optional breakdown field. */
export interface SubagentToolSummary {
  subagent_id: string;
  tool_calls: number;
  tool_errors: number;
  tool_counts: Record<string, number>;
}

/** Full output of the journal adapter. */
export interface JournalAdapterResult {
  /** Parent-session tool events only (subagent calls excluded). */
  toolEvents: ToolEventInput[];
  /** Per-subagent breakdown, populated when subagent journals were supplied. */
  subagentBreakdown: SubagentToolSummary[];
}

/** Concatenate text parts of a tool_result content array, capped at `cap` chars. */
function extractResultText(parts: readonly JournalResultPart[], cap: number): string {
  let out = '';
  for (const part of parts) {
    if (out.length >= cap) break;
    const remaining = cap - out.length;
    if (part.type === 'text') {
      out += part.text.length > remaining ? part.text.slice(0, remaining) : part.text;
    } else if (part.type === 'text_ref') {
      // preview is a head of the spilled text (already capped by the writer)
      out += part.preview.length > remaining ? part.preview.slice(0, remaining) : part.preview;
    }
    // image / document parts produce no text contribution
  }
  return out;
}

/**
 * Scan a flat list of JournalBlocks for all tool_use / tool_result blocks,
 * returning them in encounter order.
 */
function extractToolBlocks(blocks: readonly JournalBlock[]): Array<Extract<JournalBlock, { type: 'tool_use' | 'tool_result' }>> {
  const out: Array<Extract<JournalBlock, { type: 'tool_use' | 'tool_result' }>> = [];
  for (const b of blocks) {
    if (b.type === 'tool_use' || b.type === 'tool_result') {
      out.push(b as Extract<JournalBlock, { type: 'tool_use' | 'tool_result' }>);
    }
  }
  return out;
}

/**
 * Convert a list of raw journal records (from one journal file) into a
 * ToolEventInput array suitable for derive.ts.
 *
 * @param records   All records from `readJournalRecords(sessionId)`.
 * @param options   See JournalAdapterOptions.
 */
export function journalRecordsToToolEvents(
  records: readonly JournalRecord[],
  options: JournalAdapterOptions = {},
): ToolEventInput[] {
  const cap = options.resultTextCap ?? 2000;

  // Pass 1: collect tool_use order + tool_result for every id seen.
  // We scan ALL append records (including ones later truncated/compacted).
  const toolUseOrder: string[] = []; // first-seen order
  const toolUseNames = new Map<string, string>(); // id → name
  const toolUseInputRaw = new Map<string, string | undefined>(); // id → extracted inputRaw
  const toolResultText = new Map<string, string>(); // id → result text
  const toolResultError = new Map<string, boolean>(); // id → isError

  for (const rec of records) {
    if (rec.kind !== 'append') continue;
    for (const block of extractToolBlocks(rec.message.content)) {
      if (block.type === 'tool_use') {
        if (!toolUseNames.has(block.id)) {
          // First time we see this tool_use id — record its position.
          toolUseOrder.push(block.id);
          toolUseNames.set(block.id, block.name);
          toolUseInputRaw.set(block.id, extractRawToolInput(block.input));
        } else {
          // Re-append after compaction: update name + input, keep position.
          toolUseNames.set(block.id, block.name);
          toolUseInputRaw.set(block.id, extractRawToolInput(block.input));
        }
      } else {
        // tool_result: last-write-wins (latest append after compaction is canonical)
        const text = extractResultText(block.content, cap);
        toolResultText.set(block.toolUseId, text);
        if (block.isError !== undefined) {
          toolResultError.set(block.toolUseId, block.isError);
        }
      }
    }
  }

  // Pass 2: build ToolEventInput[] in first-seen call order, deduped by id.
  const events: ToolEventInput[] = [];
  for (const id of toolUseOrder) {
    const toolName = toolUseNames.get(id);
    if (!toolName) continue; // should never happen
    const inputRaw = toolUseInputRaw.get(id);
    const result = toolResultText.get(id);
    const isError = toolResultError.get(id);
    const ev: ToolEventInput = {
      toolName,
      toolUseId: id,
      ...(inputRaw !== undefined ? { inputRaw } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(isError !== undefined ? { isError } : {}),
    };
    events.push(ev);
  }

  return events;
}

/**
 * Build a SubagentToolSummary from one subagent's journal records.
 * Only tool_use blocks contribute (not results) — we count calls, not
 * round trips. Uses first-seen dedup by toolUseId (same as parent path).
 */
export function summarizeSubagentJournal(
  subagentId: string,
  records: readonly JournalRecord[],
): SubagentToolSummary {
  const seen = new Set<string>();
  const toolCounts: Record<string, number> = {};
  let toolCalls = 0;
  let toolErrors = 0;

  // Build a result-error map first so we can count errors per call.
  const resultError = new Map<string, boolean>();
  for (const rec of records) {
    if (rec.kind !== 'append') continue;
    for (const block of rec.message.content) {
      if (block.type === 'tool_result' && block.isError !== undefined) {
        resultError.set(block.toolUseId, block.isError);
      }
    }
  }

  for (const rec of records) {
    if (rec.kind !== 'append') continue;
    for (const block of rec.message.content) {
      if (block.type !== 'tool_use') continue;
      if (seen.has(block.id)) continue;
      seen.add(block.id);
      toolCalls += 1;
      toolCounts[block.name] = (toolCounts[block.name] ?? 0) + 1;
      if (resultError.get(block.id) === true) toolErrors += 1;
    }
  }

  return { subagent_id: subagentId, tool_calls: toolCalls, tool_errors: toolErrors, tool_counts: toolCounts };
}
