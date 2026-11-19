import { useEffect, useMemo, useRef, useState } from 'react';
import { ArchiveRestore, Download, LoaderCircle, Upload } from 'lucide-react';
import type { HassSnapshot } from '../lib/home-assistant';
import type { HomeSetup } from '../lib/home-setup-types';
import {
  applyImport,
  buildConfiguration,
  configurationFileName,
  exportMoods,
  exportRoutines,
  parseConfiguration,
  planImport,
  type ExportedSettings,
  type HjemConfiguration,
  type ImportPlan,
  type ImportProgress,
  type ImportResult,
} from '../lib/home-configuration';
import { openConfigurationFile, saveConfigurationFile } from '../lib/configuration-file';
import type { HomeReplica } from '../lib/home-replica';
import '../configuration-transfer.css';

interface Props {
  snapshot: HassSnapshot;
  getSnapshot: () => HassSnapshot;
  setup: HomeSetup | undefined;
  demo: boolean;
  /** Controls are unavailable or another setup change is running. */
  disabled: boolean;
  /** Use Android's system file picker rather than a browser download. */
  nativeFiles: boolean;
  collectSettings: () => ExportedSettings;
  /** Restores Hjem's own settings; resolves to any failures. */
  restoreSettings: (settings: ExportedSettings) => Promise<string[]>;
  onBusyChange: (busy: boolean) => void;
  notify: (text: string, error?: boolean) => void;
  /** Full copies of the home this device holds, newest first. */
  copies?: HomeReplica[];
  /** The Hjem hub this device is connected through, if any. */
  hubId?: string;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; label: string }
  | { kind: 'preview'; configuration: HjemConfiguration }
  | { kind: 'copies' }
  | { kind: 'applying'; progress: ImportProgress }
  | { kind: 'done'; result: ImportResult; unmatched: number };

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong. Please try again.';
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const savedOn = (time: number) => new Date(time).toLocaleString(undefined, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const contents = ({ document }: HomeReplica) => [
  plural(document.rooms.length, 'room'),
  plural(document.devices.length, 'device'),
  plural(document.moods.length, 'mood'),
  plural(document.routines.length, 'automation or script', 'automations and scripts'),
].join(', ');
const exportedOn = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : ` · exported ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`;
};

