import type { ClaudeTranscriptMessage } from '../../shared/types';

export function parseClaudeTranscript(jsonl: string): ClaudeTranscriptMessage[] {
  const messages: ClaudeTranscriptMessage[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'user' && event?.type !== 'assistant') continue;
    if (event.isMeta === true || event.message?.role !== event.type) continue;
    const text = extractText(event.message?.content);
    if (!text || isInternalMessage(text)) continue;
    messages.push({ kind: event.type, text, timestamp: typeof event.timestamp === 'string' ? event.timestamp : undefined });
  }
  return mergeAdjacentAssistantMessages(messages);
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((item): item is { type?: string; text?: string } => Boolean(item) && typeof item === 'object')
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text!.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function isInternalMessage(text: string): boolean {
  return /^<local-command-caveat>[\s\S]*<\/local-command-caveat>$/i.test(text)
    || /^<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*<\/(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr)>$/i.test(text)
    || text === 'No response requested.';
}

function mergeAdjacentAssistantMessages(messages: ClaudeTranscriptMessage[]): ClaudeTranscriptMessage[] {
  const merged: ClaudeTranscriptMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous?.kind === 'assistant' && message.kind === 'assistant') {
      previous.text = `${previous.text}\n\n${message.text}`;
    } else {
      merged.push({ ...message });
    }
  }
  return merged;
}
