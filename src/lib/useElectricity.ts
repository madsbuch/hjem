import { useCallback, useEffect, useRef, useState } from 'react';
import {
  demoElectricity,
  electricityAvailable,
  getElectricitySettings,
  loadElectricity,
  localDate,
  type ElectricityData,
  type ElectricitySettings,
} from './electricity';

const REFRESH_MS = 60 * 60 * 1000;
/** A manual or foreground refresh never runs more often than this. */
const MIN_GAP_MS = 5 * 60 * 1000;

export interface ElectricityState {
  /** demo: sample data; setup: no key or location yet; live: Osmund data. */
  source: 'demo' | 'setup' | 'live';
  data: ElectricityData | null;
  loading: boolean;
  error: string;
  settings: ElectricitySettings;
  setSettings: (settings: ElectricitySettings) => void;
  refresh: () => void;
}

/**
 * Six Osmund requests per load: on open, hourly, on a new day, when Hjem
 * returns to the foreground, and on demand, never closer than five minutes.
 * That stays far inside Osmund's 120 requests an hour and 1000 a day.
 */
export function useElectricity(demo: boolean, now: Date): ElectricityState {
  const [settings, setSettings] = useState<ElectricitySettings>({ hasApiKey: false, locationId: null });
  const [data, setData] = useState<ElectricityData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const lastLoad = useRef(0);
  const generation = useRef(0);
  const native = electricityAvailable();
  const configured = native && settings.hasApiKey && !!settings.locationId;
  const source: ElectricityState['source'] = configured ? 'live' : demo ? 'demo' : 'setup';
  const today = localDate(now);
  const hour = now.getHours();

  useEffect(() => {
    let active = true;
    void getElectricitySettings()
      .then((value) => { if (active) setSettings(value); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Electricity settings could not be read.'); });
    return () => { active = false; };
  }, []);

  const load = useCallback((force: boolean) => {
    if (!configured) return;
    if (!force && Date.now() - lastLoad.current < MIN_GAP_MS) return;
    lastLoad.current = Date.now();
    const current = ++generation.current;
    setLoading(true);
    void loadElectricity(new Date())
      .then((value) => {
        if (current !== generation.current) return;
        setData(value);
        setError('');
      })
      .catch((cause: unknown) => {
        if (current === generation.current) setError(cause instanceof Error ? cause.message : 'Osmund could not be reached.');
      })
      .finally(() => { if (current === generation.current) setLoading(false); });
  }, [configured]);

  // A new key or location starts over; a new day reloads straight away.
  useEffect(() => {
    generation.current++;
    setData(null);
    setLoading(false);
    if (configured) load(true);
  }, [configured, settings.locationId, today, load]);

  useEffect(() => {
    if (!configured) return;
    const timer = setInterval(() => load(true), REFRESH_MS);
    const visible = () => { if (document.visibilityState === 'visible') load(false); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [configured, load]);

  // The demo is regenerated each hour so "now" and tomorrow's prices move with the clock.
  useEffect(() => {
    if (source === 'demo') setData(demoElectricity(new Date()));
  }, [source, today, hour]);

  return {
    source,
    data: source === 'setup' ? null : data,
    loading,
    error,
    settings,
    setSettings,
    refresh: () => load(false),
  };
}
