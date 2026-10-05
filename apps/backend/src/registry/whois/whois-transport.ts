import { Injectable } from '@nestjs/common';
import { connect } from 'node:net';

export interface WhoisRequest {
  host: string;
  port: number;
  /** Query line without the CRLF terminator. */
  query: string;
  signal: AbortSignal;
  maxBytes: number;
}

export interface WhoisResponse {
  text: string;
  /** True when the size cap was reached or the connection failed after data arrived. */
  truncated: boolean;
}

export class WhoisTransportError extends Error {
  constructor(
    readonly code: 'network' | 'aborted',
    message: string,
  ) {
    super(message);
    this.name = 'WhoisTransportError';
  }
}

/** WHOIS over TCP port 43 (RFC 3912). Tests override this provider with a fake. */
export abstract class WhoisTransport {
  abstract query(request: WhoisRequest): Promise<WhoisResponse>;
}

@Injectable()
export class NetWhoisTransport extends WhoisTransport {
  query(request: WhoisRequest): Promise<WhoisResponse> {
    return new Promise((resolve, reject) => {
      if (request.signal.aborted) {
        reject(new WhoisTransportError('aborted', 'Aborted before connecting'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const socket = connect({ host: request.host, port: request.port });

      const finish = (result: WhoisResponse | Error) => {
        if (settled) return;
        settled = true;
        request.signal.removeEventListener('abort', onAbort);
        socket.destroy();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const text = () => Buffer.concat(chunks).toString('utf8');
      const onAbort = () => finish(new WhoisTransportError('aborted', 'Aborted'));
      request.signal.addEventListener('abort', onAbort, { once: true });

      socket.on('connect', () => socket.write(`${request.query}\r\n`));
      socket.on('data', (chunk: Buffer) => {
        if (size + chunk.length > request.maxBytes) {
          chunks.push(chunk.subarray(0, request.maxBytes - size));
          finish({ text: text(), truncated: true });
          return;
        }
        size += chunk.length;
        chunks.push(chunk);
      });
      socket.on('end', () => finish({ text: text(), truncated: false }));
      socket.on('close', () => finish({ text: text(), truncated: false }));
      socket.on('error', (error: NodeJS.ErrnoException) => {
        if (size > 0) finish({ text: text(), truncated: true });
        else finish(new WhoisTransportError('network', error.code ?? error.message));
      });
    });
  }
}
