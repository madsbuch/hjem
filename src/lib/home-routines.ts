import type { HassSnapshot } from './home-assistant';
import { isEntityId, isRecord } from './home-assistant-protocol';
import { nameOf } from './entities';
import type {
  AutomationRequest,
  HelperDomain,
  RoutineConfig,
  RoutineKind,
  ScriptRequest,
} from './home-setup-types';

export const MAX_ROUTINE_BYTES = 64 * 1024;
const MAX_DEPTH = 24;
const MAX_STEPS = 60;
type Step = Record<string, unknown>;

export const validRoutineId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
const servicePattern = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const isTemplate = (value: string) => value.includes('{{') || value.includes('{%');
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const modes = ['single', 'restart', 'queued', 'parallel'];

/**
 * Routines run unattended, so their actions stay away from the system and from
 * anything that guards the home. Triggers and conditions may still read them.
 */
const blockedServiceDomains = new Set([
  'shell_command', 'python_script', 'pyscript', 'hassio', 'rest_command', 'backup',
  'recorder', 'system_log', 'logger', 'mqtt', 'zha', 'zwave_js', 'frontend', 'cloud',
  'lock', 'alarm_control_panel',
]);
const allowedCoreServices = new Set(['turn_on', 'turn_off', 'toggle', 'update_entity']);
const guardedEntityDomains = new Set(['lock', 'alarm_control_panel']);
const dataKeys = new Set(['data', 'service_data', 'data_template', 'event_data', 'variables']);

