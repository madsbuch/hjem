import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getLauncherStatus,
  listInstalledApps,
  type LauncherApp,
} from './launcher';
import { savePinnedApps, useStorage } from './storage';

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
  const pinScope = preview ? 'demo' : 'android';
  const pinned = storage.pinnedApps.find((item) => item.scope === pinScope)?.packageNames
    ?? apps.slice(0, 6).map((app) => app.packageName);

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

  const togglePin = (id: string) => {
    const next = pinned.includes(id) ? pinned.filter((item) => item !== id) : [...pinned, id];
    void savePinnedApps(pinScope, next).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Could not save pinned apps.');
    });
  };

  return {
    apps,
    pinned,
    preview,
    supported,
    isDefaultHome,
    loading,
    error,
    refresh,
    togglePin,
  };
}
