import { describe, expect, it } from 'vitest';
import { demoSnapshot } from './demo';
import { DemoHomeSetupTransport } from './demo-home-setup';
import { HomeSetupManager } from './home-setup';
import type { HassSnapshot } from './home-assistant';
import { applyImport, buildConfiguration, exportMoods, exportRoutines, parseConfiguration, planImport, type ExportedSettings, type HjemConfiguration } from './home-configuration';
import { COPIES_PER_HUB, listReplicas, replicaFrom, retained, saveReplica, type HomeReplica } from './home-replica';

const settings: ExportedSettings = { theme: 'dark', calendars: [], favourites: [], selected_speaker: null, hidden_apps: [], pinned_apps: [], concierge_model: '' };
function home(snapshot: HassSnapshot = structuredClone(demoSnapshot)) {
  let current = snapshot;
  const transport = new DemoHomeSetupTransport({ getSnapshot: () => current, setSnapshot: (value) => { current = value; } });
  const setup = new HomeSetupManager({ transport, demo: true, isCurrent: () => true });
  return { setup, transport, snapshot: () => current };
}
async function exported(source = home()): Promise<HjemConfiguration> {
  const { moods } = await exportMoods(source.setup, source.snapshot(), true);
  const { routines, helpers } = await exportRoutines(source.setup, source.snapshot(), true);
  return parseConfiguration(JSON.stringify(buildConfiguration(source.snapshot(), moods, settings, new Date(), routines, helpers)));
}
const copy = (hubId: string, revision: number, savedAt: number, document: HjemConfiguration): HomeReplica => ({ hubId, revision, savedAt, document });

describe('a full copy of the home', () => {
  it('carries automations, scripts, and helpers with what they refer to', async () => {
    const document = await exported();
    expect(document.helpers).toEqual([{ domain: 'input_datetime', name: 'Wake-up time', settings: { has_date: false, has_time: true } }]);
    expect(document.routines.map((routine) => [routine.kind, routine.name, routine.enabled])).toEqual([
      ['script', 'Movie time', true],
      ['automation', 'Welcome home light', true],
      ['automation', 'Dimmer switch turns on the bedside lamp', true],
      ['automation', 'Wake up gently', false],
    ]);
    const dimmer = document.routines.find((routine) => routine.name.startsWith('Dimmer'));
    expect(dimmer?.config).not.toHaveProperty('id');
    expect(dimmer?.entities).toEqual(expect.arrayContaining([
      { device: expect.stringMatching(/^zigbee:/), entity_id: 'event.remote_dimmer_action' },
      { device: expect.stringMatching(/^zigbee:/), entity_id: 'light.bedside' },
    ]));
  });

  it('restores routines onto a new server where the same devices have new ids', async () => {
    const document = await exported();
    // The new server: same hardware, but Home Assistant's own ids and names differ, and nothing is set up.
    const fresh = structuredClone(demoSnapshot);
    const renamed = (id: string) => id === 'light.bedside' ? 'light.tradfri_bulb_3' : id;
    fresh.areas = [];
    fresh.devices = fresh.devices.map((device) => ({ ...device, id: `new_${device.id}`, area_id: null }));
    fresh.registry = fresh.registry.filter((entry) => entry.device_id).map((entry) => ({ ...entry, entity_id: renamed(entry.entity_id), device_id: `new_${entry.device_id}` }));
    fresh.entities = fresh.entities.filter((entity) => !/^(automation|script|scene|input_datetime)\./.test(entity.entity_id)).map((entity) => ({ ...entity, entity_id: renamed(entity.entity_id) }));
    const target = home(fresh);
    // Its demo transport starts with the sample routines stored; a new server has none.
    for (const kind of ['automation', 'script'] as const)
      for (const id of ['demo_welcome_light', 'demo_bedside_dimmer', 'demo_wake_up', 'movie_time']) await target.transport.deleteRoutine(kind, id).catch(() => undefined);
    await target.transport.deleteHelper('input_datetime', 'wake_up_time');

    const plan = planImport(document, target.snapshot());
    expect(plan.helpers.map((helper) => helper.name)).toEqual(['Wake-up time']);
    expect(plan.routines).toHaveLength(4);
    const result = await applyImport(plan, target.setup, target.snapshot, () => undefined);
    // The demo gives a recreated mood a new id, so the script that activates it is reported rather than guessed at.
    // Home Assistant names a scene after its name, so there the script finds it.
    expect(result.failures.filter((failure) => !failure.includes('Movie time'))).toEqual([]);
    const names = target.snapshot().entities.filter((entity) => entity.entity_id.startsWith('automation.')).map((entity) => [entity.attributes.friendly_name, entity.state]);
    expect(names).toEqual(expect.arrayContaining([['Welcome home light', 'on'], ['Dimmer switch turns on the bedside lamp', 'on'], ['Wake up gently', 'off']]));
    const dimmer = target.snapshot().entities.find((entity) => entity.attributes.friendly_name === 'Dimmer switch turns on the bedside lamp');
    const saved = await target.transport.readRoutine('automation', String(dimmer?.attributes.id));
    expect(saved.actions).toEqual([{ action: 'light.turn_on', target: { entity_id: 'light.tradfri_bulb_3' }, data: { brightness_pct: 40 } }]);
    // Importing the same copy again changes nothing.
    const again = planImport(document, target.snapshot());
    expect(again.helpers).toEqual([]);
    expect(again.routines.map((routine) => routine.name).filter((name) => name !== 'Movie time')).toEqual([]);
  });

  it('reads files written before routines were included', () => {
    const old = parseConfiguration(JSON.stringify({ format: 'hjem-configuration', version: 1, home_name: 'Home', rooms: ['Hall'], devices: [], moods: [] }));
    expect(old).toMatchObject({ rooms: ['Hall'], routines: [], helpers: [] });
    expect(planImport(old, structuredClone(demoSnapshot))).toMatchObject({ routines: [], helpers: [], existingRoutines: [] });
  });
});

