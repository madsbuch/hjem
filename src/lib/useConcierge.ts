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
import {
  conciergeSystemPrompt,
  conciergeTools,
  createConciergeExecutor,
  type ConciergeContext,
} from './concierge-tools';

const labels: Record<string, string> = {
  get_home_state: 'Checking your home',
  control_device: 'Adjusting a device',
  activate_scene: 'Activating your scene',
  list_apps: 'Finding your apps',
  open_app: 'Opening your app',
};

export function useConcierge(context: ConciergeContext) {
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
  const add = (role: ConciergeMessage['role'], text: string) => {
    if (mounted.current)
      setMessages((previous) => [
        ...previous,
        { id: crypto.randomUUID(), role, text },
      ]);
  };

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void getConciergeSettings()
      .then((value) => {
        if (!cancelled) setSettings(value);
      })
      .catch((error) => {
        if (!cancelled)
          setSettingsError(
            error instanceof Error
              ? error.message
              : 'Could not load concierge settings.',
          );
      });
    return () => {
      cancelled = true;
      mounted.current = false;
      generation.current++;
      currentRun.current?.abort();
      currentRun.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    // Invalidate the old run before aborting it: its catch/finally handlers may
    // settle after a new home or model has already started a conversation.
    generation.current++;
    const previousRun = currentRun.current;
    currentRun.current = null;
    previousRun?.abort();
    history.current = [];
    setMessages([]);
    setUsage(null);
    setBusy(false);
    setStatus('');
  }, [context.sessionId, settings.model]);

  async function send(text: string) {
    if (currentRun.current || pendingSettings.current > 0 || !text.trim())
      return;
    if (!settings.hasApiKey || !settings.model) {
      add(
        'error',
        'Add your OpenRouter key and choose a model in Settings first.',
      );
      return;
    }
    if (text.length > 8000) {
      add('error', 'Please keep your message under 8,000 characters.');
      return;
    }
    const controller = new AbortController();
    currentRun.current = controller;
    const homeSession = latest.current.sessionId;
    const runGeneration = generation.current;
    const runModel = settings.model;
    const isCurrentRun = () =>
      mounted.current &&
      currentRun.current === controller &&
      generation.current === runGeneration &&
      latest.current.sessionId === homeSession &&
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
      ...retained,
      { role: 'user', content: text.trim() },
    ];
    const activityIds = new Map<string, string[]>();
    try {
      const result = await runConcierge({
        messages: wire,
        systemPrompt: conciergeSystemPrompt,
        tools: conciergeTools,
        request: requestConcierge,
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
              setMessages((previous) => [
                ...previous,
                { id, role: 'activity', text: `${label}…` },
              ]);
              setStatus(`${label}…`);
            } else {
              const id = activityIds.get(event.name)?.shift();
              if (id)
                setMessages((previous) =>
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
      }
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
      history.current = [];
      setMessages([]);
      setUsage(null);
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
    send,
    stop,
    clear,
  };
}
