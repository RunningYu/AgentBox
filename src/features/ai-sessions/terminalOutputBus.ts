type TerminalOutputWriter = (data: string) => void;

const writers = new Map<string, TerminalOutputWriter>();

export function registerTerminalOutputWriter(sessionId: string, writer: TerminalOutputWriter): () => void {
  writers.set(sessionId, writer);
  return () => {
    if (writers.get(sessionId) === writer) {
      writers.delete(sessionId);
    }
  };
}

export function writeTerminalOutput(sessionId: string, data: string): boolean {
  const writer = writers.get(sessionId);
  if (!writer) {
    return false;
  }
  writer(data);
  return true;
}
