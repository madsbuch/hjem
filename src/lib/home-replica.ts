import type { HubState } from './home-assistant';
import { parseConfiguration, type ExportedSettings, type HjemConfiguration } from './home-configuration';

/**
 * A full copy of the home kept on this device, so any device can bring the
 * home back onto a new hub. Copies come from the Hjem hub as it numbers them,
 * with this device's own settings added.
 */
export interface HomeReplica {
  hubId: string;
  revision: number;
  savedAt: number;
  document: HjemConfiguration;
}

const DATABASE = 'hjem-home-copies';
const STORE = 'copies';
/** Earlier copies stay, in case the newest was taken from a home that had just lost something. */
export const COPIES_PER_HUB = 5;
const MAX_HUBS = 4;
const memory = new Map<string, HomeReplica>();
const keyOf = (replica: Pick<HomeReplica, 'hubId' | 'revision'>) => `${replica.hubId}:${replica.revision}`;

/** What a device with room for a few copies keeps: the newest of each hub, newest hubs first. */
export function retained(copies: HomeReplica[]): HomeReplica[] {
  const newestFirst = [...copies].sort((first, second) => second.savedAt - first.savedAt || second.revision - first.revision);
  const hubs = [...new Set(newestFirst.map((copy) => copy.hubId))].slice(0, MAX_HUBS);
  return hubs.flatMap((hubId) => newestFirst
    .filter((copy) => copy.hubId === hubId)
    .sort((first, second) => second.revision - first.revision)
    .slice(0, COPIES_PER_HUB))
    .sort((first, second) => second.savedAt - first.savedAt || second.revision - first.revision);
}

export function replicaFrom(hub: HubState, settings: ExportedSettings, now = Date.now()): HomeReplica | null {
  if (!hub.document || hub.revision < 1) return null;
  return { hubId: hub.hubId, revision: hub.revision, savedAt: now, document: { ...hub.document, settings } };
}

function parseReplica(value: unknown): HomeReplica | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { hubId, revision, savedAt, document } = Object.fromEntries(Object.entries(value));
  if (typeof hubId !== 'string' || typeof revision !== 'number' || typeof savedAt !== 'number') return null;
  try {
    return { hubId, revision, savedAt, document: parseConfiguration(JSON.stringify(document)) };
  } catch {
    return null;
  }
}

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    // Without device storage the copy still lasts as long as the app stays open.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}
const done = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error ?? new Error('The copy could not be saved.'));
  transaction.onabort = () => reject(transaction.error ?? new Error('The copy could not be saved.'));
});

export async function listReplicas(): Promise<HomeReplica[]> {
  const database = await open();
  if (!database) return retained([...memory.values()]);
  try {
    const transaction = database.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).getAll();
    await done(transaction);
    const stored: unknown[] = Array.isArray(request.result) ? request.result : [];
    return retained(stored.flatMap((value) => {
      const replica = parseReplica(value);
      return replica ? [replica] : [];
    }));
  } finally {
    database.close();
  }
}

/** Save a copy and let go of the ones beyond what is kept. Resolves to the copies now on the device. */
export async function saveReplica(replica: HomeReplica): Promise<HomeReplica[]> {
  const existing = await listReplicas();
  const same = existing.find((copy) => keyOf(copy) === keyOf(replica));
  // The same numbered copy is only rewritten to refresh this device's settings in it.
  const all = [...existing.filter((copy) => copy !== same), same ? { ...replica, savedAt: same.savedAt } : replica];
  const kept = retained(all);
  const database = await open();
  if (!database) {
    memory.clear();
    for (const copy of kept) memory.set(keyOf(copy), copy);
    return kept;
  }
  try {
    // Ask the browser not to clear this under storage pressure; it is the device's backup of the home.
    void navigator.storage?.persist?.().catch(() => undefined);
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const keep = new Set(kept.map(keyOf));
    for (const copy of all) if (!keep.has(keyOf(copy))) store.delete(keyOf(copy));
    for (const copy of kept) if (keyOf(copy) === keyOf(replica)) store.put(copy, keyOf(copy));
    await done(transaction);
    return kept;
  } finally {
    database.close();
  }
}
