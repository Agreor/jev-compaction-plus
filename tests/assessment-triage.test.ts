import { expect, it } from 'vitest';
import { triagedExtractor } from '../src/assessment/triage.js';
import type { JevQuestions } from '../src/types.js';

const state = { schema: 1 as const, host: 'claude' as const, session: 's', directory: '/tmp/s', coveredEvents: 0, events: [], entries: [] };
const delta = [
  { id: 'u1', role: 'user' as const, text: 'Use SQLite, not Postgres.', turn: 1 },
  { id: 't1', role: 'tool' as const, text: 'ls output', turn: 1 },
  { id: 'a1', role: 'assistant' as const, text: 'Reading the file now.', turn: 1 },
  { id: 'c1', role: 'assistant' as const, text: 'Call toolu_1 Bash: {"command":"ls"}', turn: 1 },
  { id: 'a2', role: 'assistant' as const, text: 'Decision: keep SQLite for the cache.', turn: 1 },
];
const jev = (noul: (instructions: string) => number) => ({ ask: async (_s: unknown, q: JevQuestions) =>
  ({ answers: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, { noul: noul(v.instructions) }])) }) });

it('always sends user messages, sends flagged assistant prose, and never sends tool results or tool calls', async () => {
  let sent: string[] = [];
  const asked: string[] = [];
  const extract = triagedExtractor(async (_s, d) => { sent = d.map(e => e.id); return []; },
    jev(i => { asked.push(i); return i.includes('Decision') ? 0.9 : 0.1; }));
  await extract(state, delta);
  expect(sent).toEqual(['u1', 'a2']);
  expect(asked).toHaveLength(2);
});

it('skips Haiku when there is no user message and no flagged prose', async () => {
  const extract = triagedExtractor(async () => { throw new Error('must not call Haiku'); }, jev(() => 0.05));
  expect(await extract(state, delta.filter(e => e.role !== 'user'))).toEqual([]);
});

it('falls back to the full delta when Jev fails', async () => {
  let sent = 0;
  const extract = triagedExtractor(async (_s, d) => { sent = d.length; return []; }, { ask: async () => { throw new Error('no key'); } });
  await extract(state, delta);
  expect(sent).toBe(5);
});
