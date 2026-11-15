import { useEffect, useState, type FormEvent } from 'react';
import { Check, KeyRound, LoaderCircle, Sparkles, Trash2 } from 'lucide-react';
import {
  clearConciergeKey,
  listConciergeModels,
  nativeConcierge,
  saveConciergeSettings,
  testConciergeKey,
  type ConciergeSettings as SettingsValue,
} from '../lib/concierge-api';

// Tool-capable models verified against OpenRouter's public catalogue, 2026-11-15.
const recommendedModels = [
  {
    id: 'anthropic/claude-haiku-5.5',
    name: 'Claude Haiku 5.5',
    badge: 'Recommended',
    description: 'Quick, low-cost help with everyday home controls.',
  },
  {
    id: 'openai/gpt-6.1-terra',
    name: 'GPT-6.1 Terra',
    badge: 'Balanced',
    description: 'For requests that need a few steps and more planning.',
  },
  {
    id: 'anthropic/claude-sonnet-5.5',
    name: 'Claude Sonnet 5.5',
    badge: 'More capable',
    description: 'For more involved requests. Higher cost per message.',
  },
];
const isRecommended = (id: string) =>
  recommendedModels.some((item) => item.id === id);

export function ConciergeSettings({
  settings,
  onChange,
  disabled,
  initialError,
}: {
  settings: SettingsValue;
  onChange: (settings: SettingsValue) => void;
  disabled: boolean;
  initialError: string;
}) {
  const [key, setKey] = useState('');
  const [model, setModel] = useState(settings.model || recommendedModels[0].id);
  const [custom, setCustom] = useState(
    !!settings.model && !isRecommended(settings.model),
  );
  const [customModel, setCustomModel] = useState(
    isRecommended(settings.model) ? '' : settings.model,
  );
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState(initialError);
  useEffect(() => {
    setModel(settings.model || recommendedModels[0].id);
    setCustom(!!settings.model && !isRecommended(settings.model));
    if (settings.model && !isRecommended(settings.model))
      setCustomModel(settings.model);
  }, [settings.model]);
  const locked = disabled || !!busy;
  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError('');
    setFeedback('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void run('save', async () => {
      const value = await saveConciergeSettings(
        key.trim() ? key : undefined,
        model,
      );
      onChange(value);
      setKey('');
      setFeedback('Home Concierge settings saved.');
    });
  }
  return (
    <section
      className="settings-card concierge-settings"
      id="concierge-settings"
    >
      <span className="settings-icon">
        <Sparkles size={25} />
      </span>
      <h2>Home Concierge</h2>
      <p>
        A little help with your home, Sonos, and tablet apps. Bring your own
        OpenRouter key and choose a model that supports tools.
      </p>
      <div className="setting-row">
        <span>OpenRouter key</span>
        <strong>
          {settings.hasApiKey
            ? nativeConcierge()
              ? 'Saved on this device'
              : 'Set for this session'
            : 'Not added yet'}
        </strong>
      </div>
      <form onSubmit={save} className="concierge-settings-form">
        <label className="field-label" htmlFor="openrouter-key">
          OpenRouter API key
        </label>
        <input
          id="openrouter-key"
          className="text-input"
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder={
            settings.hasApiKey
              ? 'Enter a key to replace the saved key'
              : 'Paste your OpenRouter API key'
          }
          disabled={locked}
        />
        <p className="field-help">
          {nativeConcierge()
            ? 'Stored in Hjem’s private app data on this device. Saved keys are used by the native app and are never sent back to the web interface.'
            : 'In this browser preview, your key stays in memory until you reload. The Android app saves it in private app data.'}
        </p>
        <fieldset className="concierge-model-picker" disabled={locked}>
          <legend className="field-label">Concierge model</legend>
          <div className="recommended-models">
            {recommendedModels.map((item) => (
              <label
                className={`model-choice ${!custom && model === item.id ? 'selected' : ''}`}
                key={item.id}
              >
                <input
                  type="radio"
                  name="concierge-model-choice"
                  aria-label={item.name}
                  checked={!custom && model === item.id}
                  onChange={() => {
                    setCustom(false);
                    setModel(item.id);
                  }}
                />
                <span className="model-choice-top">
                  <span className="model-badge">{item.badge}</span>
                  <span className="model-choice-check" aria-hidden="true">
                    <Check size={14} />
                  </span>
                </span>
                <strong>{item.name}</strong>
                <span className="model-description">{item.description}</span>
              </label>
            ))}
          </div>
          <label className="custom-model-choice">
            <input
              type="radio"
              name="concierge-model-choice"
              checked={custom}
              onChange={() => {
                setCustom(true);
                setModel(customModel);
              }}
            />
            Use another model
          </label>
          {custom && (
            <div className="custom-model-fields">
              <label className="field-label" htmlFor="concierge-model">
                Custom model ID
              </label>
              <div className="concierge-model-row">
                <input
                  id="concierge-model"
                  className="text-input"
                  value={customModel}
                  onChange={(event) => {
                    setCustomModel(event.target.value);
                    setModel(event.target.value);
                  }}
                  placeholder="provider/model-name"
                  autoCapitalize="none"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="secondary-button"
                  disabled={locked || !customModel.trim()}
                  onClick={() =>
                    void run('models', async () => {
                      const catalogue = await listConciergeModels();
                      const match = catalogue.find(
                        (item) => item.id === customModel.trim(),
                      );
                      if (!match)
                        throw new Error(
                          'This model was not found among OpenRouter’s tool-capable text models. Check the model ID.',
                        );
                      setFeedback(
                        `${match.name} is available and supports tools.`,
                      );
                    })
                  }
                >
                  {busy === 'models' ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    'Check model'
                  )}
                </button>
              </div>
            </div>
          )}
        </fieldset>
        <p className="field-help">
          Models use your OpenRouter credits. Haiku is a good starting point for
          home controls; actual cost depends on the model and the length of your
          conversation.
        </p>
        <div className="concierge-key-actions">
          <button
            className="primary-button"
            type="submit"
            disabled={
              locked || !model.trim() || (!key.trim() && !settings.hasApiKey)
            }
          >
            {busy === 'save' ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <KeyRound size={16} />
            )}
            Save concierge settings
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={locked || !settings.hasApiKey}
            onClick={() =>
              void run('test', async () => {
                await testConciergeKey();
                setFeedback('OpenRouter accepted your key.');
              })
            }
          >
            {busy === 'test' ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Check size={16} />
            )}
            Test key
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={locked || !settings.hasApiKey}
            onClick={() =>
              void run('remove', async () => {
                onChange(await clearConciergeKey());
                setKey('');
                setFeedback('API key removed.');
              })
            }
          >
            <Trash2 size={16} />
            Remove key
          </button>
        </div>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {feedback && (
        <p className="concierge-feedback" role="status">
          {feedback}
        </p>
      )}
      <p className="concierge-privacy">
        When you send a message, your chat and the device or app information
        needed to help are sent to OpenRouter and your selected model provider.
        Home Assistant access tokens are never included.
      </p>
    </section>
  );
}
