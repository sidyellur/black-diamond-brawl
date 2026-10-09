/** Exercise the real storage adapter with controlled native bridge promises. */
import assert from 'node:assert/strict';
import { createStorage, STORAGE_KEYS } from '../src/platform/storage';

const RECORDS = STORAGE_KEYS.records;
const MUTED = STORAGE_KEYS.muted;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const noBrowserStorage = (): Storage => { throw new Error('Native must never read WebView storage'); };

// Boot hydration is awaited, concurrent calls are idempotent, and every key is
// available synchronously before scenes/audio are created.
const savedRecords = JSON.stringify({ bestScore: 900, courses: {} });
const recordRead = deferred<{ value: string | null }>();
const muteRead = deferred<{ value: string | null }>();
const reads: string[] = [];
const hydrating = createStorage({
  native: true, browserStorage: noBrowserStorage,
  preferences: {
    get: ({ key }) => {
      reads.push(key);
      return key === RECORDS ? recordRead.promise : key === MUTED ? muteRead.promise : Promise.resolve({ value: null });
    },
    set: async () => {}
  }
});
const ready = hydrating.initialize();
assert.equal(hydrating.initialize(), ready, 'one shared hydration promise');
assert.equal(hydrating.get(RECORDS), null);
let bootReady = false;
void ready.then(() => { bootReady = true; });
recordRead.resolve({ value: savedRecords });
await tick();
assert.equal(bootReady, false, 'game cannot boot before all preferences hydrate');
muteRead.resolve({ value: '1' });
await ready;
assert.equal(hydrating.get(RECORDS), savedRecords);
assert.equal(hydrating.get(MUTED), '1');
assert.deepEqual(reads.sort(), Object.values(STORAGE_KEYS).sort());
await hydrating.initialize();
assert.equal(reads.length, Object.values(STORAGE_KEYS).length);

// A changing score/mute takes effect immediately in memory. Writes cannot race:
// there is only one in-flight bridge call, including across preference keys.
const disk = new Map<string, string>();
const calls: { key: string; value: string; completed: ReturnType<typeof deferred<void>> }[] = [];
const serialized = createStorage({
  native: true, browserStorage: noBrowserStorage,
  preferences: {
    get: async ({ key }) => ({ value: disk.get(key) ?? null }),
    set: async ({ key, value }) => {
      const completed = deferred<void>();
      calls.push({ key, value, completed });
      await completed.promise;
      disk.set(key, value);
    }
  }
});
await serialized.initialize();
serialized.set(RECORDS, 'first');
serialized.set(RECORDS, 'latest');
serialized.set(MUTED, '1');
assert.equal(serialized.get(RECORDS), 'latest');
assert.equal(serialized.get(MUTED), '1');
await tick();
assert.equal(calls.length, 1);
assert.equal(calls[0].value, 'first');
let flushed = false;
const flush = serialized.flush().then(() => { flushed = true; });
calls[0].completed.resolve();
await tick();
assert.equal(calls.length, 2);
assert.equal(calls[1].value, 'latest');
assert.equal(flushed, false);
calls[1].completed.resolve();
await tick();
assert.equal(calls.length, 3);
assert.equal(calls[2].key, MUTED);
calls[2].completed.resolve();
await flush;
assert.equal(disk.get(RECORDS), 'latest');
assert.equal(disk.get(MUTED), '1');

const reloaded = createStorage({
  native: true, browserStorage: noBrowserStorage,
  preferences: {
    get: async ({ key }) => ({ value: disk.get(key) ?? null }),
    set: async ({ key, value }) => { disk.set(key, value); }
  }
});
await reloaded.initialize();
assert.equal(reloaded.get(RECORDS), 'latest', 'native reload restores saved records');
assert.equal(reloaded.get(MUTED), '1', 'native reload restores mute');

// A rejected write leaves memory intact, and a later write can still succeed.
let rejectWrite = true;
const recovering = createStorage({
  native: true, browserStorage: noBrowserStorage,
  preferences: {
    get: async () => ({ value: null }),
    set: async ({ key, value }) => {
      if (rejectWrite) throw new Error('temporary storage failure');
      disk.set(key, value);
    }
  }
});
await recovering.initialize();
recovering.set(RECORDS, 'memory only');
await recovering.flush();
assert.equal(recovering.get(RECORDS), 'memory only');
rejectWrite = false;
recovering.set(RECORDS, 'recovered');
await recovering.flush();
assert.equal(disk.get(RECORDS), 'recovered');

// Rejected reads are isolated by key. Do not replace an unreadable existing PB
// with a new session's lower score; mute remains usable when its read succeeds.
const partialWrites: string[] = [];
const partiallyBlocked = createStorage({
  native: true, browserStorage: noBrowserStorage,
  preferences: {
    get: ({ key }) => {
      if (key === RECORDS) throw new Error('native get can throw synchronously');
      return Promise.resolve({ value: '1' });
    },
    set: async ({ key }) => { partialWrites.push(key); }
  }
});
await partiallyBlocked.initialize();
partiallyBlocked.set(RECORDS, 'new lower score');
partiallyBlocked.set(MUTED, '0');
await partiallyBlocked.flush();
assert.equal(partiallyBlocked.get(RECORDS), 'new lower score');
assert.equal(partiallyBlocked.get(MUTED), '0');
assert.deepEqual(partialWrites, [MUTED]);

