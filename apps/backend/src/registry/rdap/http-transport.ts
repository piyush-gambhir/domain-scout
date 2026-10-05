import { Injectable } from '@nestjs/common';

export interface HttpGetRequest {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  /** Bytes read before the body is cut off and `truncated` is set. */
  maxBytes: number;
}

export interface HttpGetResponse {
  url: string;
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

/**
 * HTTP GET used for RDAP queries and IANA bootstrap refreshes. Redirects are never followed by the
 * transport: callers decide whether a Location is a verified registry host. Tests override this
 * provider with a fake so no test touches the network.
 */
export abstract class RegistryHttpTransport {
  abstract get(request: HttpGetRequest): Promise<HttpGetResponse>;
}

@Injectable()
export class FetchHttpTransport extends RegistryHttpTransport {
  async get(request: HttpGetRequest): Promise<HttpGetResponse> {
    const response = await fetch(request.url, {
      method: 'GET',
      headers: request.headers,
      signal: request.signal,
      redirect: 'manual',
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > request.maxBytes) {
          chunks.push(value.subarray(0, request.maxBytes - size));
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        size += value.byteLength;
        chunks.push(value);
      }
    }
    return {
      url: request.url,
      status: response.status,
      headers,
      body: Buffer.concat(chunks).toString('utf8'),
      truncated,
    };
  }
}
