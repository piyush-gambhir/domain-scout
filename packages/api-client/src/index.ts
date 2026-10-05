import {
  API_PREFIX,
  buildPath,
  routes,
  type ApiError as ApiErrorBody,
  type OperationArgs,
  type OperationId,
  type OperationResponse,
} from '@domain-scout/contracts';

export interface ClientOptions {
  /** Origin of the backend or of the web server that forwards /api/v1, e.g. http://127.0.0.1:4317. Empty for same-origin. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Extra headers per request, e.g. Authorization or the CSRF token. */
  headers?: () => Record<string, string>;
  credentials?: "include" | "omit" | "same-origin";
}

/** Error thrown for non-2xx responses. `body` follows the ErrorResponse contract when the backend produced it. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
    readonly operationId: string,
  ) {
    super(body?.message ?? `${operationId} failed with HTTP ${status}`);
    this.name = 'ApiRequestError';
  }
}

type AnyArgs = {
  params?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export function queryString(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function createClient(options: ClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  function url<Op extends OperationId>(operationId: Op, args?: Partial<OperationArgs<Op>>): string {
    const def = routes[operationId];
    const a = (args ?? {}) as AnyArgs;
    return `${baseUrl}${API_PREFIX}${buildPath(def.path, a.params)}${queryString(a.query)}`;
  }

  async function call<Op extends OperationId>(
    operationId: Op,
    ...rest: {} extends OperationArgs<Op> ? [args?: OperationArgs<Op>] : [args: OperationArgs<Op>]
  ): Promise<OperationResponse<Op>> {
    const def = routes[operationId];
    if ('produces' in def && def.produces === 'sse') {
      // A stream never finishes as JSON; use url() with EventSource or a dedicated SSE reader.
      throw new Error(`${operationId} is a server-sent event stream; open client.url('${operationId}') instead`);
    }
    const a = (rest[0] ?? {}) as AnyArgs;
    const headers: Record<string, string> = { Accept: 'application/json', ...(options.headers?.() ?? {}) };
    if (a.body !== undefined) headers['Content-Type'] = 'application/json';
    if (a.idempotencyKey) headers['Idempotency-Key'] = a.idempotencyKey;
    const response = await doFetch(url(operationId, a as Partial<OperationArgs<Op>>), {
      method: def.method.toUpperCase(),
      headers,
      body: a.body === undefined ? undefined : JSON.stringify(a.body),
      credentials: options.credentials,
      signal: a.signal,
    });
    if (!response.ok) {
      let body: ApiErrorBody | null = null;
      try {
        const json = (await response.json()) as { error?: ApiErrorBody };
        body = json.error ?? null;
      } catch {
        body = null;
      }
      throw new ApiRequestError(response.status, body, operationId);
    }
    if ('produces' in def && def.produces === 'file') return (await response.text()) as OperationResponse<Op>;
    return (await response.json()) as OperationResponse<Op>;
  }

  return { call, url };
}

export type ApiClient = ReturnType<typeof createClient>;
export type { OperationArgs, OperationId, OperationResponse };