interface References {
  entities: Set<string>;
  devices: Set<string>;
  areas: Set<string>;
  services: Set<string>;
  deviceActionDomains: Set<string>;
  templatedService: boolean;
}
const emptyReferences = (): References => ({
  entities: new Set(), devices: new Set(), areas: new Set(), services: new Set(),
  deviceActionDomains: new Set(), templatedService: false,
});
const idList = (value: unknown): string[] =>
  (typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
    .map((item) => item.trim())
    .filter((item) => item && !isTemplate(item));

function collect(value: unknown, references: References, services: boolean, depth = 0): void {
  if (depth > MAX_DEPTH) throw new Error('This configuration is nested too deeply.');
  if (Array.isArray(value)) {
    for (const item of value) collect(item, references, services, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (services && typeof value.device_id === 'string' && typeof value.domain === 'string' && typeof value.type === 'string')
    references.deviceActionDomains.add(value.domain);
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'entity_id') {
      // Device triggers address entities by registry id; only real entity ids are checked.
      for (const id of idList(entry)) if (isEntityId(id)) references.entities.add(id);
    } else if (key === 'device_id') idList(entry).forEach((id) => references.devices.add(id));
    else if (key === 'area_id') idList(entry).forEach((id) => references.areas.add(id));
    else if (key === 'scene' && typeof entry === 'string' && isEntityId(entry)) references.entities.add(entry);
    else if (key === 'service_template' && services) references.templatedService = true;
    else if (services && (key === 'service' || key === 'action') && typeof entry === 'string') {
      if (isTemplate(entry)) references.templatedService = true;
      else if (servicePattern.test(entry)) references.services.add(entry);
    }
    collect(entry, references, services && !dataKeys.has(key), depth + 1);
  }
}

function steps(value: unknown, label: string, required: boolean): Step[] {
  const list: unknown[] = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
  if (list.length > MAX_STEPS || !list.every(isRecord))
    throw new Error(`${label} must be a list of up to ${MAX_STEPS} Home Assistant ${label.toLowerCase()}.`);
  if (required && !list.length) throw new Error(`Add at least one of the ${label.toLowerCase()}.`);
  return list;
}

/** Refuse unknown devices and unattended actions Hjem does not author. */
function check(reading: Step[], acting: Step[], snapshot: HassSnapshot): void {
  const read = emptyReferences();
  const act = emptyReferences();
  collect(reading, read, false);
  collect(acting, act, true);
  if (act.templatedService) throw new Error('Name each action’s service directly; templated service names cannot be checked.');
  const blocked = [...act.services].filter((service) => {
    const [domain = '', name = ''] = service.split('.');
    return blockedServiceDomains.has(domain) || (domain === 'homeassistant' && !allowedCoreServices.has(name));
  });
  if (blocked.length)
    throw new Error(`Hjem does not set up routines that call ${blocked.join(', ')}. Locks, alarms, and system services stay outside routines.`);
  const guarded = [
    ...[...act.entities].filter((id) => guardedEntityDomains.has(id.split('.')[0] ?? '')),
    ...[...act.deviceActionDomains].filter((domain) => guardedEntityDomains.has(domain)),
  ];
  if (guarded.length) throw new Error(`Hjem does not set up routines that operate locks or alarms (${guarded.join(', ')}).`);
  const known = new Set([...snapshot.entities.map((entity) => entity.entity_id), ...snapshot.registry.map((entry) => entry.entity_id)]);
  const unknown = [
    ...[...read.entities, ...act.entities].filter((id) => id !== 'all' && id !== 'none' && !known.has(id)),
    ...[...read.devices, ...act.devices].filter((id) => !snapshot.devices.some((device) => device.id === id)),
    ...[...read.areas, ...act.areas].filter((id) => !snapshot.areas.some((area) => area.area_id === id)),
  ];
  if (unknown.length)
    throw new Error(`These do not exist in this home: ${[...new Set(unknown)].slice(0, 12).join(', ')}. Read the home again and use its exact identifiers.`);
}

function common(request: { description?: string; mode?: string }, previous: RoutineConfig | undefined) {
  const description = request.description ?? text(previous?.description);
  if (typeof description !== 'string' || description.length > 500) throw new Error('Keep the description under 500 characters.');
  const mode = request.mode ?? (text(previous?.mode) || 'single');
  if (!modes.includes(mode)) throw new Error(`mode must be one of ${modes.join(', ')}.`);
  return { description, mode };
}
function bounded(config: RoutineConfig): RoutineConfig {
  let size: number;
  try { size = new TextEncoder().encode(JSON.stringify(config)).byteLength; }
  catch { throw new Error('This configuration could not be encoded.'); }
  if (size > MAX_ROUTINE_BYTES) throw new Error('This configuration is too large to save.');
  // A JSON round trip drops anything Home Assistant could not store.
  const copy: unknown = JSON.parse(JSON.stringify(config));
  if (!isRecord(copy)) throw new Error('This configuration could not be encoded.');
  return copy;
}
const automationKeys = new Set(['id', 'alias', 'description', 'mode', 'trigger', 'triggers', 'condition', 'conditions', 'action', 'actions']);
const scriptKeys = new Set(['alias', 'description', 'mode', 'icon', 'sequence']);
const keep = (previous: RoutineConfig | undefined, replaced: Set<string>): RoutineConfig =>
  Object.fromEntries(Object.entries(previous ?? {}).filter(([key]) => !replaced.has(key)));

/** Build the configuration Home Assistant stores; `name` is already validated. */
export function compileAutomation(request: AutomationRequest, name: string, snapshot: HassSnapshot, previous?: RoutineConfig): RoutineConfig {
  const triggers = steps(request.triggers, 'Triggers', true);
  const conditions = steps(request.conditions, 'Conditions', false);
  const actions = steps(request.actions, 'Actions', true);
  check([...triggers, ...conditions], actions, snapshot);
  return bounded({ ...keep(previous, automationKeys), alias: name, ...common(request, previous), triggers, conditions, actions });
}

export function compileScript(request: ScriptRequest, name: string, snapshot: HassSnapshot, previous?: RoutineConfig): RoutineConfig {
  const sequence = steps(request.sequence, 'Actions', true);
  check([], sequence, snapshot);
  const icon = request.icon ?? text(previous?.icon);
  if (typeof icon !== 'string' || (icon && !/^[a-z0-9]+:[a-z0-9-]+$/.test(icon))) throw new Error('icon must look like mdi:movie.');
  return bounded({ ...keep(previous, scriptKeys), alias: name, ...common(request, previous), ...(icon ? { icon } : {}), sequence });
}

const stepList = (value: unknown): Step[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).filter(isRecord);
/** Triggers, conditions, and actions under their current names, whichever the file uses. */
export function routineParts(kind: RoutineKind, config: RoutineConfig) {
  if (kind === 'script') return { triggers: [], conditions: [], actions: stepList(config.sequence) };
  return {
    triggers: stepList(config.triggers ?? config.trigger),
    conditions: stepList(config.conditions ?? config.condition),
    actions: stepList(config.actions ?? config.action),
  };
}
/** The saved configuration as the tools accept it back. */
export function normalizeRoutine(kind: RoutineKind, config: RoutineConfig): RoutineConfig {
  if (kind === 'script') return { ...config };
  const { trigger: _trigger, condition: _condition, action: _action, ...rest } = config;
  return { ...rest, ...routineParts(kind, config) };
}

/** Devices a routine refers to that are gone or not answering. */
export function routineProblems(kind: RoutineKind, config: RoutineConfig, snapshot: HassSnapshot): string[] {
  const references = emptyReferences();
  const parts = routineParts(kind, config);
  try { collect([parts.triggers, parts.conditions, parts.actions], references, false); }
  catch { return ['This configuration is too deeply nested to check.']; }
  const problems: string[] = [];
  for (const id of references.entities) {
    if (id === 'all' || id === 'none') continue;
    const entity = snapshot.entities.find((item) => item.entity_id === id);
    if (!entity) problems.push(`${id} is missing.`);
    else if (entity.state === 'unavailable') problems.push(`${nameOf(entity)} is unavailable.`);
  }
  for (const id of references.devices)
    if (!snapshot.devices.some((device) => device.id === id)) problems.push('A device this routine uses has been removed.');
  for (const id of references.areas)
    if (!snapshot.areas.some((area) => area.area_id === id)) problems.push('A room this routine uses has been removed.');
  return problems;
}

export const slugify = (name: string): string =>
  name.normalize('NFKD').toLowerCase().replace(/[̀-ͯ]/g, '')
    .replace(/æ/g, 'ae').replace(/ø/g, 'o')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

// Plain-language summaries for the Home setup screen.
const words = (value: string) => value.replaceAll('_', ' ');
const sentence = (value: string) => value ? value[0]?.toUpperCase() + value.slice(1) : value;
const scalar = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value)
    : Array.isArray(value) ? value.map(scalar).filter(Boolean).join(' or ') : '';
