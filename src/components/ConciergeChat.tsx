import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ArrowRight,
  ArrowUp,
  CircleAlert,
  History,
  Lightbulb,
  LoaderCircle,
  Mic,
  Plus,
  Sofa,
  Sparkles,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import { ConciergeMarkdown } from './ConciergeMarkdown';
import { ConciergeHistory } from './ConciergeHistory';
import type { ChatSummary } from '../lib/concierge-history';
import { useConciergeVoice } from '../lib/useConciergeVoice';

export interface ConciergeMessage {
  id: string;
  role: 'user' | 'assistant' | 'activity' | 'error';
  text: string;
}

export interface ConciergeChatProps {
  messages: ConciergeMessage[];
  chats: ChatSummary[];
  chatId: string | null;
  historyLoading: boolean;
  historyError: string;
  saveError: string;
  readOnly: boolean;
  onOpenChat: (id: string) => Promise<boolean>;
  onRefreshChats: () => Promise<void>;
  onRetrySaving: () => void;
  busy: boolean;
  settingsPending?: boolean;
  status: string;
  configured: boolean;
  onSend: (text: string) => void;
  onSendVoice: (audio: string, onAudio: (chunk: string) => void) => Promise<boolean>;
  voiceSessionKey: string;
  onStop: () => void;
  onClear: () => void;
  onOpenSettings: () => void;
  draftRequest?: { id: number; text: string };
  onDraftApplied?: (id: number) => void;
  /** Shown beside something else: a smaller heading, under the page's own. */
  compact?: boolean;
  /** Starting points for an empty conversation; defaults to everyday questions. */
  suggestions?: { text: string; Icon: typeof Lightbulb }[];
  placeholder?: string;
  children?: ReactNode;
}

const everydaySuggestions = [
  { text: 'Which lights are on?', Icon: Lightbulb },
  { text: 'Set up a cosy evening mood', Icon: Sofa },
];