export function ConfigurationTransfer({
  snapshot, getSnapshot, setup, demo, disabled, nativeFiles, collectSettings, restoreSettings, onBusyChange, notify, copies = [], hubId,
}: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [withSettings, setWithSettings] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const busy = phase.kind === 'working' || phase.kind === 'applying';
  const onBusyRef = useRef(onBusyChange);
  onBusyRef.current = onBusyChange;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    onBusyRef.current(busy);
    return () => onBusyRef.current(false);
  }, [busy]);

  async function exportConfiguration() {
    if (!setup || busy) return;
    setPhase({ kind: 'working', label: 'Reading rooms, names, moods, and automations…' });
    try {
      const current = getSnapshot();
      const { moods, skipped } = await exportMoods(setup, current);
      const { routines, helpers } = await exportRoutines(setup, current);
      const configuration = buildConfiguration(current, moods, collectSettings(), new Date(), routines, helpers);
      if (!mounted.current) return;
      setPhase({ kind: 'working', label: 'Saving the file…' });
      const saved = await saveConfigurationFile(configurationFileName(), `${JSON.stringify(configuration, null, 2)}\n`, nativeFiles);
      if (!mounted.current) return;
      if (saved)
        notify(skipped.length
          ? `Configuration saved. ${plural(skipped.length, 'scene')} from other integrations ${skipped.length === 1 ? 'was' : 'were'} not included.`
          : 'Configuration saved.');
    } catch (error) {
      if (mounted.current) notify(errorMessage(error), true);
    } finally {
      if (mounted.current) setPhase({ kind: 'idle' });
    }
  }

  async function chooseFile() {
    if (busy) return;
    setPhase({ kind: 'working', label: 'Opening the file…' });
    try {
      const text = await openConfigurationFile(nativeFiles);
      if (!mounted.current) return;
      if (text === null) {
        setPhase({ kind: 'idle' });
        return;
      }
      const configuration = parseConfiguration(text);
      setPhase({ kind: 'preview', configuration });
    } catch (error) {
      if (!mounted.current) return;
      notify(errorMessage(error), true);
      setPhase({ kind: 'idle' });
    }
  }

  async function apply(configuration: HjemConfiguration, plan: ImportPlan) {
    if (!setup || busy) return;
    const abort = new AbortController();
    controller.current = abort;
    setPhase({ kind: 'applying', progress: { done: 0, total: 1, current: 'Starting…' } });
    try {
      const result = await applyImport(plan, setup, getSnapshot, (progress) => {
        if (mounted.current) setPhase({ kind: 'applying', progress });
      }, abort.signal);
      if (withSettings) {
        if (mounted.current) setPhase({ kind: 'applying', progress: { done: 1, total: 1, current: 'Restoring Hjem settings…' } });
        result.failures.push(...await restoreSettings(configuration.settings));
      }
      if (mounted.current) setPhase({ kind: 'done', result, unmatched: plan.unmatched.length });
    } catch (error) {
      if (!mounted.current) return;
      if (!isAbort(error)) notify(errorMessage(error), true);
      else notify('Import stopped. Changes made so far are kept and can be undone under Concierge.');
      setPhase({ kind: 'idle' });
    } finally {
      controller.current = null;
    }
  }

  // Recomputed as the home changes, so the preview always describes what Import will do.
  const preview = phase.kind === 'preview' ? phase.configuration : null;
  const plan = useMemo(() => preview ? planImport(preview, snapshot) : null, [preview, snapshot]);
  const steps = (plan: ImportPlan) => plan.roomsToCreate.length + plan.renames.length + plan.rooms.length + plan.moods.length + plan.helpers.length + plan.routines.length;

  return (
    <section className="settings-card configuration-card" aria-labelledby="configuration-title">
      <span className="settings-icon">
        <ArchiveRestore size={25} />
      </span>
      <h2 id="configuration-title">Move or back up your home</h2>
      <p>
        Save your rooms, the names and rooms of your lights, remotes, and other devices, your moods, automations, scripts,
        and helpers, and Hjem’s settings to a file. Import it after moving Home Assistant to a new Raspberry Pi, or onto a new tablet.
      </p>
      <p className="configuration-note">
        Access tokens and your OpenRouter key are never included. Calendar links are, so keep the file private.
        {demo && ' In the demo home, importing changes only the demo.'}
      </p>

      {phase.kind === 'idle' && (
        <div className="configuration-actions">
          <button className="primary-button" onClick={() => void exportConfiguration()} disabled={disabled || !setup}>
            <Download size={17} /> Export configuration
          </button>
          <button className="secondary-button" onClick={() => void chooseFile()} disabled={disabled || !setup}>
            <Upload size={17} /> Import configuration
          </button>
        </div>
      )}

      {copies.length > 0 && (phase.kind === 'idle' || phase.kind === 'copies') && (
        <div className="configuration-copies">
          <h3>On this device</h3>
          <p>
            {hubId && copies[0]?.hubId === hubId
              ? `This device keeps a full copy of your home from the Hjem hub, last updated ${savedOn(copies[0].savedAt)}.`
              : `This device holds a full copy of a home from another Hjem hub, saved ${copies[0] ? savedOn(copies[0].savedAt) : ''}.`}
            {' '}If the hub is ever replaced, the home can be brought back from here.
          </p>
          {phase.kind === 'idle' && (
            <button className="secondary-button" onClick={() => setPhase({ kind: 'copies' })} disabled={disabled || !setup}>
              <ArchiveRestore size={17} /> Restore from this device
            </button>
          )}
          {phase.kind === 'copies' && (
            <>
              <ul className="configuration-copy-list">
                {copies.map((copy) => (
                  <li key={`${copy.hubId}:${copy.revision}`}>
                    <button onClick={() => setPhase({ kind: 'preview', configuration: copy.document })}>
                      <strong>{copy.document.home_name} · {savedOn(copy.savedAt)}</strong>
                      <span>{contents(copy)}{hubId && copy.hubId !== hubId ? ' · from another hub' : ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <button className="secondary-button" onClick={() => setPhase({ kind: 'idle' })}>Cancel</button>
            </>
          )}
        </div>
      )}

      {phase.kind === 'working' && (
        <p className="configuration-status" role="status">
          <LoaderCircle size={16} className="spin" /> {phase.label}
        </p>
      )}

      {phase.kind === 'preview' && plan && (
        <div className="configuration-preview">
          <h3>
            {plan.homeName}
            <span>{exportedOn(plan.exportedAt)}</span>
          </h3>
          <ul>
            <li>{plan.matched} of {phase.configuration.devices.length} devices found on this server</li>
            {plan.roomsToCreate.length > 0 && <li>{plural(plan.roomsToCreate.length, 'room')} to create: {plan.roomsToCreate.join(', ')}</li>}
            {plan.renames.length > 0 && <li>{plural(plan.renames.length, 'name')} to restore</li>}
            {plan.rooms.length > 0 && <li>{plural(plan.rooms.length, 'device')} to put back in {plan.rooms.length === 1 ? 'its room' : 'their rooms'}</li>}
            {plan.moods.length > 0 && <li>{plural(plan.moods.length, 'mood')} to create: {plan.moods.map((mood) => mood.name).join(', ')}</li>}
            {plan.existingMoods.length > 0 && <li>{plural(plan.existingMoods.length, 'mood')} already here and left as {plan.existingMoods.length === 1 ? 'it is' : 'they are'}</li>}
            {plan.helpers.length > 0 && <li>{plural(plan.helpers.length, 'helper')} to create: {plan.helpers.map((helper) => helper.name).join(', ')}</li>}
            {plan.routines.length > 0 && <li>{plural(plan.routines.length, 'automation or script', 'automations and scripts')} to create: {plan.routines.map((routine) => routine.name).join(', ')}</li>}
            {plan.existingRoutines.length > 0 && <li>{plural(plan.existingRoutines.length, 'automation or script', 'automations and scripts')} already here and left as {plan.existingRoutines.length === 1 ? 'it is' : 'they are'}</li>}
            {steps(plan) === 0 && <li>Rooms, names, moods, and automations already match this copy.</li>}
          </ul>
          {plan.unmatched.length > 0 && (
            <details className="configuration-unmatched">
              <summary>{plural(plan.unmatched.length, 'device')} not on this server yet</summary>
              <p>Pair them with Add appliance in the Home planner, then import this file again. Hjem matches Zigbee devices by their hardware address, so their names and rooms come back.</p>
              <ul>
                {plan.unmatched.map((device) => (
                  <li key={device.key}>
                    {device.name ?? device.default_name ?? 'Unnamed device'}
                    {device.room && ` · ${device.room}`}
                    {device.model && <span> · {device.model}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <label className="configuration-check">
            <input type="checkbox" checked={withSettings} onChange={(event) => setWithSettings(event.target.checked)} />
            Also restore Hjem’s settings: appearance, calendars, pinned devices, music speaker, hidden apps, and Concierge model
          </label>
          <div className="configuration-actions">
            <button className="primary-button" onClick={() => void apply(phase.configuration, plan)} disabled={disabled || (steps(plan) === 0 && !withSettings)}>
              Import {steps(plan) ? plural(steps(plan), 'change') : 'settings'}
            </button>
            <button className="secondary-button" onClick={() => setPhase({ kind: 'idle' })}>Cancel</button>
          </div>
        </div>
      )}

      {phase.kind === 'applying' && (
        <div className="configuration-progress" role="status">
          <progress max={Math.max(1, phase.progress.total)} value={phase.progress.done} aria-label="Import progress" />
          <p>{phase.progress.current}</p>
          <button className="secondary-button" onClick={() => controller.current?.abort()}>Stop import</button>
        </div>
      )}

      {phase.kind === 'done' && (
        <div className="configuration-preview" role="status">
          <h3>Import finished</h3>
          <p>
            {plural(phase.result.applied, 'change')} applied
            {phase.unmatched > 0 && `. ${plural(phase.unmatched, 'device')} still to pair; import the file again afterwards`}.
            Setup changes can be undone under Concierge.
          </p>
          {phase.result.failures.length > 0 && (
            <ul className="configuration-failures">
              {phase.result.failures.map((failure) => <li key={failure}>{failure}</li>)}
            </ul>
          )}
          <div className="configuration-actions">
            <button className="secondary-button" onClick={() => setPhase({ kind: 'idle' })}>Done</button>
          </div>
        </div>
      )}
      {!setup && !demo && <p className="configuration-note">Connect to Home Assistant with access to its rooms and devices to export or import.</p>}
    </section>
  );
}