function duration(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return typeof value === 'number' ? `${value} s` : value;
  if (!isRecord(value)) return '';
  return ['days', 'hours', 'minutes', 'seconds', 'milliseconds']
    .flatMap((unit) => typeof value[unit] === 'number' && value[unit] !== 0 ? [`${value[unit]} ${value[unit] === 1 ? unit.slice(0, -1) : unit}`] : [])
    .join(' ');
}
function entityName(id: string, snapshot: HassSnapshot): string {
  const entity = snapshot.entities.find((item) => item.entity_id === id);
  return entity ? nameOf(entity) : id;
}
function deviceName(id: unknown, snapshot: HassSnapshot): string {
  const device = snapshot.devices.find((item) => item.id === id);
  return device?.name_by_user || device?.name || 'A device';
}
function targets(step: Step, snapshot: HassSnapshot): string {
  const names: string[] = [];
  for (const source of [step, step.target, step.data, step.service_data]) {
    if (!isRecord(source)) continue;
    for (const id of idList(source.entity_id)) names.push(isEntityId(id) ? entityName(id, snapshot) : id);
    if (source !== step) for (const id of idList(source.device_id)) names.push(deviceName(id, snapshot));
    for (const id of idList(source.area_id)) names.push(snapshot.areas.find((area) => area.area_id === id)?.name ?? id);
  }
  return [...new Set(names)].join(', ');
}
const offset = (value: unknown) => {
  const amount = scalar(value);
  return amount ? ` (${amount.startsWith('-') ? `${amount.slice(1)} before` : `${amount.replace(/^\+/, '')} after`})` : '';
};

