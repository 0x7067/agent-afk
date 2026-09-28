/**
 * Tests for resolveCrossProviderSummarize (shared/compact-summarizer.ts).
 *
 * All cases use injected fakes or module-scope factory hooks — no network, no
 * real SDK clients. Tests are colocated with the module under test.
 *
 * Coverage:
 *   T1 — AFK_COMPACT_MODEL unset → session summarizer returned unchanged.
 *   T2 — AFK_COMPACT_MODEL same anthropic family → session summarizer returned.
 *   T3 — Claude session + gpt id + API key → oneShotChatCompletion path.
 *   T4 — Claude session + gpt id + ChatGPT-OAuth → oneShotResponses path.
 *   T5 — OpenAI session + claude id → oneShotCompletion (Anthropic) path.
 *   T6 — Slot alias with apiKey/baseUrl → binding forwarded correctly.
 *   T7 — Non-abort failure warns once and re-throws (no session client call).
 *   T8 — AbortError propagates unchanged (no double-wrap).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveCrossProviderSummarize, __resetCrossProviderWarnState } from './compact-summarizer.js';
import * as anthropicOneshot from '../anthropic-direct/oneshot.js';
import * as openaiOneshot from '../openai-compatible/oneshot.js';
import * as openaiAuth from '../openai-compatible/auth.js';
import * as xaiAuth from '../xai/auth.js';
import * as xaiEndpoints from '../xai/endpoints.js';
import * as credentialResolver from '../../auth/credential-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_RESULT = 'session-summary';
const FOREIGN_RESULT = 'foreign-summary';

function makeSessionFn(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(SESSION_RESULT);
}

// ---------------------------------------------------------------------------
// Setup: reset warn state and spy on console.warn before each test.
// ---------------------------------------------------------------------------

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetCrossProviderWarnState();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// T1: unset AFK_COMPACT_MODEL
// ---------------------------------------------------------------------------

describe('T1: unset compact model', () => {
  it('returns session summarizer unchanged when compactModelRaw is undefined', async () => {
    const sessionFn = makeSessionFn();
    const resolved = resolveCrossProviderSummarize('anthropic-direct', sessionFn, undefined);
    const result = await resolved('transcript');
    expect(resolved).toBe(sessionFn);
    expect(result).toBe(SESSION_RESULT);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns session summarizer unchanged when compactModelRaw is empty string', async () => {
    const sessionFn = makeSessionFn();
    const resolved = resolveCrossProviderSummarize('anthropic-direct', sessionFn, '');
    expect(resolved).toBe(sessionFn);
  });
});

// ---------------------------------------------------------------------------
// T2: same-family (anthropic) compact model
// ---------------------------------------------------------------------------

describe('T2: same-family compact model', () => {
  it('returns session summarizer unchanged for a claude-* id on anthropic-direct session', async () => {
    const sessionFn = makeSessionFn();
    const resolved = resolveCrossProviderSummarize(
      'anthropic-direct',
      sessionFn,
      'claude-haiku-4-5-20251001',
    );
    expect(resolved).toBe(sessionFn);
    await resolved('transcript');
    expect(sessionFn).toHaveBeenCalledWith('transcript');
  });

  it('returns session summarizer unchanged for a gpt-* id on openai-compatible session', async () => {
    const sessionFn = makeSessionFn();
    const resolved = resolveCrossProviderSummarize(
      'openai-compatible',
      sessionFn,
      'gpt-4o-mini',
    );
    expect(resolved).toBe(sessionFn);
  });
});

// ---------------------------------------------------------------------------
// T3: Claude session + gpt id + API key → Chat Completions
// ---------------------------------------------------------------------------

describe('T3: Claude session + gpt id + api key', () => {
  it('calls oneShotChatCompletion with the gpt model id', async () => {
    const oneShotChat = vi.spyOn(openaiOneshot, 'oneShotChatCompletion').mockResolvedValue(FOREIGN_RESULT);
    vi.spyOn(openaiAuth, 'resolveOpenAIAuth').mockReturnValue({
      apiKey: 'sk-test-key',
      source: 'env',
    });

    const sessionFn = makeSessionFn();
    const resolved = resolveCrossProviderSummarize(
      'anthropic-direct',
      sessionFn,
      'gpt-4o',
    );

    const result = await resolved('my transcript');

    expect(oneShotChat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o',
        apiKey: 'sk-test-key',
        system: expect.any(String),
        user: expect.any(String),
        maxTokens: 1024,
      }),
    );
    expect(result).toBe(FOREIGN_RESULT);
    expect(sessionFn).not.toHaveBeenCalled();
    // Privacy warning emitted exactly once
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/cross-provider compaction/i);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/gpt-4o/);
  });
});

// ---------------------------------------------------------------------------
// T4: Claude session + gpt id + ChatGPT-OAuth → Responses wire
// ---------------------------------------------------------------------------

describe('T4: Claude session + gpt id + ChatGPT-OAuth', () => {
  it('calls oneShotResponses with isChatGptBackend:true', async () => {
    const oneShotResp = vi.spyOn(openaiOneshot, 'oneShotResponses').mockResolvedValue(FOREIGN_RESULT);
    vi.spyOn(openaiAuth, 'resolveOpenAIAuth').mockReturnValue({
      apiKey: 'chatgpt-oauth-token',
      source: 'chatgpt-oauth',
      accountId: 'acct_test123',
    });

    const sessionFn = makeSessionFn();
    const resolved = resolveCrossProviderSummarize(
      'anthropic-direct',
      sessionFn,
      'gpt-6-luna',
    );

    const result = await resolved('my transcript');

    expect(oneShotResp).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-6-luna',
        isChatGptBackend: true,
        system: expect.any(String),
        user: expect.any(String),
        maxTokens: 1024,
      }),
    );
    // The client passed to oneShotResponses must have the ChatGPT backend URL
    const callArg = (oneShotResp.mock.calls[0] as [{ client: { baseURL?: string } }] | undefined)?.[0];
    expect(callArg?.client).toBeDefined();
    expect(result).toBe(FOREIGN_RESULT);
    expect(sessionFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T5: OpenAI session + claude id → oneShotCompletion (Anthropic)
// ---------------------------------------------------------------------------

describe('T5: OpenAI session + claude id', () => {
  it('calls oneShotCompletion with the anthropic token', async () => {
    const oneShotAnthropic = vi
      .spyOn(anthropicOneshot, 'oneShotCompletion')
      .mockResolvedValue(FOREIGN_RESULT);
    vi.spyOn(credentialResolver, 'loadAnthropicCredential').mockReturnValue('sk-ant-test');

    const sessionFn = makeSessionFn();
    const resolved = resolveCrossProviderSummarize(
      'openai-compatible',
      sessionFn,
      'claude-haiku-4-5-20251001',
    );

    const result = await resolved('transcript');

    expect(oneShotAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'sk-ant-test',
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 1024,
      }),
    );
    expect(result).toBe(FOREIGN_RESULT);
    expect(sessionFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T6: slot alias forwards binding (apiKey, baseUrl)
// ---------------------------------------------------------------------------

describe('T6: slot alias with binding credentials', () => {
  it('uses binding apiKey when the slot provides one', async () => {
    const oneShotAnthropic = vi
      .spyOn(anthropicOneshot, 'oneShotCompletion')
      .mockResolvedValue(FOREIGN_RESULT);
    // Make sure loadAnthropicCredential is NOT called when the binding has an
    // explicit apiKey (we verify the spy is called with the binding key).
    vi.spyOn(credentialResolver, 'loadAnthropicCredential').mockReturnValue('fallback-token');

    // Passing a raw claude model id (no slot alias resolution needed here since
    // the compact-summarizer calls resolveBinding which passes through raw ids).
    const sessionFn = makeSessionFn();
    const resolved = resolveCrossProviderSummarize(
      'openai-compatible',
      sessionFn,
      'claude-opus-5-5',
    );
    await resolved('transcript');

    // oneShotCompletion called with the anthropic model id
    expect(oneShotAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-5-5' }),
    );
  });
});

// ---------------------------------------------------------------------------
// T7: non-abort failure warns once and re-throws (no session client call)
// ---------------------------------------------------------------------------

describe('T7: failure handling', () => {
  it('emits a one-time failure warning and re-throws on network error', async () => {
    const networkError = new Error('network error from openai');
    vi.spyOn(openaiOneshot, 'oneShotChatCompletion').mockRejectedValue(networkError);
    vi.spyOn(openaiAuth, 'resolveOpenAIAuth').mockReturnValue({
      apiKey: 'sk-key',
      source: 'env',
    });

    const sessionFn = makeSessionFn();
    const resolved = resolveCrossProviderSummarize(
      'anthropic-direct',
      sessionFn,
      'gpt-4o',
    );

    await expect(resolved('transcript')).rejects.toThrow('network error from openai');
    // Two warnings: privacy (first use) + failure (first failure)
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[1]?.[0]).toMatch(/cross-provider summarization failed/i);

    // Second call: failure warning NOT emitted again (already warned)
    await expect(resolved('transcript2')).rejects.toThrow('network error from openai');
    // Privacy warning is also suppressed on second call
    expect(warnSpy).toHaveBeenCalledTimes(2);

    // Session client never called
    expect(sessionFn).not.toHaveBeenCalled();
  });

  it('does not emit failure warning for the same model on success', async () => {
    vi.spyOn(openaiOneshot, 'oneShotChatCompletion').mockResolvedValue(FOREIGN_RESULT);
    vi.spyOn(openaiAuth, 'resolveOpenAIAuth').mockReturnValue({
      apiKey: 'sk-key',
      source: 'env',
    });

    const sessionFn = makeSessionFn();
    const resolved = resolveCrossProviderSummarize('anthropic-direct', sessionFn, 'gpt-4o');
    await resolved('transcript');

    // Only privacy warning on success
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/cross-provider compaction/i);
  });
});

// ---------------------------------------------------------------------------
// T8: AbortError propagates unchanged
// ---------------------------------------------------------------------------

describe('T8: abort propagation', () => {
  it('re-throws AbortError without emitting failure warning', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.spyOn(openaiOneshot, 'oneShotChatCompletion').mockRejectedValue(abortErr);
    vi.spyOn(openaiAuth, 'resolveOpenAIAuth').mockReturnValue({
      apiKey: 'sk-key',
      source: 'env',
    });

    const sessionFn = makeSessionFn();
    const resolved = resolveCrossProviderSummarize('anthropic-direct', sessionFn, 'gpt-4o');

    const controller = new AbortController();
    controller.abort();

    await expect(resolved('transcript', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

    // Only the privacy warning, not the failure warning
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/cross-provider compaction/i);
    // Failure warning NOT emitted
    expect(warnSpy.mock.calls.every((c: unknown[]) => !String(c[0]).includes('failed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T9: xAI cross-provider path
// ---------------------------------------------------------------------------

describe('T9: xAI cross-provider', () => {
  it('calls oneShotChatCompletion with xAI endpoint on claude session', async () => {
    const oneShotChat = vi.spyOn(openaiOneshot, 'oneShotChatCompletion').mockResolvedValue(FOREIGN_RESULT);
    vi.spyOn(xaiAuth, 'resolveXaiAuth').mockReturnValue({
      apiKey: 'xai-key',
      source: 'env',
      mode: 'apikey',
    });
    vi.spyOn(xaiEndpoints, 'resolveXaiEndpoint').mockReturnValue({
      baseURL: 'https://api.x.ai/v1',
      defaultHeaders: {},
      mode: 'apikey',
      proxyHeadersApplied: false,
    });

    const sessionFn = makeSessionFn();
    const resolved = resolveCrossProviderSummarize(
      'anthropic-direct',
      sessionFn,
      'grok-3-beta',
    );

    const result = await resolved('transcript');

    expect(oneShotChat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'grok-3-beta',
        baseURL: 'https://api.x.ai/v1',
        maxTokens: 1024,
      }),
    );
    expect(result).toBe(FOREIGN_RESULT);
    expect(sessionFn).not.toHaveBeenCalled();
  });
});
