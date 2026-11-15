import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, LoaderCircle, MessageCircle, RefreshCw, Search, X } from 'lucide-react';
import type { ChatSummary } from '../lib/concierge-history';
import '../concierge-history.css';

interface Props {
  open: boolean;
  chats: ChatSummary[];
  selectedId: string | null;
  loading: boolean;
  error: string;
  disabled: boolean;
  onSelect: (id: string) => Promise<boolean>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}

export function ConciergeHistory({ open, chats, selectedId, loading, error, disabled, onSelect, onRefresh, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const shown = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return chats.filter((chat) => terms.every((term) => `${chat.title} ${chat.model}`.toLocaleLowerCase().includes(term)));
  }, [chats, query]);
  return <dialog ref={dialog} className="concierge-history" aria-labelledby="chat-history-title" onClose={onClose}>
    <header>
      <div><span className="eyebrow">HOME CONCIERGE</span><h2 id="chat-history-title">Previous chats</h2></div>
      <button type="button" className="icon-button" aria-label="Close chat history" onClick={onClose}><X size={21} /></button>
    </header>
    <div className="chat-history-search">
      <label htmlFor="chat-history-search">Search chats</label>
      <div><Search size={17} /><input id="chat-history-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by title or model" /></div>
    </div>
    <div className="chat-history-count"><span>{shown.length} {shown.length === 1 ? 'conversation' : 'conversations'}</span>
      <button type="button" onClick={() => void onRefresh()} disabled={loading} aria-label="Refresh chat history"><RefreshCw size={16} /></button>
    </div>
    {error && <div className="chat-history-error" role="alert"><p>{error}</p><button className="secondary-button" disabled={loading} onClick={() => void onRefresh()}>Retry loading chats</button></div>}
    {disabled && <p className="chat-history-notice">Finish or stop the current reply before opening another conversation.</p>}
    <div className="chat-history-scroll">
      {loading && <p className="chat-history-empty" role="status"><LoaderCircle className="spin" size={18} /> Loading chats…</p>}
      {!loading && !error && shown.length === 0 && <p className="chat-history-empty">{query.trim() ? 'No chats match your search.' : 'Your conversations will appear here after you send a message.'}</p>}
      <ul>
        {shown.map((chat) => <li key={chat.id}>
          <button type="button" className={chat.id === selectedId ? 'selected' : ''} aria-label={chat.title}
            aria-current={chat.id === selectedId ? 'true' : undefined} disabled={loading || disabled}
            onClick={() => { void onSelect(chat.id).then((selected) => { if (selected) onClose(); }); }}>
            <MessageCircle size={19} />
            <span><strong>{chat.title}</strong><span className="chat-history-meta">
              <time dateTime={new Date(chat.updatedAt).toISOString()}>{new Date(chat.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
              <span>{chat.model.split('/').pop()}</span>
            </span></span>
            {chat.id === selectedId && <Check size={17} aria-label="Current conversation" />}
          </button>
        </li>)}
      </ul>
    </div>
  </dialog>;
}
