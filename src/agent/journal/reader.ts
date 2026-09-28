/**
 * STUB (contract only). Lane A replaces the bodies; the exported signatures
 * are the contract other lanes import. See docs/message-journal.md.
 *
 * @module agent/journal/reader
 */

import type { JournalBlock, JournalMessage, JournalRecord } from './types.js';

export interface JournalLocator {
  /** Read `subagents/<subagentId>.jsonl` instead of the top-level journal. */
  subagentId?: string;
}

export interface FoldResult {
  messages: JournalMessage[];
  meta: Extract<JournalRecord, { kind: 'meta' }> | undefined;
  /** Non-fatal inconsistencies (bad lines, index gaps from concurrent writers). */
  anomalies: string[];
}

export function journalExists(_sessionId: string, _loc: JournalLocator = {}): boolean {
  throw new Error('not implemented (lane A)');
}

/** Parse every record; malformed lines are skipped (reported via fold anomalies). */
export function readJournalRecords(_sessionId: string, _loc: JournalLocator = {}): JournalRecord[] {
  throw new Error('not implemented (lane A)');
}

/** Pure fold of records into the message array (see types.ts invariant). */
export function foldJournal(_records: readonly JournalRecord[]): FoldResult {
  throw new Error('not implemented (lane A)');
}

/**
 * Resolve every `text_ref` / `ref` source back to inline content. A missing
 * or unreadable blob becomes a text part naming what was lost; never throws.
 */
export function hydrateMessages(_messages: readonly JournalMessage[]): JournalMessage[] {
  throw new Error('not implemented (lane A)');
}

/** Fold + hydrate. `null` when the journal is absent, disabled, or empty. */
export function loadJournalMessages(_sessionId: string, _loc: JournalLocator = {}): JournalMessage[] | null {
  throw new Error('not implemented (lane A)');
}

/**
 * Find a tool_result by tool_use id across the top-level journal and every
 * subagent journal of the session, hydrated. Scans all records (not just the
 * folded array), so results removed by compaction are still found.
 */
export function findToolResult(
  _sessionId: string,
  _toolUseId: string,
): { block: Extract<JournalBlock, { type: 'tool_result' }>; subagentId?: string } | null {
  throw new Error('not implemented (lane A)');
}

/** Subagent ids that have a journal under this session. */
export function listSubagentJournals(_sessionId: string): string[] {
  throw new Error('not implemented (lane A)');
}
