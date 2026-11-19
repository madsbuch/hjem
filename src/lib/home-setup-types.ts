import type { HassArea, HassSnapshot } from './home-assistant';

export interface SceneEntityState {
  state: string;
  [attribute: string]: unknown;
}

export interface SceneConfig {
  id?: string;
  name: string;
  icon?: string;
  entities: Record<string, string | SceneEntityState>;
  metadata?: Record<string, unknown>;
}

/** Only these explicit settings can be authored by Concierge. */
export interface MoodTarget {
  entity_id: string;
  state: string;
  brightness_pct?: number;
  color_temp_kelvin?: number;
  /** A colour, as hue 0–360 and saturation 0–100; given together, and not with a colour temperature. */
  hue?: number;
  saturation?: number;
  temperature?: number;
  position?: number;
  volume_pct?: number;
  is_volume_muted?: boolean;
}

export interface SaveMoodRequest {
  name: string;
  entity_id?: string;
  targets: MoodTarget[];
}

/** Authenticated, fixed-operation transport; credentials never enter tool data. */
export interface HomeSetupTransport {
  getSnapshot(): HassSnapshot;
  refreshStructure(): Promise<HassSnapshot>;
  refreshStates(): Promise<HassSnapshot>;
  createArea(name: string): Promise<HassArea>;
  renameArea(areaId: string, name: string): Promise<HassArea>;
  deleteArea(areaId: string): Promise<void>;
  assignDeviceArea(deviceId: string, areaId: string | null): Promise<void>;
  assignEntityArea(entityId: string, areaId: string | null): Promise<void>;
  /** `null` restores the integration's default name. */
  renameDevice(deviceId: string, name: string | null): Promise<void>;
  renameEntity(entityId: string, name: string | null): Promise<void>;
  readScene(configId: string): Promise<SceneConfig>;
  saveScene(configId: string, config: SceneConfig): Promise<void>;
  deleteScene(configId: string): Promise<void>;
  relatedToArea(areaId: string): Promise<Record<string, string[]>>;
  activateScene(entityId: string): Promise<void>;
  /** Automation and script editor configurations, addressed by their saved id. */
  readRoutine(kind: RoutineKind, configId: string): Promise<RoutineConfig>;
  saveRoutine(kind: RoutineKind, configId: string, config: RoutineConfig): Promise<void>;
  deleteRoutine(kind: RoutineKind, configId: string): Promise<void>;
  /** Ask Home Assistant to check triggers, conditions, and actions without saving. */
  validateRoutine(parts: RoutineParts): Promise<RoutineValidation>;
  deviceTriggers(deviceId: string): Promise<Record<string, unknown>[]>;
  routineTraces(kind: RoutineKind, configId: string): Promise<RoutineTrace[]>;
  routineService(kind: RoutineKind, service: RoutineService, entityId: string): Promise<void>;
  listHelpers(domain: HelperDomain): Promise<HelperRecord[]>;
  createHelper(domain: HelperDomain, fields: Record<string, unknown>): Promise<HelperRecord>;
  updateHelper(domain: HelperDomain, helperId: string, fields: Record<string, unknown>): Promise<HelperRecord>;
  deleteHelper(domain: HelperDomain, helperId: string): Promise<void>;
  setEntityHidden(entityId: string, hidden: boolean): Promise<void>;
}

export type RoutineKind = 'automation' | 'script';
export type RoutineService = 'turn_on' | 'turn_off' | 'trigger';
/** A Home Assistant automation or script as its editor stores it. */
export type RoutineConfig = Record<string, unknown>;
export interface RoutineParts {
  triggers?: Record<string, unknown>[];
  conditions?: Record<string, unknown>[];
  actions?: Record<string, unknown>[];
}
export interface RoutineValidation {
  /** False when this Home Assistant could not check the configuration in advance. */
  checked: boolean;
  errors: string[];
}
export interface RoutineTrace {
  run_id: string;
  started?: string;
  finished?: string;
  /** How the run ended, such as finished, failed_conditions, or error. */
  result?: string;
  trigger?: string;
  error?: string;
  last_step?: string;
}

