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
import { ModelBrowser, isRecommended, recommendedModels, supportsConcierge } from './ModelBrowser';

export function ConciergeSettings({
  settings,
  onChange,
  onBusyChange,
  disabled,
  initialError,
}: {
  settings: SettingsValue;
  onChange: (settings: SettingsValue) => void;
  onBusyChange: (pending: boolean) => void;
  disabled: boolean;
  initialError: string;
}) {
  const [key, setKey] = useState('');
  const [model, setModel] = useState(settings.model || recommendedModels[0].id);
  const [custom, setCustom] = useState(
    settings.model.length > 0 && !isRecommended(settings.model),
  );
  const [customModel, setCustomModel] = useState(
    isRecommended(settings.model) ? '' : settings.model,
  );
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState(initialError);
  useEffect(() => {
    setModel(settings.model || recommendedModels[0].id);
    setCustom(settings.model.length > 0 && !isRecommended(settings.model));
    if (settings.model && !isRecommended(settings.model))
      setCustomModel(settings.model);
  }, [settings.model]);
  const locked = disabled || busy.length > 0;
  async function run(label: string, action: () => Promise<void>) {
    onBusyChange(true);
    setBusy(label);
    setError('');
    setFeedback('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update concierge settings.');
    } finally {
      setBusy('');
      onBusyChange(false);
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
          <ModelBrowser value={model} active={!custom} disabled={locked} onSelect={(id) => {
            setCustom(false);
            setModel(id);
          }} />
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
                          'This model was not found in OpenRouter’s catalogue. Check the model ID.',
                        );
                      if (!supportsConcierge(match))
                        throw new Error('This model does not support the text and tool calls required by Home Concierge.');
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
          Models use your OpenRouter credits. Browsing the catalogue is free;
          sending a message uses the selected model’s rates.
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
            disabled={locked || !settings.hasApiKey || key.trim().length > 0}
            title={
              key.trim() ? 'Save the new key before testing it' : undefined
            }
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
