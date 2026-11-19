import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import {
  getLauncherStatus,
  listInstalledApps,
  type LauncherApp,
} from './launcher';
import { setAppHidden, useStorage } from './storage';

const sampleApps: LauncherApp[] = [
  { packageName: 'preview.sonos', name: 'Sonos' },
  { packageName: 'preview.spotify', name: 'Spotify' },
  { packageName: 'preview.youtube', name: 'YouTube' },
  { packageName: 'preview.calendar', name: 'Calendar' },
  { packageName: 'preview.chrome', name: 'Chrome' },
  { packageName: 'preview.photos', name: 'Photos' },
];

const MODE_KEY = 'hjem-home-screen';
/**
 * Whether Hjem is this device's home screen, or just one of its apps. Android
 * decides; the last answer is remembered so the menu does not change shape
 * while Hjem starts. Where there is no Android launcher (the browser preview,
 * desktop, iOS) Hjem shows its sample apps as before.
 */
function rememberedHomeScreen(): boolean {
  try {
    return !isTauri() || localStorage.getItem(MODE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function useLauncher() {
  const storage = useStorage();
  const [apps, setApps] = useState<LauncherApp[]>([]);
  const [preview, setPreview] = useState(true);
  const [supported, setSupported] = useState(false);
  const [isDefaultHome, setIsDefaultHome] = useState(false);
  const [homeScreen, setHomeScreen] = useState(rememberedHomeScreen);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const appScope = preview ? 'demo' : 'android';
  const hidden = storage.hiddenApps.find((item) => item.scope === appScope)?.packageNames ?? [];

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const status = await getLauncherStatus();
      const discovered = status.supported
        ? await listInstalledApps()
        : sampleApps;
      if (current !== generation.current) return;
      setSupported(status.supported);
      setIsDefaultHome(status.isDefaultHome);
      // On a phone Hjem is an app like any other; on the tablet it is the home screen.
      const home = !status.supported || status.isDefaultHome;
      setHomeScreen(home);
      if (status.supported) {
        try {
          localStorage.setItem(MODE_KEY, home ? '1' : '0');
        } catch {
          // Without storage the mode is simply asked again next time.
        }
      }
      setPreview(!status.supported);
      setApps(discovered);
    } catch (cause) {
      if (current !== generation.current) return;
      setPreview(false);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not load installed apps. Please try again.',
      );
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      generation.current++;
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return {
    apps: apps.filter((app) => !hidden.includes(app.packageName)),
    allApps: apps,
    hidden,
    setHidden: (packageName: string, value: boolean) => setAppHidden(appScope, packageName, value),
    preview,
    supported,
    isDefaultHome,
    /** Hjem is this device's home screen, so it shows and opens the device's apps. */
    homeScreen,
    loading,
    error,
    refresh,
  };
}
