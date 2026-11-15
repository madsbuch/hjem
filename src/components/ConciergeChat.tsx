import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  ArrowRight,
  ArrowUp,
  CircleAlert,
  Grid2X2,
  Lightbulb,
  LoaderCircle,
  MessageCircle,
  Music2,
  Plus,
  Settings2,
  Sofa,
  Sparkles,
  Square,
  Wrench,
} from 'lucide-react';

export interface ConciergeMessage {
  id: string;
  role: 'user' | 'assistant' | 'activity' | 'error';
  text: string;
}

export interface ConciergeChatProps {
  messages: ConciergeMessage[];
  busy: boolean;
  status: string;
  configured: boolean;
  model: string;
  onSend: (text: string) => void;
  onStop: () => void;
  onClear: () => void;
  onOpenSettings: () => void;
}

const suggestions = [
  { text: 'Which lights are on?', Icon: Lightbulb },
  { text: 'Make the living room cosy', Icon: Sofa },
  { text: 'What is playing on Sonos?', Icon: Music2 },
  { text: 'Open my music app', Icon: Grid2X2 },
];

export function ConciergeChat({
  messages,
  busy,
  status,
  configured,
  model,
  onSend,
  onStop,
  onClear,
  onOpenSettings,
}: ConciergeChatProps) {
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const newest = useRef<HTMLDivElement>(null);
  const canSend = configured && !busy && draft.trim().length > 0;

  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(input.current.scrollHeight, 160)}px`;
  }, [draft]);

  useEffect(() => {
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    newest.current?.scrollIntoView({
      behavior: busy || reducedMotion ? 'auto' : 'smooth',
      block: 'nearest',
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
            disabled={busy}
            aria-label="New conversation"
          >
            <Plus size={17} />
            <span>New conversation</span>
          </button>
          <button
            className="concierge-settings-button"
            onClick={onOpenSettings}
            aria-label="Concierge settings"
            title="Concierge settings"
          >
            <Settings2 size={19} />
          </button>
        </div>
      </header>

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

      <div className="concierge-chat-panel">
        <div className="concierge-panel-topline">
          <span className="concierge-identity">
            <Sparkles size={16} />
            Home Concierge
          </span>
          <button
            className="concierge-model"
            onClick={onOpenSettings}
            title={model || 'Choose a model in Settings'}
          >
            <span className={configured ? 'configured' : ''} />
            {configured
              ? model.split('/').pop() || 'OpenRouter'
              : 'Ready for setup'}
          </button>
        </div>

        <div className="concierge-scroll">
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
                  ? 'Ask a question, make a little adjustment, or find the app you need.'
                  : 'Set up Home Concierge to ask about your devices, control your home, and open your apps.'}
              </p>
              {configured && (
                <div className="concierge-suggestions">
                  {suggestions.map(({ text, Icon }) => (
                    <button
                      key={text}
                      onClick={() => onSend(text)}
                      disabled={busy}
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
                  <p>{message.text}</p>
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
          <div ref={newest} className="concierge-scroll-anchor" />
        </div>

        <form className="concierge-compose" onSubmit={handleSubmit}>
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
                  ? 'What can I help with at home?'
                  : 'Set up Concierge in Settings to send a message.'
              }
              disabled={!configured}
              rows={1}
            />
            {busy ? (
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
              <button
                type="submit"
                className="concierge-send"
                disabled={!canSend}
                aria-label="Send message"
                title="Send message"
              >
                <ArrowUp size={22} />
              </button>
            )}
          </div>
          <div className="concierge-compose-hint">
            <span>
              {configured
                ? 'A little help, right here at home.'
                : 'Add an OpenRouter key and choose a model in Settings.'}
            </span>
            <span className="concierge-keyboard-hint">
              Enter to send · Shift + Enter for a new line
            </span>
          </div>
        </form>
      </div>
    </section>
  );
}
