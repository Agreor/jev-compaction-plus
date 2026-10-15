import { describe, expect, it } from 'vitest';
import { parseReply, runProcess } from '../src/assessment/runner.js';

describe('isolated CLI runner', () => {
  it('reads Claude structured output and records actual model and cache usage', () => {
    const result = parseReply('claude', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { entries: [] }, usage: { input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 30 }, modelUsage: { 'claude-haiku-5-5': {} } }), '', 'claude-haiku-5-5');
    expect(result.value).toEqual({ entries: [] });
    expect(result.inputTokens).toBe(170);
    expect(result.outputTokens).toBe(20);
    expect(result.resolvedModel).toBe('claude-haiku-5-5');
  });
  it('reads Codex final response and usage while rejecting tool calls or model substitution', () => {
    const lines = [{ type: 'item.completed', item: { type: 'agent_message', text: '{"entries":[]}' } }, { type: 'turn.completed', usage: { input_tokens: 500, output_tokens: 10, cached_input_tokens: 100 } }].map(JSON.stringify).join('\n');
    const parsed = parseReply('codex', lines, 'model: gpt-6-luna\n', 'gpt-6-luna');
    expect(parsed.inputTokens).toBe(500);
    expect(parsed.value).toEqual({ entries: [] });
    expect(() => parseReply('codex', lines, 'model: gpt-6.1-sol\n', 'gpt-6-luna')).toThrow('model');
    expect(() => parseReply('codex', lines + '\n' + JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }), '', 'gpt-6-luna')).toThrow('tool');
  });
  it('passes input without shell interpolation and terminates timed-out processes', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'literal $(echo bad) `pwd`', 5000);
    expect(result.stdout).toBe('literal $(echo bad) `pwd`');
    await expect(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], '', 50)).rejects.toThrow('timeout');
  });
});
