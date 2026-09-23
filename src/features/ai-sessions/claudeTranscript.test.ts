import { describe, expect, it } from 'vitest';
import { parseClaudeTranscript } from './claudeTranscript';

describe('parseClaudeTranscript', () => {
  it('keeps only real user prompts and assistant text', () => {
    const jsonl = [
      JSON.stringify({ type: 'attachment', content: 'startup hook' }),
      JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'internal' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '你好' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '你好！\n\n这是回复。' }] } }),
    ].join('\n');

    expect(parseClaudeTranscript(jsonl)).toEqual([
      { kind: 'user', text: '你好' },
      { kind: 'assistant', text: '你好！\n\n这是回复。' },
    ]);
  });

  it('merges adjacent assistant text events without duplicating redraw frames', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '检查代码' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '第一段' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '第二段' }] } }),
    ].join('\n');

    expect(parseClaudeTranscript(jsonl)).toEqual([
      { kind: 'user', text: '检查代码' },
      { kind: 'assistant', text: '第一段\n\n第二段' },
    ]);
  });
});
