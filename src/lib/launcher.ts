import { addPluginListener, invoke, isTauri } from '@tauri-apps/api/core';

export interface LauncherApp {
  packageName: string;
  name: string;
  icon?: string;
}

export interface LauncherStatus {
  supported: boolean;
  isDefaultHome: boolean;
}

export async function getLauncherStatus(): Promise<LauncherStatus> {
  if (!isTauri()) return { supported: false, isDefaultHome: false };
  const value = await invoke<unknown>('plugin:launcher|get_status');
  if (!record(value) || typeof value.supported !== 'boolean' || typeof value.isDefaultHome !== 'boolean')
    throw new Error('Android returned an unreadable launcher status.');
  return { supported: value.supported, isDefaultHome: value.isDefaultHome };
}

export async function listInstalledApps(): Promise<LauncherApp[]> {
  if (!isTauri()) return [];
  const value = await invoke<unknown>('plugin:launcher|list_apps');
  if (!unknownArray(value)) throw new Error('Android returned an unreadable app list.');
  return value.map((app) => {
    if (!record(app) || typeof app.packageName !== 'string' || typeof app.name !== 'string' ||
      (app.icon !== undefined && typeof app.icon !== 'string')) throw new Error('Android returned an unreadable app.');
    return { packageName: app.packageName, name: app.name, ...(typeof app.icon === 'string' ? { icon: app.icon } : {}) };
  });
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const unknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

export async function launchApp(packageName: string): Promise<void> {
  if (!isTauri())
    throw new Error('Installed apps can only be opened in Hjem for Android.');
  return invoke<void>('plugin:launcher|launch_app', { packageName });
}

export async function uninstallApp(packageName: string): Promise<void> {
  if (!isTauri())
    throw new Error('App management is available in Hjem for Android.');
  await invoke<unknown>('plugin:launcher|uninstall_app', { packageName });
}

export async function openAppInfo(packageName: string): Promise<void> {
  if (!isTauri())
    throw new Error('App management is available in Hjem for Android.');
  await invoke<unknown>('plugin:launcher|open_app_info', { packageName });
}

export async function openHomeSettings(): Promise<void> {
  if (!isTauri())
    throw new Error(
      'Choosing Hjem as your home screen is available on Android.',
    );
  return invoke<void>('plugin:launcher|open_home_settings');
}

/** Android delivers this when Home is pressed while Hjem's activity already exists. */
export async function onHomeRequested(
  callback: () => void,
): Promise<() => void> {
  if (!(await getLauncherStatus()).supported) return () => {};
  const listener = await addPluginListener(
    'launcher',
    'homeRequested',
    callback,
  );
  return () => {
    void listener.unregister().catch(() => undefined);
  };
}
