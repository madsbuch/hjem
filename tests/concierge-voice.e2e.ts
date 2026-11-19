import { expect, test, type Page } from '@playwright/test';
import { openSettings } from './helpers/settings';
import type { ChatRecord } from '../src/lib/concierge-history';

type VoiceRequest = {
  model: string;
  stream: boolean;
  modalities?: string[];
  audio?: { format: string };
  messages: { role: string; content: unknown; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
};

type VoiceHarness = {
  requests: VoiceRequest[];
  streams: (ReadableStreamDefaultController<Uint8Array> | undefined)[];
  microphoneRequests: number;
  tracks: MediaStreamTrack[];
  sourceClock: AudioContext | null;
  outputStarts: number;
  outputStops: number;
  aborts: number;
  ignoreAbort: boolean;
};

declare global {
  interface Window { __hjemVoice: VoiceHarness }
}

async function installVoiceHarness(page: Page, denied = false) {
  await page.addInitScript(({ denyMicrophone }) => {
    const fixture: VoiceHarness = {
      requests: [], streams: [], microphoneRequests: 0, tracks: [],
      sourceClock: null, outputStarts: 0, outputStops: 0, aborts: 0, ignoreAbort: false,
    };
    window.__hjemVoice = fixture;

    // Use real browser audio processing with a synthetic microphone. It is
    // connected only to a MediaStreamDestination, never to the speakers.
    const NativeAudioContext = window.AudioContext;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        fixture.microphoneRequests++;
        if (denyMicrophone) throw new DOMException('Permission denied', 'NotAllowedError');
        const context = new NativeAudioContext({ sampleRate: 24000 });
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const destination = context.createMediaStreamDestination();
        gain.gain.value = 0.05;
        oscillator.frequency.value = 220;
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        fixture.sourceClock = context;
        for (const track of destination.stream.getTracks()) {
          fixture.tracks.push(track);
          const stop = track.stop.bind(track);
          track.stop = () => {
            if (track.readyState === 'ended') return;
            stop();
            oscillator.stop();
            void context.close();
          };
        }
        await context.resume();
        return destination.stream;
      },
    });

    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration?: number) {
      fixture.outputStarts++;
      if (duration === undefined) start.call(this, when, offset);
      else start.call(this, when, offset, duration);
    };
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (when = 0) {
      fixture.outputStops++;
      stop.call(this, when);
    };

    // route.fulfill buffers its body. A controlled browser ReadableStream lets
    // these tests stop between SSE fragments while exercising the real parser.
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== 'https://openrouter.ai/api/v1/chat/completions') return originalFetch(input, init);
      const body = JSON.parse(String(init?.body)) as VoiceRequest;
      const index = fixture.requests.push(body) - 1;
      if (!body.stream) return new Response(JSON.stringify({ choices: [{
        message: { role: 'assistant', content: 'Text chat still works.' }, finish_reason: 'stop',
      }] }), { headers: { 'content-type': 'application/json' } });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          fixture.streams[index] = controller;
          init?.signal?.addEventListener('abort', () => {
            fixture.aborts++;
            if (!fixture.ignoreAbort) controller.error(new DOMException('Stopped.', 'AbortError'));
          }, { once: true });
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    };
  }, { denyMicrophone: denied });

  // Every other OpenRouter endpoint is intercepted; no test audio or key leaves
  // the browser, even if the application makes an unexpected request.
  await page.route('https://openrouter.ai/**', async (route) => {
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (new URL(route.request().url()).pathname === '/api/v1/models') {
      await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ data: [{
        id: 'fixture/text', name: 'Text fixture', supported_parameters: ['tools'],
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      }] }) });
    } else await route.abort('blockedbyclient');
  });
}

async function navigate(page: Page, name: string) {
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const navigation = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name, exact: true }).click();
}

async function startConcierge(page: Page, denied = false) {
  await installVoiceHarness(page, denied);
  await page.goto('/');
  await openSettings(page, 'Concierge');
  await page.getByLabel('OpenRouter API key', { exact: true }).fill('fixture-voice-key');
  await page.getByRole('radio', { name: 'Use another model', exact: true }).check();
  await page.getByLabel('Custom model ID', { exact: true }).fill('fixture/text');
  await page.getByRole('button', { name: 'Save concierge settings' }).click();
  await expect(page.getByText('Home Concierge settings saved.', { exact: true })).toBeVisible();
  await navigate(page, 'Concierge');
  expect(await page.evaluate(() => window.__hjemVoice.microphoneRequests)).toBe(0);
}

