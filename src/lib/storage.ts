import { invoke, isTauri } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';
import {
  normalizeCalendarUrl,
  parseFeed,
  type CalendarFeed,
} from './calendar-feed-types';

export type Theme = 'system' | 'light' | 'dark';
export type PinScope = 'demo' | 'android';
export interface SavedConnection {
  serverUrl: string;
  token: string;
}
export interface PinnedApps {
  scope: PinScope;
  packageNames: string[];
}
export interface Favourites {
  scope: string;
  entityIds: string[];
}
export interface SelectedSpeaker {
  scope: string;
  entityId: string | null;
}
export interface StorageSnapshot {
  connection: SavedConnection | null;
  serverUrl: string;
  theme: Theme;
  pinnedApps: PinnedApps[];
  favourites: Favourites[];
  selectedSpeakers: SelectedSpeaker[];
  legacyImportComplete: boolean;
  calendarFeeds: CalendarFeed[];
}
interface LegacyPreferences {
  serverUrl?: string;
  theme?: Theme;
  pinnedApps: PinnedApps[];
  favourites: Favourites[];
  selectedSpeakers: SelectedSpeaker[];
  conciergeModel?: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const array = (value: unknown): value is unknown[] => Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  array(value) && value.every((item) => typeof item === 'string');
const isTheme = (value: unknown): value is Theme =>
  value === 'system' || value === 'light' || value === 'dark';
const isPinScope = (value: unknown): value is PinScope =>
  value === 'demo' || value === 'android';
const unreadable = () =>
  new Error(
    'Saved settings could not be read. Your saved data has not been changed.',
  );
async function nativeStorage(
  command: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  try {
    return await invoke<unknown>(command, args);
  } catch (cause: unknown) {
    if (cause instanceof Error) throw cause;
    throw new Error(
      typeof cause === 'string'
        ? cause
        : 'Could not save settings. Please try again.',
    );
  }
}

export function parseStorageSnapshot(value: unknown): StorageSnapshot {
  if (
    !record(value) ||
    typeof value.serverUrl !== 'string' ||
    !isTheme(value.theme) ||
    !array(value.pinnedApps) ||
    !array(value.favourites) ||
    !array(value.selectedSpeakers) ||
    !array(value.calendarFeeds) ||
    typeof value.legacyImportComplete !== 'boolean'
  )
    throw unreadable();
  let connection: SavedConnection | null = null;
  if (value.connection !== null) {
    if (
      !record(value.connection) ||
      typeof value.connection.serverUrl !== 'string' ||
      typeof value.connection.token !== 'string' ||
      value.connection.token.length === 0
    )
      throw unreadable();
    connection = {
      serverUrl: value.connection.serverUrl,
      token: value.connection.token,
    };
  }
  return {
    connection,
    serverUrl: value.serverUrl,
    theme: value.theme,
    legacyImportComplete: value.legacyImportComplete,
    calendarFeeds: value.calendarFeeds.map(parseFeed),
    pinnedApps: value.pinnedApps.map((item) => {
      if (
        !record(item) ||
        !isPinScope(item.scope) ||
        !strings(item.packageNames)
      )
        throw unreadable();
      return { scope: item.scope, packageNames: item.packageNames };
    }),
    favourites: value.favourites.map((item) => {
      if (
        !record(item) ||
        typeof item.scope !== 'string' ||
        !strings(item.entityIds)
      )
        throw unreadable();
      return { scope: item.scope, entityIds: item.entityIds };
    }),
    selectedSpeakers: value.selectedSpeakers.map((item) => {
      if (
        !record(item) ||
        typeof item.scope !== 'string' ||
        (item.entityId !== null && typeof item.entityId !== 'string')
      )
        throw unreadable();
      return { scope: item.scope, entityId: item.entityId };
    }),
  };
}

const emptySnapshot = (): StorageSnapshot => ({
  connection: null,
  serverUrl: '',
  theme: 'system',
  pinnedApps: [],
  favourites: [],
  selectedSpeakers: [],
  legacyImportComplete: false,
  calendarFeeds: [],
});
let snapshot = emptySnapshot();
let initialized: Promise<void> | undefined;
let writes: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getStorageSnapshot = () => snapshot;
export const useStorage = () =>
  useSyncExternalStore(subscribe, getStorageSnapshot);

/** Read legacy values only for a one-time native migration. Never write Web Storage. */
function legacyPreferences(): { legacy: LegacyPreferences; keys: string[] } {
  const legacy: LegacyPreferences = {
    pinnedApps: [],
    favourites: [],
    selectedSpeakers: [],
  };
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (
      !key ||
      !(
        key === 'hjem.server' ||
        key === 'hjem.theme' ||
        key === 'hjem.concierge.model' ||
        key.startsWith('hjem.favourites.') ||
        key === 'hjem.pinnedApps.demo' ||
        key === 'hjem.pinnedApps.android'
      )
    )
      continue;
    const text = localStorage.getItem(key);
    if (text === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw unreadable();
    }
    if (key === 'hjem.server' && typeof value === 'string')
      legacy.serverUrl = value;
    else if (key === 'hjem.theme' && isTheme(value)) legacy.theme = value;
    else if (key === 'hjem.concierge.model' && typeof value === 'string')
      legacy.conciergeModel = value;
    else if (key.startsWith('hjem.favourites.') && strings(value)) {
      legacy.favourites.push({
        scope: key.slice('hjem.favourites.'.length),
        entityIds: value,
      });
    } else if (key.startsWith('hjem.pinnedApps.') && strings(value)) {
      const scope = key.slice('hjem.pinnedApps.'.length);
      if (!isPinScope(scope)) throw unreadable();
      legacy.pinnedApps.push({ scope, packageNames: value });
    } else throw unreadable();
    keys.push(key);
  }
  return { legacy, keys };
}

