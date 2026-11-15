import { Injectable } from '@nestjs/common';

export interface ProviderHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;

  maxBytes?: number;
}

export interface ProviderHttpResponse {
  status: number;

  headers: Record<string, string>;
  body: string;
}

export type TransportFailure = 'timeout' | 'aborted' | 'network' | 'too_large' | 'redirect';


export class TransportError extends Error {
  constructor(
    readonly kind: TransportFailure,
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}






export abstract class ProviderTransport {
  abstract send(request: ProviderHttpRequest): Promise<ProviderHttpResponse>;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

@Injectable()
export class FetchProviderTransport extends ProviderTransport {
  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal,

        redirect: 'error',
      });
    } catch (error) {
      throw classify(error, timeout, request.signal);
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const body = await readBounded(response, request.maxBytes ?? DEFAULT_MAX_BYTES, timeout, request.signal);
    return { status: response.status, headers, body };
  }
}

async function readBounded(response: Response, maxBytes: number, timeout: AbortSignal, outer?: AbortSignal) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TransportError('too_large', `Response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throw classify(error, timeout, outer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function classify(error: unknown, timeout: AbortSignal, outer?: AbortSignal): TransportError {
  if (outer?.aborted) return new TransportError('aborted', 'Request aborted');
  if (timeout.aborted) return new TransportError('timeout', 'Request timed out');
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  if (/redirect/i.test(`${(error as Error)?.message ?? ''} ${cause?.message ?? ''}`)) {
    return new TransportError('redirect', 'Provider responded with a redirect, which is not followed');
  }
  return new TransportError('network', cause?.code ? `Network error (${cause.code})` : 'Network error');
}
