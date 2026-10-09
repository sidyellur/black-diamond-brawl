import { getStoredValue, setStoredValue, STORAGE_KEYS } from '../platform/storage';

export interface ValueStore { get(): string | null; set(value: string): void }
export function localStore(key: typeof STORAGE_KEYS[keyof typeof STORAGE_KEYS]): ValueStore {
  return { get: () => getStoredValue(key), set: value => setStoredValue(key, value) };
}
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
export function finite(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,120}$/.test(value);
}
export function parseStored(store: ValueStore, maxCharacters: number): unknown {
  try {
    const text = store.get();
    return text && text.length <= maxCharacters ? JSON.parse(text) : null;
  } catch { return null; }
}
export function saveStored(store: ValueStore, value: unknown): void {
  try { store.set(JSON.stringify(value)); } catch { /* This launch keeps its live cache. */ }
}
export function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
