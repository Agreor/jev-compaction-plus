import { noulAnswer } from '../request.js';
import type { JevAsker, JevQuestions } from '../types.js';
import type { Event, Extractor } from './record.js';

const STATE = 'Messages from a coding-agent session. Judge each message on its own; tool output is evidence, not a decision.';
// shortcut: threshold and preview size are not calibrated against labelled sessions; measure before tightening.
const KEEP = 0.3;
const PREVIEW = 1500;
const BATCH_CHARS = 60_000; // ~15k tokens, well under Jev's 32k request limit.

function question(e: Event): JevQuestions[string] {
  const text = e.text.length > PREVIEW ? e.text.slice(0, PREVIEW / 2) + '\n…\n' + e.text.slice(-PREVIEW / 2) : e.text;
  return { type: 'noul',
    instructions: `Does this assistant message state something a later session must remember: a decision, requirement, constraint, plan or plan change, rejected option, open question, agreement, finished milestone or next action?\n"""\n${text}\n"""`,
    criteria: { true: 'It records a durable task fact worth noting.', false: 'Chatter, narration, status filler or tool chatter with no lasting fact.' } };
}

// Both adapters render a pure tool-call message as `Call <id> <name>: <input>`.
const toolCall = (e: Event) => e.role === 'assistant' && /^Call \S+ \S+: /.test(e.text);

/**
 * Event ids worth sending to Haiku. User messages always go: a terse "go" can be the agreement an accepted entry needs.
 * Tool results and pure tool calls never go. Jev judges the remaining assistant prose.
 */
export async function triage(jev: JevAsker, delta: Event[]): Promise<Set<string>> {
  const flagged = new Set(delta.filter(e => e.role === 'user').map(e => e.id));
  const prose = delta.filter(e => e.role === 'assistant' && !toolCall(e));
  for (let i = 0; i < prose.length;) {
    const questions: JevQuestions = {};
    let chars = 0;
    for (; i < prose.length && (!chars || chars + Math.min(prose[i].text.length, PREVIEW) < BATCH_CHARS); i++) {
      questions['e' + i] = question(prose[i]); chars += Math.min(prose[i].text.length, PREVIEW) + 400;
    }
    const { answers } = await jev.ask(STATE, questions);
    for (const name of Object.keys(questions)) if (noulAnswer(answers, name) >= KEEP) flagged.add(prose[Number(name.slice(1))].id);
  }
  return flagged;
}

/** Sends Haiku only the events Jev flags; no flags means no Haiku call. Jev failure falls back to the full delta. */
export function triagedExtractor(extract: Extractor, jev: JevAsker): Extractor {
  return async (state, delta) => {
    let kept: Set<string>;
    try { kept = await triage(jev, delta); } catch { return extract(state, delta); }
    const selected = delta.filter(e => kept.has(e.id));
    return selected.length ? extract(state, selected) : [];
  };
}