async function record(page: Page) {
  await page.getByRole('button', { name: 'Start voice message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send voice message', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__hjemVoice.sourceClock?.currentTime ?? 0))
    .toBeGreaterThan(0.3);
}

async function sendVoice(page: Page) {
  await record(page);
  await page.getByRole('button', { name: 'Send voice message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__hjemVoice.requests.length)).toBe(1);
  await expectMicrophoneReleased(page);
}

async function expectMicrophoneReleased(page: Page) {
  await expect.poll(() => page.evaluate(() => window.__hjemVoice.tracks
    .filter((track) => track.readyState === 'live').length)).toBe(0);
}

function delta(value: Record<string, unknown>) {
  return { choices: [{ index: 0, delta: value, finish_reason: null }] };
}

function finish(reason = 'stop') {
  return { choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

async function emit(page: Page, index: number, events: unknown[], end = false) {
  await page.evaluate(({ requestIndex, chunks, close }) => {
    const controller = window.__hjemVoice.streams[requestIndex];
    if (!controller) throw new Error(`Missing stream for request ${requestIndex}`);
    controller.enqueue(new TextEncoder().encode(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
      (close ? 'data: [DONE]\n\n' : '')));
    if (close) controller.close();
  }, { requestIndex: index, chunks: events, close: end });
}

async function readHome(page: Page, index: number) {
  await emit(page, index, [delta({ tool_calls: [{ index: 0, id: `home-${index}`, type: 'function',
    function: { name: 'get_home_state', arguments: '{}' } }] }), finish('tool_calls')], true);
  await expect.poll(() => page.evaluate(() => window.__hjemVoice.requests.length)).toBe(index + 2);
}

async function savedChats(page: Page): Promise<ChatRecord[]> {
  return page.evaluate(() => new Promise<ChatRecord[]>((resolve, reject) => {
    const request = indexedDB.open('hjem-concierge-history', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('chats', 'readonly');
      const records = transaction.objectStore('chats').getAll();
      transaction.oncomplete = () => { database.close(); resolve(records.result as ChatRecord[]); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }));
}

test('a voice message streams PCM audio and keeps a readable transcript without changing the saved text model', async ({ page }) => {
  await startConcierge(page);
  await sendVoice(page);
  const request = await page.evaluate(() => window.__hjemVoice.requests[0]);
  expect(request.model).toBe('openai/gpt-audio');
  expect(request.stream).toBe(true);
  expect(request.modalities).toEqual(expect.arrayContaining(['text', 'audio']));
  expect(request.audio?.format).toBe('pcm16');
  expect(request.tools?.map((tool) => tool.function.name)).toContain('get_home_state');
  expect(request.messages.at(-1)?.content).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'input_audio', input_audio: expect.objectContaining({ data: expect.any(String), format: 'wav' }) }),
  ]));
  const audioPart = (request.messages.at(-1)?.content as { type: string; input_audio?: { data: string } }[])
    .find((part) => part.type === 'input_audio');
  expect(Buffer.from(audioPart!.input_audio!.data, 'base64').subarray(0, 4).toString()).toBe('RIFF');

  const outputAudio = Buffer.alloc(4802).toString('base64');
  // Real provider variants include empty partial fields, omitted singleton
  // indexes, and base64 split inside quartets rather than at audio boundaries.
  await emit(page, 0, [
    delta({ role: 'assistant', content: null, audio: { id: 'reply-audio', transcript: '', data: '' } }),
    { choices: [{ delta: { audio: { transcript: 'The **bedroom** lights ' } } }] },
    ...[outputAudio.slice(0, 1), outputAudio.slice(1, 3), outputAudio.slice(3, 1001), outputAudio.slice(1001)]
      .map((data) => delta({ audio: { data } })),
  ]);
  await expect.poll(() => page.evaluate(() => window.__hjemVoice.outputStarts)).toBeGreaterThan(0);
  await emit(page, 0, [
    delta({ audio: { transcript: 'are on.' } }), finish(),
    delta({ audio: { id: 'reply-audio', expires_at: 1794770000, transcript: '', data: '' }, tool_calls: [] }),
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: null } },
  ], true);
  await expect(page.getByRole('article', { name: 'Home Concierge response' })).toContainText('The bedroom lights are on.');
  await expect(page.getByRole('button', { name: 'Start voice message', exact: true })).toBeEnabled();
  await expect.poll(async () => (await savedChats(page))[0]?.messages).toEqual([
    { id: expect.any(String), role: 'user', text: 'Voice message' },
    { id: expect.any(String), role: 'assistant', text: 'The **bedroom** lights are on.' },
  ]);
  const saved = await savedChats(page);
  expect(saved).toHaveLength(1);
  expect(saved[0].model).toBe('fixture/text');
  expect(JSON.stringify(saved)).not.toContain('input_audio');
  expect(JSON.stringify(saved)).not.toContain(audioPart!.input_audio!.data);
  expect(JSON.stringify(saved)).not.toContain(outputAudio);
  await openSettings(page, 'Concierge');
  await expect(page.getByLabel('Custom model ID', { exact: true })).toHaveValue('fixture/text');
  await page.reload();
  await navigate(page, 'Concierge');
  await expect(page.getByRole('article', { name: 'Your message' })).toContainText('Voice message');
  await expect(page.getByRole('article', { name: 'Home Concierge response' })).toContainText('The bedroom lights are on.');
  expect(await page.evaluate(() => ({ requests: window.__hjemVoice.requests.length,
    microphones: window.__hjemVoice.microphoneRequests, playback: window.__hjemVoice.outputStarts })))
    .toEqual({ requests: 0, microphones: 0, playback: 0 });
});

