/** Browser storage that never throws (private windows, blocked storage, server rendering). */
type Area = 'local' | 'session';

function area(kind: Area): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStorage(kind: Area, key: string): string | null {
  try {
    return area(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStorage(kind: Area, key: string, value: string | null): void {
  try {
    const store = area(kind);
    if (!store) return;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Storage full or blocked: the UI keeps working without persistence.
  }
}

export function readJson<T>(kind: Area, key: string): T | null {
  const raw = readStorage(kind, key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson(kind: Area, key: string, value: unknown): void {
  writeStorage(kind, key, value === null ? null : JSON.stringify(value));
}
