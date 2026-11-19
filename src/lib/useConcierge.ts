import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ConciergeMessage } from '../components/ConciergeChat';
import {
  ConciergeRunError,
  runConcierge,
  type AgentUsage,
  type WireMessage,
} from './concierge-agent';
import {
  getConciergeSettings,
  requestConcierge,
  type ConciergeSettings,
} from './concierge-api';
import { requestConciergeVoice } from './concierge-voice-api';
import { listConciergeChats, loadConciergeChat, saveConciergeChat, type ChatRecord, type ChatSummary } from './concierge-history';
import {
  conciergeSystemPrompt,
  toolsFor,
  createConciergeExecutor,
  type ConciergeContext,
} from './concierge-tools';

const labels: Record<string, string> = {
  get_home_state: 'Checking your home',
  control_device: 'Adjusting a device',
  activate_scene: 'Activating your scene',
  list_home_structure: 'Checking rooms and devices',
  create_room: 'Creating your room',
  rename_room: 'Renaming your room',
  assign_device_to_room: 'Moving your device',
  assign_entity_to_room: 'Updating the room assignment',
  inspect_mood: 'Checking your mood',
  save_mood: 'Saving your mood',
  rename_device: 'Renaming your device',
  rename_entity: 'Renaming your device',
  set_entity_hidden: 'Updating what Hjem shows',
  delete_room: 'Deleting your room',
  list_routines: 'Checking automations and scripts',
  inspect_routine: 'Reading your routine',
  list_device_triggers: 'Checking what the device can trigger',
  save_automation: 'Saving your automation',
  save_script: 'Saving your script',
  delete_routine: 'Deleting your routine',
  set_automation_enabled: 'Updating your automation',
  run_routine: 'Running your routine',
  get_routine_runs: 'Checking recent runs',
  list_helpers: 'Checking helpers',
  save_helper: 'Saving your helper',
  delete_helper: 'Deleting your helper',
  list_setup_changes: 'Checking recent setup changes',
  undo_setup_change: 'Undoing your setup change',
  list_apps: 'Finding your apps',
  open_app: 'Opening your app',
  get_electricity_prices: 'Checking electricity prices',
  find_cheapest_hours: 'Finding the cheapest hours',
  get_electricity_usage: 'Checking your electricity use',
};

