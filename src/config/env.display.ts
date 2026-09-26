/**
 * Text-layout and display-effect env vars: the prose/text measure, content
 * centering, and the smoke-text reveal. A contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling,
 * following the `env.browser.ts` precedent (#2206). `env.ts` spreads this
 * tuple into `ENV_REGISTRY` at the same position the entries used to occupy,
 * so registry order, the derived `EnvObject` / `EnvVarName` types, and the
 * rendered `docs/env-registry.*` are all unchanged.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.display
 */

import type { EnvVarMeta } from './env.js';

export const DISPLAY_ENV_REGISTRY = [
  {
    name: 'AFK_TEXT_MEASURE',
    description:
      'Maximum line length (columns) for unbordered streamed text in the interactive REPL: assistant prose, ' +
      'thinking blocks, tool-lane text, and subagent text. Display-only — affects wrapping, never behavior. ' +
      'Bordered elements (cards, error boxes) already cap at 100; this applies the same ceiling to the ' +
      'unbordered surfaces, which previously scaled to the full terminal width. ' +
      'Accepts a positive integer (minimum 20), or full | off | none | 0 to disable capping and restore ' +
      'full-width wrapping. Unparseable or below-minimum values fall back to the default. ' +
      'No-op on terminals at or below the measure, so narrow terminals are unaffected.',
    type: 'string',
    required: false,
    default: '100',
    example: 'full',
    category: 'misc',
  },
  {
    name: 'AFK_PROSE_MEASURE',
    description:
      'Maximum line length (columns) for prose-only blocks (paragraphs, list items, blockquotes) in the ' +
      'interactive REPL. Code fences use the wider AFK_TEXT_MEASURE (default 100). When AFK_TEXT_MEASURE ' +
      'is explicitly set, it overrides this value for backward compatibility. ' +
      'Accepts a positive integer (minimum 20), or full | off | none | 0 to disable. ' +
      'Unparseable or below-minimum values fall back to the default.',
    type: 'string',
    required: false,
    default: '80',
    example: '72',
    category: 'misc',
  },
  {
    name: 'AFK_CENTER_CONTENT',
    description:
      'When set to "1" (or any truthy value), content surfaces (tool-lane overlay, ' +
      'scrollback blocks, input line, spinner, and OODA stage rail) are horizontally ' +
      'centered by prepending a left margin equal to Math.floor((terminalWidth - contentMeasure) / 2). ' +
      'No-op when the terminal is at or below the content measure — the common 80–100 column case. ' +
      'Default off (empty string). Opt-in: set AFK_CENTER_CONTENT=1 to enable.',
    type: 'boolean',
    required: false,
    default: '',
    example: '1',
    category: 'display',
  },
  {
    name: 'AFK_INK_TEXT',
    description:
      'Streamed assistant prose in the interactive REPL arrives like ink drying: letters are revealed at a steady ' +
      'pace (never more than a quarter second behind the model) and rise from near the background into their own ' +
      'color, never brighter. Layout and scrollback are identical to having it off. On by default on 256-color or ' +
      'truecolor terminals. It stays off for NO_COLOR, non-TTY output, AFK_PLAIN_OUTPUT, Telegram, the daemon, ' +
      'and AFK_REDUCED_MOTION=1. Set AFK_INK_TEXT=0 (or false/no/off) to show text the instant it arrives.',
    type: 'boolean',
    required: false,
    default: '',
    example: '0',
    category: 'display',
  },
  {
    name: 'AFK_SMOKE_TEXT',
    description:
      'When set to "1" (or true/yes/on), markdown headings in streamed assistant output condense out of rolling ' +
      'smoke (braille particles thickening into each letter, with a thin wisp drifting ahead of the front), and ' +
      'machine-status UI (tool rows, the thought summary) fades in. Body prose keeps the calm AFK_INK_TEXT ' +
      'reveal, so smoke stays an accent. Needs a 256-color or truecolor terminal. It stays off for NO_COLOR, ' +
      'non-TTY output, AFK_PLAIN_OUTPUT, Telegram, the daemon, and AFK_REDUCED_MOTION=1. Default off.',
    type: 'boolean',
    required: false,
    default: '',
    example: '1',
    category: 'display',
  },
] as const satisfies readonly EnvVarMeta[];
