import type { Page } from '@playwright/test';
import type { LauncherApp } from '../../src/lib/launcher';
import {
  parseStorageSnapshot,
  type StorageSnapshot,
} from '../../src/lib/storage';

declare global {
  interface Window {
    __hjemStorageInvoke: (command: string, args?: unknown) => Promise<unknown>;
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** IPC fixture persists in the test process across WebView reloads. Real SQLite
 * migrations/restarts are tested separately in database.rs. */
export async function nativeStorage(
  page: Page,
  initial: Partial<StorageSnapshot> = {},
) {
  let snapshot: StorageSnapshot = {
    serverUrl: '',
    connection: null,
    theme: 'system',
    pinnedApps: [],
    hiddenApps: [],
    favourites: [],
    selectedSpeakers: [],
    calendarFeeds: [],
    legacyImportComplete: true,
    ...initial,
  };
  let failedCommand = '';
  let concierge = { hasApiKey: false, model: '' };
  let launcherSupported = false;
  let launcherApps: LauncherApp[] = [];
  const commands: string[] = [];
  const feedResponses = new Map<string, string | Error>();
  const feedFetches: number[] = [];
  let nextFeedId = Math.max(0, ...snapshot.calendarFeeds.map((feed) => feed.id)) + 1;
  await page.exposeFunction(
    '__hjemStorageInvoke',
    (command: string, raw: unknown = {}) => {
      commands.push(command);
      if (command === failedCommand)
        throw new Error('Could not save settings. Please try again.');
      if (!record(raw)) throw new Error('Expected structured IPC arguments');
      if (command === 'storage_load') return structuredClone(snapshot);
      if (command === 'calendar_add_feed') {
        if (typeof raw.name !== 'string' || typeof raw.url !== 'string')
          throw new Error('Missing calendar name or URL');
        if (snapshot.calendarFeeds.some((feed) => feed.url === raw.url))
          throw new Error('This calendar link is already added.');
        const feed = { id: nextFeedId++, name: raw.name, url: raw.url };
        snapshot = parseStorageSnapshot({ ...snapshot, calendarFeeds: [...snapshot.calendarFeeds, feed] });
        return structuredClone(feed);
      } else if (command === 'calendar_remove_feed') {
        if (typeof raw.id !== 'number') throw new Error('Missing calendar ID');
        snapshot = { ...snapshot, calendarFeeds: snapshot.calendarFeeds.filter((feed) => feed.id !== raw.id) };
      } else if (command === 'calendar_fetch_feed') {
        if (typeof raw.id !== 'number') throw new Error('Missing calendar ID');
        const feed = snapshot.calendarFeeds.find((item) => item.id === raw.id);
        if (!feed) throw new Error('This calendar is no longer saved.');
        feedFetches.push(feed.id);
        const response = feedResponses.get(feed.url);
        if (response instanceof Error) throw response;
        return response ?? 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Hjem//Test fixture//EN\r\nEND:VCALENDAR\r\n';
      } else if (command === 'storage_save_connection') {
        if (!record(raw.connection)) throw new Error('Missing connection');
        snapshot = parseStorageSnapshot({
          ...snapshot,
          connection: raw.connection,
          serverUrl: raw.connection.serverUrl,
        });
      } else if (command === 'storage_clear_connection') {
        snapshot = { ...snapshot, connection: null, serverUrl: '' };
      } else if (command === 'storage_set_theme') {
        snapshot = parseStorageSnapshot({ ...snapshot, theme: raw.theme });
      } else if (command === 'storage_set_pinned_apps') {
        snapshot = parseStorageSnapshot({
          ...snapshot,
          pinnedApps: [
            ...snapshot.pinnedApps.filter((item) => item.scope !== raw.scope),
            raw,
          ],
        });
      } else if (command === 'storage_set_app_hidden') {
        if ((raw.scope !== 'demo' && raw.scope !== 'android') ||
          typeof raw.packageName !== 'string' || typeof raw.hidden !== 'boolean')
          throw new Error('Missing app visibility settings');
        const previous = snapshot.hiddenApps.find((item) => item.scope === raw.scope)?.packageNames ?? [];
        const packageNames = raw.hidden
          ? [...new Set([...previous, raw.packageName])]
          : previous.filter((name) => name !== raw.packageName);
        snapshot = parseStorageSnapshot({
          ...snapshot,
          hiddenApps: [
            ...snapshot.hiddenApps.filter((item) => item.scope !== raw.scope),
            { scope: raw.scope, packageNames },
          ],
        });
      } else if (command === 'storage_set_favourites') {
        snapshot = parseStorageSnapshot({
          ...snapshot,
          favourites: [
            ...snapshot.favourites.filter((item) => item.scope !== raw.scope),
            raw,
          ],
        });
      } else if (command === 'storage_set_selected_speaker') {
        snapshot = parseStorageSnapshot({
          ...snapshot,
          selectedSpeakers: [
            ...snapshot.selectedSpeakers.filter(
              (item) => item.scope !== raw.scope,
            ),
            raw,
          ],
        });
      } else if (command === 'storage_import_legacy') {
        if (!record(raw.legacy)) throw new Error('Missing legacy preferences');
        snapshot = parseStorageSnapshot({
          ...snapshot,
          ...raw.legacy,
          legacyImportComplete: true,
        });
        return structuredClone(snapshot);
      } else if (command === 'plugin:launcher|get_status')
        return { supported: launcherSupported, isDefaultHome: launcherSupported };
      else if (command === 'plugin:launcher|list_apps') return structuredClone(launcherApps);
      else if (command === 'plugin:launcher|register_listener' || command === 'plugin:launcher|remove_listener') return null;
      else if (command === 'plugin:launcher|launch_app') {
        if (typeof raw.packageName !== 'string' || !launcherApps.some((app) => app.packageName === raw.packageName))
          throw new Error('App is not installed.');
        return null;
      }
      else if (command === 'concierge_get_settings') return { ...concierge };
      else if (command === 'concierge_save_settings') {
        if (typeof raw.model !== 'string') throw new Error('Expected model');
        concierge = {
          hasApiKey: concierge.hasApiKey || typeof raw.apiKey === 'string',
          model: raw.model,
        };
        return { ...concierge };
      } else if (command === 'concierge_clear_key') {
        concierge.hasApiKey = false;
        return { ...concierge };
      } else if (command === 'concierge_list_models') return [];
      else throw new Error(`Unexpected IPC command: ${command}`);
      return null;
    },
  );
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: window.__hjemStorageInvoke, transformCallback: () => 1 },
    });
  });
  return {
    get snapshot() {
      return structuredClone(snapshot);
    },
    commands,
    feedFetches,
    setAndroidApps(apps: LauncherApp[]) {
      launcherSupported = true;
      launcherApps = structuredClone(apps);
    },
    setPreviewLauncher() {
      launcherSupported = false;
    },
    setFeedResponse(url: string, text: string) {
      feedResponses.set(url, text);
    },
    setFeedError(url: string, message: string) {
      feedResponses.set(url, new Error(message));
    },
    fail(command: string) {
      failedCommand = command;
    },
  };
}
