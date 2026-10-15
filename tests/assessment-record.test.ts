import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpoint, inspect, render, due } from '../src/assessment/record.js';

const roots: string[] = [];
async function root() { const p = await mkdtemp(join(tmpdir(), 'compaction-test-')); roots.push(p); return p; }
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const first = { id: 'u1', role: 'user', text: 'Use SQLite. No network access.', turn: 1 };
const entry = { id: 'd1', kind: 'decision', status: 'accepted', text: 'Use SQLite', rationale: 'Local operation', sourceIds: ['u1'], supersedes: [] };
const key = { host: 'codex', session: 'session-a' };

describe('durable preservation', () => {
  it('rejects missing checkpoint entries instead of restoring an empty complete record', async () => {
    const dir = await root();
    const state = await checkpoint(dir, key, [first], async () => [entry], true);
    const path = join(state.directory, state.checkpoint!);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    delete saved.entries;
    await writeFile(path, JSON.stringify(saved));
    await expect(inspect(dir, key)).rejects.toThrow('checkpoint');
  });
  it('rejects a null pointer instead of silently resetting prior decisions', async () => {
    const dir = await root();
    const state = await checkpoint(dir, key, [first], async () => [entry], true);
    await writeFile(join(state.directory, 'latest.json'), 'null');
    await expect(inspect(dir, key)).rejects.toThrow('pointer');
  });
  it('restores decisions on reopen and retains superseded decisions with original evidence', async () => {
    const dir = await root();
    const a = await checkpoint(dir, key, [first], async () => [entry], true);
    const b = await checkpoint(dir, key, [first, { id: 'u2', role: 'user', text: 'Change to Postgres.', turn: 2 }], async () => [{ ...entry, id: 'd2', text: 'Use Postgres', sourceIds: ['u2'], supersedes: ['d1'] }], true);
    expect(a.entries).toHaveLength(1);
    expect(b.entries).toHaveLength(2);
    const reopened = await inspect(dir, key);
    expect(reopened.coveredEvents).toBe(2);
    expect(render(reopened)).toContain('Use Postgres');
    expect(render(reopened)).toContain('superseded');
    expect(render(reopened)).toContain('u1');
    expect((await readdir(reopened.directory)).filter((p: string) => p.startsWith('checkpoint-'))).toHaveLength(2);
  });
  it('retains the last good checkpoint and archives new events on model failure', async () => {
    const dir = await root();
    await checkpoint(dir, key, [first], async () => [entry], true);
    await expect(checkpoint(dir, key, [first, { ...first, id: 'u2', turn: 2 }], async () => { throw new Error('offline'); }, true)).rejects.toThrow('offline');
    const state = await inspect(dir, key);
    expect(state.coveredEvents).toBe(1);
    expect(state.events).toHaveLength(2);
    expect(render(state)).toContain('UNCOVERED');
  });
  it('rejects invalid references, source-free agreement, and changed history without publishing', async () => {
    const dir = await root();
    await checkpoint(dir, key, [first], async () => [entry], true);
    await expect(checkpoint(dir, key, [first, { ...first, id: 'u2', turn: 2 }], async () => [{ ...entry, id: 'd2', sourceIds: ['missing'] }], true)).rejects.toThrow('source');
    await expect(checkpoint(dir, key, [{ ...first, text: 'changed' }], async () => [], true)).rejects.toThrow('history');
    expect((await inspect(dir, key)).entries).toHaveLength(1);
  });
  it('isolates session names including path-like identifiers', async () => {
    const dir = await root();
    await checkpoint(dir, { ...key, session: '../a' }, [first], async () => [entry], true);
    expect((await inspect(dir, { ...key, session: 'a' })).entries).toEqual([]);
    expect((await inspect(dir, { ...key, session: '../a' })).directory.startsWith(dir + '/')).toBe(true);
  });
  it('serializes concurrent checkpoints and avoids repeating an already covered delta', async () => {
    const dir = await root();
    let calls = 0;
    const extract = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return [entry]; };
    await Promise.all([checkpoint(dir, key, [first], extract, true), checkpoint(dir, key, [first], extract, true)]);
    expect((await inspect(dir, key)).entries).toHaveLength(1);
    expect(calls).toBe(1);
  });
  it('does not checkpoint short discussions but does at five turns or the byte-estimated token limit', () => {
    expect(due([{ ...first, turn: 4 }], 0)).toBe(false);
    expect(due([{ ...first, turn: 5 }], 0)).toBe(true);
    expect(due([{ ...first, text: 'x'.repeat(32000) }], 0)).toBe(true);
  });
});
