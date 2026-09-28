/**
 * Lazy loader for a tool call's FULL result from the message journal.
 *
 * The SSE stream carries only the ledger's clipped preview of each tool
 * result (live records stay small). When the user asks for the whole output,
 * this hook fetches it once from `GET /api/sessions/:id/tool-results/:toolUseId`.
 *
 * Contract: nothing is fetched until `load()` is called. The session id comes
 * from {@link TranscriptSessionContext}, which the transcript view provides;
 * outside that provider (or for a tool row with no toolUseId) `canLoad` is
 * false and `load()` is a no-op.
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { toolResultPath } from '@/lib/ledger-adapter';
import type { ToolResultResponse } from '@/types/api';

/** Session id of the transcript currently rendered; `null` outside a session. */
export const TranscriptSessionContext = createContext<string | null>(null);

export type FullToolResultState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; result: ToolResultResponse }
  | { status: 'error'; message: string };

export interface FullToolResult {
  state: FullToolResultState;
  canLoad: boolean;
  load: () => void;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return err.message.includes('journal_not_found')
      ? 'Full output unavailable: this session has no message journal.'
      : 'Full output not found in the session journal.';
  }
  return err instanceof Error ? err.message : String(err);
}

export function useFullToolResult(toolUseId: string | undefined): FullToolResult {
  const sessionId = useContext(TranscriptSessionContext);
  const [state, setState] = useState<FullToolResultState>({ status: 'idle' });
  const canLoad = sessionId !== null && toolUseId !== undefined && toolUseId.length > 0;

  // A different call (or session) invalidates what was loaded.
  useEffect(() => {
    setState({ status: 'idle' });
  }, [sessionId, toolUseId]);

  const load = useCallback(() => {
    if (!canLoad || sessionId === null || toolUseId === undefined) return;
    setState({ status: 'loading' });
    apiFetch<ToolResultResponse>(toolResultPath(sessionId, toolUseId)).then(
      (result) => setState({ status: 'loaded', result }),
      (err: unknown) => setState({ status: 'error', message: describeError(err) }),
    );
  }, [canLoad, sessionId, toolUseId]);

  return { state, canLoad, load };
}
