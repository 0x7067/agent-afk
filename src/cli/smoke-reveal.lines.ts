/**
 * Line classification for the text reveal: splits streamed raw markdown into
 * runs of "heading line" vs "everything else", carrying line state across
 * chunk boundaries, so the mask can give headings the smoke accent.
 *
 * Contract: `split(chunk)` returns runs whose texts concatenate back to
 * `chunk` exactly. Classification happens at each line start from whatever
 * of that line is in hand. A line start that is still ambiguous at the end of
 * a chunk (`#`, `##` with nothing after) is guessed to be a heading; a wrong
 * guess only changes the reveal style of a couple of syntax characters.
 * Lines inside a fenced code block are never headings (the mask skips code
 * anyway, this just keeps `# comment` lines out of the accent).
 *
 * @module cli/smoke-reveal.lines
 */

export interface LineRun {
  text: string;
  heading: boolean;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}#{1,6}(\s|$)/;
const PARTIAL_HEADING_RE = /^ {0,3}#{1,6}$/;

export class LineClassifier {
  private atLineStart = true;
  private heading = false;
  private inFence = false;

  split(chunk: string): LineRun[] {
    const runs: LineRun[] = [];
    let cur = '';
    let curHeading = this.heading;
    let i = 0;
    while (i < chunk.length) {
      if (this.atLineStart) {
        const nl = chunk.indexOf('\n', i);
        const rest = chunk.slice(i, nl === -1 ? chunk.length : nl);
        this.heading = this.classify(rest, nl === -1);
        this.atLineStart = false;
      }
      const nl = chunk.indexOf('\n', i);
      const end = nl === -1 ? chunk.length : nl + 1;
      if (this.heading !== curHeading && cur) {
        runs.push({ text: cur, heading: curHeading });
        cur = '';
      }
      curHeading = this.heading;
      cur += chunk.slice(i, end);
      if (nl !== -1) this.atLineStart = true;
      i = end;
    }
    if (cur) runs.push({ text: cur, heading: curHeading });
    return runs;
  }

  reset(): void {
    this.atLineStart = true;
    this.heading = false;
    this.inFence = false;
  }

  private classify(rest: string, truncated: boolean): boolean {
    if (FENCE_RE.test(rest)) {
      this.inFence = !this.inFence;
      return false;
    }
    if (this.inFence) return false;
    return HEADING_RE.test(rest) || (truncated && PARTIAL_HEADING_RE.test(rest));
  }
}