// A missing bridge must not strand the title screen. Late native reads cannot
// replace live in-memory values after the timeout fallback was chosen.
const lateRead = deferred<{ value: string | null }>();
let timedOutWrites = 0;
const unavailable = createStorage({
  native: true, browserStorage: noBrowserStorage, timeoutMs: 10,
  preferences: {
    get: () => lateRead.promise,
    set: async () => { timedOutWrites++; }
  }
});
await unavailable.initialize();
unavailable.set(RECORDS, 'fallback');
await unavailable.flush();
assert.equal(unavailable.get(RECORDS), 'fallback');
assert.equal(timedOutWrites, 0);
lateRead.resolve({ value: 'late stale read' });
await tick();
assert.equal(unavailable.get(RECORDS), 'fallback');
assert.equal(unavailable.get(MUTED), null);

// Even if a consumer writes during initialization, hydration cannot replace it.
const slowRead = deferred<{ value: string | null }>();
const earlyWrites: string[] = [];
const early = createStorage({
  native: true, browserStorage: noBrowserStorage,
  preferences: {
    get: () => slowRead.promise,
    set: async ({ value }) => { earlyWrites.push(value); }
  }
});
const earlyReady = early.initialize();
early.set(MUTED, '0');
slowRead.resolve({ value: '1' });
await earlyReady;
await early.flush();
assert.equal(early.get(MUTED), '0');
assert.deepEqual(earlyWrites, ['0']);

// A hung write is different from a rejection: it may still complete later.
// Do not start newer native writes after timing it out and create a stale race.
const lateWrite = deferred<void>();
const hungCalls: string[] = [];
const hung = createStorage({
  native: true, browserStorage: noBrowserStorage, timeoutMs: 10,
  preferences: {
    get: async () => ({ value: null }),
    set: async ({ value }) => { hungCalls.push(value); await lateWrite.promise; }
  }
});
await hung.initialize();
hung.set(RECORDS, 'older');
hung.set(RECORDS, 'newer');
await hung.flush();
assert.deepEqual(hungCalls, ['older']);
assert.equal(hung.get(RECORDS), 'newer');
lateWrite.resolve();
await tick();
assert.deepEqual(hungCalls, ['older']);
assert.equal(hung.get(RECORDS), 'newer');

// Browser builds still use their original localStorage keys and refresh reads
// for cross-tab merging. No native plugin calls are made for a browser/PWA.
const browserDisk = new Map<string, string>();
const forbiddenPreferences = {
  get: async () => { assert.fail('browser must not read the native plugin'); },
  set: async () => { assert.fail('browser must not write the native plugin'); }
};
const browserOptions = {
  native: false,
  preferences: forbiddenPreferences,
  browserStorage: () => ({
    getItem: (key: string) => browserDisk.get(key) ?? null,
    setItem: (key: string, value: string) => { browserDisk.set(key, value); }
  })
};
const tabA = createStorage(browserOptions);
const tabB = createStorage(browserOptions);
await tabA.initialize();
tabA.set(RECORDS, 'tab A');
assert.equal(browserDisk.get(RECORDS), 'tab A');
assert.equal(tabB.get(RECORDS), 'tab A');
tabB.set(RECORDS, 'tab B');
assert.equal(tabA.get(RECORDS), 'tab B');
tabA.set(MUTED, '1');
assert.equal(browserDisk.get('bdb-muted'), '1');
browserDisk.delete(MUTED);
assert.equal(tabA.get(MUTED), null, 'browser removals are observed');
await tabA.flush();

// Quota can block writes while reads keep working. An old persisted scalar
// setting must not undo its newer in-memory value. Record snapshots deliberately
// remain visible to the session's separate cross-tab/in-memory record merger.
let quotaBlocked = true;
browserDisk.set(MUTED, '0');
browserDisk.set(RECORDS, 'old disk record');
const quotaBrowser = createStorage({
  ...browserOptions,
  browserStorage: () => ({
    getItem: (key: string) => browserDisk.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (quotaBlocked) throw new Error('QuotaExceededError');
      browserDisk.set(key, value);
    }
  })
});
assert.equal(quotaBrowser.get(MUTED), '0');
quotaBrowser.set(MUTED, '1');
quotaBrowser.set(RECORDS, 'unsaved local record');
assert.equal(browserDisk.get(MUTED), '0', 'failed write leaves old persistent mute');
assert.equal(quotaBrowser.get(MUTED), '1', 'new in-memory mute survives readable stale storage');
browserDisk.set(RECORDS, 'another tab record');
assert.equal(quotaBrowser.get(RECORDS), 'another tab record', 'record merger can still read another tab after failed writes');
quotaBlocked = false;
quotaBrowser.set(MUTED, '1');
assert.equal(browserDisk.get(MUTED), '1', 'subsequent successful write recovers persistence');
browserDisk.set(MUTED, '0');
assert.equal(quotaBrowser.get(MUTED), '0', 'successful persistence clears the in-memory-only override');

const blockedBrowser = createStorage({
  ...browserOptions,
  browserStorage: () => { throw new Error('SecurityError accessing localStorage'); }
});
await blockedBrowser.initialize();
assert.equal(blockedBrowser.get(RECORDS), null);
blockedBrowser.set(RECORDS, savedRecords);
blockedBrowser.set(MUTED, '1');
assert.equal(blockedBrowser.get(RECORDS), savedRecords);
assert.equal(blockedBrowser.get(MUTED), '1');
await blockedBrowser.flush();

console.log('PASS storage: native boot hydration, mute/reload, serial writes, rejection recovery, protected unreadable keys, bridge timeouts/late completion, browser refresh, quota-only mute fallback and denied-storage fallback.');
