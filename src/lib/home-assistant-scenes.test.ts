import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSceneConfig, requestSceneConfig, SceneConfigNotFoundError, SceneRequestError } from './home-assistant-scenes';

afterEach(() => vi.unstubAllGlobals());

describe('Home Assistant persistent scene transport', () => {
  it('accepts YAML boolean states but rejects unusable scene definitions', () => {
    expect(parseSceneConfig({ name: 'Evening', id: '123', entities: { 'light.desk': true, 'light.hall': { state: false, brightness: 80 } } })).toEqual({
      name: 'Evening', id: '123', entities: { 'light.desk': 'on', 'light.hall': { state: 'off', brightness: 80 } },
    });
    expect(() => parseSceneConfig({ name: 'Broken', entities: { 'light.desk': { brightness: 10 } } })).toThrow('scene state');
    expect(() => parseSceneConfig({ name: 'Broken', entities: { '../bad': 'on' } })).toThrow('scene entity');
  });

  it('saves through the fixed scene-editor path and never follows redirects', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const config = { name: 'Evening', entities: { 'light.desk': 'on' } };
    await requestSceneConfig('http://homeassistant.local:8123', 'fixture-secret', 'POST', 'hjem_123', config);
    expect(fetch).toHaveBeenCalledWith('http://homeassistant.local:8123/api/config/scene/config/hjem_123', expect.objectContaining({
      method: 'POST', redirect: 'error', body: JSON.stringify(config),
      headers: { Authorization: 'Bearer fixture-secret', 'Content-Type': 'application/json' },
    }));
    await expect(requestSceneConfig('http://homeassistant.local:8123', 'fixture-secret', 'GET', '../other')).rejects.toThrow('identifier');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports permission errors without exposing remote content and limits response size', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret from upstream', { status: 403 })));
    await expect(requestSceneConfig('http://home', 'token', 'GET', '123')).rejects.toThrow('administrator');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(256 * 1024 + 1))));
    await expect(requestSceneConfig('http://home', 'token', 'GET', '123')).rejects.toThrow('oversized');
  });

  it('distinguishes a confirmed missing scene from an unavailable endpoint and unknown write outcome', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Resource not found' }), { status: 404 })));
    await expect(requestSceneConfig('http://home', 'token', 'GET', '123')).rejects.toBeInstanceOf(SceneConfigNotFoundError);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('404: Not Found', { status: 404 })));
    await expect(requestSceneConfig('http://home', 'token', 'GET', '123')).rejects.toMatchObject({ definitelyRejected: true, message: expect.stringContaining('does not support') });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unknown upstream failure', { status: 500 })));
    await expect(requestSceneConfig('http://home', 'token', 'POST', '123', { name: 'Mood', entities: {} })).rejects.toMatchObject({ definitelyRejected: false });
    expect(new SceneRequestError('rejected', true).definitelyRejected).toBe(true);
  });
});
