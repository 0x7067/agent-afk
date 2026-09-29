/**
 * Outcome turn loader — sidecar with journal fallback.
 *
 * `loadOutcomeTurns(sessionId)` is the single entry point that session-end-hook.ts
 * uses to obtain a Turn[] for labeling. It tries the session sidecar first
 * (fast, already-structured), then falls back to the message journal when the
 * sidecar is absent or empty.
 *
 * Error posture: never throws. Any failure (missing sidecar, unreadable
 * journal, malformed records) degrades to `{ turns: [], source: 'none' }` so
 * the hook's fire-and-forget contract is preserved.
 *
 * Dependency direction: outcomes → journal (not the reverse).
 *
 * @module agent/outcomes/load-outcome-turns
 */

import { loadStoredSession } from '../facets/store.js';
import { readJournalRecords, hydrateMessages } from '../journal/reader.js';
import type { JournalMessage, JournalRecord } from '../journal/types.js';
import { journalMessagesToTurns } from './journal-turns.js';
import type { Turn } from './artifacts.js';

export type OutcomeTurnsSource = 'sidecar' | 'journal' | 'none';

export interface OutcomeTurnsResult {
  turns: Turn[];
  source: OutcomeTurnsSource;
}

/**
 * Load Turn[] for a session, preferring the sidecar and falling back to the
 * message journal when the sidecar is absent or has no turns.
 *
 * "Absent" covers: file does not exist, parse failure, and sessions.turns
 * being empty — all three leave the outcome hook with no labeling signal.
 * Scheduled/daemon sessions never write the sidecar at all; for those the
 * journal is the only source.
 */
export function loadOutcomeTurns(sessionId: string): OutcomeTurnsResult {
  try {
    // 1. Try the sidecar first.
    const session = loadStoredSession(sessionId);
    if (session !== undefined && session.turns.length > 0) {
      // Sidecar turns already carry the Turn / ToolEvent shape; pass through.
      return { turns: session.turns, source: 'sidecar' };
    }

    // 2. Fall back to the journal.
    const messages = sessionHistoryMessages(readJournalRecords(sessionId));
    if (messages.length === 0) {
      return { turns: [], source: 'none' };
    }

    // Hydrate spilled blob references before converting (best-effort; a
    // missing blob becomes a stand-in text block — never throws).
    const turns = journalMessagesToTurns(hydrateMessages(messages));
    return { turns, source: turns.length > 0 ? 'journal' : 'none' };
  } catch {
    // Any unexpected error (path validation, permission, etc.) degrades to
    // an empty result exactly like a missing sidecar.
    return { turns: [], source: 'none' };
  }
}

/**
 * Invariant: outcome labeling needs everything the session DID, not what the
 * model can still see. The folded journal (loadJournalFold) applies
 * `truncate` records (compact, resync, rewind, clear, repair,
 * provider_switch), which drop messages from the model context but not from
 * history: a commit or a failing test before a compaction still happened.
 * The sidecar keeps every turn for the same reason, and facets'
 * journalRecordsToToolEvents scans all appends too. So we take every
 * `append` in record order and skip verbatim re-appends (resync / compaction
 * replay the same message), which would otherwise duplicate turns and tool
 * events.
 */
export function sessionHistoryMessages(records: readonly JournalRecord[]): JournalMessage[] {
  const seen = new Set<string>();
  const out: JournalMessage[] = [];
  for (const rec of records) {
    if (rec.kind !== 'append') continue;
    const key = JSON.stringify(rec.message);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec.message);
  }
  return out;
}
