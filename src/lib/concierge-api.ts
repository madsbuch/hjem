import { invoke, isTauri } from '@tauri-apps/api/core';

export interface ConciergeSettings {
  hasApiKey: boolean;
  model: string;
}
export interface ConciergeModel {
  id: string;
  name: string;
  description: string;
  contextLength: number | null;
  /** USD per input/output token, and per request. Unknown/dynamic prices stay null. */
  inputPrice: number | null;
  outputPrice: number | null;
  requestPrice: number | null;
  isFree: boolean;
  supportsTools: boolean;
  inputModalities: string[];
  outputModalities: string[];
  created: number | null;
}
const API = 'https://openrouter.ai/api/v1';
// Without this parameter OpenRouter defaults to text-output models. Omitting
// offset/limit returns its complete catalogue rather than a single page.
const MODELS_PATH = '/models?output_modalities=all';
let sessionKey = '';
let sessionModel = '';
export const nativeConcierge = () => isTauri();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

function settingsFromResponse(value: unknown): ConciergeSettings {
  if (!isRecord(value) || typeof value.hasApiKey !== 'boolean' || typeof value.model !== 'string')
    throw new Error('Concierge settings could not be read.');
  return { hasApiKey: value.hasApiKey, model: value.model };
}

export async function getConciergeSettings(): Promise<ConciergeSettings> {
  if (isTauri()) return settingsFromResponse(await invoke<unknown>('concierge_get_settings'));
  return {
    hasApiKey: sessionKey.length > 0,
    model: sessionModel,
  };
}

export async function saveConciergeSettings(
  apiKey: string | undefined,
  model: string,
): Promise<ConciergeSettings> {
  const cleaned = apiKey?.trim();
  if (apiKey !== undefined && !cleaned)
    throw new Error('Enter an OpenRouter API key.');
  if (model.trim().length > 200 || /\s/.test(model.trim()))
    throw new Error('Use a valid model ID from OpenRouter.');
  if (isTauri())
    return settingsFromResponse(await invoke<unknown>('concierge_save_settings', {
      apiKey: cleaned ?? null,
      model: model.trim(),
    }));
  if (cleaned) sessionKey = cleaned;
  sessionModel = model.trim();
  return getConciergeSettings();
}

export async function clearConciergeKey(): Promise<ConciergeSettings> {
  if (isTauri()) return settingsFromResponse(await invoke<unknown>('concierge_clear_key'));
  sessionKey = '';
  return getConciergeSettings();
}

function requestError(status: number) {
  if (status === 401 || status === 403)
    return 'OpenRouter did not accept the API key. Check it in Settings.';
  if (status === 402)
    return 'Your OpenRouter account needs credits before the concierge can reply.';
  if (status === 429)
    return 'OpenRouter is rate limiting requests. Please try again shortly.';
  if (status >= 500)
    return 'OpenRouter or the selected model is temporarily unavailable. Please try again.';
  return `OpenRouter could not complete the request (${status}). Check the selected model in Settings.`;
}

