/**
 * Unit tests for content operators (append, file, hot).
 *
 * Focuses on the append operator's leading-newline stripping guarantee:
 *   - Empty file: change.text with leading newlines → no leading blank lines.
 *   - Non-empty file: change.text with leading newlines → one blank-line separator.
 *   - touchesProject: true for 'project-afk-md', false for 'user-afk-md'.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { appendOperator } from './content-ops.js';
import type { Environment, OperatorContext } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(os.tmpdir(), 'content-ops-test-'));
}

function makeEnv(root: string): Environment {
  return {
    label: 'candidate',
    home: join(root, 'home'),
    cwd: join(root, 'cwd'),
    launch: { env: {} },
  };
}

const FAKE_CTX: OperatorContext = {
  realHome: '/tmp/real-home',
  realCwd: '/tmp/real-cwd',
};

// ---------------------------------------------------------------------------
// append operator: leading-newline stripping
// ---------------------------------------------------------------------------

describe('appendOperator: leading-newline stripping', () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('appends to empty file with leading-newline change.text — no leading blank lines', async () => {
    root = tmpDir();
    const env = makeEnv(root);
    // Both home and cwd must exist (assertInsideSandbox calls realpathSync on env.cwd)
    mkdirSync(env.home, { recursive: true });
    mkdirSync(env.cwd, { recursive: true });

    await appendOperator.apply(
      { kind: 'append', target: 'user-afk-md', text: '\n\nRule' },
      env,
      FAKE_CTX,
    );

    const result = readFileSync(join(env.home, 'AFK.md'), 'utf8');
    // Must start with 'Rule', not with blank lines
    expect(result).toBe('Rule\n');
    expect(result).not.toMatch(/^\n/);
  });

  it('appends to non-empty file with leading-newline change.text — one blank-line separator', async () => {
    root = tmpDir();
    const env = makeEnv(root);
    mkdirSync(env.home, { recursive: true });
    mkdirSync(env.cwd, { recursive: true });
    // Pre-existing content (trailing newline as a normal file would have)
    writeFileSync(join(env.home, 'AFK.md'), 'existing content\n', 'utf8');

    await appendOperator.apply(
      { kind: 'append', target: 'user-afk-md', text: '\n\nRule' },
      env,
      FAKE_CTX,
    );

    const result = readFileSync(join(env.home, 'AFK.md'), 'utf8');
    // Exactly one blank line (two newlines) between existing content and appended text
    expect(result).toBe('existing content\n\nRule\n');
    // No extra leading blank lines in the appended portion
    expect(result).not.toMatch(/existing content\n{3,}/);
  });

  it('appends trailing-newline change.text without accumulating trailing blank lines', async () => {
    root = tmpDir();
    const env = makeEnv(root);
    mkdirSync(env.home, { recursive: true });
    mkdirSync(env.cwd, { recursive: true });
    writeFileSync(join(env.home, 'AFK.md'), 'existing content\n', 'utf8');

    await appendOperator.apply(
      { kind: 'append', target: 'user-afk-md', text: 'Rule\n\n' },
      env,
      FAKE_CTX,
    );

    const result = readFileSync(join(env.home, 'AFK.md'), 'utf8');
    // Trailing newlines in change.text should be stripped; final file ends with exactly one '\n'
    expect(result).toBe('existing content\n\nRule\n');
    expect(result).not.toMatch(/\n{3,}$/);
  });
});

// ---------------------------------------------------------------------------
// appendOperator.touchesProject smoke test
// ---------------------------------------------------------------------------

describe('appendOperator: touchesProject', () => {
  it('returns true for project-afk-md target', () => {
    expect(
      appendOperator.touchesProject({ kind: 'append', target: 'project-afk-md', text: 'x' }),
    ).toBe(true);
  });

  it('returns false for user-afk-md target', () => {
    expect(
      appendOperator.touchesProject({ kind: 'append', target: 'user-afk-md', text: 'x' }),
    ).toBe(false);
  });
});
