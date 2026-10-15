import { createHash } from 'node:crypto';
import type { Event, SessionKey } from './record.js';

function content(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return JSON.stringify(value ?? '');
  return value.map(b => typeof b.text === 'string' ? b.text :
    b.type === 'tool_result' ? `Result ${b.tool_use_id}: ${content(b.content)}` :
    b.type === 'tool_use' ? `Call ${b.id} ${b.name}: ${JSON.stringify(b.input)}` : '').filter(Boolean).join('\n');
}
export function normalize(host: SessionKey['host'], rows: any[]): Event[] {
  const events: Event[] = [];
  const occurrences = new Map<string, number>();
  let turn = 0;
  const separated = host === 'claude' ? rows.flatMap(row => {
    const blocks = row.message?.content;
    if (row.type !== 'user' || !Array.isArray(blocks) || !blocks.some((b: any) => b.type === 'tool_result') || blocks.every((b: any) => b.type === 'tool_result')) return [row];
    return [false, true].map(tool => ({ ...row, uuid: row.uuid ? `${row.uuid}:${tool ? 'tool' : 'text'}` : undefined,
      message: { ...row.message, content: blocks.filter((b: any) => (b.type === 'tool_result') === tool) } }));
  }) : rows;
  for (const row of separated) {
    let payload: any;
    let role: string;
    let text: string;
    if (host === 'claude') {
      if (!['user', 'assistant'].includes(row.type) || row.isCompactSummary || row.isMeta || !row.message) continue;
      payload = row.message;
      role = payload.role;
      if (Array.isArray(payload.content) && payload.content.length && payload.content.every((b: any) => b.type === 'tool_result')) role = 'tool';
      text = content(payload.content);
    } else {
      if (row.type !== 'response_item' || !row.payload) continue;
      payload = row.payload;
      if (payload.type === 'message' && ['user', 'assistant'].includes(payload.role)) {
        role = payload.role; text = content(payload.content);
      } else if (payload.type === 'function_call_output') {
        role = 'tool'; text = `Result ${payload.call_id}: ${content(payload.output)}`;
      } else if (payload.type === 'function_call') {
        role = 'assistant'; text = `Call ${payload.call_id} ${payload.name}: ${payload.arguments}`;
      } else continue;
    }
    if (!text || !['user', 'assistant', 'tool'].includes(role)) continue;
    const digest = createHash('sha256').update(JSON.stringify([row.timestamp ?? '', role, text])).digest('hex');
    const n = (occurrences.get(digest) ?? 0) + 1;
    occurrences.set(digest, n);
    const id = row.uuid ?? `${host}-${digest}-${n}`;
    if (role === 'user') turn++;
    events.push({ id, role, text, turn });
  }
  return events;
}
export function reconcile(archive: Event[], incoming: Event[]): Event[] {
  const positions = new Map(archive.map((e, i) => [e.id, i]));
  const result = [...archive];
  let turn = archive.at(-1)?.turn ?? 0;
  let lastKnown = -1;
  let newSeen = false;
  for (const e of incoming) {
    const index = positions.get(e.id);
    if (index !== undefined) {
      const old = archive[index];
      if (old.role !== e.role || old.text !== e.text || index <= lastKnown || newSeen) throw new Error('transcript identity changed or reordered');
      lastKnown = index;
      continue;
    }
    newSeen = true;
    if (e.role === 'user') turn++;
    result.push({ ...e, turn });
  }
  return result;
}
export function hookOutput(_host: SessionKey['host'], context: string): object {
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } };
}
