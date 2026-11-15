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
  Lightbulb,
  LoaderCircle,
  MessageCircle,
  Mic,
  Music2,
  Plus,
  Sofa,
  Sparkles,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import { ConciergeMarkdown } from './ConciergeMarkdown';
import { useConciergeVoice } from '../lib/useConciergeVoice';

export interface ConciergeMessage {
  id: string;
  role: 'user' | 'assistant' | 'activity' | 'error';
  text: string;
}

export interface ConciergeChatProps {
  messages: ConciergeMessage[];
  busy: boolean;
  settingsPending?: boolean;
  status: string;
  configured: boolean;
  model: string;
  onSend: (text: string) => void;
  onSendVoice: (audio: string, onAudio: (chunk: string) => void) => Promise<boolean>;
  voiceSessionKey: string;
  onStop: () => void;
  onClear: () => void;
  onOpenSettings: () => void;
  draftRequest?: { id: number; text: string };
  onDraftApplied?: (id: number) => void;
  children?: ReactNode;
}

const suggestions = [
  { text: 'Which lights are on?', Icon: Lightbulb },
  { text: 'Set up a cosy evening mood', Icon: Sofa },
  { text: 'What is playing on Sonos?', Icon: Music2 },
  { text: 'Help me organize my rooms and devices', Icon: Wrench },
];

export function ConciergeChat({
  messages,
  busy,
  settingsPending = false,
  status,
  configured,
  model,
  onSend,
  onSendVoice,
  voiceSessionKey,
  onStop,
  onClear,
  onOpenSettings,
  draftRequest,
  onDraftApplied,
  children,
}: ConciergeChatProps) {
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const appliedDraft = useRef<number | undefined>(undefined);
  const voice = useConciergeVoice({
    enabled: configured && !settingsPending,
    busy,
    sessionKey: voiceSessionKey,
    onSend: onSendVoice,
    onStop,
  });
  const canSend =
    configured && !busy && !settingsPending && !voice.active && draft.trim().length > 0;

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
        <div>
          <span className="eyebrow date-label">
            YOUR HOME, WITH A HELPING HAND
          </span>
          <h1>
            Home Concierge<span>.</span>
          </h1>
          <p>A little help around the home.</p>
        </div>
        <div className="concierge-header-actions">
          <button
            className="concierge-new"
            onClick={() => {
              onClear();
              setDraft('');
              input.current?.focus();
            }}
            disabled={busy || settingsPending || voice.active}
            aria-label="New conversation"
          >
            <Plus size={17} />
            <span>New conversation</span>
          </button>
        </div>
      </header>

      <div className="concierge-chat-panel">
        <div className="concierge-panel-topline">
          <span className="concierge-identity">
            <Sparkles size={16} />
            Home Concierge
          </span>
          <button
            className="concierge-model"
            onClick={onOpenSettings}
            title={voice.active ? 'openai/gpt-audio' : model || 'Choose a model in Settings'}
            disabled={voice.active}
          >
            <span className={configured ? 'configured' : ''} />
            {voice.active ? 'gpt-audio' : configured
              ? model.split('/').pop() || 'OpenRouter'
              : 'Ready for setup'}
          </button>
        </div>

        <div className="concierge-scroll" ref={transcript} tabIndex={0} role="region" aria-label="Conversation history">
          {!configured && (
            <div className="concierge-setup">
              <span className="concierge-setup-icon">
                <Sparkles size={25} strokeWidth={1.6} />
              </span>
              <div>
                <h2>A little introduction first.</h2>
                <p>
                  Add your OpenRouter key and choose a model in Settings to start
                  talking with your home.
                </p>
              </div>
              <button className="primary-button" onClick={onOpenSettings}>
                Set up Concierge
                <ArrowRight size={17} />
              </button>
            </div>
          )}
          {messages.length === 0 && !busy && (
            <div className="concierge-welcome">
              <span className="concierge-welcome-mark">
                <Sparkles size={35} strokeWidth={1.4} />
              </span>
              <h2>
                {configured
                  ? 'What would feel good at home?'
                  : 'Your home. A conversation away.'}
              </h2>
              <p>
                {configured
                  ? 'Organize your rooms, set up a mood, or ask for a little adjustment.'
                  : 'Set up Home Concierge to organize rooms, create moods, control devices, and open your apps.'}
              </p>
              {configured && (
                <div className="concierge-suggestions">
                  {suggestions.map(({ text, Icon }) => (
                    <button
                      key={text}
                      onClick={() => onSend(text)}
                      disabled={busy || settingsPending || voice.active}
                    >
                      <Icon size={19} strokeWidth={1.7} />
                      <span>{text}</span>
                      <ArrowRight size={15} />
                    </button>
                  ))}
                </div>
              )}
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

        <form className="concierge-compose" onSubmit={handleSubmit}>
          {voice.active && (
            <div className="concierge-voice-status" role="status">
              <Mic size={15} />
              <span>{voice.phase === 'starting' ? 'Opening microphone…'
                : voice.phase === 'recording' ? 'Listening… Tap send when finished.'
                  : voice.phase === 'speaking' ? 'Speaking…' : 'Waiting for a reply…'}</span>
              <span>GPT Audio</span>
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
            <MessageCircle
              className="concierge-input-icon"
              size={20}
              strokeWidth={1.6}
            />
            <textarea
              ref={input}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              aria-label="Message Home Concierge"
              placeholder={
                configured
                  ? 'Message Home Concierge'
                  : 'Set up Concierge in Settings to send a message.'
              }
              disabled={!configured || settingsPending || voice.active}
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
                disabled={!configured || settingsPending} aria-label="Start voice message" title="Voice message · GPT Audio">
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
          <div className="concierge-compose-hint">
            {settingsPending && <span>Updating concierge settings…</span>}
            <span className="concierge-keyboard-hint">
              Enter to send · Shift + Enter for a new line
            </span>
          </div>
        </form>
      </div>
    </section>
  );
}
