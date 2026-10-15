import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleHook } from '../src/assessment/cli.js';
import { inspect } from '../src/assessment/record.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it('archives a short session without calling a compactor, then forces a checkpoint and restores it on resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preservation-hook-')); roots.push(root);
  const transcript = join(root, 'transcript.jsonl');
  await writeFile(transcript, JSON.stringify({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'Use SQLite' } }) + '\n');
  const envelope = { session_id: 's1', hook_event_name: 'Stop', transcript_path: transcript };
  await handleHook(root, 'claude', envelope, async () => { throw new Error('should not call on short session'); });
  expect((await inspect(root, { host: 'claude', session: 's1' })).coveredEvents).toBe(0);
  await handleHook(root, 'claude', { ...envelope, hook_event_name: 'PreCompact' }, async () => [{ id: 'db', kind: 'decision', status: 'accepted', text: 'Use SQLite', rationale: '', sourceIds: ['u1'], supersedes: [] }]);
  const output = await handleHook(root, 'claude', { session_id: 's1', hook_event_name: 'SessionStart', source: 'resume' }, async () => { throw new Error('must not call model at resume'); });
  expect((output as any).hookSpecificOutput.additionalContext).toContain('Use SQLite');
  expect((output as any).hookSpecificOutput.additionalContext).toContain('Coverage: 1/1');
});
it('does not silently consume a partially written transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preservation-hook-')); roots.push(root);
  const transcript = join(root, 'transcript.jsonl');
  await writeFile(transcript, '{"type":"user"');
  await expect(handleHook(root, 'codex', { session_id: 's', hook_event_name: 'PreCompact', transcript_path: transcript }, async () => [])).rejects.toThrow();
  expect((await inspect(root, { host: 'codex', session: 's' })).entries).toHaveLength(0);
});