export function useConcierge(context: ConciergeContext, homeKey: string) {
  const latest = useRef(context);
  latest.current = context;
  const [messages, setMessages] = useState<ConciergeMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [settingsBusy, setSettingsBusyState] = useState(false);
  const pendingSettings = useRef(0);
  const setSettingsBusy = useCallback((pending: boolean) => {
    // Keep the guard synchronous, including navigation before React repaints.
    // A counter also covers overlapping settings operations from a remount.
    pendingSettings.current = Math.max(
      0,
      pendingSettings.current + (pending ? 1 : -1),
    );
    setSettingsBusyState(pendingSettings.current > 0);
  }, []);
  const [status, setStatus] = useState('');
  const [settings, setSettings] = useState<ConciergeSettings>({
    hasApiKey: false,
    model: '',
  });
  const [settingsError, setSettingsError] = useState('');
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const history = useRef<WireMessage[]>([]);
  const currentRun = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const latestModel = useRef(settings.model);
  latestModel.current = settings.model;
  const mounted = useRef(true);
  const messagesRef = useRef<ConciergeMessage[]>([]);
  const activeChat = useRef<ChatRecord | null>(null);
  const home = useRef(homeKey);
  home.current = homeKey;
  const initialized = useRef(false);
  const identity = useRef({ sessionId: context.sessionId, homeKey, model: settings.model });
  const cache = useRef(new Map<string, ChatRecord>());
  const unsaved = useRef(new Map<string, ChatRecord>());
  const saves = useRef<Promise<void>>(Promise.resolve());
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [chatHome, setChatHome] = useState(homeKey);
  const [initializing, setInitializing] = useState(true);
  const [openingChat, setOpeningChat] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [saveError, setSaveError] = useState('');
  const summary = (chat: ChatRecord): ChatSummary => {
    const { messages: saved, ...details } = chat;
    return { ...details, messageCount: saved.length };
  };
  const mergeChats = (saved: ChatSummary[]) => {
    const combined = new Map(saved.map((chat) => [chat.id, chat]));
    for (const chat of cache.current.values()) {
      const savedChat = combined.get(chat.id);
      if (!savedChat || chat.updatedAt >= savedChat.updatedAt) combined.set(chat.id, summary(chat));
    }
    return [...combined.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  };
  const queueSave = (chat: ChatRecord) => {
    unsaved.current.set(chat.id, chat);
    saves.current = saves.current.then(async () => {
      try {
        await saveConciergeChat(chat);
        if (unsaved.current.get(chat.id) === chat) unsaved.current.delete(chat.id);
        if (mounted.current && unsaved.current.size === 0) setSaveError('');
      } catch {
        if (mounted.current) setSaveError('This conversation could not be saved. Keep Hjem open and retry saving.');
      }
    });
  };
  const changeMessages = (update: (previous: ConciergeMessage[]) => ConciergeMessage[]) => {
    if (!mounted.current) return;
    const next = update(messagesRef.current);
    messagesRef.current = next;
    setMessages(next);
    const firstUser = next.find((message) => message.role === 'user');
    if (!firstUser || chatHome !== home.current) return;
    const previous = activeChat.current;
    const now = Math.min(8_640_000_000_000_000, Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1));
    const title = firstUser.text.replace(/\s+/g, ' ').trim();
    const chat: ChatRecord = {
      id: previous?.id ?? crypto.randomUUID(),
      title: title.length > 80 ? `${title.slice(0, 80)}…` : title || 'Conversation',
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      model: latestModel.current,
      homeKey: home.current,
      messages: next.map((message) => ({ ...message })),
    };
    activeChat.current = chat;
    cache.current.set(chat.id, chat);
    setChatId(chat.id);
    setChats(mergeChats);
    queueSave(chat);
  };
  const add = (role: ConciergeMessage['role'], text: string) => changeMessages((previous) => [
    ...previous, { id: crypto.randomUUID(), role, text },
  ]);
  const restoreChat = (chat: ChatRecord | null) => {
    activeChat.current = chat;
    setChatId(chat?.id ?? null);
    setChatHome(chat?.homeKey ?? home.current);
    const restored = chat?.messages.map((message) => message.role === 'activity' && message.text.endsWith('…')
      ? { ...message, text: `${message.text.slice(0, -1)} · interrupted` } : { ...message }) ?? [];
    messagesRef.current = restored;
    setMessages(restored);
    // Saved transcripts are conversational context only. Never replay stored
    // function calls, pending actions, provider reasoning, or microphone data.
    history.current = restored.flatMap((message): WireMessage[] => message.role === 'user' || message.role === 'assistant'
      ? [{ role: message.role, content: message.text }] : []);
    setUsage(null);
    if (chat) cache.current.set(chat.id, chat);
  };
  const refreshChats = async () => {
    try {
      const saved = await listConciergeChats();
      if (mounted.current) { setChats(mergeChats(saved)); setHistoryError(''); }
    } catch {
      if (mounted.current) setHistoryError('Previous chats could not be loaded. Please retry.');
    }
  };
  const openChat = async (id: string): Promise<boolean> => {
    if (currentRun.current || pendingSettings.current || !initialized.current || openingChat) return false;
    const version = ++generation.current;
    setOpeningChat(true);
    setHistoryError('');
    try {
      const chat = unsaved.current.get(id) ?? await loadConciergeChat(id);
      if (!mounted.current || version !== generation.current) return false;
      if (!chat) throw new Error('Conversation not found');
      restoreChat(chat);
      return true;
    } catch {
      if (mounted.current && version === generation.current) setHistoryError('This conversation could not be opened. Please retry.');
      return false;
    } finally {
      if (mounted.current) setOpeningChat(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const start = async () => {
      const [loadedSettings, savedChats] = await Promise.allSettled([getConciergeSettings(), listConciergeChats()]);
      if (cancelled) return;
      const value = loadedSettings.status === 'fulfilled' ? loadedSettings.value : { hasApiKey: false, model: '' };
      if (loadedSettings.status === 'rejected') setSettingsError('Could not load concierge settings.');
      setSettings(value);
      latestModel.current = value.model;
      if (savedChats.status === 'fulfilled') {
        setChats(mergeChats(savedChats.value));
        const recent = savedChats.value.find((chat) => chat.homeKey === home.current);
        if (recent) {
          try {
            const chat = await loadConciergeChat(recent.id);
            if (cancelled) return;
            if (chat?.homeKey === home.current) restoreChat(chat);
          } catch {
            if (!cancelled) setHistoryError('Your latest conversation could not be opened. You can retry from Chat history.');
          }
        }
      } else setHistoryError('Previous chats could not be loaded. Please retry.');
      if (cancelled) return;
      if (activeChat.current?.homeKey !== home.current) restoreChat(null);
      identity.current = { sessionId: latest.current.sessionId, homeKey: home.current, model: value.model };
      initialized.current = true;
      setInitializing(false);
    };
    void start();
    return () => {
      cancelled = true;
      mounted.current = false;
      generation.current++;
      currentRun.current?.abort();
      currentRun.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (!initialized.current || (identity.current.sessionId === context.sessionId && identity.current.homeKey === homeKey && identity.current.model === settings.model)) return;
    identity.current = { sessionId: context.sessionId, homeKey, model: settings.model };
    // Existing chats are already saved. Changing homes/models starts a fresh
    // conversation while keeping every earlier transcript in the archive.
    generation.current++;
    const previousRun = currentRun.current;
    currentRun.current = null;
    previousRun?.abort();
    history.current = [];
    restoreChat(null);
    setBusy(false);
    setStatus('');
  }, [context.sessionId, homeKey, settings.model]);

  async function send(text: string, voice?: { audio: string; onAudio: (chunk: string) => void }): Promise<boolean> {
    if (currentRun.current || pendingSettings.current > 0 || !initialized.current || openingChat || chatHome !== home.current || !text.trim())
      return false;
    if (!settings.hasApiKey || !settings.model) {
      add(
        'error',
        'Add your OpenRouter key and choose a model in Settings first.',
      );
      return false;
    }
    if (text.length > 8000) {
      add('error', 'Please keep your message under 8,000 characters.');
      return false;
    }
    const controller = new AbortController();
    currentRun.current = controller;
    const homeSession = latest.current.sessionId;
    const runHome = home.current;
    const runGeneration = generation.current;
    const runModel = settings.model;
    const isCurrentRun = () =>
      mounted.current &&
      currentRun.current === controller &&
      generation.current === runGeneration &&
      latest.current.sessionId === homeSession &&
      home.current === runHome &&
      latestModel.current === runModel;
    setBusy(true);
    setStatus('Thinking about your home…');
    setUsage(null);
    add('user', text.trim());
    const userTurns = history.current
      .map((message, index) => (message.role === 'user' ? index : -1))
      .filter((index) => index >= 0);
    const retained =
      userTurns.length > 3
        ? history.current.slice(userTurns[userTurns.length - 3])
        : history.current;
    const wire: WireMessage[] = [
      // Text-only models cannot accept earlier microphone recordings. Retain
      // their replies and tool results without sending unsupported audio.
      ...retained.map((message) => !voice && Array.isArray(message.content)
        ? { ...message, content: '[Voice message]' }
        : message),
      { role: 'user', content: voice
        ? [{ type: 'input_audio', input_audio: { data: voice.audio, format: 'wav' } }]
        : text.trim() },
    ];
    const activityIds = new Map<string, string[]>();
    try {
      const result = await runConcierge({
        messages: wire,
        systemPrompt: conciergeSystemPrompt + '\nEarlier conversation messages are historical context. Never repeat previous device actions automatically or use historical device states as current facts; discover the current home before acting.' + (latest.current.appsAvailable === false
          ? '\nHjem is not the home screen on this device, so you cannot find or open apps here; say so if asked.'
          : '') + (voice
          ? '\nThis is a spoken conversation. Reply naturally and concisely in the language the user speaks. Avoid Markdown formatting in spoken answers. Use the same home tools and wait for their results before reporting completed actions.'
          : ''),
        tools: toolsFor(latest.current),
        // Setting up a routine takes several reads before the write, and a retry if it is refused.
        limits: { requests: 16, tools: 36 },
        request: voice
          ? (body, signal) => requestConciergeVoice(body, signal, (chunk) => {
              if (isCurrentRun() && !signal.aborted) voice.onAudio(chunk);
            })
          : requestConcierge,
        executeTool: createConciergeExecutor(() => latest.current),
        signal: controller.signal,
        onEvent(event) {
          if (!isCurrentRun()) return;
          if (event.type === 'text') add('assistant', event.text);
          if (event.type === 'usage')
            setUsage({
              promptTokens: event.promptTokens,
              completionTokens: event.completionTokens,
              cost: event.cost,
            });
          if (event.type === 'tool') {
            const label = labels[event.name] || 'Working on your request';
            if (event.phase === 'running') {
              const id = crypto.randomUUID();
              activityIds.set(event.name, [
                ...(activityIds.get(event.name) || []),
                id,
              ]);
              changeMessages((previous) => [
                ...previous,
                { id, role: 'activity', text: `${label}…` },
              ]);
              setStatus(`${label}…`);
            } else {
              const id = activityIds.get(event.name)?.shift();
              if (id)
                changeMessages((previous) =>
                  previous.map((message) =>
                    message.id === id
                      ? {
                          ...message,
                          text:
                            event.phase === 'error'
                              ? `${label}: ${event.detail || 'could not complete'}`
                              : `${label} · done`,
                        }
                      : message,
                  ),
                );
              setStatus('Putting it together…');
            }
          }
        },
      });
      if (isCurrentRun()) {
        history.current = result.messages;
        setUsage(result.usage);
        return true;
      }
      return false;
    } catch (error) {
      if (isCurrentRun()) {
        if (error instanceof ConciergeRunError)
          history.current = error.messages;
        else history.current = wire;
        add(
          error instanceof ConciergeRunError && error.aborted
            ? 'activity'
            : 'error',
          error instanceof Error
            ? error.message
            : 'Home Concierge could not complete this request.',
        );
      }
      return false;
    } finally {
      if (currentRun.current === controller) {
        currentRun.current = null;
        if (mounted.current && generation.current === runGeneration) {
          setBusy(false);
          setStatus('');
        }
      }
    }
  }
  const stop = () => currentRun.current?.abort();
  const clear = () => {
    if (!currentRun.current) {
      generation.current++;
      restoreChat(null);
    }
  };
  return {
    messages,
    busy,
    settingsBusy,
    setSettingsBusy,
    status,
    settings,
    setSettings,
    settingsError,
    usage,
    voiceSessionKey: `${context.sessionId}:${homeKey}:${settings.model}:${generation.current}`,
    chats,
    chatId,
    historyLoading: initializing || openingChat,
    historyError,
    saveError,
    readOnly: chatHome !== homeKey,
    refreshChats,
    openChat,
    retrySaving: () => { for (const chat of unsaved.current.values()) queueSave(chat); },
    send,
    sendVoice: (audio: string, onAudio: (chunk: string) => void) => send('Voice message', { audio, onAudio }),
    stop,
    clear,
  };
}
