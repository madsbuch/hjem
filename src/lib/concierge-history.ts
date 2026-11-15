import { invoke, isTauri } from '@tauri-apps/api/core';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'activity' | 'error';
  text: string;
}
export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  homeKey: string;
  messageCount: number;
}
export interface ChatRecord extends Omit<ChatSummary, 'messageCount'> {
  messages: ChatMessage[];
}

const DATABASE = 'hjem-concierge-history';
const STORE = 'chats';
const MAX_MESSAGES = 20_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_STAMP = 8_640_000_000_000_000;
const unreadable = () => new Error('Saved Concierge chats could not be read. Your saved chats have not been changed.');
const unavailable = () => new Error('Chat history could not be saved or opened. Please retry; do not close this conversation until it is saved.');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const array = (value: unknown): value is unknown[] => Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const stamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_STAMP;
const bounded = (value: unknown, maximum: number, empty = false): value is string =>
  typeof value === 'string' && value.length <= maximum && (empty || value.trim().length > 0);
const role = (value: unknown): value is ChatMessage['role'] =>
  value === 'user' || value === 'assistant' || value === 'activity' || value === 'error';

function metadata(value: unknown): Omit<ChatSummary, 'messageCount'> {
  if (!record(value) || !id(value.id) || !bounded(value.title, 256) ||
      !stamp(value.createdAt) || !stamp(value.updatedAt) || value.updatedAt < value.createdAt ||
      !bounded(value.model, 200, true) || !bounded(value.homeKey, 1024)) throw unreadable();
  return {
    id: value.id, title: value.title, createdAt: value.createdAt,
    updatedAt: value.updatedAt, model: value.model, homeKey: value.homeKey,
  };
}

function parseSummary(value: unknown): ChatSummary {
  const base = metadata(value);
  if (!record(value) || !stamp(value.messageCount) || value.messageCount > MAX_MESSAGES) throw unreadable();
  return { ...base, messageCount: value.messageCount };
}

function parseChat(value: unknown): ChatRecord {
  const base = metadata(value);
  if (!record(value) || !array(value.messages) || value.messages.length > MAX_MESSAGES) throw unreadable();
  const ids = new Set<string>();
  const messages = value.messages.map((message): ChatMessage => {
    if (!record(message) || !id(message.id) || !role(message.role) || !bounded(message.text, 1024 * 1024, true) || ids.has(message.id))
      throw unreadable();
    ids.add(message.id);
    // Only visible text crosses the storage boundary. Audio recordings, provider
    // reasoning, tool arguments/results and credentials are deliberately omitted.
    return { id: message.id, role: message.role, text: message.text };
  });
  const chat = { ...base, messages };
  if (new TextEncoder().encode(JSON.stringify(chat)).byteLength > MAX_BYTES)
    throw new Error('This conversation is too large to save. Start a new chat; existing saved chats are unchanged.');
  return chat;
}

const summary = (chat: ChatRecord): ChatSummary => {
  const { messages, ...base } = chat;
  return { ...base, messageCount: messages.length };
};
const sortChats = (a: ChatSummary, b: ChatSummary) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
const conflict = () => new Error('A newer version of this chat is already saved. Reopen it before continuing.');
const transcriptPrefix = (prefix: ChatMessage[], messages: ChatMessage[]): boolean =>
  prefix.length <= messages.length && prefix.every((previous, index) => {
    const next = messages[index];
    return previous.id === next.id && previous.role === next.role &&
      (previous.role === 'activity' || previous.text === next.text);
  });

async function native(command: string, args?: Record<string, unknown>): Promise<unknown> {
  try { return await invoke<unknown>(command, args); }
  catch (cause) {
    throw cause instanceof Error ? cause : new Error(typeof cause === 'string' ? cause : unavailable().message);
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(unavailable()); return; }
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DATABASE, 1); }
    catch { reject(unavailable()); return; }
    let rejected = false;
    const fail = () => { rejected = true; reject(unavailable()); };
    request.onblocked = fail;
    request.onerror = fail;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const database = request.result;
      if (rejected) { database.close(); return; }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

async function readBrowser(idValue?: string): Promise<unknown> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = database.transaction(STORE, 'readonly'); }
    catch { database.close(); reject(unavailable()); return; }
    const store = transaction.objectStore(STORE);
    const request = idValue === undefined ? store.getAll() : store.get(idValue);
    let result: unknown;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onabort = () => { database.close(); reject(unavailable()); };
    transaction.onerror = () => { /* onabort reports the transaction failure. */ };
  });
}

async function saveBrowser(chat: ChatRecord): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = database.transaction(STORE, 'readwrite'); }
    catch { database.close(); reject(unavailable()); return; }
    const store = transaction.objectStore(STORE);
    let failure: Error | undefined;
    const request = store.get(chat.id);
    request.onsuccess = () => {
      try {
        const value: unknown = request.result;
        if (value !== undefined) {
          const previous = parseChat(value);
          if (previous.id !== chat.id || previous.createdAt !== chat.createdAt || previous.homeKey !== chat.homeKey)
            throw new Error('This chat belongs to a different conversation. Start a new chat.');
          if (previous.updatedAt > chat.updatedAt) {
            if (!transcriptPrefix(chat.messages, previous.messages)) throw conflict();
            return;
          }
          // A second window may continue an older copy of the same chat. Never
          // overwrite its saved branch, even when the counts or times match.
          if (!transcriptPrefix(previous.messages, chat.messages)) throw conflict();
        }
        store.put(chat);
      } catch (cause) {
        failure = cause instanceof Error ? cause : unavailable();
        transaction.abort();
      }
    };
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onabort = () => { database.close(); reject(failure ?? unavailable()); };
    transaction.onerror = () => { /* onabort reports the transaction failure. */ };
  });
}

// Snapshots are saved in creation order, including updates issued during a tool
// turn. A failed write is visible to its caller but does not poison later retries.
let writes: Promise<void> = Promise.resolve();

export async function listConciergeChats(): Promise<ChatSummary[]> {
  await writes;
  const value = isTauri() ? await native('concierge_list_chats') : await readBrowser();
  if (!array(value)) throw unreadable();
  const chats = isTauri() ? value.map(parseSummary) : value.map((chat) => summary(parseChat(chat)));
  return chats.sort(sortChats);
}

export async function loadConciergeChat(chatId: string): Promise<ChatRecord | null> {
  if (!id(chatId)) throw unreadable();
  await writes;
  const value = isTauri() ? await native('concierge_load_chat', { id: chatId }) : await readBrowser(chatId);
  if (value === null || value === undefined) return null;
  const chat = parseChat(value);
  if (chat.id !== chatId) throw unreadable();
  return chat;
}

export function saveConciergeChat(value: ChatRecord): Promise<void> {
  let chat: ChatRecord;
  try { chat = parseChat(value); }
  catch (cause) { return Promise.reject(cause); }
  const pending = writes.then(async () => {
    if (isTauri()) await native('concierge_save_chat', { chat });
    else await saveBrowser(chat);
  });
  writes = pending.catch(() => {});
  return pending;
}
