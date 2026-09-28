/**
 * STUB (contract only). Lane A replaces the body; the exported signatures are
 * the contract other lanes import. See docs/message-journal.md.
 *
 * @module agent/journal/writer
 */

import type { MessageJournal } from './types.js';

export interface CreateMessageJournalOptions {
  /**
   * Lazy session-id accessor. The id may be unknown at construction (it can
   * be assigned after the first turn); records are buffered in memory until
   * it resolves, then flushed in order.
   */
  getSessionId: () => string | undefined;
  /** Metadata stamped on the journal's `meta` record. */
  meta?: { provider?: string; model?: string; cwd?: string };
}

/**
 * Build the session's journal. Returns a no-op journal (length 0, every
 * method a no-op) when `AFK_MESSAGE_JOURNAL_DISABLED=1`.
 *
 * Contract: `length` reflects the ON-DISK fold of an existing journal file the
 * first time it is read after the session id resolves (so a resumed session
 * appends at the right index), then tracks writes in memory.
 */
export function createMessageJournal(_opts: CreateMessageJournalOptions): MessageJournal {
  throw new Error('createMessageJournal: not implemented (lane A)');
}
