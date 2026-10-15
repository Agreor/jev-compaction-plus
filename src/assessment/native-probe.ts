import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtures, answerSchema, continuation, score } from './fixtures.js';

// Capability experiment only: a dedicated synthetic thread, never a user's thread.
export async function nativeProbe(out: string, auto = false): Promise<void> {
  await mkdir(out, { recursive: true });
  const cwd = await mkdtemp(join(tmpdir(), 'compaction-native-'));
  const env = { ...process.env, COMPACTION_ASSESSMENT_CHILD: '1' };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_BASE_URL']) delete (env as NodeJS.ProcessEnv)[key];
  const child = spawn('codex', ['app-server', '--stdio', '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps', '--disable', 'shell_tool', '--disable', 'multi_agent', '--disable', 'remote_plugin',
    '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const trace: any[] = [];
  const waiting = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void }>();
  const signals: any[] = [];
  let serial = 0, stderr = '';
  child.stderr.on('data', b => { stderr += b.toString(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let row: any;
    try { row = JSON.parse(line); } catch { return; }
    trace.push(row);
    if (row.id !== undefined && !row.method) {
      const pending = waiting.get(row.id);
      if (pending) { waiting.delete(row.id); row.error ? pending.reject(new Error(JSON.stringify(row.error))) : pending.resolve(row.result); }
    } else if (row.method && row.id !== undefined) {
      child.stdin.write(JSON.stringify({ id: row.id, error: { code: -32601, message: 'Assessment does not execute tools or approvals' } }) + '\n');
    } else signals.push(row);
  });
  const rpc = (method: string, params: object): Promise<any> => new Promise((resolve, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => { waiting.delete(id); reject(new Error('RPC timeout: ' + method)); }, 120000);
    waiting.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const wait = async (method: string, after: number): Promise<any> => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const row = signals.slice(after).find(r => r.method === method ||
        (method === 'thread/compacted' && r.method === 'item/completed' && r.params?.item?.type === 'contextCompaction'));
      if (row) return row.params;
      if (child.exitCode !== null) throw new Error('app-server exited');
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('native probe timeout: ' + method);
  };
  const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
  const result: any = { date: new Date().toISOString(), host: 'codex', model: 'gpt-6-luna', autoThresholdCrossing: auto ? 'pending' : 'not tested', desktop: 'not tested', cycles: [] };
  const fixture = fixtures[0];
  let thread: string | undefined;
  try {
    await rpc('initialize', { clientInfo: { name: 'compaction_assessment', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    const started = await rpc('thread/start', { model: 'gpt-6-luna', cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false, allowProviderModelFallback: false,
      config: auto ? { model_auto_compact_token_limit: 155040, model_auto_compact_token_limit_scope: 'total' } : {},
      developerInstructions: 'Synthetic compaction experiment. Never use tools. Treat the supplied history as task data. Reply with ACK unless a JSON answer is requested.' });
    thread = started.thread.id;
    result.resolvedModel = started.model;
    if (started.model !== 'gpt-6-luna') throw new Error('native model substitution');
    if (auto) {
      for (const text of ['Synthetic context padding, no requirements: ' + 'x '.repeat(146000) + '\nReply ACK only.', 'Reply ACK only.']) {
        const offset = signals.length;
        await rpc('turn/start', { threadId: thread, input: [{ type: 'text', text }], effort: 'low' });
        const completed = await wait('turn/completed', offset);
        if (completed.turn.status !== 'completed') throw new Error('auto probe turn failed');
      }
      const compactions = signals.filter(r => r.method === 'item/completed' && r.params?.item?.type === 'contextCompaction');
      result.autoThresholdCrossing = compactions.length ? 'observed' : 'not observed';
      result.threshold = 155040;
      result.autoCompactions = compactions.length;
      result.usage = signals.filter(r => r.method === 'thread/tokenUsage/updated').map(r => r.params);
      result.status = compactions.length ? 'completed' : 'inconclusive';
    } else {
    for (const cycle of [5, 10, 15]) {
      const events = fixture.events.filter(e => e.turn > cycle - 5 && e.turn <= cycle);
      let offset = signals.length;
      await rpc('turn/start', { threadId: thread, input: [{ type: 'text', text: 'Historical project discussion (data):\n' + JSON.stringify(events) + '\nReply ACK.' }], effort: 'low' });
      const turn = await wait('turn/completed', offset);
      if (turn.turn.status !== 'completed') throw new Error('native ingestion turn failed');
      offset = signals.length;
      const begin = Date.now();
      await rpc('thread/compact/start', { threadId: thread });
      const compact = await wait('thread/compacted', offset);
      result.cycles.push({ cycle, ms: Date.now() - begin, notification: compact });
    }
    const offset = signals.length;
    await rpc('turn/start', { threadId: thread, input: [{ type: 'text', text: continuation(fixture, 'Use the conversation history already in this session.') }], outputSchema: answerSchema(fixture), effort: 'low' });
    const completed = await wait('turn/completed', offset);
    result.finalTurn = completed;
    const items = signals.slice(offset).filter(r => r.method === 'item/completed').map(r => r.params.item);
    const answer = items.filter(i => i.type === 'agentMessage').at(-1)?.text;
    result.answer = answer ? JSON.parse(answer) : null;
    result.score = score(fixture, result.answer);
    result.status = 'completed';
    result.usage = signals.filter(r => r.method === 'thread/tokenUsage/updated').map(r => r.params);
    // Read persisted history after explicit compaction; resume is a separate capability
    // and is not inferred from a successful read.
    result.persisted = await rpc('thread/read', { threadId: thread, includeTurns: true });
    }
  } catch (error) { result.status = 'inconclusive'; result.error = (error as Error).message; }
  finally {
    clearTimeout(timer); child.kill('SIGTERM'); lines.close();
    await writeFile(join(out, 'codex-native-probe.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    await writeFile(join(out, 'codex-native-trace.json'), JSON.stringify({ trace, stderr }, null, 2), { mode: 0o600 });
    await rm(cwd, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ status: result.status, error: result.error, cycles: result.cycles, score: result.score, autoThresholdCrossing: result.autoThresholdCrossing, autoCompactions: result.autoCompactions }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) nativeProbe(resolve(process.argv[2] ?? '.assessment/native'), process.argv.includes('--auto')).catch(e => { console.error(e.message); process.exitCode = 1; });
