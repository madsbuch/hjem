import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getLauncherStatus,
  listInstalledApps,
  type LauncherApp,
} from './launcher';
import { readPreference, savePreference } from './entities';

const sampleApps: LauncherApp[] = [
  { packageName: 'preview.sonos', name: 'Sonos' },
  { packageName: 'preview.spotify', name: 'Spotify' },
  { packageName: 'preview.youtube', name: 'YouTube' },
  { packageName: 'preview.calendar', name: 'Calendar' },
  { packageName: 'preview.chrome', name: 'Chrome' },
  { packageName: 'preview.photos', name: 'Photos' },
];

function loadPins(key: string, fallback: string[]): string[] {
  const saved = readPreference<unknown>(key, fallback);
  return Array.isArray(saved)
    ? saved.filter((id): id is string => typeof id === 'string')
    : fallback;
}

export function useLauncher() {
  const [apps, setApps] = useState<LauncherApp[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  const [preview, setPreview] = useState(true);
  const [supported, setSupported] = useState(false);
  const [isDefaultHome, setIsDefaultHome] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const pinKey = `hjem.pinnedApps.${preview ? 'demo' : 'android'}`;

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
      setPinned(
        loadPins(
          `hjem.pinnedApps.${status.supported ? 'android' : 'demo'}`,
          discovered.slice(0, 6).map((app) => app.packageName),
        ),
      );
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

  const togglePin = (id: string) =>
    setPinned((current) => {
      const next = current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
      savePreference(pinKey, next);
      return next;
    });

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
