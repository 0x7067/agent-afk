/**
 * Per-cell renderers for the text reveal: the calm ink fade (default for
 * prose) and the smoke condense (accent for headings), plus the drifting
 * wisp that runs ahead of a smoke front.
 *
 * Invariant (no overshoot): a revealing character is NEVER drawn brighter
 * than its settled self. The first smoke reveal ramped every letter up to a
 * near-white tone and then snapped it down to its dimmer real color, which
 * read as a flashbulb sweep. Here a letter either blends toward its own exact
 * RGB (when the formatter gave it one; basic white blends toward the theme's
 * near-foreground, which sits at or below it) or, when its color belongs to the
 * terminal's palette and cannot be known, climbs a low smoke tone and then
 * shows its real color with the faint attribute before settling. Both paths
 * only ever get brighter.
 *
 * Contract: every renderer returns a string that occupies exactly the same
 * number of columns as the settled character, ends by restoring `state`
 * (so the following text keeps its styling), and never emits anything but
 * SGR escapes around the cell.
 *
 * @module cli/smoke-reveal.cells
 */

import stringWidth from 'string-width';
import { SMOKE_GLYPH_LEVELS, charLifetime, easeOutCubic, seedUnit, smokeGlyph, smokeToneOffset } from './smoke-reveal.frame.js';
import { toneRgb } from './smoke-reveal.tones.js';
import { EMPTY_SGR, fgParams, isBasicWhite, knownFgRgb, mixRgb, serializeSgr, type SgrState } from './smoke-reveal.sgr.js';

export type RevealStyle = 'ink' | 'smoke';

/** Ink fade duration. Long enough to read as a soft trailing edge, short enough to never feel slow. */
export const INK_MS = 200;
/**
 * Width of the ink trailing edge in characters. A letter is settled once it
 * is `INK_MS` old OR this many characters behind the front, whichever comes
 * first. Time alone would make the edge as wide as `rate * INK_MS`, so a
 * fast catch-up would paint a whole paragraph faint at once and then sweep
 * it bright: a block again. Capping by distance keeps a narrow, constant
 * band while text flows; time still settles the tail when the flow stops.
 */
export const INK_TRAIL_CHARS = 20;
/** Ramp position a fresh ink letter starts from: a whisper above the background. */
export const INK_FLOOR = 0.06;
/** Ramp position where an unknown-color letter hands over to its faint real color. */
export const INK_DIM = 0.22;
/** Share of the ink fade spent on the low ramp before the faint stage (unknown colors only). */
export const INK_SPECK_PHASE = 0.3;

/** Smoke accent lifetime (base; per-letter jitter only shortens it). */
export const SMOKE_MS = 520;
/** Share of the smoke lifetime spent as a particle before the letter appears. */
export const SMOKE_GLYPH_PHASE = 0.42;
/** Ramp position of the densest particle, and where the letter phase starts. */
const SMOKE_PEAK = 0.36;

/** Cells of wisp drawn ahead of a smoke front. */
export const WISP_CELLS = 3;
/** How long the wisp lingers after the front stops advancing. */
export const WISP_MS = 280;
/** Wisp drift cadence: the pattern shifts one cell right per step. */
const WISP_STEP_MS = 70;
const WISP_LANE = 97;

/** Lifetime of a character revealed with `style`. */
export function lifetimeOf(style: RevealStyle, seed: number): number {
  return style === 'ink' ? INK_MS : charLifetime(seed, SMOKE_MS);
}

/** Longest lifetime any character can have (for pruning finished bursts). */
export const MAX_LIFETIME_MS = Math.max(INK_MS, SMOKE_MS);

function tone(t: number): string {
  return fgParams(toneRgb(t));
}

/**
 * The letter itself at blend `p` in [0, 1] from ramp position `from` toward
 * its settled look. Exact colors blend continuously; palette colors climb the
 * ramp to `INK_DIM` and then show faint-real, so neither ever overshoots.
 */
function letter(ch: string, state: SgrState, from: number, p: number): string {
  const target = knownFgRgb(state) ?? (isBasicWhite(state) ? toneRgb(1) : null);
  if (target) {
    const rgb = mixRgb(toneRgb(from), target, easeOutCubic(p));
    return serializeSgr(state, fgParams(rgb)) + ch;
  }
  if (p < INK_SPECK_PHASE) {
    const t = from + (Math.max(from, INK_DIM) - from) * (p / INK_SPECK_PHASE);
    return serializeSgr({ ...state, faint: false }, tone(t)) + ch;
  }
  return serializeSgr({ ...state, faint: true }) + ch;
}

/**
 * Ink cell at `age` ms and `behind` characters from the front (0 = newest),
 * or null once settled (caller emits the original text).
 */
export function inkCell(ch: string, age: number, state: SgrState, behind = 0): string | null {
  const p = Math.max(age / INK_MS, behind / INK_TRAIL_CHARS);
  if (p >= 1) return null;
  return letter(ch, state, INK_FLOOR, p) + serializeSgr(state);
}

/** Smoke cell at `age` ms, or null once settled. */
export function smokeCell(ch: string, age: number, seed: number, state: SgrState): string | null {
  const life = charLifetime(seed, SMOKE_MS);
  if (age >= life) return null;
  const f = age / life;
  if (f < SMOKE_GLYPH_PHASE && stringWidth(ch) === 1) {
    const p = f / SMOKE_GLYPH_PHASE;
    const t = 0.1 + (SMOKE_PEAK - 0.1) * p + smokeToneOffset(seed);
    return serializeSgr(EMPTY_SGR, tone(t)) + smokeGlyph(p, seed) + serializeSgr(state);
  }
  const p = f < SMOKE_GLYPH_PHASE ? 0 : (f - SMOKE_GLYPH_PHASE) / (1 - SMOKE_GLYPH_PHASE);
  return letter(ch, state, SMOKE_PEAK, p) + serializeSgr(state);
}

/**
 * One wisp cell `k` columns ahead of a smoke front (k >= 1), or null for an
 * empty cell, or '' once the wisp has faded. `frontAge` is the front
 * character's age; `now` drives the drift. The pattern at cell k and step n
 * equals the pattern at cell k-1 and step n-1, so the texture visibly
 * travels rightward while it thins out. Callers restore their own style.
 */
export function wispCell(k: number, frontAge: number, now: number, seed: number): string | null {
  if (frontAge >= WISP_MS || k < 1 || k > WISP_CELLS) return '';
  const strength = 1 - Math.max(0, frontAge) / WISP_MS;
  const u = seedUnit(seed + Math.floor(now / WISP_STEP_MS) - k, WISP_LANE);
  if (u < 0.22) return null;
  const level = SMOKE_GLYPH_LEVELS[k === 1 ? 1 : 0] ?? [];
  const glyph = level[Math.floor(u * 997) % Math.max(1, level.length)] ?? '⠁';
  const t = (0.2 - 0.045 * k) * strength;
  return serializeSgr(EMPTY_SGR, tone(Math.max(0.03, t))) + glyph;
}

/** The whole `WISP_CELLS`-wide wisp (for a front with no reserved cells after it), or '' once faded. */
export function wispCells(frontAge: number, now: number, seed: number): string {
  if (frontAge >= WISP_MS) return '';
  let out = '';
  for (let k = 1; k <= WISP_CELLS; k++) out += wispCell(k, frontAge, now, seed) ?? ' ';
  return out;
}
