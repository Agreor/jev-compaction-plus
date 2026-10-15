import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpoint, inspect, render, due, withLock } from '../src/assessment/record.js';

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

it('retains successful catch-up batches when a later batch has invalid source references', async () => {
  const dir = await root();
  const events = [
    { id: 'u1', role: 'user', text: 'Use SQLite. ' + 'x'.repeat(20000), turn: 1 },
    { id: 'u2', role: 'user', text: 'No network. ' + 'y'.repeat(20000), turn: 2 },
  ];
  let calls = 0;
  await expect(checkpoint(dir, key, events, async (_state, delta) => {
    calls++;
    if (delta[0].id === 'u1' && delta.length === 1) return [entry];
    return [{ ...entry, id: 'bad', sourceIds: ['invented-source'] }];
  }, true)).rejects.toThrow('unknown source');
  const saved = await inspect(dir, key);
  expect(calls).toBe(2);
  expect(saved.coveredEvents).toBe(1);
  expect(saved.entries).toHaveLength(1);
  expect(saved.events).toHaveLength(2);
  const rejected = JSON.parse(await readFile(join(saved.directory, 'rejected.json'), 'utf8'));
  expect(rejected.coveredEvents).toBe(1);
  expect(rejected.entries[0].id).toBe('bad');
});

it('bounds catch-up calls and resumes without skipping oversized events', async () => {
  const dir = await root();
  const events = Array.from({ length: 3 }, (_, i) => ({
    id: `u${i + 1}`, role: 'user', text: 'x'.repeat(40000), turn: i + 1,
  }));
  const seen: string[] = [];
  const extract = async (_state: unknown, delta: typeof events) => {
    expect(delta).toHaveLength(1);
    expect(delta[0].text).toHaveLength(40000);
    seen.push(delta[0].id);
    return [{ ...entry, id: `entry-${delta[0].id}`, sourceIds: [delta[0].id] }];
  };
  const partial = await checkpoint(dir, key, events, extract, true);
  expect(partial.coveredEvents).toBe(2);
  expect(render(partial)).toContain('UNCOVERED');
  const complete = await checkpoint(dir, key, events, extract, true);
  expect(complete.coveredEvents).toBe(3);
  expect(seen).toEqual(['u1', 'u2', 'u3']);
});

describe('lock and extraction claim', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, role: 'user', text: 'Use SQLite', turn: i + 1 }));
  it('archives new events while another process is extracting', async () => {
    const dir = await root();
    let release!: () => void;
    let calls = 0;
    const slow = checkpoint(dir, key, many.slice(0, 5), async () => { if (!calls++) await new Promise<void>(r => { release = r; }); return []; }, true);
    while (!release) await new Promise(r => setTimeout(r, 5));
    const quick = await checkpoint(dir, key, many, async () => { throw new Error('claim is held; must not extract'); }, true);
    expect(quick.events).toHaveLength(6);
    release(); await slow;
    const saved = await inspect(dir, key);
    expect(saved.events).toHaveLength(6);
    // The holder's second batch covers the event archived while it was extracting.
    expect(saved.coveredEvents).toBe(6);
    expect(calls).toBe(2);
  });
  it('takes over a claim whose process is gone and a lock left by a crash', async () => {
    const dir = await root();
    const state = await checkpoint(dir, key, [first], async () => [], false);
    await writeFile(join(state.directory, 'extracting.json'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    await mkdir(join(state.directory, 'lock'));
    await utimes(join(state.directory, 'lock'), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    const done = await checkpoint(dir, key, [first], async () => [entry], true);
    expect(done.entries).toHaveLength(1);
    await expect(readFile(join(state.directory, 'extracting.json'))).rejects.toThrow();
  });
  // The two-remover race needs separate processes to interleave; this checks clearing and one holder at a time.
  it('clears a stale lock and keeps one holder at a time', async () => {
    const dir = await root();
    await mkdir(join(dir, 'lock'));
    await utimes(join(dir, 'lock'), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    let inside = 0, most = 0;
    await Promise.all(Array.from({ length: 8 }, () => withLock(dir, async () => {
      most = Math.max(most, ++inside); await new Promise(r => setTimeout(r, 20)); inside--;
    })));
    expect(most).toBe(1);
    expect((await readdir(dir)).filter(f => f.startsWith('lock'))).toEqual([]);
  });
});
