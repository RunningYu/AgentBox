export class PtyHistoryBuffer {
  private chunks = new Map<string, string[]>();

  push(sessionId: string, data: string): void {
    if (!data) {
      return;
    }
    const sessionChunks = this.chunks.get(sessionId);
    if (sessionChunks) {
      sessionChunks.push(data);
    } else {
      this.chunks.set(sessionId, [data]);
    }
  }

  delete(sessionId: string): void {
    this.chunks.delete(sessionId);
  }

  drain(): Map<string, string> {
    const drained = new Map<string, string>();
    for (const [sessionId, chunks] of this.chunks) {
      drained.set(sessionId, chunks.join(''));
    }
    this.chunks.clear();
    return drained;
  }
}
