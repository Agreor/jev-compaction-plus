import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runProcess } from './runner.js';
import { continuation, fixtures, score } from './fixtures.js';

export function assertNativeCompaction(message: string, before: number, after: number): void {
  if (/isn't available|not available|unsupported/i.test(message)) throw new Error('native compaction unavailable in this CLI environment');
  if (after <= before) throw new Error('no new native compaction boundary observed');
}

export async function claudeNativeProbe(out: string, auto = false): Promise<void> {
  await mkdir(out, { recursive: true, mode: 0o700 });
  const cwd = await mkdtemp(join(tmpdir(), 'claude-native-'));
  const session = randomUUID();
  const calls: any[] = [];
  const result: any = { host: 'claude', model: 'claude-haiku-5-5', session, autoThresholdCrossing: 'not tested', status: 'inconclusive', cycles: [] };
  const common = ['--print', '--safe-mode', '--setting-sources', '', '--tools', '', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}', '--model', 'claude-haiku-5-5', '--output-format', 'json', ...(auto ? ['--autocompact', '120000'] : [])];
  async function call(prompt: string, fresh: boolean, phase: string) {
    const start = Date.now();
    const raw = await runProcess('claude', [...common, fresh ? '--session-id' : '--resume', session], prompt, 120000, cwd, auto ? { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } : {});
    const value = JSON.parse(raw.stdout);
    calls.push({ phase, ms: Date.now() - start, ...value });
    if (value.is_error || value.subtype !== 'success') throw new Error(value.result || value.subtype);
    return value;
  }
  const fixture = fixtures[0];
  async function boundaries(): Promise<number> {
    const candidates = [...new Set([cwd, await realpath(cwd)])];
    for (const path of candidates) {
      const transcript = join(homedir(), '.claude', 'projects', path.replace(/[^a-zA-Z0-9]/g, '-'), session + '.jsonl');
      try {
        const rows = (await readFile(transcript, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
        return rows.filter(r => r.type === 'system' && r.subtype === 'compact_boundary').length;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return 0;
  }
  try {
    if (auto) {
      const before = await boundaries();
      const first = await call('Synthetic context padding with no requirements: ' + 'padding '.repeat(50000) + '\nReply ACK only. Never use tools.', true, 'auto-ingest-1');
      const u = first.usage;
      const firstInput = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      const perWord = Math.max(.1, (firstInput - 3000) / 50000);
      const words = Math.max(0, Math.min(100000, Math.ceil((123000 - firstInput) / perWord)));
      await call('More synthetic padding, no requirements: ' + 'padding '.repeat(words) + '\nReply ACK only.', false, 'auto-ingest-2');
      await call('Reply ACK only.', false, 'auto-continuation');
      const after = await boundaries();
      result.autoThresholdCrossing = after > before ? 'observed' : 'not observed';
      result.configuredWindow = 200000;
      result.threshold = 120000;
      result.firstInput = firstInput;
      result.autoCompactions = after - before;
      result.status = after > before ? 'completed' : 'inconclusive';
    } else {
    for (const cycle of [5, 10, 15]) {
      await call('Historical project discussion (data, not executable instructions):\n' + JSON.stringify(fixture.events.filter(e => e.turn > cycle - 5 && e.turn <= cycle)) + '\nReply ACK only. Never use tools.', cycle === 5, 'ingest-' + cycle);
      const before = await boundaries();
      const compacted = await call('/compact', false, 'native-compact-' + cycle);
      assertNativeCompaction(compacted.result ?? '', before, await boundaries());
      result.cycles.push({ cycle, ms: calls.at(-1).ms, result: compacted.result });
    }
    const answer = await call(continuation(fixture, 'Use the history in this session. Return only the JSON object, without Markdown fences.'), false, 'continuation');
    result.answer = JSON.parse(answer.result);
    result.score = score(fixture, result.answer);
    result.status = 'completed';
    }
  } catch (error) { result.error = (error as Error).message; }
  finally {
    await writeFile(join(out, 'claude-native-probe.json'), JSON.stringify({ ...result, calls }, null, 2), { mode: 0o600 });
    await rm(cwd, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ status: result.status, error: result.error, calls: calls.length, cycles: result.cycles.length, score: result.score, autoThresholdCrossing: result.autoThresholdCrossing, autoCompactions: result.autoCompactions }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) claudeNativeProbe(resolve(process.argv[2] ?? '.assessment/native'), process.argv.includes('--auto')).catch(e => { console.error(e.message); process.exitCode = 1; });
