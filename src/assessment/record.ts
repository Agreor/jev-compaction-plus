import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
    if (!e || typeof e.id !== 'string' || !e.id ||
        !['goal', 'constraint', 'decision', 'alternative', 'question', 'plan', 'progress', 'next'].includes(e.kind) ||
        !['accepted', 'proposed', 'rejected', 'open', 'done'].includes(e.status) ||
        typeof e.text !== 'string' || !e.text.trim() || typeof e.rationale !== 'string' ||
        !Array.isArray(e.sourceIds) || !e.sourceIds.length || !e.sourceIds.every((id: unknown) => typeof id === 'string') ||
        !Array.isArray(e.supersedes) || !e.supersedes.every((id: unknown) => typeof id === 'string')) throw new Error('invalid entry shape');
    if (ids.has(e.id)) throw new Error('duplicate entry ID');
    if (!e.sourceIds.every((id: string) => sources.has(id))) throw new Error('unknown source reference');
    if (!e.supersedes.every((id: string) => ids.has(id))) throw new Error('unknown supersession reference');
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
// The file lock covers only reads and writes, so a lock older than this belongs to a crashed process.
const STALE_LOCK_MS = 60_000;
// Longer than any live extraction (two batches of Jev plus a 140s model call).
const STALE_CLAIM_MS = 600_000;
async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(dir, 'lock');
  const deadline = Date.now() + 30000;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const age = await stat(lock).then(s => Date.now() - s.mtimeMs, () => 0);
      if (age > STALE_LOCK_MS) { await rm(lock, { recursive: true, force: true }); continue; }
      if (Date.now() >= deadline) throw new Error('checkpoint busy; inspect lock before recovery');
      await sleep(50);
    }
  }
  try { return await fn(); } finally { await rm(lock, { recursive: true, force: true }); }
}
const alive = (pid: unknown) => {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid as number, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};
/** Claims the model call for this session; false while another live process holds it. */
async function claim(file: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await writeFile(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600, flag: 'wx' }); return true; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = await json(file, null).catch(() => null);
      if (held && Date.now() - held.at < STALE_CLAIM_MS && alive(held.pid)) return false;
      await rm(file, { force: true });
    }
  }
  return false;
}
async function release(file: string) {
  const held = await json(file, null).catch(() => null);
  if (held?.pid === process.pid) await rm(file, { force: true });
}
async function archive(root: string, key: SessionKey, dir: string, incoming: Event[]): Promise<RecordState> {
  const state = await inspect(root, key);
  const overlap = Math.min(state.events.length, incoming.length);
  for (let i = 0; i < overlap; i++) if (JSON.stringify(state.events[i]) !== JSON.stringify(incoming[i])) throw new Error('history changed; reconcile transcript before checkpointing');
  if (incoming.length > state.events.length) {
    state.events = incoming;
    await atomic(join(dir, 'events.json'), incoming);
  }
  return state;
}
export async function checkpoint(root: string, key: SessionKey, incoming: Event[], extract: Extractor, force = false, maxBatches = 2): Promise<RecordState> {
  validateEvents(incoming);
  const dir = directory(root, key);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let state = await withLock(dir, () => archive(root, key, dir, incoming));
  if (state.coveredEvents === state.events.length || (!force && !due(state.events, state.coveredEvents))) return state;
  // Model calls run outside the file lock, so PreCompact still archives while a Stop worker extracts.
  // A process that finds the claim held returns: the holder covers this delta, and the rest stays UNCOVERED.
  const claimFile = join(dir, 'extracting.json');
  if (!(await claim(claimFile))) return state;
  try {
    // Bound each invocation's model calls; later hooks continue from the saved prefix.
    for (let batch = 0; batch < maxBatches && state.coveredEvents < state.events.length; batch++) {
      const delta: Event[] = [];
      let tokens = 0;
      for (const event of state.events.slice(state.coveredEvents)) {
        const size = estimateTokens(JSON.stringify(event));
        if (delta.length && tokens + size > 8000) break;
        delta.push(event); tokens += size;
      }
      const raw = await extract(state, delta);
      const started = state.coveredEvents;
      const committed = await withLock(dir, async () => {
        const current = await inspect(root, key);
        // A process whose stale claim was taken over may have committed this delta first.
        if (current.coveredEvents !== started) return null;
        let updates: Entry[];
        const coveredEvents = started + delta.length;
        const suppliedIds = new Set([...current.entries.flatMap(e => e.sourceIds), ...delta.map(e => e.id)]);
        try { updates = validateEntries(raw, current.entries, current.events.filter(e => suppliedIds.has(e.id))); }
        catch (error) {
          await atomic(join(dir, 'rejected.json'), { coveredEvents: started,
            eventCount: delta.length, entries: raw, error: (error as Error).message });
          throw error;
        }
        const next = { schema: 1 as const, host: key.host, session: key.session,
          entries: [...current.entries, ...updates], coveredEvents };
        const file = 'checkpoint-' + randomUUID() + '.json';
        await writeFile(join(dir, file), JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
        await atomic(join(dir, 'latest.json'), { file });
        return { ...current, ...next, checkpoint: file };
      });
      if (!committed) return inspect(root, key);
      state = committed;
    }
    return state;
  } finally { await release(claimFile); }
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
