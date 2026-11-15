import { useCallback, useEffect, useRef, useState } from 'react';
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

export function useLauncher() {
  const storage = useStorage();
  const [apps, setApps] = useState<LauncherApp[]>([]);
  const [preview, setPreview] = useState(true);
  const [supported, setSupported] = useState(false);
  const [isDefaultHome, setIsDefaultHome] = useState(false);
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
    loading,
    error,
    refresh,
  };
}