const openings = ['door', 'window', 'opening', 'garage_door'];
const movement = ['motion', 'occupancy', 'presence', 'moving'];
/** "opens" rather than "becomes on" where the sensor's kind says what on means. */
function stateChange(ids: string[], to: string, snapshot: HassSnapshot): string {
  const kinds = new Set(ids.map((id) => {
    const kind = snapshot.entities.find((item) => item.entity_id === id)?.attributes.device_class;
    return id.startsWith('binary_sensor.') && typeof kind === 'string' ? kind : '';
  }));
  const [kind = ''] = kinds;
  if (kinds.size === 1 && (to === 'on' || to === 'off')) {
    if (openings.includes(kind)) return to === 'on' ? 'opens' : 'closes';
    if (movement.includes(kind)) return to === 'on' ? 'notices movement' : 'stops noticing movement';
  }
  if (to === 'on' || to === 'off') return `turns ${to}`;
  return `becomes ${words(to)}`;
}
const dayNames: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
function weekdays(value: unknown): string {
  const days = idList(value);
  const has = (...names: string[]) => names.length === days.length && names.every((name) => days.includes(name));
  if (has('mon', 'tue', 'wed', 'thu', 'fri')) return 'a weekday';
  if (has('sat', 'sun')) return 'the weekend';
  return days.map((day) => dayNames[day] ?? day).join(', ');
}

export function describeTrigger(step: Step, snapshot: HassSnapshot): string {
  const type = text(step.trigger) || text(step.platform);
  const who = targets(step, snapshot) || 'Something';
  if (type === 'state') {
    const from = scalar(step.from);
    const to = scalar(step.to);
    const held = duration(step.for);
    const ids = idList(step.entity_id);
    // A remote's event entity reports each press as its event type.
    if (step.attribute === 'event_type' && ids.every((id) => id.startsWith('event.')))
      return `${who.replace(/ action$/i, '')}: ${to ? words(to) : 'any press'}`;
    const change = to ? stateChange(ids, to, snapshot) : 'changes';
    return `${who}${step.attribute ? ` ${words(scalar(step.attribute))}` : ''} ${change}${from ? ` from ${words(from)}` : ''}${held ? ` for ${held}` : ''}`;
  }
  if (type === 'numeric_state')
    return `${who} ${[step.above !== undefined && `rises above ${scalar(step.above)}`, step.below !== undefined && `drops below ${scalar(step.below)}`].filter(Boolean).join(' or ') || 'changes'}`;
  if (type === 'time') return `At ${idList(step.at).map((at) => isEntityId(at) ? entityName(at, snapshot) : at).join(' or ') || 'a set time'}`;
  if (type === 'time_pattern') return 'On a repeating schedule';
  if (type === 'sun') return `At ${scalar(step.event) || 'sunrise or sunset'}${offset(step.offset)}`;
  if (type === 'device') return `${deviceName(step.device_id, snapshot)}: ${words([scalar(step.type), scalar(step.subtype)].filter(Boolean).join(' · ')) || 'is used'}`;
  if (type === 'event') return `The ${scalar(step.event_type) || 'chosen'} event happens`;
  if (type === 'homeassistant') return `Home Assistant ${scalar(step.event) === 'shutdown' ? 'shuts down' : 'starts'}`;
  if (type === 'zone') return `${who} ${scalar(step.event) === 'leave' ? 'leaves' : 'enters'} ${entityName(scalar(step.zone), snapshot)}`;
  if (type === 'template') return 'A custom rule becomes true';
  return type ? `${sentence(words(type))} trigger` : 'A custom trigger';
}

