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
}

export interface SetupChange {
  id: string;
  description: string;
  createdAt: string;
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
  changes(): SetupChange[];
  undo(changeId: string, signal?: AbortSignal): Promise<unknown>;
}