export function initializeStorage(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    if (!isTauri()) return; // The web demo is ephemeral; installed apps use SQLite.
    snapshot = parseStorageSnapshot(await nativeStorage('storage_load'));
    if (!snapshot.legacyImportComplete) {
      const { legacy, keys } = legacyPreferences();
      snapshot = parseStorageSnapshot(
        await nativeStorage('storage_import_legacy', { legacy }),
      );
      for (const key of keys) localStorage.removeItem(key);
    }
    emit();
  })().catch((error: unknown) => {
    initialized = undefined;
    throw error;
  });
  return initialized;
}

function change(
  command: string,
  args: Record<string, unknown>,
  update: (current: StorageSnapshot) => StorageSnapshot,
): Promise<void> {
  const operation = writes
    .catch(() => {})
    .then(async () => {
      if (isTauri()) await nativeStorage(command, args);
      snapshot = update(snapshot);
      emit();
    });
  writes = operation;
  return operation;
}

export const saveConnection = (connection: SavedConnection) =>
  change('storage_save_connection', { connection }, (current) => ({
    ...current,
    connection,
    serverUrl: connection.serverUrl,
  }));
export const forgetConnection = () =>
  change('storage_clear_connection', {}, (current) => ({
    ...current,
    connection: null,
    serverUrl: '',
  }));
export const saveTheme = (theme: Theme) =>
  change('storage_set_theme', { theme }, (current) => ({ ...current, theme }));
export const savePinnedApps = (scope: PinScope, packageNames: string[]) =>
  change('storage_set_pinned_apps', { scope, packageNames }, (current) => ({
    ...current,
    pinnedApps: [
      ...current.pinnedApps.filter((item) => item.scope !== scope),
      { scope, packageNames },
    ],
  }));
export const saveFavourites = (scope: string, entityIds: string[]) =>
  change('storage_set_favourites', { scope, entityIds }, (current) => ({
    ...current,
    favourites: [
      ...current.favourites.filter((item) => item.scope !== scope),
      { scope, entityIds },
    ],
  }));
export const saveSelectedSpeaker = (scope: string, entityId: string | null) =>
  change('storage_set_selected_speaker', { scope, entityId }, (current) => ({
    ...current,
    selectedSpeakers: [
      ...current.selectedSpeakers.filter((item) => item.scope !== scope),
      { scope, entityId },
    ],
  }));

export async function addCalendarFeed(
  name: string,
  input: string,
): Promise<void> {
  const url = normalizeCalendarUrl(input);
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100)
    throw new Error('Enter a calendar name of up to 100 characters.');
  const operation = writes
    .catch(() => {})
    .then(async () => {
      if (snapshot.calendarFeeds.some((feed) => feed.url === url))
        throw new Error('This calendar link is already added.');
      const feed = isTauri()
        ? parseFeed(
            await nativeStorage('calendar_add_feed', { name: trimmed, url }),
          )
        : {
            id:
              Math.max(0, ...snapshot.calendarFeeds.map((item) => item.id)) + 1,
            name: trimmed,
            url,
          };
      snapshot = {
        ...snapshot,
        calendarFeeds: [...snapshot.calendarFeeds, feed],
      };
      emit();
    });
  writes = operation;
  return operation;
}
export const removeCalendarFeed = (id: number) =>
  change('calendar_remove_feed', { id }, (current) => ({
    ...current,
    calendarFeeds: current.calendarFeeds.filter((feed) => feed.id !== id),
  }));
