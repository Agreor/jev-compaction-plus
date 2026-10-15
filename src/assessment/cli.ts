import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkpoint, inspect, render } from './record.js';
import type { Event, Extractor, SessionKey } from './record.js';
import { normalize, reconcile, hookOutput } from './adapters.js';
import { modelExtractor } from './runner.js';
import { triagedExtractor } from './triage.js';
import { JevClient } from '../client.js';
import type { Model } from './runner.js';

// A hung Jev call must fall back to Haiku well inside PreCompact's 180s host timeout.
const JEV_TIMEOUT_MS = 10_000;
const defaultRoot = join(homedir(), '.local', 'state', 'compaction-assessment');
async function stdin(): Promise<string> { let value = ''; for await (const b of process.stdin) value += b; return value; }
export async function handleHook(root: string, host: SessionKey['host'], envelope: any, extract: Extractor): Promise<object> {
  if (process.env.COMPACTION_ASSESSMENT_CHILD === '1') return {};
  if (!envelope || typeof envelope.session_id !== 'string') throw new Error('hook session_id required');
  const key = { host, session: envelope.session_id };
  if (envelope.hook_event_name === 'SessionStart') return hookOutput(host, render(await inspect(root, key)));
  if (!['Stop', 'PreCompact'].includes(envelope.hook_event_name)) throw new Error('unsupported assessment hook');
  if (envelope.agent_id || envelope.agentId) return {};
  if (typeof envelope.transcript_path !== 'string') throw new Error('hook transcript_path required');
  const raw = await readFile(envelope.transcript_path, 'utf8');
  // A partial JSONL record is a retryable failure, never permission to truncate evidence.
  const rows = raw.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const archived = await inspect(root, key);
  const events = reconcile(archived.events, normalize(host, rows));
  // PreCompact blocks the host under a 180s hook timeout, so it gets one model call.
  const precompact = envelope.hook_event_name === 'PreCompact';
  const state = await checkpoint(root, key, events, extract, precompact, precompact ? 1 : 2);
  const uncovered = state.events.length - state.coveredEvents;
  // Compaction proceeds either way; say so when recent turns are not in the record yet.
  if (precompact && uncovered > 0) return { systemMessage: `Compaction preservation: ${uncovered} recent events are not recorded yet (extraction still running or backlog); restore marks them UNCOVERED.` };
  return {};
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const rootIndex = args.indexOf('--root');
  let root = defaultRoot;
  if (rootIndex !== -1) { if (!args[rootIndex + 1]) throw new Error('--root requires path'); root = resolve(args[rootIndex + 1]); args = [...args.slice(0, rootIndex), ...args.slice(rootIndex + 2)]; }
  const [command, hostArg, session, file, modelArg] = args;
  if (command === 'threshold') {
    const window = Number(hostArg);
    if (!Number.isInteger(window) || window <= 0) throw new Error('threshold requires effective context token count');
    console.log(JSON.stringify({ effectiveWindow: window, targetPercent: 60, tokenThreshold: Math.floor(window * .6), note: 'Host safe-point scheduling may overshoot. Recalculate after model or window changes.' })); return;
  }
  if (!['claude', 'codex'].includes(hostArg)) throw new Error('Usage: assessment <checkpoint|render|status|hook> <claude|codex> ... [--root path]; threshold <effective-window>');
  const host = hostArg as SessionKey['host'];
  if (command === 'hook') {
    const model = session as Model;
    const input = await stdin();
    try {
      const envelope = JSON.parse(input);
      // Stop fires after every reply: checkpoint in a detached worker so the host never waits on the model.
      // Worker failures stay silent; their backlog is marked UNCOVERED at restore and PreCompact retries it.
      if (envelope?.hook_event_name === 'Stop' && !args.includes('--foreground')) {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2), '--foreground'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
        child.stdin.end(input); child.unref(); console.log('{}'); return;
      }
      const extract = process.env.TYPESAFE_API_KEY ? triagedExtractor(modelExtractor(model), new JevClient({ fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(JEV_TIMEOUT_MS) }) })) : modelExtractor(model);
      console.log(JSON.stringify(await handleHook(root, host, envelope, extract)));
    }
    catch (error) { console.log(JSON.stringify({ systemMessage: 'Compaction preservation incomplete: ' + (error as Error).message })); }
    return;
  }
  if (!session) throw new Error('session id required');
  const key = { host, session };
  if (command === 'render') { console.log(render(await inspect(root, key))); return; }
  if (command === 'status') {
    const state = await inspect(root, key);
    console.log(JSON.stringify({ directory: state.directory, archivedEvents: state.events.length, coveredEvents: state.coveredEvents, entries: state.entries.length, checkpoint: state.checkpoint ?? null, complete: state.coveredEvents === state.events.length })); return;
  }
  if (command !== 'checkpoint' || !file || !modelArg) throw new Error('checkpoint <host> <session> <events.json> <model> [--force]');
  const events: Event[] = JSON.parse(await readFile(file, 'utf8'));
  const state = await checkpoint(root, key, events, modelExtractor(modelArg as Model), args.includes('--force'));
  console.log(JSON.stringify({ coveredEvents: state.coveredEvents, archivedEvents: state.events.length, entries: state.entries.length, checkpoint: state.checkpoint ?? null }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
