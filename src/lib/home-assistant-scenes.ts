import { invoke, isTauri } from '@tauri-apps/api/core';
import { isEntityId, isRecord } from './home-assistant-protocol';
import type { SceneConfig, SceneEntityState } from './home-setup-types';

const MAX_SCENE_BYTES = 256 * 1024;
export const validSceneConfigId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);

export class SceneRequestError extends Error {
  constructor(message: string, readonly definitelyRejected = false) {
    super(message);
  }
}

export class SceneConfigNotFoundError extends SceneRequestError {
  constructor(noun = 'scene') {
    super(`This ${noun} no longer has a saved Home Assistant configuration.`, true);
  }
}

async function readResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new SceneRequestError('Home Assistant returned an empty scene response.');
  let size = 0;
  let text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_SCENE_BYTES) throw new SceneRequestError('Home Assistant returned an oversized scene configuration.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    const result: unknown = JSON.parse(text);
    return result;
  } catch {
    throw new SceneRequestError('Home Assistant returned an unreadable scene response.');
  }
}

export function parseSceneConfig(value: unknown): SceneConfig {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim() || !isRecord(value.entities))
    throw new Error('Home Assistant returned an invalid scene configuration.');
  const entities: Record<string, string | SceneEntityState> = {};
  for (const [id, state] of Object.entries(value.entities)) {
    if (!isEntityId(id)) throw new Error('Home Assistant returned an invalid scene entity.');
    if (typeof state === 'string') entities[id] = state;
    else if (typeof state === 'boolean') entities[id] = state ? 'on' : 'off';
    else if (isRecord(state) && (typeof state.state === 'string' || typeof state.state === 'boolean')) {
      entities[id] = { ...state, state: typeof state.state === 'boolean' ? (state.state ? 'on' : 'off') : state.state };
    } else throw new Error('Home Assistant returned an invalid scene state.');
  }
  if (value.id !== undefined && typeof value.id !== 'string')
    throw new Error('Home Assistant returned an invalid scene identifier.');
  if (value.icon !== undefined && typeof value.icon !== 'string')
    throw new Error('Home Assistant returned an invalid scene icon.');
  if (value.metadata !== undefined && !isRecord(value.metadata))
    throw new Error('Home Assistant returned invalid scene metadata.');
  return {
    name: value.name,
    entities,
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.icon === undefined ? {} : { icon: value.icon }),
    ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
  };
}

type EditorKind = 'scene' | 'automation' | 'script';
/** Wording for each fixed editor endpoint; the scene texts predate the others. */
const editors: Record<EditorKind, { noun: string; item: string; manage: string; editing: string }> = {
  scene: { noun: 'scene', item: 'mood', manage: 'manage moods', editing: 'scene editing' },
  automation: { noun: 'automation', item: 'automation', manage: 'manage automations', editing: 'automation editing' },
  script: { noun: 'script', item: 'script', manage: 'manage scripts', editing: 'script editing' },
};

/** Fixed scene-editor endpoint, never an arbitrary URL supplied by the model. */
export function requestSceneConfig(
  serverUrl: string,
  token: string,
  method: 'GET' | 'POST' | 'DELETE',
  configId: string,
  config?: SceneConfig,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestEditorConfig('scene', serverUrl, token, method, configId, config, signal);
}

/** One of Home Assistant's three editor endpoints, chosen by kind and never by URL. */
export async function requestEditorConfig(
  kind: EditorKind,
  serverUrl: string,
  token: string,
  method: 'GET' | 'POST' | 'DELETE',
  configId: string,
  config?: Record<string, unknown> | SceneConfig,
  signal?: AbortSignal,
): Promise<unknown> {
  const { noun, item, manage, editing } = editors[kind];
  if (!validSceneConfigId(configId)) throw new SceneRequestError(`This ${noun} has an unsupported configuration identifier.`, true);
  const body = config === undefined ? undefined : JSON.stringify(config);
  if (body !== undefined && new TextEncoder().encode(body).byteLength > MAX_SCENE_BYTES)
    throw new SceneRequestError(`This ${item} is too large to save.`, true);
  if (signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
  if (isTauri()) {
    try {
      return kind === 'scene'
        ? await invoke<unknown>('home_scene_config', { expectedServerUrl: serverUrl, method, configId, config: config ?? null })
        : await invoke<unknown>('home_routine_config', { expectedServerUrl: serverUrl, kind, method, configId, config: config ?? null });
    } catch (cause: unknown) {
      if (isRecord(cause) && typeof cause.message === 'string') {
        if (cause.code === 'not_found') throw new SceneConfigNotFoundError(noun);
        if (cause.code === 'rejected' || cause.code === 'unconfirmed')
          throw new SceneRequestError(cause.message, cause.code === 'rejected');
      }
      throw new SceneRequestError(`Home Assistant could not confirm this ${noun} request. Read its current configuration before trying again.`);
    }
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 12_000);
  try {
    const response = await fetch(`${serverUrl}/api/config/${kind}/config/${configId}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403)
      throw new SceneRequestError(`Home Assistant administrator access is required to ${manage}. Update the connection in Settings.`, true);
    if (response.status === 404) {
      const detail = await readResponse(response).catch(() => null);
      if (isRecord(detail) && detail.message === 'Resource not found') throw new SceneConfigNotFoundError(noun);
      throw new SceneRequestError(`This Home Assistant connection does not support ${editing}.`, true);
    }
    if (!response.ok) throw new SceneRequestError(`Home Assistant did not accept this ${noun} configuration. No automatic retry was made.`, response.status >= 400 && response.status < 500);
    return await readResponse(response);
  } catch (error: unknown) {
    if (error instanceof Error && error.name !== 'AbortError' && error.name !== 'TypeError') throw error;
    throw new SceneRequestError(`Home Assistant did not confirm this ${noun} request. Check the saved ${item} before trying again. Browser previews also require Home Assistant to allow browser access.`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
