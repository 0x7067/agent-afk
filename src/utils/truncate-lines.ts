/**
 * Line-boundary truncation helper for elicitation surfaces.
 *
 * Keeps whole lines within a character budget, then appends an explicit
 * notice so operators always know when content was cut. The final string
 * never exceeds `maxChars`.
 *
 * Edge case: if the very first line alone exceeds the budget, the line is
 * cut at the character boundary (since we can't keep any whole lines) and
 * the notice is still appended — capped to `maxChars`.
 *
 * @param text     The string to potentially truncate (may contain '\n').
 * @param maxChars Maximum character length of the returned string (inclusive).
 * @returns The original string when it fits, or the truncated string with an
 *          explicit count notice appended.
 */
export function truncateAtLineBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const lines = text.split('\n');
  const totalLines = lines.length;

  // Build the notice template; the actual kept count is filled in below.
  // Pattern: [truncated: showing N of M lines, K chars omitted]
  // We need to know how many lines fit before we know N, so we iterate.
  // Use worst-case estimates for notice length to guarantee the result fits:
  //   - keptLines = kept.length + 1 (the count we'd have after adding this line)
  //   - charsOmitted = text.length  (maximum possible; real value is always ≤ this)

  const kept: string[] = [];
  let keptChars = 0;

  for (const line of lines) {
    // How much content do we have after tentatively adding this line?
    const tentativeChars = keptChars === 0 ? line.length : keptChars + 1 + line.length;

    // Worst-case notice length: use actual text.length for the chars-omitted
    // field (real value ≤ text.length, so notice is ≤ this estimate in length).
    const noticeEst = buildNotice(kept.length + 1, totalLines, text.length).length;

    // Total: content + '\n' separator before notice + notice itself.
    const totalWithNotice = tentativeChars + 1 + noticeEst;

    if (totalWithNotice <= maxChars) {
      kept.push(line);
      keptChars = tentativeChars;
    } else {
      break;
    }
  }

  if (kept.length === 0) {
    // First line alone exceeds budget. Fall back to char cut with notice.
    // Size the room with a worst-case notice, then report the real omitted
    // count (a shorter number can only shrink the notice, so it still fits).
    const room = maxChars - buildNotice(0, totalLines, text.length).length - 1; // 1 for '\n'
    if (room <= 0) {
      // Extreme edge: notice itself exceeds budget — just truncate notice.
      return buildNotice(0, totalLines, text.length).slice(0, maxChars);
    }
    return text.slice(0, room) + '\n' + buildNotice(0, totalLines, text.length - room);
  }

  const keptText = kept.join('\n');
  const charsOmitted = text.length - keptChars;
  const notice = buildNotice(kept.length, totalLines, charsOmitted);
  return keptText + '\n' + notice;
}

function buildNotice(keptLines: number, totalLines: number, charsOmitted: number): string {
  return `[truncated: showing ${keptLines} of ${totalLines} lines, ${charsOmitted} chars omitted]`;
}
