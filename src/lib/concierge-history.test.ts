import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRecord } from './concierge-history';

const native = vi.hoisted(() => ({
  enabled: true,
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.enabled, invoke: native.invoke }));

beforeEach(() => {
  vi.resetModules();
  native.enabled = true;
  native.invoke.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function chat(): ChatRecord {
  return {
    id: 'chat-1', title: 'Which lights are on?', createdAt: 100, updatedAt: 200,
    model: 'provider/model', homeKey: 'demo', messages: [
      { id: 'msg-1', role: 'user', text: 'Which lights are on?' },
      { id: 'msg-2', role: 'assistant', text: '**Kitchen** and living room.' },
    ],
  };
}

describe('persistent Concierge history', () => {
  it('returns every saved summary, sorted newest first across homes', async () => {
    const { messages, ...base } = chat();
    const values = Array.from({ length: 150 }, (_, index) => ({
      ...base, id: `chat-${index}`, homeKey: `home-${index % 3}`, updatedAt: 200 + index, messageCount: messages.length,
    }));
    native.invoke.mockResolvedValue(values);
    const { listConciergeChats } = await import('./concierge-history');
    const listed = await listConciergeChats();
    expect(listed).toHaveLength(150);
    expect(listed.map((item) => item.id)).toEqual([...values].reverse().map((item) => item.id));
    expect(native.invoke).toHaveBeenCalledWith('concierge_list_chats', undefined);
  });

  it('loads the visible transcript and strips fields that should never enter history', async () => {
    const original = chat();
    native.invoke.mockResolvedValue({ ...original, apiKey: 'fixture-key', history: ['provider state'], messages: [
      { ...original.messages[0], audio: 'recording', tool_calls: ['arguments'], reasoning_details: ['private'] },
      original.messages[1],
    ] });
    const { loadConciergeChat } = await import('./concierge-history');
    expect(await loadConciergeChat('chat-1')).toEqual(original);
    expect(native.invoke).toHaveBeenCalledWith('concierge_load_chat', { id: 'chat-1' });
    native.invoke.mockResolvedValue(null);
    expect(await loadConciergeChat('missing')).toBeNull();
  });

  it.each([
    { id: 'different-chat' }, { title: '' }, { createdAt: -1 }, { updatedAt: 99 },
    { createdAt: Number.MAX_SAFE_INTEGER + 1 }, { homeKey: '' },
    { messages: [{ id: 'message-1', role: 'tool', text: 'result' }] },
    { messages: [{ id: 'message-1', role: 'user', text: null }] },
    { messages: [{ id: 'same', role: 'user', text: 'a' }, { id: 'same', role: 'assistant', text: 'b' }] },
  ])('rejects malformed stored transcripts without changing them: %j', async (invalid) => {
    native.invoke.mockResolvedValue({ ...chat(), ...invalid });
    const { loadConciergeChat } = await import('./concierge-history');
    await expect(loadConciergeChat('chat-1')).rejects.toThrow('saved chats have not been changed');
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid ids before reading and invalid summaries without hiding them', async () => {
    const { listConciergeChats, loadConciergeChat } = await import('./concierge-history');
    await expect(loadConciergeChat('../chat')).rejects.toThrow('could not be read');
    expect(native.invoke).not.toHaveBeenCalled();
    native.invoke.mockResolvedValue([{ ...chat(), messageCount: -1 }]);
    await expect(listConciergeChats()).rejects.toThrow('could not be read');
  });

  it('accepts the JavaScript Date boundary and rejects safe integers outside it at every storage boundary', async () => {
    const maximumDate = 8_640_000_000_000_000;
    const boundary = { ...chat(), createdAt: maximumDate, updatedAt: maximumDate };
    const { messages, ...metadata } = boundary;
    const { loadConciergeChat, listConciergeChats, saveConciergeChat } = await import('./concierge-history');
    native.invoke.mockResolvedValue(boundary);
    const loaded = await loadConciergeChat('chat-1');
    expect(loaded).toEqual(boundary);
    expect(() => new Date(loaded?.updatedAt ?? NaN).toISOString()).not.toThrow();
    native.invoke.mockResolvedValue([{ ...metadata, messageCount: messages.length }]);
    expect(await listConciergeChats()).toHaveLength(1);
    for (const invalid of [
      { ...boundary, updatedAt: maximumDate + 1 },
      { ...boundary, createdAt: maximumDate + 1, updatedAt: maximumDate + 1 },
    ]) {
      native.invoke.mockResolvedValue(invalid);
      await expect(loadConciergeChat('chat-1')).rejects.toThrow('could not be read');
      native.invoke.mockResolvedValue([{ ...invalid, messageCount: messages.length }]);
      await expect(listConciergeChats()).rejects.toThrow('could not be read');
      native.invoke.mockClear();
      await expect(saveConciergeChat(invalid)).rejects.toThrow('could not be read');
      expect(native.invoke).not.toHaveBeenCalled();
    }
  });

  it('captures each visible snapshot immediately and writes in order before reading', async () => {
    let finishFirst: () => void = () => {};
    const firstWrite = new Promise<void>((resolve) => { finishFirst = resolve; });
    native.invoke.mockImplementationOnce(() => firstWrite).mockResolvedValue(undefined);
    const { saveConciergeChat, loadConciergeChat } = await import('./concierge-history');
    const original = chat();
    const first = saveConciergeChat({ ...original, messages: original.messages.map((item) => ({ ...item, audio: 'omit me' })) });
    original.messages[1].text = 'Updated answer';
    original.updatedAt = 300;
    const second = saveConciergeChat(original);
    const loaded = loadConciergeChat('chat-1');
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1));
    expect(native.invoke).toHaveBeenNthCalledWith(1, 'concierge_save_chat', { chat: chat() });
    native.invoke.mockImplementation(async (command) => command === 'concierge_load_chat' ? original : undefined);
    finishFirst();
    await Promise.all([first, second]);
    expect(await loaded).toEqual(original);
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'concierge_save_chat', { chat: original });
    expect(native.invoke).toHaveBeenNthCalledWith(3, 'concierge_load_chat', { id: 'chat-1' });
  });

  it('surfaces a failed native write and allows retrying the same transcript', async () => {
    native.invoke.mockRejectedValueOnce('Device storage is full.').mockResolvedValue(undefined);
    const { saveConciergeChat } = await import('./concierge-history');
    await expect(saveConciergeChat(chat())).rejects.toThrow('Device storage is full.');
    await expect(saveConciergeChat(chat())).resolves.toBeUndefined();
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });

  it('never substitutes temporary memory or localStorage when IndexedDB is unavailable', async () => {
    native.enabled = false;
    vi.stubGlobal('indexedDB', undefined);
    const storage = { setItem: vi.fn(), getItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    const { saveConciergeChat, listConciergeChats } = await import('./concierge-history');
    await expect(saveConciergeChat(chat())).rejects.toThrow('could not be saved or opened');
    await expect(listConciergeChats()).rejects.toThrow('could not be saved or opened');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it('reports blocked browser storage and closes a connection that opens after the rejection', async () => {
    native.enabled = false;
    const close = vi.fn();
    const request = {
      onblocked: () => {}, onerror: () => {}, onsuccess: () => {}, onupgradeneeded: () => {},
      result: { close },
    };
    const open = vi.fn(() => request);
    vi.stubGlobal('indexedDB', { open });
    const { listConciergeChats } = await import('./concierge-history');
    const pending = listConciergeChats();
    const rejection = expect(pending).rejects.toThrow('could not be saved or opened');
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('hjem-concierge-history', 1));
    request.onblocked();
    await rejection;
    request.onsuccess();
    expect(close).toHaveBeenCalledOnce();
  });
});
