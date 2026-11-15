import { expect, test, type Page } from '@playwright/test';
import QRCode from 'qrcode';

const part = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const token = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ iss: 'test-only-does-not-authenticate', iat: 1, exp: 9999999999 })}.test_signature`;

async function openConnection(page: Page) {
  await page.goto('/');
  await page.locator('nav:visible').first().waitFor();
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const nav = (await mobile.isVisible())
    ? mobile
    : page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .locator('main')
    .getByRole('button', { name: 'Connect your home', exact: true })
    .click();
}

async function fakeCamera(
  page: Page,
  contents: string,
  options: { denied?: boolean; deferred?: boolean; blank?: boolean } = {},
) {
  const png = await QRCode.toDataURL(contents, {
    width: 512,
    margin: 4,
    errorCorrectionLevel: 'Q',
  });
  await page.addInitScript(
    ({ png, options }) => {
      const fixture = {
        streams: [] as MediaStream[],
        calls: [] as MediaStreamConstraints[],
        release: () => {},
        denied: !!options.denied,
      };
      Object.assign(window, { cameraFixture: fixture });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: async (constraints: MediaStreamConstraints) => {
          fixture.calls.push(constraints);
          if (fixture.denied)
            throw new DOMException('Permission denied', 'NotAllowedError');
          if (options.deferred)
            await new Promise<void>((resolve) => {
              fixture.release = resolve;
            });
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 720;
          const context = canvas.getContext('2d')!;
          context.fillStyle = 'white';
          context.fillRect(0, 0, 720, 720);
          if (!options.blank) {
            const image = new Image();
            image.src = png;
            await image.decode();
            context.drawImage(image, 104, 104, 512, 512);
          }
          const stream = canvas.captureStream(10);
          fixture.streams.push(stream);
          return stream;
        },
      });
    },
    { png, options },
  );
}

test('camera decodes a real QR frame into the masked token field without connecting or saving it', async ({
  page,
}) => {
  await fakeCamera(page, token);
  await openConnection(page);
  await page
    .getByLabel('Home Assistant address', { exact: true })
    .fill('https://ha.example');
  await page.getByRole('button', { name: 'Scan QR code' }).click();
  const input = page.getByLabel('Long-lived access token', { exact: true });
  await expect(input).toHaveValue(token);
  await expect(input).toHaveAttribute('type', 'password');
  await expect(
    page.getByRole('dialog', { name: 'Scan access token' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Connect Home Assistant', exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => Object.values(localStorage).join('')),
  ).not.toContain(token);
  expect(
    await page.evaluate(() =>
      (window as any).cameraFixture.streams.every((stream: MediaStream) =>
        stream.getTracks().every((track) => track.readyState === 'ended'),
      ),
    ),
  ).toBe(true);
  await expect(page.locator('body')).not.toContainText(token);
});

test('unrelated QR code preserves the existing token and closes the camera', async ({
  page,
}) => {
  await fakeCamera(page, 'https://example.invalid/unrelated');
  await openConnection(page);
  await page
    .getByLabel('Long-lived access token', { exact: true })
    .fill('keep-this-value');
  await page.getByRole('button', { name: 'Scan QR code' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Scan a Home Assistant access-token QR code.',
  );
  await expect(
    page.getByLabel('Long-lived access token', { exact: true }),
  ).toHaveValue('keep-this-value');
  expect(
    await page.evaluate(
      () => (window as any).cameraFixture.streams[0].getTracks()[0].readyState,
    ),
  ).toBe('ended');
  await page
    .getByRole('button', { name: 'Cancel scanning', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Scan QR code' }),
  ).toBeVisible();
});

test('denied camera permission keeps manual entry usable', async ({ page }) => {
  await fakeCamera(page, token, { denied: true });
  await openConnection(page);
  await page.getByRole('button', { name: 'Scan QR code' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Camera access is denied',
  );
  await page
    .getByRole('button', { name: 'Cancel scanning', exact: true })
    .click();
  await page
    .getByLabel('Long-lived access token', { exact: true })
    .fill('manually-entered');
  await expect(
    page.getByLabel('Long-lived access token', { exact: true }),
  ).toHaveValue('manually-entered');
});

test('cancelling while permission is pending stops a late camera stream', async ({
  page,
}) => {
  await fakeCamera(page, token, { deferred: true });
  await openConnection(page);
  await page.getByRole('button', { name: 'Scan QR code' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).cameraFixture.calls.length))
    .toBe(1);
  await page
    .getByRole('button', { name: 'Cancel scanning', exact: true })
    .click();
  await page.evaluate(() => (window as any).cameraFixture.release());
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).cameraFixture.streams[0]?.getTracks()[0].readyState,
      ),
    )
    .toBe('ended');
  await expect(
    page.getByLabel('Long-lived access token', { exact: true }),
  ).toHaveValue('');
});

test('switching cameras and cancelling release every stream', async ({
  page,
}) => {
  await fakeCamera(page, token, { blank: true });
  await openConnection(page);
  await page.getByRole('button', { name: 'Scan QR code' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).cameraFixture.streams.length),
    )
    .toBe(1);
  await page
    .getByRole('button', { name: 'Switch camera', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).cameraFixture.streams.length),
    )
    .toBe(2);
  expect(
    await page.evaluate(() =>
      (window as any).cameraFixture.calls.map(
        (call: any) => call.video.facingMode.ideal,
      ),
    ),
  ).toEqual(['environment', 'user']);
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Scan QR code' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).cameraFixture.streams.every((stream: MediaStream) =>
        stream.getTracks().every((track) => track.readyState === 'ended'),
      ),
    ),
  ).toBe(true);
});

async function nativeCamera(page: Page, denied = false) {
  await page.addInitScript(
    ({ denied }) => {
      const fixture = {
        commands: [] as { command: string; args: any }[],
        scans: [] as ((value: unknown) => void)[],
        cancels: 0,
      };
      Object.assign(window, {
        isTauri: true,
        nativeCameraFixture: fixture,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: any) => {
            fixture.commands.push({ command, args });
            if (command === 'storage_load') return {
              serverUrl: '', connection: null, theme: 'system', pinnedApps: [],
              favourites: [], selectedSpeakers: [], legacyImportComplete: true, calendarFeeds: [], hiddenApps: [],
            };
            if (command === 'plugin:launcher|get_status')
              return { supported: false, isDefaultHome: false };
            if (command === 'concierge_get_settings')
              return { hasApiKey: false, model: '' };
            if (command === 'concierge_list_models') return [];
            if (command === 'qr_scanner_native') return true;
            if (command === 'plugin:barcode-scanner|check_permissions')
              return { camera: 'prompt' };
            if (command === 'plugin:barcode-scanner|request_permissions')
              return { camera: denied ? 'denied' : 'granted' };
            if (command === 'plugin:barcode-scanner|scan')
              return new Promise((resolve) => fixture.scans.push(resolve));
            if (command === 'plugin:barcode-scanner|cancel') {
              fixture.cancels++;
              return;
            }
            throw new Error('Unexpected native command');
          },
        },
      });
    },
    { denied },
  );
}

test('native scanning requests permission, limits formats, ignores cancelled results, and restores the page', async ({
  page,
}) => {
  await nativeCamera(page);
  await openConnection(page);
  await page.getByRole('button', { name: 'Scan QR code' }).click();
  await expect(page.locator('html')).toHaveAttribute(
    'data-qr-scanner',
    'native',
  );
  await expect(
    page.getByRole('button', { name: 'Cancel scanning', exact: true }),
  ).toBeVisible();
  // A modal lives in the browser's top layer, so hiding #root alone does not
  // hide the connection form behind the transparent native camera viewfinder.
  await expect(page.locator('.connection-dialog')).toBeHidden();
  expect(
    await page.locator('.connection-dialog').evaluate(
      (dialog) => getComputedStyle(dialog, '::backdrop').visibility,
    ),
  ).toBe('hidden');
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).nativeCameraFixture.scans.length),
    )
    .toBe(1);
  await page
    .getByRole('button', { name: 'Switch camera', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).nativeCameraFixture.scans.length),
    )
    .toBe(2);
  await page.evaluate(
    (token) => (window as any).nativeCameraFixture.scans[0]({ content: token }),
    token,
  );
  await expect(
    page.getByRole('dialog', { name: 'Scan access token' }),
  ).toBeVisible();
  const scans = await page.evaluate(() =>
    (window as any).nativeCameraFixture.commands
      .filter((item: any) => item.command.endsWith('|scan'))
      .map((item: any) => item.args),
  );
  expect(scans).toEqual([
    { windowed: true, formats: ['QR_CODE'], cameraDirection: 'back' },
    { windowed: true, formats: ['QR_CODE'], cameraDirection: 'front' },
  ]);
  await page.evaluate(
    (token) => (window as any).nativeCameraFixture.scans[1]({ content: token }),
    token,
  );
  await expect(
    page.getByLabel('Long-lived access token', { exact: true }),
  ).toHaveValue(token);
  await expect(page.locator('html')).not.toHaveAttribute('data-qr-scanner');
  await expect(page.locator('.connection-dialog')).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).nativeCameraFixture.cancels),
  ).toBe(2);
});

test('native denial never starts a scan or hides the app', async ({ page }) => {
  await nativeCamera(page, true);
  await openConnection(page);
  await page.getByRole('button', { name: 'Scan QR code' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Camera access is denied',
  );
  expect(
    await page.evaluate(() => (window as any).nativeCameraFixture.scans.length),
  ).toBe(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-qr-scanner');
  await page
    .getByRole('button', { name: 'Cancel scanning', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Scan QR code' }),
  ).toBeVisible();
});
