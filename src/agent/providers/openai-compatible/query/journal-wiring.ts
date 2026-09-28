/**
 * Message-journal wiring for {@link OpenAICompatibleQuery}
 * (docs/message-journal.md). Kept out of query.ts so the query only carries
 * one-line commit-point calls.
 *
 * Commit points (all `sync(priorTurns)`; JournalSync diffs by reference):
 *   - top of every `runIteration` (what is about to be sent);
 *   - after a tool round's assistant{tool_calls} + tool messages are pushed;
 *   - after the terminal assistant message is pushed;
 *   - after a successful compaction splice (`reason: 'compact'`).
 * Microcompaction rewrites tool content IN PLACE and is not detected (the
 * accepted in-place-mutation gap in journal/sync.ts).
 *
 * Resume: when `config.resumeMessages` is set, `priorTurns` is seeded from it
 * via the adapter and the legacy text-only `resumeHistory` replay is skipped
 * (it would duplicate the conversation). Without a journal nothing changes.
 *
 * @module agent/providers/openai-compatible/query/journal-wiring
 */

import { JournalSync } from '../../../journal/index.js';
import type { AgentConfig, ResumeHistoryTurn } from '../../../types/config-types.js';
import type { ProviderUsage } from '../../../provider.js';
import type { OpenAIMessage } from '../messages.js';
import { openAIJournalAdapter } from '../journal-adapter.js';

export class OpenAIJournalWiring {
  private readonly journalSync: JournalSync<OpenAIMessage>;

  constructor(private readonly config: AgentConfig) {
    this.journalSync = new JournalSync(config.messageJournal, openAIJournalAdapter);
  }

  /**
   * Starting `priorTurns` for this runtime: the journal-resumed conversation
   * when present (and seeded into the journal), otherwise `[]` (seeded lazily
   * on the first sync, which also resets a journal after `/clear`).
   */
  initialTurns(): OpenAIMessage[] {
    const resumed = this.config.resumeMessages;
    if (resumed === undefined) return [];
    const turns = openAIJournalAdapter.fromJournalMessages(resumed);
    this.journalSync.seed(turns);
    return turns;
  }

  /**
   * Context-overflow guard seed (#1294): the last sidecar turn's `inputTokens`
   * (still present alongside a journal resume). Conservative: over-estimating
   * triggers compaction; under-estimating lets a full context hit a 400.
   */
  resumedUsage(): ProviderUsage | null {
    const inputTokens = this.config.resumeHistory?.at(-1)?.inputTokens;
    if (inputTokens === undefined || inputTokens <= 0) return null;
    return { inputTokens, stopReason: null, resultSubtype: 'success', isError: false };
  }

  /** Legacy sidecar replay, suppressed when the journal supplied the history. */
  legacyResumeHistory(): { resumeHistory?: ResumeHistoryTurn[] } {
    const history = this.config.resumeHistory;
    return history !== undefined && this.config.resumeMessages === undefined ? { resumeHistory: history } : {};
  }

  /** Commit the current array to the journal. Never throws. */
  sync(turns: readonly OpenAIMessage[], compacted = false): void {
    try {
      this.journalSync.sync(turns, compacted ? { reason: 'compact' } : {});
    } catch {
      // Journal is best-effort; a mapping bug must never break a turn.
    }
  }
}
