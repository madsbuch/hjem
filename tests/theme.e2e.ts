import { expect, test, type Page } from '@playwright/test';
import { nativeStorage } from './helpers/native-storage';

type Colours = { background: string; card: string; text: string };
type Capture = { before: Colours; frames: Colours[] };

async function openAppearance(page: Page) {
  await page.locator('nav:visible').first().waitFor();
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const navigation = (await mobile.isVisible())
    ? mobile
    : page.getByRole('navigation', { name: 'Main navigation' });
  await navigation
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: /^Appearance/ }).click();
  await expect(
    page.getByRole('group', { name: 'Appearance', exact: true }),
  ).toBeVisible();
}

function option(page: Page, name: 'Light' | 'Dark' | 'System') {
  return page
    .getByRole('group', { name: 'Appearance', exact: true })
    .getByRole('button', { name, exact: true });
}

/** Sample actual rendered colours from the mutation frame, avoiding driver timing. */
async function watchThemeChange(page: Page) {
  await page.evaluate(() => {
    const root = document.documentElement;
    const card = document.querySelector('.appearance-card')!;
    const read = () => ({
      background: getComputedStyle(root).backgroundColor,
      card: getComputedStyle(card).backgroundColor,
      text: getComputedStyle(card).color,
    });
    const before = read();
    (
      window as typeof window & { themeCapture: Promise<Capture> }
    ).themeCapture = new Promise((resolve, reject) => {
      let finished = false;
      const timeout = window.setTimeout(() => {
        finished = true;
        observer.disconnect();
        reject(new Error('No theme change was observed.'));
      }, 5000);
      const observer = new MutationObserver(() => {
        observer.disconnect();
        const frames: Colours[] = [];
        const started = performance.now();
        const sample = () => {
          if (finished) return;
          frames.push(read());
          const previous = frames.at(-2);
          const stable =
            previous &&
            Object.keys(previous).every(
              (key) =>
                previous[key as keyof Colours] ===
                frames.at(-1)![key as keyof Colours],
            );
          // Under CI load rapid clicks can be spaced farther apart than their
          // timers request. Wait for the latest fade and one settled paint.
          if (
            performance.now() - started < 450 ||
            root.classList.contains('theme-changing') ||
            !stable
          )
            requestAnimationFrame(sample);
          else {
            finished = true;
            window.clearTimeout(timeout);
            resolve({ before, frames });
          }
        };
        requestAnimationFrame(sample);
      });
      observer.observe(root, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
    });
  });
}

async function capturedTheme(page: Page): Promise<Capture> {
  return page.evaluate(
    () =>
      (window as typeof window & { themeCapture: Promise<Capture> })
        .themeCapture,
  );
}

function expectFade(capture: Capture) {
  const after = capture.frames.at(-1)!;
  for (const property of ['background', 'card', 'text'] as const) {
    expect(after[property]).not.toBe(capture.before[property]);
    expect(
      capture.frames.some(
        (frame) =>
          frame[property] !== capture.before[property] &&
          frame[property] !== after[property],
      ),
    ).toBe(true);
  }
}

test('saved appearance applies on initial load without a theme animation', async ({
  page,
}) => {
  await page.emulateMedia({
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  });
  await nativeStorage(page, { theme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const initial = await page.evaluate(() => ({
    background: getComputedStyle(document.documentElement).backgroundColor,
    transitions: document.documentElement
      .getAnimations()
      .filter((animation) => animation instanceof CSSTransition).length,
  }));
  expect(initial.background).toBe('rgb(20, 24, 29)');
  expect(initial.transitions).toBe(0);
  await expect(page.locator('html')).not.toHaveClass(/theme-changing/);
});

test('manual appearance changes fade surfaces and rapid choices settle on the latest theme', async ({
  page,
}) => {
  await page.emulateMedia({
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  });
  await page.goto('/');
  await openAppearance(page);
  await watchThemeChange(page);
  await option(page, 'Dark').click();
  expectFade(await capturedTheme(page));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).not.toHaveClass(/theme-changing/);

  await watchThemeChange(page);
  await page.evaluate(async () => {
    const choose = (name: string) => {
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>('.theme-option'),
      ].find((item) => item.textContent?.trim() === name)!;
      button.click();
    };
    choose('Light');
    await new Promise((resolve) => setTimeout(resolve, 45));
    choose('Dark');
    await new Promise((resolve) => setTimeout(resolve, 45));
    choose('Light');
  });
  const rapid = await capturedTheme(page);
  expect(rapid.frames.at(-1)?.background).toBe('rgb(245, 247, 249)');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(option(page, 'Light')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).not.toHaveClass(/theme-changing/);
});

test('System appearance fades when the device changes its colour scheme', async ({
  page,
}) => {
  await page.emulateMedia({
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  });
  await page.goto('/');
  await openAppearance(page);
  await expect(option(page, 'System')).toHaveAttribute('aria-pressed', 'true');
  await watchThemeChange(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  expectFade(await capturedTheme(page));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await watchThemeChange(page);
  await page.emulateMedia({ colorScheme: 'light' });
  expectFade(await capturedTheme(page));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('reduced motion applies manual and system themes immediately', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/');
  await openAppearance(page);
  await watchThemeChange(page);
  await option(page, 'Dark').click();
  const manual = await capturedTheme(page);
  expect(
    manual.frames.every(
      (frame) =>
        frame.background === 'rgb(20, 24, 29)' &&
        frame.card === 'rgb(32, 38, 44)',
    ),
  ).toBe(true);
  await expect(page.locator('html')).not.toHaveClass(/theme-changing/);
  await option(page, 'System').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await watchThemeChange(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  const system = await capturedTheme(page);
  expect(
    system.frames.every(
      (frame) =>
        frame.background === 'rgb(20, 24, 29)' &&
        frame.card === 'rgb(32, 38, 44)',
    ),
  ).toBe(true);
  await expect(page.locator('html')).not.toHaveClass(/theme-changing/);
});

test('System catches missed appearance notifications on the ten-minute poll and foreground check', async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    (window as any).silentSystemDark = false;
    window.matchMedia = (query: string) => {
      if (query !== '(prefers-color-scheme: dark)') return original(query);
      // Model a WebView that updates its preference but drops change events.
      return {
        media: query,
        get matches() {
          return (window as any).silentSystemDark;
        },
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return true;
        },
      } as MediaQueryList;
    };
  });
  await page.goto('/');
  await openAppearance(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.evaluate(() => {
    (window as any).silentSystemDark = true;
  });
  await page.clock.fastForward(9 * 60_000);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.clock.fastForward(60_000);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveClass(/theme-changing/);
  await page.clock.fastForward(1000);
  await expect(page.locator('html')).not.toHaveClass(/theme-changing/);
  await page.evaluate(() => {
    (window as any).silentSystemDark = false;
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveClass(/theme-changing/);
  await page.clock.fastForward(1000);
  await option(page, 'Dark').click();
  await page.clock.fastForward(10 * 60_000);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(option(page, 'Dark')).toHaveAttribute('aria-pressed', 'true');
});
