import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtures, score } from '../src/assessment/fixtures.js';
import { evaluate } from '../src/assessment/evaluate.js';
it('scores a local database qualifier as equivalent without accepting wrong databases or cloud qualifiers', () => {
  const fixture = fixtures.find(f => f.id === 'reversed-decision')!;
  expect(score(fixture, { database: 'PostgreSQL (local)', oldDatabase: 'no', cloud: 'no' }).pass).toBe(true);
  expect(score(fixture, { database: 'SQLite (local)', oldDatabase: 'no', cloud: 'no' }).pass).toBe(false);
  expect(score(fixture, { database: 'PostgreSQL (cloud)', oldDatabase: 'no', cloud: 'no' }).pass).toBe(false);
  expect(score(fixture, { database: 'not PostgreSQL', oldDatabase: 'no', cloud: 'no' }).pass).toBe(false);
});
it('resumes twice without model calls or overwriting the original score snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assessment-resume-'));
  try {
    const outcomes = fixtures.flatMap(f => ['full-context-reference', 'claude-haiku-5-5', 'gpt-6-luna'].map(arm => ({ fixture: f.id, arm, pass: true })));
    outcomes.push({ fixture: fixtures[0].id, arm: 'claude-haiku-5-5', pass: true, repeat: true } as any);
    outcomes.push({ fixture: fixtures[0].id, arm: 'gpt-6-luna', pass: true, repeat: true } as any);
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ started: new Date().toISOString() }));
    // Exhausted budget makes any accidental model call fail before starting it.
    await writeFile(join(root, 'results.json'), JSON.stringify({ calls: 100, knownReportedTokens: 2000000, rows: [] }));
    await writeFile(join(root, 'outcomes.json'), JSON.stringify(outcomes));
    await evaluate(root, true, true);
    const original = await readFile(join(root, 'outcomes-before-rescore.json'), 'utf8');
    await evaluate(root, true);
    await evaluate(root, true);
    expect(await readFile(join(root, 'outcomes-before-rescore.json'), 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(join(root, 'results.json'), 'utf8')).calls).toBe(100);
  } finally { await rm(root, { recursive: true, force: true }); }
});