export function ConciergeChat({
  messages,
  chats,
  chatId,
  historyLoading,
  historyError,
  saveError,
  readOnly,
  onOpenChat,
  onRefreshChats,
  onRetrySaving,
  busy,
  settingsPending = false,
  status,
  configured,
  onSend,
  onSendVoice,
  voiceSessionKey,
  onStop,
  onClear,
  onOpenSettings,
  draftRequest,
  onDraftApplied,
  compact = false,
  suggestions = everydaySuggestions,
  placeholder = 'Ask anything…',
  children,
}: ConciergeChatProps) {
  const [draft, setDraft] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const appliedDraft = useRef<number | undefined>(undefined);
  const voice = useConciergeVoice({
    enabled: configured && !settingsPending && !historyLoading && !readOnly,
    busy,
    sessionKey: voiceSessionKey,
    onSend: onSendVoice,
    onStop,
  });
  const canSend =
    configured && !busy && !settingsPending && !historyLoading && !readOnly && !voice.active && draft.trim().length > 0;

  useEffect(() => {
    if (!draftRequest || !configured || busy || appliedDraft.current === draftRequest.id) return;
    appliedDraft.current = draftRequest.id;
    setDraft(draftRequest.text);
    input.current?.focus();
    onDraftApplied?.(draftRequest.id);
  }, [draftRequest, configured, busy, onDraftApplied]);

  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(input.current.scrollHeight, 160)}px`;
  }, [draft, busy, voice.active]);

  useEffect(() => {
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    transcript.current?.scrollTo({
      top: messages.length || busy ? transcript.current.scrollHeight : 0,
      behavior: busy || reducedMotion ? 'auto' : 'smooth',
    });
  }, [messages, busy, status]);

  const send = () => {
    if (!canSend) return;
    onSend(draft.trim());
    setDraft('');
    input.current?.focus();
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      send();
    }
  };

  return (
    <section className="concierge-page" aria-label="Home Concierge">
      <header className="concierge-heading">
        {compact
          ? <h2>Concierge<span>.</span></h2>
          : <h1>Concierge<span>.</span></h1>}
        <div className="concierge-header-actions">
          <button className="concierge-new" aria-label="Chat history" title="Chat history" disabled={voice.active}
            onClick={() => { setHistoryOpen(true); void onRefreshChats(); }}>
            <History size={18} />
          </button>
          <button
            className="concierge-new"
            onClick={() => {
              onClear();
              setDraft('');
              input.current?.focus();
            }}
            disabled={busy || settingsPending || voice.active || historyLoading}
            aria-label="New conversation"
            title="New conversation"
          >
            <Plus size={18} />
          </button>
        </div>
      </header>

      <div className="concierge-chat-panel">
        <div className="concierge-scroll" ref={transcript} tabIndex={0} role="region" aria-label="Conversation history">
          {historyLoading && <div className="concierge-history-banner" role="status">Loading conversation…</div>}
          {historyError && <div className="concierge-history-banner" role="alert"><span>{historyError}</span>
            <button onClick={() => { setHistoryOpen(true); void onRefreshChats(); }}>Open chat history</button></div>}
          {readOnly && <div className="concierge-history-banner">This chat belongs to another home. Start a new conversation to use your current home.</div>}
          {!configured && !historyLoading && (
            <div className="concierge-setup">
              <p>Add an OpenRouter key in Settings to get started.</p>
              <button className="primary-button" onClick={onOpenSettings}>
                Set up Concierge
                <ArrowRight size={17} />
              </button>
            </div>
          )}
          {messages.length === 0 && !busy && !historyLoading && configured && (
            <div className="concierge-welcome">
              <h2>How can I help?</h2>
              <div className="concierge-suggestions">
                {suggestions.map(({ text, Icon }) => (
                  <button
                    key={text}
                    onClick={() => onSend(text)}
                    disabled={busy || settingsPending || voice.active || historyLoading || readOnly}
                  >
                    <Icon size={18} strokeWidth={1.7} />
                    <span>{text}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div
            className="concierge-log"
            role="log"
            aria-label="Conversation with Home Concierge"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {messages.map((message) =>
              message.role === 'activity' ? (
                <div className="concierge-activity" key={message.id}>
                  <Wrench size={14} />
                  <p>{message.text}</p>
                </div>
              ) : message.role === 'error' ? (
                <div className="concierge-message-error" key={message.id}>
                  <CircleAlert size={18} />
                  <p>{message.text}</p>
                </div>
              ) : (
                <article
                  className={`concierge-message concierge-message-${message.role}`}
                  key={message.id}
                  aria-label={
                    message.role === 'user'
                      ? 'Your message'
                      : 'Home Concierge response'
                  }
                >
                  <span className="concierge-message-author">
                    {message.role === 'assistant' && <Sparkles size={12} />}
                    {message.role === 'user' ? 'You' : 'Home Concierge'}
                  </span>
                  {message.role === 'assistant'
                    ? <ConciergeMarkdown>{message.text}</ConciergeMarkdown>
                    : <p>{message.text}</p>}
                </article>
              ),
            )}
          </div>
          {busy && (
            <div className="concierge-working" role="status">
              <LoaderCircle size={17} className="spin" />
              <span>{status || 'Thinking about your home…'}</span>
            </div>
          )}
          {children}
        </div>

        {saveError && <div className="concierge-history-banner" role="alert"><span>{saveError}</span>
          <button onClick={onRetrySaving}>Retry saving</button></div>}
        <form className="concierge-compose" onSubmit={handleSubmit}>
          {voice.active && (
            <div className="concierge-voice-status" role="status">
              <Mic size={15} />
              <span>{voice.phase === 'starting' ? 'Opening microphone…'
                : voice.phase === 'recording' ? 'Listening…'
                  : voice.phase === 'speaking' ? 'Speaking…' : 'Thinking…'}</span>
            </div>
          )}
          {voice.error && (
            <div className="concierge-voice-error" role="alert">
              <span>{voice.error}</span>
              <button type="button" onClick={voice.clearError} aria-label="Dismiss voice error"><X size={16} /></button>
            </div>
          )}
          <div
            className={`concierge-input-wrap ${!configured ? 'unconfigured' : ''}`}
          >
            <textarea
              ref={input}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              aria-label="Message Home Concierge"
              placeholder={
                configured
                  ? placeholder
                  : 'Set up Concierge first'
              }
              disabled={!configured || settingsPending || voice.active || historyLoading || readOnly}
              rows={1}
            />
            {voice.phase === 'recording' ? (
              <>
                <button type="button" className="concierge-mic" onClick={voice.stop} aria-label="Cancel voice message" title="Cancel recording"><X size={20} /></button>
                <button type="button" className="concierge-send" onClick={() => void voice.send()} aria-label="Send voice message" title="Send voice message"><ArrowUp size={22} /></button>
              </>
            ) : voice.active ? (
              <button type="button" className="concierge-stop" onClick={voice.stop}
                aria-label={voice.phase === 'starting' ? 'Cancel voice message' : 'Stop concierge'} title="Stop voice">
                <Square size={15} fill="currentColor" />
              </button>
            ) : busy ? (
              <button
                type="button"
                className="concierge-stop"
                onClick={onStop}
                aria-label="Stop concierge"
                title="Stop concierge"
              >
                <Square size={15} fill="currentColor" />
              </button>
            ) : (
              <>
              <button type="button" className="concierge-mic" onClick={() => void voice.start()}
                disabled={!configured || settingsPending || historyLoading || readOnly} aria-label="Start voice message" title="Voice message">
                <Mic size={21} />
              </button>
              <button
                type="submit"
                className="concierge-send"
                disabled={!canSend}
                aria-label="Send message"
                title="Send message"
              >
                <ArrowUp size={22} />
              </button>
              </>
            )}
          </div>
          {settingsPending && <div className="concierge-compose-hint"><span>Updating concierge settings…</span></div>}
        </form>
      </div>
      <ConciergeHistory open={historyOpen} chats={chats} selectedId={chatId}
        loading={historyLoading} error={historyError} disabled={busy || settingsPending || voice.active}
        onSelect={async (id) => { const selected = await onOpenChat(id); if (selected) setDraft(''); return selected; }}
        onRefresh={onRefreshChats} onClose={() => setHistoryOpen(false)} />
    </section>
  );
}