export type HelperDomain =
  | 'input_boolean' | 'input_number' | 'input_text' | 'input_select'
  | 'input_datetime' | 'input_button' | 'counter' | 'timer';
export const helperDomains: readonly HelperDomain[] = [
  'input_boolean', 'input_number', 'input_text', 'input_select',
  'input_datetime', 'input_button', 'counter', 'timer',
];
export interface HelperRecord {
  id: string;
  name: string;
  [setting: string]: unknown;
}

export interface AutomationRequest {
  entity_id?: string;
  name: string;
  description?: string;
  mode?: string;
  triggers: unknown;
  conditions?: unknown;
  actions: unknown;
  enabled?: boolean;
}
export interface ScriptRequest {
  entity_id?: string;
  name: string;
  description?: string;
  mode?: string;
  icon?: string;
  sequence: unknown;
}
export interface HelperRequest {
  domain: HelperDomain;
  helper_id?: string;
  name: string;
  settings?: Record<string, unknown>;
}

/** What a setup change touched, so the Home setup screen can point at it. */
export interface SetupTarget {
  kind: 'room' | 'device' | 'entity' | 'mood' | 'automation' | 'script' | 'helper';
  id: string;
}

export interface SetupChange {
  id: string;
  description: string;
  createdAt: string;
  target?: SetupTarget;
}

/** The chat and UI share this session-bound controller. */
export interface HomeSetup {
  inspect(signal?: AbortSignal): Promise<unknown>;
  createRoom(name: string, signal?: AbortSignal): Promise<unknown>;
  renameRoom(areaId: string, name: string, signal?: AbortSignal): Promise<unknown>;
  assignDevice(deviceId: string, areaId: string | null, signal?: AbortSignal): Promise<unknown>;
  assignEntity(entityId: string, areaId: string | null, signal?: AbortSignal): Promise<unknown>;
  renameDevice(deviceId: string, name: string | null, signal?: AbortSignal): Promise<unknown>;
  renameEntity(entityId: string, name: string | null, signal?: AbortSignal): Promise<unknown>;
  inspectMood(entityId: string, signal?: AbortSignal): Promise<unknown>;
  saveMood(request: SaveMoodRequest, signal?: AbortSignal): Promise<unknown>;
  activateMood(entityId: string, signal?: AbortSignal): Promise<unknown>;
  deleteRoom(areaId: string, signal?: AbortSignal): Promise<unknown>;
  setEntityHidden(entityId: string, hidden: boolean, signal?: AbortSignal): Promise<unknown>;
  listRoutines(signal?: AbortSignal): Promise<unknown>;
  inspectRoutine(entityId: string, signal?: AbortSignal): Promise<unknown>;
  /** A read for the Home setup screen; it does not count as inspecting before an edit. */
  describeRoutine(entityId: string, signal?: AbortSignal): Promise<RoutineDescription>;
  describeMood(entityId: string, signal?: AbortSignal): Promise<string[]>;
  deviceTriggers(deviceId: string, signal?: AbortSignal): Promise<unknown>;
  saveAutomation(request: AutomationRequest, signal?: AbortSignal): Promise<unknown>;
  saveScript(request: ScriptRequest, signal?: AbortSignal): Promise<unknown>;
  deleteRoutine(entityId: string, signal?: AbortSignal): Promise<unknown>;
  setAutomationEnabled(entityId: string, enabled: boolean, signal?: AbortSignal): Promise<unknown>;
  runRoutine(entityId: string, signal?: AbortSignal): Promise<unknown>;
  routineRuns(entityId: string, signal?: AbortSignal): Promise<unknown>;
  listHelpers(signal?: AbortSignal): Promise<unknown>;
  saveHelper(request: HelperRequest, signal?: AbortSignal): Promise<unknown>;
  deleteHelper(domain: HelperDomain, helperId: string, signal?: AbortSignal): Promise<unknown>;
  changes(): SetupChange[];
  undo(changeId: string, signal?: AbortSignal): Promise<unknown>;
}

/** A routine in plain language, with its saved configuration for those who want it. */
export interface RoutineDescription {
  kind: RoutineKind;
  editable: boolean;
  when: string[];
  conditions: string[];
  then: string[];
  problems: string[];
  config?: RoutineConfig;
  message?: string;
}
