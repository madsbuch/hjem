import { invoke, isTauri } from '@tauri-apps/api/core';
import { readPreference, savePreference } from './entities';

export interface ConciergeSettings {
  hasApiKey: boolean;
  model: string;
}
export interface ConciergeModel {
  id: string;
  name: string;
}
const API = 'https://openrouter.ai/api/v1';
let sessionKey = '';
export const nativeConcierge = () => isTauri();

export async function getConciergeSettings(): Promise<ConciergeSettings> {
  if (isTauri()) return invoke('concierge_get_settings');
  return {
    hasApiKey: !!sessionKey,
    model: readPreference('hjem.concierge.model', ''),
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
    return invoke('concierge_save_settings', {
      apiKey: cleaned ?? null,
      model: model.trim(),
    });
  if (cleaned) sessionKey = cleaned;
  savePreference('hjem.concierge.model', model.trim());
  return getConciergeSettings();
}

export async function clearConciergeKey(): Promise<ConciergeSettings> {
  if (isTauri()) return invoke('concierge_clear_key');
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
) {
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
        ...(path === '/models'
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
      return JSON.parse(text);
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
  if (isTauri()) return invoke('concierge_test_key');
  if (!sessionKey) throw new Error('Save your OpenRouter API key first.');
  await browserRequest('/key');
}

export async function listConciergeModels(): Promise<ConciergeModel[]> {
  if (isTauri()) return invoke('concierge_list_models');
  const response = await browserRequest('/models');
  if (!Array.isArray(response.data))
    throw new Error('OpenRouter returned an unreadable model list.');
  return response.data
    .filter(
      (model: any) =>
        typeof model.id === 'string' &&
        model.supported_parameters?.includes('tools') &&
        (!model.architecture?.output_modalities ||
          model.architecture.output_modalities.includes('text')),
    )
    .map((model: any) => ({
      id: model.id,
      name: typeof model.name === 'string' ? model.name : model.id,
    }))
    .sort((a: ConciergeModel, b: ConciergeModel) =>
      a.name.localeCompare(b.name),
    );
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
      void invoke('concierge_cancel', { requestId }).catch(() => undefined);
      reject(new DOMException('Stopped.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void invoke('concierge_request', { requestId, body })
      .then((value) => {
        if (signal.aborted) reject(new DOMException('Stopped.', 'AbortError'));
        else resolve(value);
      }, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
