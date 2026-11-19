import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HomeAssistantClient, type ConnectionStatus, type HassSnapshot } from '../src/lib/home-assistant';
import { HomeSetupManager } from '../src/lib/home-setup';
import { isRecord } from '../src/lib/home-assistant-protocol';
import { helperDomains } from '../src/lib/home-setup-types';
import {
  buildConfiguration,
  exportMoods,
  exportRoutines,
  parseConfiguration,
  type ExportedSettings,
  type HjemConfiguration,
} from '../src/lib/home-configuration';

/** The whole home as one document, numbered so every device knows whether its copy is current. */
export interface HomeRecord {
  revision: number;
  updated_at: string;
  document: HjemConfiguration;
}
interface Options {
  haUrl: string;
  haToken: string;
  file: string;
  log: (line: string) => void;
  /** How long the home must stay quiet before it is read again. */
  settle?: number;
  /** A full re-read catches edits that leave no trace in live state. */
  interval?: number;
}

/** Device settings are each device's own; the hub's copy carries none. */
const noSettings: ExportedSettings = {
  theme: 'system', calendars: [], favourites: [], selected_speaker: null, hidden_apps: [], pinned_apps: [], concierge_model: '',
};
const tracked = new Set<string>(['scene', 'automation', 'script', ...helperDomains]);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const digest = (document: HjemConfiguration) =>
  createHash('sha256').update(canonical({ ...document, exported_at: '' })).digest('hex');

/**
 * Keeps the home document current. It reads the home through the same
 * validated setup code as the app, and only ever replaces the saved copy
 * with a complete one: a failed read leaves the previous copy in place.
 */
export class HomeDocumentService {
  private readonly client: HomeAssistantClient;
  private readonly setup: HomeSetupManager;
  private readonly listeners = new Set<(record: HomeRecord) => void>();
  private record: HomeRecord | null = null;
  private hash = '';
  private status: ConnectionStatus = 'disconnected';
  private timer?: ReturnType<typeof setTimeout>;
  private periodic?: ReturnType<typeof setInterval>;
  private building = false;
  private again = false;
  private structure: unknown[] = [];
  private routines = '';
  private stopped = false;
  private reading: Promise<void> = Promise.resolve();

  constructor(private readonly options: Options) {
    this.client = new HomeAssistantClient({
      onSnapshot: (snapshot) => this.observe(snapshot),
      onStatus: (status, message) => {
        if (status !== this.status) options.log(`Home Assistant: ${status}${message ? ` (${message})` : ''}`);
        this.status = status;
        if (status === 'connected') this.schedule(0);
      },
    });
    this.setup = new HomeSetupManager({ transport: this.client, demo: false, isCurrent: () => !this.stopped });
  }

  async start(): Promise<void> {
    try {
      const saved: unknown = JSON.parse(await readFile(this.options.file, 'utf8'));
      if (isRecord(saved) && typeof saved.revision === 'number' && typeof saved.updated_at === 'string') {
        const document = parseConfiguration(JSON.stringify(saved.document));
        this.record = { revision: saved.revision, updated_at: saved.updated_at, document };
        this.hash = digest(document);
      }
    } catch {
      // No saved copy yet, or an unreadable one: the next read of the home writes a fresh one.
    }
    this.periodic = setInterval(() => this.schedule(0), this.options.interval ?? 15 * 60_000);
    void this.client.connect(this.options.haUrl, this.options.haToken, { retryInitial: true }).catch((error: unknown) => {
      this.options.log(`Home Assistant could not be reached: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
  }

  /** Stop reading the home; resolves once a read that was under way has finished with its files. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.periodic);
    this.client.disconnect();
    await this.reading;
  }

  current(): HomeRecord | null {
    return this.record;
  }

  get connected(): boolean {
    return this.status === 'connected';
  }

  onChange(listener: (record: HomeRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Read the home again soon; repeated requests while it settles count once. */
  schedule(delay = this.options.settle ?? 5_000): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    // Reads run one after another, so stopping can wait for the one under way.
    this.timer = setTimeout(() => { this.reading = this.reading.then(() => this.build()); }, delay);
  }

  /** Rooms, names, and the list of moods and routines changing means the document may have. */
  private observe(snapshot: HassSnapshot): void {
    const structure = [snapshot.areas, snapshot.devices, snapshot.registry, snapshot.locationName];
    const routines = snapshot.entities
      .filter((entity) => tracked.has(entity.entity_id.split('.')[0] ?? ''))
      .map((entity) => `${entity.entity_id}|${String(entity.attributes.friendly_name)}|${entity.entity_id.startsWith('automation.') ? entity.state : ''}`)
      .join('\n');
    if (routines === this.routines && structure.every((part, index) => part === this.structure[index])) return;
    this.structure = structure;
    this.routines = routines;
    this.schedule();
  }

  private async build(): Promise<void> {
    if (this.stopped || this.status !== 'connected') return;
    if (this.building) {
      this.again = true;
      return;
    }
    this.building = true;
    try {
      await this.client.refreshStates();
      const snapshot = await this.client.refreshStructure();
      const { moods } = await exportMoods(this.setup, snapshot, true);
      const { routines, helpers } = await exportRoutines(this.setup, snapshot, true);
      const now = new Date();
      const document = buildConfiguration(snapshot, moods, noSettings, now, routines, helpers);
      const hash = digest(document);
      if (hash === this.hash || this.stopped) return;
      const record: HomeRecord = { revision: (this.record?.revision ?? 0) + 1, updated_at: now.toISOString(), document };
      await mkdir(dirname(this.options.file), { recursive: true });
      await writeFile(`${this.options.file}.tmp`, JSON.stringify(record));
      await rename(`${this.options.file}.tmp`, this.options.file);
      this.record = record;
      this.hash = hash;
      this.options.log(`Home copy ${record.revision}: ${document.rooms.length} rooms, ${document.devices.length} devices, ${document.moods.length} moods, ${document.routines.length} automations and scripts.`);
      for (const listener of this.listeners) listener(record);
    } catch (error) {
      this.options.log(`The home could not be read completely; keeping the previous copy. ${error instanceof Error ? error.message : ''}`);
    } finally {
      this.building = false;
      if (this.again) {
        this.again = false;
        this.schedule();
      }
    }
  }
}
