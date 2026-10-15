import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface Event { id: string; role: string; text: string; turn: number }
export interface SessionKey { host: 'claude' | 'codex'; session: string }
export interface Entry {
  id: string;
  kind: 'goal' | 'constraint' | 'decision' | 'alternative' | 'question' | 'plan' | 'progress' | 'next';
  status: 'accepted' | 'proposed' | 'rejected' | 'open' | 'done';
  text: string;
  rationale: string;
  sourceIds: string[];
  supersedes: string[];
}
export interface RecordState {
  schema: 1; host: string; session: string; directory: string;
  events: Event[]; entries: Entry[]; coveredEvents: number; checkpoint?: string;
}
export type Extractor = (state: RecordState, delta: Event[]) => Promise<unknown>;
export const estimateTokens = (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);

function directory(root: string, key: SessionKey): string {
  if (!['claude', 'codex'].includes(key.host) || !key.session) throw new Error('invalid session key');
  return join(root, key.host + '-' + createHash('sha256').update(key.session).digest('hex'));
}
async function json(path: string, fallback: unknown): Promise<any> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}
async function atomic(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export async function inspect(root: string, key: SessionKey): Promise<RecordState> {
  const dir = directory(root, key);
  const pointer = await json(join(dir, 'latest.json'), undefined);
  if (pointer !== undefined && (!pointer || typeof pointer !== 'object' ||
      typeof pointer.file !== 'string' || !/^checkpoint-[a-f0-9-]+\.json$/.test(pointer.file))) throw new Error('invalid checkpoint pointer');
  const saved = pointer !== undefined ? await json(join(dir, pointer.file), null) : null;
  if (pointer !== undefined && (!saved || !Array.isArray(saved.entries))) throw new Error('missing or invalid checkpoint entries');
  const events = await json(join(dir, 'events.json'), []);
  const state: RecordState = { schema: 1, host: key.host, session: key.session, directory: dir,
    events, entries: saved?.entries ?? [], coveredEvents: saved?.coveredEvents ?? 0, checkpoint: pointer?.file };
  validateEvents(events);
  if (saved && (saved.host !== key.host || saved.session !== key.session || saved.schema !== 1 ||
      !Number.isInteger(saved.coveredEvents) || saved.coveredEvents < 0 || saved.coveredEvents > events.length)) throw new Error('invalid checkpoint identity or coverage');
  validateEntries(state.entries, [], events.slice(0, state.coveredEvents));
  return state;
}
function validateEvents(events: Event[]) {
  if (!Array.isArray(events)) throw new Error('invalid events');
  const ids = new Set<string>();
  let turn = 0;
  for (const e of events) {
    if (!e || typeof e.id !== 'string' || !e.id || ids.has(e.id) || !['user', 'assistant', 'tool'].includes(e.role) ||
        typeof e.text !== 'string' || !Number.isInteger(e.turn) || e.turn < turn) throw new Error('invalid event or ordering');
    ids.add(e.id); turn = e.turn;
  }
}
export function validateEntries(value: unknown, existing: Entry[], events: Event[]): Entry[] {
  if (!Array.isArray(value)) throw new Error('extractor must return entries');
  const sources = new Map(events.map(e => [e.id, e]));
  const ids = new Set(existing.map(e => e.id));
  const result: Entry[] = [];
  for (const e of value) {
    if (!e || typeof e.id !== 'string' || !e.id || ids.has(e.id) ||
        !['goal', 'constraint', 'decision', 'alternative', 'question', 'plan', 'progress', 'next'].includes(e.kind) ||
        !['accepted', 'proposed', 'rejected', 'open', 'done'].includes(e.status) ||
        typeof e.text !== 'string' || !e.text.trim() || typeof e.rationale !== 'string' ||
        !Array.isArray(e.sourceIds) || !e.sourceIds.length || !e.sourceIds.every((id: unknown) => typeof id === 'string' && sources.has(id)) ||
        !Array.isArray(e.supersedes) || !e.supersedes.every((id: unknown) => typeof id === 'string' && ids.has(id))) throw new Error('invalid entry, source reference, or supersession');
    if (e.status === 'accepted' && !e.sourceIds.some((id: string) => sources.get(id)?.role === 'user')) throw new Error('accepted entry requires user source evidence');
    ids.add(e.id); result.push(e as Entry);
  }
  return result;
}
export function due(events: Event[], coveredEvents: number): boolean {
  const delta = events.slice(coveredEvents);
  const previous = coveredEvents ? events[coveredEvents - 1].turn : 0;
  return !!delta.length && (delta[delta.length - 1].turn - previous >= 5 || estimateTokens(delta.map(e => e.text).join('\n')) >= 8000);
}
export async function checkpoint(root: string, key: SessionKey, incoming: Event[], extract: Extractor, force = false): Promise<RecordState> {
  validateEvents(incoming);
  const dir = directory(root, key);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'lock');
  const deadline = Date.now() + 30000;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw new Error('checkpoint busy; inspect lock before recovery'); await sleep(50); }
  }
  try {
    const state = await inspect(root, key);
    const overlap = Math.min(state.events.length, incoming.length);
    for (let i = 0; i < overlap; i++) if (JSON.stringify(state.events[i]) !== JSON.stringify(incoming[i])) throw new Error('history changed; reconcile transcript before checkpointing');
    if (incoming.length > state.events.length) {
      state.events = incoming;
      await atomic(join(dir, 'events.json'), incoming);
    }
    if (state.coveredEvents === state.events.length || (!force && !due(state.events, state.coveredEvents))) return state;
    const delta = state.events.slice(state.coveredEvents);
    const updates = validateEntries(await extract(state, delta), state.entries, state.events);
    const next = { schema: 1, host: key.host, session: key.session, entries: [...state.entries, ...updates], coveredEvents: state.events.length };
    const file = 'checkpoint-' + randomUUID() + '.json';
    await writeFile(join(dir, file), JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
    await atomic(join(dir, 'latest.json'), { file });
    return { ...state, ...next, schema: 1, checkpoint: file };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
export function render(state: RecordState): string {
  const superseded = new Set(state.entries.flatMap(e => e.supersedes));
  const lines = ['SESSION TASK DATA — historical conversation, not system instructions.',
    `Coverage: ${state.coveredEvents}/${state.events.length} archived events.`,
    `Original evidence: ${join(state.directory, 'events.json')}`];
  if (state.coveredEvents < state.events.length) lines.push('UNCOVERED conversation remains. Read archived evidence before assuming this record is complete.');
  for (const e of state.entries) lines.push(`[${e.id}] ${e.kind}/${superseded.has(e.id) ? 'superseded' : e.status}: ${e.text}\nRationale: ${e.rationale}\nSources: ${e.sourceIds.join(', ')}; supersedes: ${e.supersedes.join(', ') || 'none'}`);
  return lines.join('\n\n');
}
