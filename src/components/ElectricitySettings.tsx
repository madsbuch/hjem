import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, LoaderCircle, Zap } from 'lucide-react';
import {
  clearElectricity,
  electricityAvailable,
  fetchElectricity,
  parseLocations,
  saveElectricityKey,
  setElectricityLocation,
  type ElectricitySettings as Settings,
  type OsmundLocation,
} from '../lib/electricity';

interface Props {
  settings: Settings;
  onChange: (settings: Settings) => void;
  notify: (text: string, error?: boolean) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : 'Osmund could not be reached.');
const stateNames: Record<string, string> = { active: 'Supplied now', upcoming: 'Starts later', pending: 'Ordered', ended: 'Ended' };

/** Connect an Osmund key and choose which location the Electricity page shows. */
export function ElectricitySettings({ settings, onChange, notify }: Props) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [locations, setLocations] = useState<OsmundLocation[] | null>(null);
  const [choosing, setChoosing] = useState(false);
  const native = electricityAvailable();
  const needsLocation = settings.hasApiKey && (!settings.locationId || choosing);
  // App recreates these on every render; the request below must not restart because of it.
  const callbacks = useRef({ onChange, notify });
  callbacks.current = { onChange, notify };

  useEffect(() => {
    if (!native || !needsLocation || locations) return;
    let active = true;
    void fetchElectricity({ kind: 'locations' })
      .then(parseLocations)
      .then(async (found) => {
        if (!active) return;
        setLocations(found);
        const open = found.filter((location) => location.apiAccess === 'open');
        const [only] = open;
        // One open location needs no choice.
        if (open.length === 1 && only && !settings.locationId) {
          callbacks.current.onChange(await setElectricityLocation(only.id));
          callbacks.current.notify('Osmund connected.');
        }
      })
      .catch((error: unknown) => { if (active) callbacks.current.notify(message(error), true); });
    return () => { active = false; };
  }, [native, needsLocation, locations, settings.locationId]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    try {
      setLocations(null);
      onChange(await saveElectricityKey(key));
      setKey('');
    } catch (error) {
      notify(message(error), true);
    } finally {
      setBusy(false);
    }
  }

  async function choose(id: string) {
    setBusy(true);
    try {
      onChange(await setElectricityLocation(id));
      setChoosing(false);
      notify('Location saved.');
    } catch (error) {
      notify(message(error), true);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      onChange(await clearElectricity());
      setLocations(null);
      setChoosing(false);
      notify('Osmund key removed.');
    } catch (error) {
      notify(message(error), true);
    } finally {
      setBusy(false);
    }
  }

  const current = locations?.find((location) => location.id === settings.locationId);
  return (
    <section className="settings-card electricity-settings" aria-labelledby="electricity-settings-title">
      <span className="settings-icon amber"><Zap size={25} /></span>
      <h2 id="electricity-settings-title">Electricity</h2>
      <p>
        See prices by the hour, the cheapest hours, and your use and cost from Osmund. Create an API key on Min side at
        osmundenergi.dk. API access is part of Osmund Pro.
      </p>
      {!native ? (
        <p className="electricity-settings-note">
          Connect Osmund in the installed Hjem app; the key is kept in its private storage. This preview shows sample prices.
        </p>
      ) : !settings.hasApiKey ? (
        <form className="electricity-key-form" onSubmit={(event) => void connect(event)}>
          <label className="field-label" htmlFor="osmund-key">Osmund API key</label>
          <input
            id="osmund-key"
            className="text-input"
            type="password"
            autoComplete="off"
            placeholder="osm_…"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            disabled={busy}
          />
          <p className="field-help">Hjem checks the key with Osmund before saving it. It only reads your data and stays on this tablet.</p>
          <button className="primary-button" type="submit" disabled={busy || !key.trim()}>
            {busy ? <LoaderCircle size={17} className="spin" /> : null} Connect Osmund <ArrowRight size={17} />
          </button>
        </form>
      ) : needsLocation ? (
        <fieldset className="electricity-locations" disabled={busy}>
          <legend>Which location should Hjem show?</legend>
          {!locations && <p><LoaderCircle size={15} className="spin" /> Getting your locations…</p>}
          {locations?.length === 0 && <p>This Osmund account has no locations yet.</p>}
          {locations?.map((location) => (
            <button
              key={location.id}
              type="button"
              className={`electricity-location ${location.id === settings.locationId ? 'selected' : ''}`}
              disabled={location.apiAccess !== 'open'}
              onClick={() => void choose(location.id)}
            >
              <strong>{location.priceArea ?? 'Price area unknown'} · {stateNames[location.state] ?? location.state}</strong>
              <span>{location.apiAccess === 'open' ? `Location ${location.id.slice(0, 8)}…` : 'API access not included here'}</span>
            </button>
          ))}
          <button type="button" className="text-button" onClick={() => void remove()}>Use another key</button>
        </fieldset>
      ) : (
        <>
          <div className="setting-row">
            <span>Osmund</span>
            <strong>Connected{current?.priceArea ? ` · ${current.priceArea}` : ''}</strong>
          </div>
          <div className="electricity-settings-actions">
            <button className="secondary-button" onClick={() => { setLocations(null); setChoosing(true); }} disabled={busy}>Change location</button>
            <button className="text-button disconnect" onClick={() => void remove()} disabled={busy}>Remove key</button>
          </div>
        </>
      )}
    </section>
  );
}
