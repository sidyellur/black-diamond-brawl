import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

export const STORAGE_KEYS = {
  records: 'black-diamond-brawl:records:v1',
  muted: 'bdb-muted'
} as const;

type StorageKey = typeof STORAGE_KEYS[keyof typeof STORAGE_KEYS];

interface PreferencesStore {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
}

interface StorageOptions {
  native: boolean;
  preferences: PreferencesStore;
  browserStorage: () => Pick<Storage, 'getItem' | 'setItem'>;
  /** A missing native bridge must not leave the game stuck at boot. */
  timeoutMs?: number;
}

class StorageTimeout extends Error {}

/** Keep an unavailable bridge from hanging boot or a best-effort flush. */
function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StorageTimeout('Storage bridge timed out')), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

/** Small, local-only storage adapter. The factory also lets tests exercise the
 * actual native path without pretending a browser has an iOS plugin bridge. */
export function createStorage(options: StorageOptions) {
  const memory = new Map<StorageKey, string>();
  const failedReads = new Set<StorageKey>();
  const pendingBrowserWrites = new Set<StorageKey>();
  const timeoutMs = options.timeoutMs ?? 3000;
  let initialization: Promise<void> | null = null;
  let writes = Promise.resolve();
  let nativeWritesTimedOut = false;

  function initialize(): Promise<void> {
    return initialization ??= options.native
      ? Promise.all(Object.values(STORAGE_KEYS).map(async key => {
        try {
          const { value } = await bounded(options.preferences.get({ key }), timeoutMs);
          // A synchronous local change made during hydration wins. Normal game
          // boot awaits initialization before any scene reads or writes records.
          if (value !== null && !memory.has(key)) memory.set(key, value);
        } catch {
          // Do not overwrite an unreadable, potentially better durable record
          // with a new empty-session snapshot. This key stays memory-only until
          // the next launch, where hydration can try again.
          failedReads.add(key);
        }
      })).then(() => {})
      : Promise.resolve();
  }

  function get(key: StorageKey): string | null {
    if (!options.native) {
      try {
        // Re-read each time so session.ts can merge another browser tab's PBs.
        const value = options.browserStorage().getItem(key);
        // Scalar settings have no domain-level merge cache: keep a failed mute
        // write effective for this session even if reading old storage works.
        // Records must still return the disk snapshot so session.ts can merge
        // another tab's progress with its own unsaved in-memory bests.
        if (key === STORAGE_KEYS.muted && pendingBrowserWrites.has(key)) {
          return memory.get(key) ?? null;
        }
        if (!pendingBrowserWrites.has(key)) {
          if (value === null) memory.delete(key);
          else memory.set(key, value);
        }
        return value;
      } catch {
        // SecurityError, private browsing and SSR use the live session cache.
      }
    }
    return memory.get(key) ?? null;
  }

  function set(key: StorageKey, value: string): void {
    memory.set(key, value);
    if (!options.native) {
      try {
        options.browserStorage().setItem(key, value);
        pendingBrowserWrites.delete(key);
      } catch {
        pendingBrowserWrites.add(key);
      }
      return;
    }

    // Capture the immutable string now and serialize native writes. A slower
    // earlier save can never finish after, and overwrite, a newer snapshot.
    writes = writes.then(async () => {
      await initialize();
      if (failedReads.has(key) || nativeWritesTimedOut) return;
      try {
        await bounded(options.preferences.set({ key, value }), timeoutMs);
      } catch (error) {
        // A rejection does not poison subsequent writes. On timeout, however,
        // the native call might still finish later: stop writes for this launch
        // instead of allowing that old call to overwrite a newer saved value.
        if (error instanceof StorageTimeout) nativeWritesTimedOut = true;
      }
    });
  }

  async function flush(): Promise<void> {
    await initialize();
    let pending: Promise<void>;
    do {
      pending = writes;
      await pending;
    } while (pending !== writes);
  }

  return { initialize, get, set, flush };
}

const storage = createStorage({
  native: Capacitor.isNativePlatform(),
  preferences: Preferences,
  // Access inside the guarded operation: even the localStorage getter can throw.
  browserStorage: () => localStorage
});

/** Await once before constructing Phaser so scores and mute are ready at boot.
 * Native iOS uses Preferences/UserDefaults, never WebView localStorage. No data
 * leaves the device through this adapter; uninstalling the app removes its data. */
export const initializeStorage = storage.initialize;
export const getStoredValue = storage.get;
export const setStoredValue = storage.set;
/** Best effort: failures keep the current session playable and memory intact. */
export const flushStorage = storage.flush;
