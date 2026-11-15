import { useEffect, useRef, useState } from 'react';
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
  const [status, setStatus] = useState('');
  const [settings, setSettings] = useState<ConciergeSettings>({
    hasApiKey: false,
    model: '',
  });
  const [settingsError, setSettingsError] = useState('');
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const history = useRef<WireMessage[]>([]);
  const currentRun = useRef<AbortController | null>(null);
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
      currentRun.current?.abort();
    };
  }, []);
  useEffect(() => {
    currentRun.current?.abort();
    history.current = [];
    setMessages([]);
    setUsage(null);
  }, [context.sessionId, settings.model]);

  async function send(text: string) {
    if (currentRun.current || !text.trim()) return;
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
          if (!mounted.current || latest.current.sessionId !== homeSession)
            return;
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
      if (latest.current.sessionId === homeSession) {
        history.current = result.messages;
        setUsage(result.usage);
      }
    } catch (error) {
      if (latest.current.sessionId === homeSession) {
        if (error instanceof ConciergeRunError)
          history.current = error.messages;
        else history.current = wire;
      }
      if (latest.current.sessionId === homeSession)
        add(
          error instanceof ConciergeRunError && error.aborted
            ? 'activity'
            : 'error',
          error instanceof Error
            ? error.message
            : 'Home Concierge could not complete this request.',
        );
    } finally {
      if (currentRun.current === controller) currentRun.current = null;
      if (mounted.current) {
        setBusy(false);
        setStatus('');
      }
    }
  }
  const stop = () => currentRun.current?.abort();
  const clear = () => {
    if (!currentRun.current) {
      history.current = [];
      setMessages([]);
      setUsage(null);
    }
  };
  return {
    messages,
    busy,
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
