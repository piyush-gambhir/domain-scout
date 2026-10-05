import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';

export interface SseMessage {
  id: string | null;
  event: string | null;
  data: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

/** Minimal incremental SSE reader for tests (supertest buffers until the response ends). */
export class SseClient {
  readonly messages: SseMessage[] = [];
  private buffer = '';
  private readonly listeners = new Set<() => void>();

  private constructor(
    readonly req: ClientRequest,
    readonly res: IncomingMessage,
  ) {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf('\n\n')) >= 0) {
        const block = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 2);
        this.messages.push(parseBlock(block));
      }
      for (const listener of this.listeners) listener();
    });
  }

  static open(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(url, { headers: { Accept: 'text/event-stream', ...headers } }, (res) => resolve(new SseClient(req, res)));
      req.on('error', reject);
      req.end();
    });
  }

  get status() {
    return this.res.statusCode ?? 0;
  }

  /** Resolves once `predicate` holds for the received messages. */
  waitFor(predicate: (messages: SseMessage[]) => boolean, timeoutMs = 3000): Promise<SseMessage[]> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!predicate(this.messages)) return;
        cleanup();
        resolve(this.messages);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out; received ${JSON.stringify(this.messages.map((m) => [m.id, m.event]))}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      this.listeners.add(check);
      check();
    });
  }

  /** Messages other than heartbeats. */
  events(): SseMessage[] {
    return this.messages.filter((m) => m.event !== 'heartbeat');
  }

  close() {
    this.req.destroy();
  }
}

function parseBlock(block: string): SseMessage {
  let id: string | null = null;
  let event: string | null = null;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  const text = data.join('\n');
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { id, event, data: text, json };
}
