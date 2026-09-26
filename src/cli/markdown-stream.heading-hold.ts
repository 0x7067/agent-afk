/**
 * Heading hold for the smoke accent (AFK_SMOKE_TEXT=1 only).
 *
 * The renderer commits a block to scrollback the moment the buffer holds its
 * `\n\n` boundary, and committed text is written once with no reveal. A
 * heading's boundary almost always streams in tens of milliseconds after the
 * heading itself, so without a hold the smoke accent would be cut off after
 * a frame or two: a flicker, not a moment. This module splits an incoming
 * chunk at the character that would complete a HEADING block's boundary, so
 * the renderer can hold the rest until the heading has condensed.
 *
 * Contract (narrow on purpose): only a block whose last line is a markdown
 * heading qualifies, so the held overlay is a single row and its commit is
 * the smallest repaint the compositor can do. Body paragraphs are never
 * held; the reveal paces their styling, never their commits (see the "pace
 * the reveal, never the text" invariant in smoke-reveal.ts). The owner must
 * release held text synchronously before any path that commits or inspects
 * the buffer, so nothing can be committed above a heading that preceded it.
 *
 * @module cli/markdown-stream.heading-hold
 */

import { findBlockBoundary } from './markdown-stream-format.js';

const HEADING_LINE_RE = /^ {0,3}#{1,6}(\s|$)/;

/**
 * If appending `chunk` to `buffer` completes a block whose last line is a
 * heading, return the part of `chunk` to push now (up to, not including, the
 * character that completes the boundary) and the rest to hold. Otherwise null.
 */
export function splitAtHeadingBoundary(buffer: string, chunk: string): { now: string; held: string } | null {
  const combined = buffer + chunk;
  const boundary = findBlockBoundary(combined);
  // The completing character must be in THIS chunk (index >= buffer.length).
  if (boundary === -1 || boundary - 1 < buffer.length) return null;
  const block = combined.slice(0, boundary).trimEnd();
  const lastLine = block.slice(block.lastIndexOf('\n') + 1);
  if (!HEADING_LINE_RE.test(lastLine)) return null;
  const cut = boundary - 1 - buffer.length;
  return { now: chunk.slice(0, cut), held: chunk.slice(cut) };
}
