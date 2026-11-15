import type { Page } from '@playwright/test';
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
    favourites: [],
    selectedSpeakers: [],
    legacyImportComplete: true,
    ...initial,
  };
  let failedCommand = '';
  let concierge = { hasApiKey: false, model: '' };
  const commands: string[] = [];
  await page.exposeFunction(
    '__hjemStorageInvoke',
    (command: string, raw: unknown = {}) => {
      commands.push(command);
      if (command === failedCommand)
        throw new Error('Could not save settings. Please try again.');
      if (!record(raw)) throw new Error('Expected structured IPC arguments');
      if (command === 'storage_load') return structuredClone(snapshot);
      if (command === 'storage_save_connection') {
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
        return { supported: false, isDefaultHome: false };
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
      __TAURI_INTERNALS__: { invoke: window.__hjemStorageInvoke },
    });
  });
  return {
    get snapshot() {
      return structuredClone(snapshot);
    },
    commands,
    fail(command: string) {
      failedCommand = command;
    },
  };
}