export function describeCondition(step: Step, snapshot: HassSnapshot): string {
  const type = text(step.condition);
  const who = targets(step, snapshot) || 'Something';
  if (type === 'state') return `${who} is ${words(scalar(step.state)) || 'in a set state'}`;
  if (type === 'numeric_state')
    return `${who} is ${[step.above !== undefined && `above ${scalar(step.above)}`, step.below !== undefined && `below ${scalar(step.below)}`].filter(Boolean).join(' and ') || 'in range'}`;
  if (type === 'time') {
    const parts = [step.weekday !== undefined && weekdays(step.weekday), step.after !== undefined && `after ${scalar(step.after)}`, step.before !== undefined && `before ${scalar(step.before)}`].filter(Boolean);
    return `It is ${parts.join(', ') || 'the right time'}`;
  }
  if (type === 'sun') {
    const parts = [step.after !== undefined && `after ${scalar(step.after)}`, step.before !== undefined && `before ${scalar(step.before)}`].filter(Boolean);
    return `It is ${parts.join(' and ') || 'the right time of day'}`;
  }
  if (type === 'and' || type === 'or' || type === 'not') {
    const inner = stepList(step.conditions).map((item) => describeCondition(item, snapshot));
    return `${type === 'and' ? 'All of' : type === 'or' ? 'Any of' : 'None of'}: ${inner.join('; ') || 'nothing'}`;
  }
  if (type === 'device') return `${deviceName(step.device_id, snapshot)} ${words(scalar(step.type)) || 'matches'}`;
  if (type === 'template') return 'A custom rule is true';
  return type ? `${sentence(words(type))} condition` : 'A custom condition';
}

const serviceVerbs: Record<string, string> = {
  turn_on: 'Turn on', turn_off: 'Turn off', toggle: 'Toggle', open_cover: 'Open', close_cover: 'Close',
  set_cover_position: 'Set position of', media_play: 'Play', media_pause: 'Pause', media_stop: 'Stop',
  volume_set: 'Set volume of', set_temperature: 'Set temperature of', select_option: 'Choose an option for',
  set_value: 'Set', press: 'Press', start: 'Start', trigger: 'Run', reload: 'Reload',
};
export function describeAction(step: Step, snapshot: HassSnapshot): string {
  const service = text(step.action) || text(step.service);
  if (service && servicePattern.test(service)) {
    const [domain = '', name = ''] = service.split('.');
    const who = targets(step, snapshot);
    const data = isRecord(step.data) ? step.data : isRecord(step.service_data) ? step.service_data : {};
    const details = [
      typeof data.brightness_pct === 'number' && `${data.brightness_pct}%`,
      typeof data.brightness === 'number' && `${Math.round(data.brightness / 2.55)}%`,
      typeof data.color_temp_kelvin === 'number' && `${data.color_temp_kelvin} K`,
      typeof data.temperature === 'number' && `${data.temperature}°`,
      typeof data.position === 'number' && `${data.position}%`,
      typeof data.volume_level === 'number' && `${Math.round(data.volume_level * 100)}%`,
      typeof data.transition === 'number' && `over ${data.transition} s`,
      typeof data.message === 'string' && `“${data.message.slice(0, 60)}”`,
    ].filter(Boolean).join(', ');
    const verb = domain === 'scene' && name === 'turn_on' ? 'Activate' : domain === 'notify' ? 'Send a notification' : serviceVerbs[name] ?? `${sentence(words(name))}:`;
    return `${verb}${who ? ` ${who}` : domain === 'notify' ? '' : ` ${words(domain)}`}${details ? ` (${details})` : ''}`;
  }
  if (step.delay !== undefined) return `Wait ${duration(step.delay) || 'a moment'}`;
  if (step.wait_template !== undefined) return 'Wait until a custom rule is true';
  if (step.wait_for_trigger !== undefined) return `Wait until: ${stepList(step.wait_for_trigger).map((item) => describeTrigger(item, snapshot)).join(' or ')}`;
  if (typeof step.scene === 'string') return `Activate ${entityName(step.scene, snapshot)}`;
  if (step.choose !== undefined) return `Choose between ${stepList(step.choose).length} option${stepList(step.choose).length === 1 ? '' : 's'}`;
  if (step.if !== undefined) return `If ${stepList(step.if).map((item) => describeCondition(item, snapshot)).join(' and ') || 'a rule matches'}: ${stepList(step.then).map((item) => describeAction(item, snapshot)).join(', then ') || 'nothing'}`;
  if (step.repeat !== undefined) return 'Repeat a set of actions';
  if (step.parallel !== undefined) return `Do ${stepList(step.parallel).length} things at once`;
  if (step.sequence !== undefined) return `Run ${stepList(step.sequence).length} steps in order`;
  if (typeof step.condition === 'string') return `Only continue if ${describeCondition(step, snapshot).replace(/^It is /, 'it is ')}`;
  if (step.event !== undefined) return `Send the ${scalar(step.event)} event`;
  if (step.stop !== undefined) return 'Stop here';
  if (step.variables !== undefined) return 'Remember some values';
  if (typeof step.device_id === 'string') return `${deviceName(step.device_id, snapshot)}: ${words(scalar(step.type)) || 'acts'}`;
  return 'A custom step';
}

