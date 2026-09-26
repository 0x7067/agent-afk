/**
 * Shared fixture helpers for tool-lane-render-compact test files.
 *
 * Consumed by:
 *   - tool-lane-render-compact.test.ts
 *   - tool-lane-render-compact-coverage.test.ts
 *
 * Named to match the existing __fixtures__ convention in the repo (see
 * src/agent/__fixtures__/) so tsconfig correctly excludes it from the build.
 */

import { freshToolEntry } from '../tool-lane-render.js';
import type { ToolEntry } from '../tool-lane-render.js';
import type { ToolResultChunk } from '../../../../agent/types/message-types.js';
import type { ToolFailureClass } from '../../../../agent/trace/types.js';

export function makeResult(
  content: string,
  isError = false,
  failureClass?: ToolFailureClass,
): ToolResultChunk {
  return {
    type: 'tool_result',
    toolUseId: 'unused',
    content,
    isError,
    ...(failureClass ? { failureClass } : {}),
  };
}

/**
 * Build a minimal ToolEntry suitable for passing to renderCompactFlushChildren
 * as a child.  `result` is set when provided so the entry is "completed".
 */
export function makeTool(
  toolUseId: string,
  toolName: string,
  toolInput: string,
  result?: ToolResultChunk,
): ToolEntry {
  const entry = freshToolEntry(toolUseId, toolName, toolInput, toolName + toolInput);
  if (result) entry.result = result;
  return entry;
}
