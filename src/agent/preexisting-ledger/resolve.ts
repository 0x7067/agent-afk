/**
 * Resolve a locus as agents write it in prose to a repo-relative path.
 *
 * Agents usually name a file by its basename (`anthropic-direct.test.ts`) or a
 * partial path (`openai-compatible/index.ts`), so an exact-path existence check
 * reports live files as missing. Resolution order: exact match, then path
 * suffix, then basename. Pure: callers supply the tracked-file list.
 *
 * @module agent/preexisting-ledger/resolve
 */

import { basename } from 'node:path';

export function resolveLocusPath(locus: string, files: readonly string[]): string | undefined {
  if (files.includes(locus)) return locus;
  const suffix = files.find((f) => f.endsWith(`/${locus}`));
  if (suffix) return suffix;
  const base = basename(locus);
  return files.find((f) => basename(f) === base);
}