export function describeParts(kind: RoutineKind, config: RoutineConfig, snapshot: HassSnapshot) {
  const parts = routineParts(kind, config);
  return {
    when: parts.triggers.map((step) => describeTrigger(step, snapshot)),
    conditions: parts.conditions.map((step) => describeCondition(step, snapshot)),
    then: parts.actions.map((step) => describeAction(step, snapshot)),
  };
}

// Helpers: the small values routines read, such as a toggle or a time.
type FieldType = 'string' | 'number' | 'boolean' | 'strings';
const helperFields: Record<HelperDomain, Record<string, FieldType>> = {
  input_boolean: {},
  input_number: { min: 'number', max: 'number', step: 'number', mode: 'string', unit_of_measurement: 'string' },
  input_text: { min: 'number', max: 'number', pattern: 'string', mode: 'string' },
  input_select: { options: 'strings' },
  input_datetime: { has_date: 'boolean', has_time: 'boolean' },
  input_button: {},
  counter: { initial: 'number', step: 'number', minimum: 'number', maximum: 'number', restore: 'boolean' },
  timer: { duration: 'string', restore: 'boolean' },
};
export const helperLabels: Record<HelperDomain, string> = {
  input_boolean: 'Toggle', input_number: 'Number', input_text: 'Text', input_select: 'Choice',
  input_datetime: 'Date and time', input_button: 'Button', counter: 'Counter', timer: 'Timer',
};

/** Keep only the settings this kind of helper has, with the right types. */
export function compileHelper(domain: HelperDomain, settings: Record<string, unknown> | undefined, creating: boolean): Record<string, unknown> {
  const allowed: Record<string, FieldType> = { ...helperFields[domain], icon: 'string' };
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings ?? {})) {
    const type = allowed[key];
    if (!type || !Object.hasOwn(allowed, key)) throw new Error(`${helperLabels[domain]} helpers have no ${key} setting. Use: ${Object.keys(allowed).join(', ')}.`);
    const valid = type === 'strings'
      ? Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every((item) => typeof item === 'string' && item.trim() && item.length <= 100)
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : type === 'string' ? typeof value === 'string' && value.length <= 200 : typeof value === 'boolean';
    if (!valid) throw new Error(`${key} must be ${type === 'strings' ? 'a list of 1 to 100 short texts' : `a ${type}`}.`);
    fields[key] = value;
  }
  if (creating) {
    if (domain === 'input_number' && (typeof fields.min !== 'number' || typeof fields.max !== 'number' || fields.min >= fields.max))
      throw new Error('A number helper needs min and max settings, with min below max.');
    if (domain === 'input_select' && !Array.isArray(fields.options)) throw new Error('A choice helper needs an options list.');
    if (domain === 'input_datetime' && fields.has_date !== true && fields.has_time !== true)
      throw new Error('A date and time helper needs has_date or has_time set to true.');
  }
  return fields;
}
