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
  return invoke<LauncherStatus>('plugin:launcher|get_status');
}

export async function listInstalledApps(): Promise<LauncherApp[]> {
  if (!isTauri()) return [];
  return invoke<LauncherApp[]>('plugin:launcher|list_apps');
}

export async function launchApp(packageName: string): Promise<void> {
  if (!isTauri())
    throw new Error('Installed apps can only be opened in Hjem for Android.');
  return invoke<void>('plugin:launcher|launch_app', { packageName });
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
