import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, Search, Sparkles } from 'lucide-react';
import { listConciergeModels, type ConciergeModel } from '../lib/concierge-api';
import '../model-browser.css';

// These are suggestions, not a catalogue. Availability and prices come from OpenRouter.
export const recommendedModels = [
  { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5', badge: 'Everyday choice', description: 'A low-cost starting point for everyday home controls.' },
  { id: 'openai/gpt-6.1-terra', name: 'GPT-6.1 Terra', badge: 'More planning', description: 'A step up for requests involving several devices or actions.' },
  { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', badge: 'Complex requests', description: 'For more involved home setup and conversations. Higher cost.' },
];
export const isRecommended = (id: string) => recommendedModels.some((item) => item.id === id);
export const supportsConcierge = (model: ConciergeModel) => model.supportsTools &&
  model.inputModalities.includes('text') && model.outputModalities.includes('text');

const PAGE_SIZE = 20;
const providerOf = (model: ConciergeModel) => model.id.split('/')[0];
const tokens = (value: number | null) => value === null ? 'Not listed' : new Intl.NumberFormat('en', {
  notation: 'compact', maximumFractionDigits: 1,
}).format(value);
const price = (value: number | null, scale = 1_000_000) => {
  if (value === null) return 'Not listed';
  if (value > 0 && value * scale < 0.0001) return '<$0.0001';
  return `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value * scale)}`;
};
const numberOrder = (a: number | null, b: number | null, descending = false) => {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
};

function ModelRates({ model }: { model: ConciergeModel }) {
  return <dl className="model-rates">
    <div><dt>Input / 1M tokens</dt><dd>{price(model.inputPrice)}</dd></div>
    <div><dt>Output / 1M tokens</dt><dd>{price(model.outputPrice)}</dd></div>
    <div><dt>Context</dt><dd>{tokens(model.contextLength)}{model.contextLength !== null && ' tokens'}</dd></div>
  </dl>;
}

export function ModelBrowser({ value, active, onSelect, disabled }: {
  value: string;
  active: boolean;
  onSelect: (id: string) => void;
  disabled: boolean;
}) {
  const [models, setModels] = useState<ConciergeModel[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('all');
  const [capability, setCapability] = useState('all');
  const [pricing, setPricing] = useState('all');
  const [sort, setSort] = useState('name');
  const [page, setPage] = useState(0);
  const generation = useRef(0);
  const results = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const next = await listConciergeModels();
      if (current === generation.current) setModels(next);
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : 'Could not load OpenRouter models.');
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => { generation.current++; };
  }, [load]);
  const providers = useMemo(() => [...new Set((models ?? []).map(providerOf))].sort(), [models]);
  const filtered = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return (models ?? []).filter((model) => {
      const text = `${model.name} ${model.id} ${model.description}`.toLocaleLowerCase();
      return terms.every((term) => text.includes(term)) &&
        (provider === 'all' || providerOf(model) === provider) &&
        (capability === 'all' || (capability === 'tools' ? model.supportsTools : model.outputModalities.includes(capability))) &&
        (pricing === 'all' || model.isFree);
    }).sort((a, b) => {
      const difference = sort === 'price' ? numberOrder(a.inputPrice, b.inputPrice)
        : sort === 'context' ? numberOrder(a.contextLength, b.contextLength, true)
          : sort === 'newest' ? numberOrder(a.created, b.created, true) : 0;
      return difference || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });
  }, [models, query, provider, capability, pricing, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const shown = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selected = models?.find((model) => model.id === value);
  const changeFilter = (change: () => void) => {
    change();
    setPage(0);
    results.current?.scrollTo({ top: 0 });
  };
  const changePage = (next: number) => {
    setPage(next);
    results.current?.scrollTo({ top: 0 });
  };
  return <div className="model-browser">
    <section aria-labelledby="recommended-models-title" className="model-recommendations">
      <div className="model-section-heading">
        <h3 id="recommended-models-title"><Sparkles size={17} /> Recommended models</h3>
        <span>Good starting points for your home</span>
      </div>
      <div className="recommended-models">
        {recommendedModels.map((item) => {
          const live = models?.find((model) => model.id === item.id);
          const available = live !== undefined && supportsConcierge(live);
          return <label className={`model-choice ${active && value === item.id ? 'selected' : ''} ${!available ? 'model-unavailable' : ''}`} key={item.id}>
            <input type="radio" name="concierge-model-choice" aria-label={item.name}
              checked={active && value === item.id} disabled={disabled || !available}
              onChange={() => onSelect(item.id)} />
            <span className="model-choice-top"><span className="model-badge">{item.badge}</span>
              <span className="model-choice-check" aria-hidden="true"><Check size={14} /></span></span>
            <strong>{item.name}</strong>
            <span className="model-description">{item.description}</span>
            {live && available ? <span className="model-recommendation-price">From {price(live.inputPrice)} input · {price(live.outputPrice)} output / 1M tokens</span>
              : <span className="model-description">{loading ? 'Checking availability…' : models ? 'Currently unavailable' : 'Catalogue unavailable'}</span>}
          </label>;
        })}
      </div>
    </section>

    <section className="model-catalogue" aria-labelledby="model-catalogue-title">
      <div className="model-section-heading">
        <div><h3 id="model-catalogue-title">All OpenRouter models</h3>
          <p>Browse the full catalogue. Select a model with text and tool support for Concierge.</p></div>
        <button type="button" className="model-refresh" onClick={() => void load()} disabled={disabled || loading}>
          <RefreshCw size={15} className={loading ? 'spin' : undefined} /> Refresh models
        </button>
      </div>
      <label className="model-search"><Search size={18} aria-hidden="true" /><span className="sr-only">Search models</span>
        <input type="search" value={query} placeholder="Search name, provider, or model ID" disabled={disabled} spellCheck={false}
          onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
          onChange={(event) => changeFilter(() => setQuery(event.target.value))} /></label>
      <div className="model-filters">
        <label>Provider<select value={provider} disabled={disabled} onChange={(event) => changeFilter(() => setProvider(event.target.value))}>
          <option value="all">All providers</option>{providers.map((item) => <option value={item} key={item}>{item}</option>)}
        </select></label>
        <label>Capability<select value={capability} disabled={disabled} onChange={(event) => changeFilter(() => setCapability(event.target.value))}>
          <option value="all">All models</option><option value="tools">Supports tools</option>
          <option value="text">Text output</option><option value="image">Image output</option><option value="audio">Audio output</option><option value="video">Video output</option>
        </select></label>
        <label>Pricing<select value={pricing} disabled={disabled} onChange={(event) => changeFilter(() => setPricing(event.target.value))}>
          <option value="all">All prices</option><option value="free">Free models</option>
        </select></label>
        <label>Sort models<select value={sort} disabled={disabled} onChange={(event) => changeFilter(() => setSort(event.target.value))}>
          <option value="name">Name</option><option value="price">Input price</option><option value="context">Context length</option><option value="newest">Newest</option>
        </select></label>
      </div>
      {error && <div className="model-catalogue-error" role="alert"><p>{error}{models && ' Showing the last loaded catalogue.'}</p>
        <button type="button" className="secondary-button" onClick={() => void load()} disabled={disabled || loading}>Retry loading models</button></div>}
      {loading && models === null && <p className="model-load-state" role="status"><LoaderCircle size={18} className="spin" /> Loading OpenRouter models…</p>}
      {models !== null && <>
        <div className="model-result-count" role="status" aria-live="polite">
          {filtered.length ? `Showing ${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of ${filtered.length} models` : 'No models match your filters.'}
          <span>{models.length} models in the catalogue</span>
        </div>
        <div className="model-results" ref={results}>
          <ul className="model-list" aria-label="OpenRouter models">
            {shown.map((model) => {
              const compatible = supportsConcierge(model);
              return <li key={model.id} className={`catalogue-model ${value === model.id ? 'selected' : ''}`}>
                <label className="catalogue-model-heading">
                  <input type="radio" name="catalogue-model" aria-label={`${model.name} from catalogue`}
                    disabled={disabled || !compatible} checked={value === model.id} onChange={() => onSelect(model.id)} />
                  <span><strong>{model.name}</strong><code>{model.id}</code></span>
                  <span className="model-capability">{model.isFree ? 'Free' : compatible ? 'Tools' : model.outputModalities.join(' · ') || 'Other'}</span>
                </label>
                {model.description && <details className="model-details"><summary>About this model</summary><p>{model.description}</p></details>}
                <ModelRates model={model} />
                {model.requestPrice !== null && model.requestPrice > 0 && <p className="model-compatibility">Plus {price(model.requestPrice, 1)} per request</p>}
                {!compatible && <p className="model-compatibility">Not compatible with Concierge · Requires text input/output and tool calls.</p>}
              </li>;
            })}
          </ul>
          {filtered.length === 0 && <p className="model-empty">Try another search or clear your filters.</p>}
        </div>
        <div className="model-pagination">
          <button type="button" aria-label="Previous page" onClick={() => changePage(currentPage - 1)} disabled={disabled || currentPage === 0}><ChevronLeft size={17} /> Previous</button>
          <span>Page {currentPage + 1} of {pages}</span>
          <button type="button" aria-label="Next page" onClick={() => changePage(currentPage + 1)} disabled={disabled || currentPage + 1 >= pages}>Next <ChevronRight size={17} /></button>
        </div>
      </>}
      <p className="model-price-note">Prices in USD, from OpenRouter’s published rates. Context tiers, providers, caching, and image/audio charges can change the final cost. “Not listed” means unknown, not free.</p>
    </section>
    {value && <div className="model-selection"><Check size={16} /><span>Selected model <strong>{selected?.name ?? value}</strong><code>{value}</code></span><span>Save below to apply</span></div>}
  </div>;
}
