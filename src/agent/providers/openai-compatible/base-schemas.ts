/**
 * Surface-scoped builtin schema filter for the OpenAI-compatible provider.
 *
 * Extracted from `index.ts` (baselined over the 350-code-line ceiling, which
 * may shrink but never grow) so dispatcher wiring can be added there without
 * growth. Behaviour is unchanged.
 *
 * @module agent/providers/openai-compatible/base-schemas
 */

import type { AnthropicToolDef } from '../anthropic-direct/types.js';

/**
 * Invariant: skill-dispatch sub-agents must never pause to ask the operator
 * "which skill?" nor mutate the operator's environment. Strip `ask_question`
 * (operator-prompt escape hatch) and `terminal_font_size` (an environment tool
 * a bare numeric skill arg can lure a confused model into), plus the clipboard
 * tools. Non-interactive surfaces drop the operator-facing tools. Parity with
 * the toolDefs filter in AnthropicDirectProvider. No skill calls either tool.
 */
export function selectBaseSchemas(
  schemas: AnthropicToolDef[],
  opts: { isSkillDispatch?: boolean; isNonInteractive?: boolean },
): AnthropicToolDef[] {
  if (opts.isSkillDispatch) {
    return schemas.filter(
      (t) =>
        t.name !== 'ask_question' &&
        t.name !== 'terminal_font_size' &&
        t.name !== 'clipboard_write' &&
        t.name !== 'clipboard_read',
    );
  }
  if (opts.isNonInteractive) {
    return schemas.filter(
      (t) => t.name !== 'ask_question' && t.name !== 'clipboard_read' && t.name !== 'clipboard_write',
    );
  }
  return schemas;
}
