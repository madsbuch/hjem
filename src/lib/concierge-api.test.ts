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

  it('loads every modality without credentials and preserves comparison metadata', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: 'valid/z', name: 'Zulu', description: 'A tool model.', context_length: 128000, created: 1700000000,
        pricing: { prompt: '0.000001', completion: '0.000003', request: '0' },
        supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
      { id: 'plain/text', name: 'Plain', supported_parameters: [], architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
      { id: 'image/only', name: 'Image', supported_parameters: [], architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
      { id: 'audio/only', name: 'Audio', architecture: { input_modalities: ['text'], output_modalities: ['audio'] } },
      { id: 'unknown/model', supported_parameters: 'tools', architecture: { output_modalities: 'text' } },
      { id: 14, supported_parameters: ['tools'] }, { id: '' }, { id: 'bad id' }, null,
    ] })));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./concierge-api');
    await api.saveConciergeSettings('test-key', 'test/model');
    const models = await api.listConciergeModels();
    expect(models.map((model) => model.id)).toEqual(['audio/only', 'image/only', 'plain/text', 'unknown/model', 'valid/z']);
    expect(models.find((model) => model.id === 'valid/z')).toEqual({
      id: 'valid/z', name: 'Zulu', description: 'A tool model.', contextLength: 128000, created: 1700000000,
      inputPrice: 0.000001, outputPrice: 0.000003, requestPrice: 0, isFree: false, supportsTools: true,
      inputModalities: ['text', 'image'], outputModalities: ['text'],
    });
    expect(models.find((model) => model.id === 'image/only')).toMatchObject({ supportsTools: false, outputModalities: ['image'] });
    expect(models.find((model) => model.id === 'unknown/model')).toMatchObject({
      supportsTools: false, inputModalities: [], outputModalities: [], contextLength: null,
      inputPrice: null, outputPrice: null, requestPrice: null, isFree: false, created: null,
    });
    expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models?output_modalities=all', expect.objectContaining({ headers: {}, redirect: 'error' }));
  });

  it('keeps unknown and dynamic prices distinct from free and normalizes numeric metadata', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: 'dynamic', pricing: { prompt: '-1', completion: '', request: 'dynamic' }, context_length: -5, created: 1.5 },
      { id: 'invalid', pricing: { prompt: true, completion: 'Infinity', request: '0x10' }, context_length: 9007199254740992, created: -1 },
      { id: 'free', pricing: { prompt: 0, completion: '0', request: '0' }, context_length: 32000, created: 0 },
      { id: 'decimal', pricing: { prompt: ' 1e-6 ', completion: '.000002', request: 0.001 } },
    ] }))));
    const { listConciergeModels } = await import('./concierge-api');
    const models = await listConciergeModels();
    for (const id of ['dynamic', 'invalid']) expect(models.find((model) => model.id === id)).toMatchObject({
      inputPrice: null, outputPrice: null, requestPrice: null, contextLength: null, created: null,
    });
    expect(models.find((model) => model.id === 'free')).toMatchObject({ inputPrice: 0, outputPrice: 0, requestPrice: 0, contextLength: 32000, created: 0 });
    expect(models.find((model) => model.id === 'decimal')).toMatchObject({ inputPrice: 0.000001, outputPrice: 0.000002, requestPrice: 0.001 });
  });

  it('marks models free only when all published charges and overrides are known to be zero', async () => {
    const prices = [
      { prompt: '0', completion: '0', request: '0', image: '0', audio: '0', overrides: [] },
      { prompt: '0', completion: '0', request: '0.001' },
      { prompt: '0', completion: '0', image: '0.02' },
      { prompt: '0', completion: '0', audio: '-1' },
      { prompt: '0', completion: '0', web_search: null },
      { prompt: '0', completion: '0', overrides: [{ prompt: '0.01' }] },
      { prompt: '0', completion: '0', overrides: {} },
      { image: '0' },
    ];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: prices.map((pricing, index) => ({ id: `model/${index}`, pricing, architecture: { output_modalities: ['text'] } })),
    }))));
    const { listConciergeModels } = await import('./concierge-api');
    expect((await listConciergeModels()).map((model) => model.isFree)).toEqual([true, false, false, false, false, false, false, false]);
  });

  it('never infers non-text generation is free from zero token prices, including Lyria per-song models', async () => {
    const zeroTokens = { prompt: '0', completion: '0' };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: 'google/lyria-3-clip-preview', description: '30 second clips are priced at $0.04 per clip.',
        architecture: { output_modalities: ['text', 'audio'] }, pricing: zeroTokens },
      { id: 'google/lyria-3-pro-preview', description: 'Full-length songs are priced at $0.08 per song.',
        architecture: { output_modalities: ['text', 'audio'] }, pricing: zeroTokens },
      ...['image', 'audio', 'video', 'speech'].map((modality) => ({ id: `other/${modality}`,
        architecture: { output_modalities: [modality] }, pricing: zeroTokens })),
      { id: 'unknown/modalities', pricing: zeroTokens },
      { id: 'invalid/modalities', architecture: { output_modalities: ['text', null] }, pricing: zeroTokens },
      { id: 'free/text', architecture: { output_modalities: ['text'] }, pricing: zeroTokens },
    ] }))));
    const models = await (await import('./concierge-api')).listConciergeModels();
    expect(models.filter((model) => model.isFree).map((model) => model.id)).toEqual(['free/text']);
    expect(models.find((model) => model.id === 'google/lyria-3-clip-preview')).toMatchObject({
      inputPrice: 0, outputPrice: 0, isFree: false,
    });
  });

  it.each([null, { data: {} }, { data: 'models' }])('rejects an unreadable public catalog %j', async (response) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response))));
    const api = await import('./concierge-api');
    await expect(api.listConciergeModels()).rejects.toThrow('unreadable model list');
  });

  it('preserves the same catalogue metadata across native IPC and strips extra fields', async () => {
    const payload = { data: [{ id: 'test/model', name: 'Test', description: 'Full metadata', context_length: 32000,
      created: 1700000000, pricing: { prompt: '0', completion: '0.000001', request: '0' },
      supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text', 'image'] } }] };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload))));
    const api = await import('./concierge-api');
    const browser = await api.listConciergeModels();
    native.enabled = true;
    native.invoke.mockResolvedValue(browser.map((model) => ({ ...model, other: 'discard' })));
    expect(await api.listConciergeModels()).toEqual(browser);
    expect(native.invoke).toHaveBeenCalledWith('concierge_list_models');
  });

  it.each([
    { name: 5 }, { supportsTools: 'true' }, { inputPrice: -1 }, { outputPrice: Infinity },
    { requestPrice: '0' }, { contextLength: 1.5 }, { created: -1 },
    { inputModalities: 'text' }, { outputModalities: ['text', 5] }, { description: null }, { isFree: 'true' },
    { id: 'bad id' }, { contextLength: undefined },
  ])('rejects malformed native model metadata %j', async (invalid) => {
    native.enabled = true;
    native.invoke.mockResolvedValue([{
      id: 'test/model', name: 'Test', description: '', contextLength: null, created: null,
      inputPrice: null, outputPrice: null, requestPrice: null, isFree: false, supportsTools: false,
      inputModalities: [], outputModalities: [], ...invalid,
    }]);
    const api = await import('./concierge-api');
    await expect(api.listConciergeModels()).rejects.toThrow('unreadable model list');
  });
});
