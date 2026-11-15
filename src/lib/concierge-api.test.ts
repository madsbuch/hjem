import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  enabled: false,
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => native.enabled,
  invoke: native.invoke,
}));

beforeEach(() => {
  vi.resetModules();
  native.enabled = false;
  native.invoke.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('Concierge transport boundaries', () => {
  it('keeps preview credentials and model in memory only, and resets on reload', async () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    const api = await import('./concierge-api');
    expect(await api.getConciergeSettings()).toEqual({ hasApiKey: false, model: '' });
    expect(await api.saveConciergeSettings(' test-key ', ' test/model ')).toEqual({ hasApiKey: true, model: 'test/model' });
    expect(await api.saveConciergeSettings(undefined, 'next/model')).toEqual({ hasApiKey: true, model: 'next/model' });
    expect(await api.clearConciergeKey()).toEqual({ hasApiKey: false, model: 'next/model' });
    await api.saveConciergeSettings('test-key', 'test/model');
    vi.resetModules();
    expect(await (await import('./concierge-api')).getConciergeSettings()).toEqual({ hasApiKey: false, model: '' });
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it.each([null, [], { hasApiKey: 'true', model: 'test/model' }, { hasApiKey: true, model: 1 }])('rejects malformed native settings %j', async (response) => {
    native.enabled = true;
    native.invoke.mockResolvedValue(response);
    const api = await import('./concierge-api');
    await expect(api.getConciergeSettings()).rejects.toThrow('settings could not be read');
    await expect(api.saveConciergeSettings(undefined, 'test/model')).rejects.toThrow('settings could not be read');
    await expect(api.clearConciergeKey()).rejects.toThrow('settings could not be read');
  });

  it('returns only the native settings contract and does not expose unexpected fields', async () => {
    native.enabled = true;
    native.invoke.mockResolvedValue({ hasApiKey: true, model: 'test/model', apiKey: 'unexpected-secret' });
    const api = await import('./concierge-api');
    expect(await api.getConciergeSettings()).toEqual({ hasApiKey: true, model: 'test/model' });
  });

  it('filters public models with validated tools and text capabilities', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: 'valid/z', name: 'Zulu', supported_parameters: ['tools'], architecture: { output_modalities: ['text'] } },
      { id: 'valid/a', supported_parameters: ['tools'] },
      { id: 'fake/tools', supported_parameters: 'tools' },
      { id: 'fake/modalities', supported_parameters: ['tools'], architecture: { output_modalities: 'text' } },
      { id: 'image/only', supported_parameters: ['tools'], architecture: { output_modalities: ['image'] } },
      { id: 14, supported_parameters: ['tools'] },
      null,
    ] })));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./concierge-api');
    await api.saveConciergeSettings('test-key', 'test/model');
    expect(await api.listConciergeModels()).toEqual([{ id: 'valid/a', name: 'valid/a' }, { id: 'valid/z', name: 'Zulu' }]);
    expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', expect.objectContaining({ headers: {}, redirect: 'error' }));
  });

  it.each([null, { data: {} }, { data: 'models' }])('rejects an unreadable public catalog %j', async (response) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response))));
    const api = await import('./concierge-api');
    await expect(api.listConciergeModels()).rejects.toThrow('unreadable model list');
  });

  it('validates native models before exposing them', async () => {
    native.enabled = true;
    native.invoke.mockResolvedValue([{ id: 'test/model', name: 5 }]);
    const api = await import('./concierge-api');
    await expect(api.listConciergeModels()).rejects.toThrow('unreadable model list');
    native.invoke.mockResolvedValue([{ id: 'test/model', name: 'Test', other: 'discard' }]);
    expect(await api.listConciergeModels()).toEqual([{ id: 'test/model', name: 'Test' }]);
  });
});
