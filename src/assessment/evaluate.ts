import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkpoint, estimateTokens, inspect, render } from './record.js';
import { extractionPrompt, runModel } from './runner.js';
import type { Model, ModelResult } from './runner.js';
import { fixtures, answerSchema, continuation, score } from './fixtures.js';

export async function evaluate(out: string, resume = false, rescore = false): Promise<void> {
  if (rescore && !resume) throw new Error('--rescore requires --resume');
  await mkdir(out, { recursive: true, mode: 0o700 });
  // An existing result is not overwritten; resume/restarts need an explicit new run.
  const manifest = { started: new Date().toISOString(), decision: 'Choose native-only vs incremental preservation, and Haiku vs Luna, based on decision retention, continuation correctness, total tokens and latency.',
    hypotheses: { native: 'No checkpoint overhead; may lose decisions.', sidecar: 'Better decision continuity; extra calls and restored-context cost.', haiku: 'Lower overhead; possible omission risk.', luna: 'Potential quality benefit; larger CLI overhead.' },
    limits: { calls: 100, reportedTokens: 2000000, runtimeMs: 3600000, perCallMs: 120000 },
    preflight: { calls: 4, knownTokens: 13968, unknownUsageCalls: 2 },
    workingModel: 'gpt-6-luna', compactors: ['claude-haiku-5-5', 'gpt-6-luna'],
    rubric: 'Exact predefined answers (case and whitespace normalized). Zero marked-decision losses. No retry on quality failure. Gold answers never enter extraction or continuation prompts.',
    efficiencyGate: 'At least 15% better tokens or elapsed time, other metric no more than 10% worse, against actual 60% native baseline only.',
    controls: ['full original context reference', 'short-session nonactivation', 'reversal', 'proposal vs approval', 'tool-data instruction look-alike', 'interruption/resume'],
    scopeLimit: 'Synthetic preservation/continuation evidence is not proof of native compaction performance or desktop compatibility. Native host measurements are recorded separately. No population-wide claim.',
  };
  let saved: any = null;
  let oldOutcomes: any[] = [];
  let start = Date.now();
  if (resume) {
    const original = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    start = Date.parse(original.started);
    saved = JSON.parse(await readFile(join(out, 'results.json'), 'utf8'));
    oldOutcomes = JSON.parse(await readFile(join(out, 'outcomes.json'), 'utf8'));
    if (rescore) {
      const artifacts = [
        ['outcomes-before-rescore.json', oldOutcomes],
        ['scoring-amendment.json', { reason: 'PostgreSQL (local) is the same database choice; location is separately scored. Allow only the unambiguous local suffix, reject cloud suffix and wrong database.', scope: 'All arms, saved outputs rescored without new model calls; original outcomes retained.', date: new Date().toISOString() }],
      ] as const;
      for (const [name, value] of artifacts) {
        try { await writeFile(join(out, name), JSON.stringify(value, null, 2), { flag: 'wx' }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      for (const row of oldOutcomes) {
        if (!row.rows) continue;
        const fixture = fixtures.find(f => f.id === row.fixture)!;
        const answers = Object.fromEntries(row.rows.map((r: any) => [r.key, r.actual]));
        Object.assign(row, score(fixture, answers));
      }
    }
  } else await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  let calls = saved?.calls ?? 4, tokens = saved?.knownReportedTokens ?? 13968;
  const rows: any[] = saved?.rows ?? [];
  async function save() { await writeFile(join(out, 'results.json'), JSON.stringify({ calls, knownReportedTokens: tokens, unknownUsageCalls: rows.filter(r => r.error).length + 2, elapsedMs: Date.now() - start, rows }, null, 2)); }
  async function call(model: Model, prompt: string, schema: object | undefined, label: object): Promise<ModelResult> {
    if (calls >= 100 || tokens + estimateTokens(prompt) + 16000 > 2000000 || Date.now() - start >= 3600000) throw new Error('assessment budget exhausted');
    calls++;
    const id = String(calls).padStart(3, '0');
    const began = Date.now();
    try {
      const result = await runModel(model, prompt, schema, Math.min(120000, 3600000 - (Date.now() - start)));
      tokens += (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
      const row = { id, ...label, model, resolvedModel: result.resolvedModel, ms: result.ms, inputTokens: result.inputTokens, outputTokens: result.outputTokens, cachedInputTokens: result.cachedInputTokens };
      rows.push(row);
      await writeFile(join(out, id + '.json'), JSON.stringify({ ...row, value: result.value, stdout: result.stdout, stderr: result.stderr }, null, 2), { mode: 0o600 });
      await save();
      console.log(JSON.stringify(row));
      return result;
    } catch (error) {
      const row = { id, ...label, model, ms: Date.now() - began, error: (error as Error).message };
      rows.push(row); await save(); console.log(JSON.stringify(row)); throw error;
    }
  }
  const outcomes: any[] = oldOutcomes;
  const stopped = new Set<Model>(outcomes.filter(o => !o.pass && manifest.compactors.includes(o.arm)).map(o => o.arm));
  // Same working model and same questions for every compactor. Full-context reference
  // is deliberately named a reference, never presented as built-in compaction.
  for (const fixture of fixtures) {
    if (!outcomes.some(o => o.fixture === fixture.id && o.arm === 'full-context-reference')) {
      const reference = await call('gpt-6-luna', continuation(fixture, JSON.stringify(fixture.events)), answerSchema(fixture), { fixture: fixture.id, phase: 'full-context-reference' });
      outcomes.push({ fixture: fixture.id, arm: 'full-context-reference', ...score(fixture, reference.value) });
    }
    for (const model of manifest.compactors as Model[]) {
      if (stopped.has(model) || outcomes.some(o => o.fixture === fixture.id && o.arm === model && !o.repeat)) continue;
      const key = { host: 'codex' as const, session: model + ':' + fixture.id };
      const stateRoot = join(out, 'sessions');
      try {
        for (const cycle of [5, 10, 15]) {
          const events = fixture.events.filter(e => e.turn <= cycle);
          if (fixture.id === 'interrupted-resume' && cycle === 10) {
            try { await checkpoint(stateRoot, key, events, async () => { throw new Error('injected interruption'); }, true); } catch {}
            const interrupted = await inspect(stateRoot, key);
            if (interrupted.coveredEvents !== fixture.events.filter(e => e.turn <= 5).length || interrupted.events.length !== events.length) throw new Error('interruption lost coverage/archive');
          }
          await checkpoint(stateRoot, key, events, async (state, delta) => {
            const result = await call(model, extractionPrompt(state, delta), undefined, { fixture: fixture.id, phase: 'checkpoint', cycle });
            return result.value.entries;
          }, true);
        }
        const reopened = await inspect(stateRoot, key);
        const context = render(reopened);
        await writeFile(join(out, fixture.id + '-' + model + '-restored.txt'), context, { mode: 0o600 });
        const result = await call('gpt-6-luna', continuation(fixture, context), answerSchema(fixture), { fixture: fixture.id, phase: 'preserved-continuation', compactor: model, restoredEstimatedTokens: estimateTokens(context) });
        const verdict = score(fixture, result.value);
        outcomes.push({ fixture: fixture.id, arm: model, ...verdict });
        if (!verdict.pass) stopped.add(model);
      } catch (error) { stopped.add(model); outcomes.push({ fixture: fixture.id, arm: model, pass: false, invalidEvidence: true, error: (error as Error).message }); }
      await writeFile(join(out, 'outcomes.json'), JSON.stringify(outcomes, null, 2));
    }
  }
  // Repeat the first fixture for candidates which qualified across the evidence floor.
  for (const model of manifest.compactors as Model[]) {
    if (stopped.has(model) || outcomes.some(o => o.arm === model && o.repeat)) continue;
    const fixture = fixtures[0];
    const key = { host: 'codex' as const, session: 'repeat:' + model };
    try {
      for (const cycle of [5, 10, 15]) await checkpoint(join(out, 'sessions'), key, fixture.events.filter(e => e.turn <= cycle), async (state, delta) =>
        (await call(model, extractionPrompt(state, delta), undefined, { fixture: fixture.id, phase: 'repeat-checkpoint', cycle })).value.entries, true);
      const context = render(await inspect(join(out, 'sessions'), key));
      const result = await call('gpt-6-luna', continuation(fixture, context), answerSchema(fixture), { fixture: fixture.id, phase: 'repeat-continuation', compactor: model });
      outcomes.push({ fixture: fixture.id, arm: model, repeat: true, ...score(fixture, result.value) });
    } catch (error) { outcomes.push({ arm: model, repeat: true, pass: false, error: (error as Error).message }); }
  }
  await writeFile(join(out, 'outcomes.json'), JSON.stringify(outcomes, null, 2));
  await save();
  console.log(JSON.stringify({ finished: true, calls, knownReportedTokens: tokens, stopped: [...stopped] }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('evaluate requires an empty output directory');
  evaluate(resolve(process.argv[2]), process.argv.includes('--resume'), process.argv.includes('--rescore')).catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