async function browserRequest(
  path: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 90_000);
  try {
    const response = await fetch(`${API}${path}`, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      headers: {
        ...(path === MODELS_PATH
          ? {}
          : { Authorization: `Bearer ${sessionKey}` }),
        ...(body
          ? {
              'Content-Type': 'application/json',
              'X-Title': 'Hjem Home Concierge',
              'HTTP-Referer': 'https://github.com/madsbuch/hjem',
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(requestError(response.status));
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024)
      throw new Error('OpenRouter returned a response that is too large.');
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed;
    } catch {
      throw new Error('OpenRouter returned an unreadable response.');
    }
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
    if (controller.signal.aborted)
      throw new Error('The model took too long to reply. Please try again.');
    if (error instanceof TypeError)
      throw new Error(
        'Could not reach OpenRouter. Check your connection and try again.',
      );
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function testConciergeKey(): Promise<void> {
  if (isTauri()) {
    await invoke<unknown>('concierge_test_key');
    return;
  }
  if (!sessionKey) throw new Error('Save your OpenRouter API key first.');
  await browserRequest('/key');
}

const validModelId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\u0000-\u001f\u007f-\u009f]/.test(value);
const stringList = (value: unknown): string[] =>
  isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const validStringList = (value: unknown): value is string[] =>
  isArray(value) && value.every((item) => typeof item === 'string');
const nullableNumber = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
const nullableInteger = (value: unknown, minimum: number): value is number | null =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum);
const integer = (value: unknown, minimum: number): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : null;
function price(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function freePricing(pricing: Record<string, unknown>, outputModalities: unknown): boolean {
  // Non-text generation can carry per-song/image charges absent from pricing.
  return validStringList(outputModalities) && outputModalities.length > 0 && outputModalities.every((modality) => modality === 'text') &&
    price(pricing.prompt) === 0 && price(pricing.completion) === 0 &&
    Object.entries(pricing).every(([key, value]) => key === 'overrides'
      ? isArray(value) && value.length === 0
      : price(value) === 0);
}

export async function listConciergeModels(): Promise<ConciergeModel[]> {
  if (isTauri()) {
    const response: unknown = await invoke<unknown>('concierge_list_models');
    if (!isArray(response)) throw new Error('OpenRouter returned an unreadable model list.');
    return response.map((model) => {
      if (!isRecord(model) || !validModelId(model.id) || typeof model.name !== 'string' ||
          typeof model.description !== 'string' || !nullableInteger(model.contextLength, 1) ||
          !nullableNumber(model.inputPrice) || !nullableNumber(model.outputPrice) || !nullableNumber(model.requestPrice) ||
          typeof model.isFree !== 'boolean' || typeof model.supportsTools !== 'boolean' || !validStringList(model.inputModalities) ||
          !validStringList(model.outputModalities) || !nullableInteger(model.created, 0))
        throw new Error('OpenRouter returned an unreadable model list.');
      return {
        id: model.id, name: model.name, description: model.description,
        contextLength: model.contextLength, inputPrice: model.inputPrice,
        outputPrice: model.outputPrice, requestPrice: model.requestPrice, isFree: model.isFree,
        supportsTools: model.supportsTools, inputModalities: model.inputModalities,
        outputModalities: model.outputModalities, created: model.created,
      };
    });
  }
  const response = await browserRequest(MODELS_PATH);
  if (!isRecord(response) || !isArray(response.data))
    throw new Error('OpenRouter returned an unreadable model list.');
  return response.data
    .flatMap((model): ConciergeModel[] => {
      if (!isRecord(model) || !validModelId(model.id)) return [];
      const architecture = isRecord(model.architecture) ? model.architecture : {};
      const pricing = isRecord(model.pricing) ? model.pricing : {};
      return [{
        id: model.id, name: typeof model.name === 'string' && model.name ? model.name : model.id,
        description: typeof model.description === 'string' ? model.description : '',
        contextLength: integer(model.context_length, 1),
        inputPrice: price(pricing.prompt), outputPrice: price(pricing.completion),
        requestPrice: price(pricing.request),
        isFree: freePricing(pricing, architecture.output_modalities),
        supportsTools: stringList(model.supported_parameters).includes('tools'),
        inputModalities: stringList(architecture.input_modalities),
        outputModalities: stringList(architecture.output_modalities),
        created: integer(model.created, 0),
      }];
    })
    .sort((a: ConciergeModel, b: ConciergeModel) =>
      a.name.localeCompare(b.name),
    );
}

/** Internal streaming transport: preview credentials remain inside this module. */
export async function streamConciergeVoiceInBrowser(
  body: Record<string, unknown>,
  signal: AbortSignal,
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  if (isTauri()) throw new Error('Native voice requests must use the private native transport.');
  if (!sessionKey) throw new Error('Add your OpenRouter API key in Settings to use voice.');
  const response = await fetch(`${API}/chat/completions`, {
    method: 'POST', redirect: 'error', signal,
    headers: {
      Authorization: `Bearer ${sessionKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Hjem Home Concierge',
      'HTTP-Referer': 'https://github.com/madsbuch/hjem',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(requestError(response.status));
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream'))
    throw new Error('OpenRouter returned an unreadable voice stream.');
  if (Number(response.headers.get('content-length')) > 24 * 1024 * 1024)
    throw new Error('OpenRouter returned a voice response that is too large.');
  if (!response.body) throw new Error('OpenRouter returned no voice stream.');
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (signal.aborted) throw new DOMException('Stopped.', 'AbortError');
      if (next.done) break;
      onChunk(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function requestConcierge(
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new DOMException('Stopped.', 'AbortError');
  if (!isTauri()) {
    const settings = await getConciergeSettings();
    if (!settings.hasApiKey || !settings.model)
      throw new Error(
        'Add your OpenRouter API key and choose a model in Settings.',
      );
    return browserRequest(
      '/chat/completions',
      { ...body, model: settings.model },
      signal,
    );
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const abort = () => {
      void invoke<unknown>('concierge_cancel', { requestId }).catch(() => undefined);
      reject(new DOMException('Stopped.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void invoke<unknown>('concierge_request', { requestId, body })
      .then((value) => {
        if (signal.aborted) reject(new DOMException('Stopped.', 'AbortError'));
        else resolve(value);
      }, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