test('streamed tool arguments execute only after a complete response and affect the real demo state', async ({ page }) => {
  await startConcierge(page);
  await sendVoice(page);
  await readHome(page, 0);
  await emit(page, 1, [delta({ tool_calls: [{ index: 0, id: 'voice-off', type: 'function',
    function: { name: 'control_device', arguments: '{"entity_id":"light.living_' } }] }),
    delta({ audio: { data: Buffer.alloc(4800).toString('base64') } })]);
  // An audio event after each argument fragment proves the parser consumed that
  // fragment before checking that no device action has run.
  await expect.poll(() => page.evaluate(() => window.__hjemVoice.outputStarts)).toBe(1);
  await expect(page.getByRole('log').getByText('Adjusting a device · done', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__hjemVoice.requests.length)).toBe(2);
  await emit(page, 1, [delta({ tool_calls: [{ index: 0,
    function: { arguments: 'pendant","action":"turn_off"}' } }] }),
    delta({ audio: { data: Buffer.alloc(4800).toString('base64') } })]);
  await expect.poll(() => page.evaluate(() => window.__hjemVoice.outputStarts)).toBe(2);
  await expect(page.getByRole('log').getByText('Adjusting a device · done', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__hjemVoice.requests.length)).toBe(2);
  await emit(page, 1, [finish('tool_calls')], true);
  await expect.poll(() => page.evaluate(() => window.__hjemVoice.requests.length)).toBe(3);
  const result = await page.evaluate(() => window.__hjemVoice.requests[2].messages
    .find((message) => message.role === 'tool' && message.tool_call_id === 'voice-off')?.content);
  expect(JSON.parse(String(result))).toMatchObject({ accepted: true, demo: true, entity_id: 'light.living_pendant', service: 'turn_off' });
  await emit(page, 2, [delta({ audio: { transcript: 'The pendant lights are now off.' } }), finish()], true);
  await expect(page.getByRole('article', { name: 'Home Concierge response' })).toContainText('The pendant lights are now off.');
  await navigate(page, 'Controls');
  await expect(page.getByRole('switch', { name: 'Toggle Pendant lights', exact: true })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Toggle Reading lamp', exact: true })).toBeChecked();
});

test('the documented OpenRouter audio stream (no id, index or finish_reason) speaks, runs tools and answers', async ({ page }) => {
  await startConcierge(page);
  await sendVoice(page);
  // Exactly the shape in OpenRouter's audio guide: only choices[0].delta.audio
  // fragments, then [DONE]. No id, choice index or finish_reason is sent.
  const bare = (value: Record<string, unknown>) => ({ choices: [{ delta: value }] });
  await emit(page, 0, [bare({ tool_calls: [{ index: 0, id: 'look', type: 'function',
    function: { name: 'get_home_state', arguments: '{}' } }] })], true);
  await expect.poll(() => page.evaluate(() => window.__hjemVoice.requests.length)).toBe(2);
  const audio = Buffer.alloc(4800).toString('base64');
  await emit(page, 1, [
    bare({ audio: { transcript: 'Your living room ', data: audio.slice(0, 2001) } }),
    bare({ audio: { transcript: 'lights are on.', data: audio.slice(2001) } }),
  ], true);
  await expect(page.getByRole('article', { name: 'Home Concierge response' })).toContainText('Your living room lights are on.');
  await expect.poll(() => page.evaluate(() => window.__hjemVoice.outputStarts)).toBeGreaterThan(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start voice message', exact: true })).toBeEnabled();
});

test('denied microphone permission leaves text chat usable', async ({ page }) => {
  await startConcierge(page, true);
  await page.getByRole('button', { name: 'Start voice message', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Microphone access was denied.');
  await expect(page.getByRole('button', { name: 'Start voice message', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Message Home Concierge' });
  await expect(input).toBeEnabled();
  await input.fill('Can we keep chatting by text?');
  await input.press('Enter');
  await expect(page.getByRole('article', { name: 'Home Concierge response' })).toContainText('Text chat still works.');
  const requests = await page.evaluate(() => window.__hjemVoice.requests);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ stream: false, model: 'fixture/text' });
});

test('Stop cancels playback and ignores late audio and actions from the interrupted stream', async ({ page }) => {
  await startConcierge(page);
  await sendVoice(page);
  await readHome(page, 0);
  await emit(page, 1, [delta({ audio: { id: 'long-audio', transcript: 'I am checking your lights.',
    data: Buffer.alloc(240000).toString('base64') } })]);
  await expect.poll(() => page.evaluate(() => window.__hjemVoice.outputStarts)).toBeGreaterThan(0);
  await page.evaluate(() => { window.__hjemVoice.ignoreAbort = true; });
  await page.getByRole('button', { name: 'Stop concierge', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__hjemVoice.outputStops)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Start voice message', exact: true })).toBeEnabled();
  const played = await page.evaluate(() => window.__hjemVoice.outputStarts);
  await emit(page, 1, [
    delta({ audio: { transcript: 'Late audio must be ignored.', data: Buffer.alloc(4800).toString('base64') } }),
    delta({ tool_calls: [{ index: 0, id: 'late-action', type: 'function',
      function: { name: 'control_device', arguments: '{"entity_id":"light.living_pendant","action":"turn_off"}' } }] }),
    finish('tool_calls'),
  ], true);
  await navigate(page, 'Controls');
  await expect(page.getByRole('switch', { name: 'Toggle Pendant lights', exact: true })).toBeChecked();
  await navigate(page, 'Concierge');
  await expect(page.getByRole('log')).not.toContainText('Late audio must be ignored.');
  expect(await page.evaluate(() => window.__hjemVoice.requests.length)).toBe(2);
  expect(await page.evaluate(() => window.__hjemVoice.outputStarts)).toBe(played);
  await expectMicrophoneReleased(page);
});

test('Stop remains available while a completed reply is still speaking', async ({ page }) => {
  await startConcierge(page);
  await sendVoice(page);
  await emit(page, 0, [delta({ audio: { id: 'complete-audio', transcript: 'Your home is ready.',
    data: Buffer.alloc(240000).toString('base64') } }), finish()], true);
  await expect(page.getByRole('article', { name: 'Home Concierge response' })).toContainText('Your home is ready.');
  await expect.poll(() => page.evaluate(() => window.__hjemVoice.outputStarts)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Stop concierge', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__hjemVoice.outputStops)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Start voice message', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__hjemVoice.requests.length)).toBe(1);
  await expectMicrophoneReleased(page);
});

test('cancel, navigation, and backgrounding all release the microphone without uploading a recording', async ({ page }) => {
  await startConcierge(page);
  await record(page);
  await page.getByRole('button', { name: 'Cancel voice message', exact: true }).click();
  await expectMicrophoneReleased(page);
  await record(page);
  await navigate(page, 'Overview');
  await expectMicrophoneReleased(page);
  await navigate(page, 'Concierge');
  await record(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expectMicrophoneReleased(page);
  expect(await page.evaluate(() => window.__hjemVoice.microphoneRequests)).toBe(3);
  expect(await page.evaluate(() => window.__hjemVoice.requests.length)).toBe(0);
});