describe('copies kept on a device', () => {
  it('adds this device’s settings and ignores a hub that has not read the home yet', async () => {
    const document = await exported();
    expect(replicaFrom({ hubId: 'hub', version: '1', revision: 0, updatedAt: null, document: null }, settings)).toBeNull();
    expect(replicaFrom({ hubId: 'hub', version: '1', revision: 2, updatedAt: null, document }, { ...settings, theme: 'light' }, 5)).toMatchObject({
      hubId: 'hub', revision: 2, savedAt: 5, document: { settings: { theme: 'light' } },
    });
  });

  it('keeps the newest few copies of each hub, so an emptier later copy does not erase a full one', async () => {
    const document = await exported();
    const empty = { ...document, devices: [], moods: [], routines: [] };
    const all = [
      ...Array.from({ length: 8 }, (_, index) => copy('old-hub', index + 1, 100 + index, document)),
      copy('new-hub', 1, 500, empty),
    ];
    const kept = retained(all);
    expect(kept.map((item) => `${item.hubId}:${item.revision}`)).toEqual(['new-hub:1', 'old-hub:8', 'old-hub:7', 'old-hub:6', 'old-hub:5', 'old-hub:4']);
    expect(kept.filter((item) => item.hubId === 'old-hub')).toHaveLength(COPIES_PER_HUB);
    expect(kept[1]?.document.routines).toHaveLength(4);
  });

  it('saves and lists copies without device storage, for as long as the app stays open', async () => {
    const document = await exported();
    await saveReplica(copy('hub', 1, 10, document));
    const kept = await saveReplica(copy('hub', 2, 20, document));
    // The same numbered copy saved again keeps its original time.
    await saveReplica(copy('hub', 2, 99, { ...document, settings: { ...settings, theme: 'light' } }));
    expect(kept.map((item) => item.revision)).toEqual([2, 1]);
    expect(await listReplicas()).toMatchObject([{ revision: 2, savedAt: 20, document: { settings: { theme: 'light' } } }, { revision: 1 }]);
  });
});
