import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { nativeStorage } from './helpers/native-storage';

const pages = ['Controls', 'Planner', 'Overview', 'Apps', 'Concierge', 'Settings'] as const;
const longRoom = 'Family room and kitchen overlooking the garden';
const unbrokenRoom = 'UpstairsBedroomAndHomeOfficeWithReadingCorner';

async function navigate(page: Page, name: string) {
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const navigation = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name: name === 'Planner' ? 'Settings' : name, exact: true }).click();
  if (name === 'Planner') await page.getByRole('button', { name: 'Open home planner' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function connectedHome(page: Page) {
  const calendarUrl = 'https://calendar.example.test/family-and-household-appointments/calendar.ics';
  const storage = await nativeStorage(page, {
    serverUrl: 'http://style-audit.test',
    connection: { serverUrl: 'http://style-audit.test', token: 'fixture-only-token' },
    calendarFeeds: [{ id: 1, name: 'FamilyCalendarAndHouseholdAppointmentsForEveryone', url: calendarUrl }],
  });
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const date = (value: Date) => value.toISOString().slice(0, 10).replaceAll('-', '');
  storage.setFeedResponse(calendarUrl, [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hjem//Style audit//EN',
    'BEGIN:VEVENT', 'UID:style-audit', 'DTSTAMP:20261101T090000Z',
    `DTSTART;VALUE=DATE:${date(today)}`, `DTEND;VALUE=DATE:${date(tomorrow)}`,
    'SUMMARY:FamilyGatheringWithAnExceptionallyLongUnbrokenEventTitle',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n'));
  storage.setAndroidApps([
    { packageName: 'com.example.home', name: 'Home Assistant and connected device dashboard' },
    { packageName: 'com.example.calendar', name: 'FamilyCalendarAndAppointmentsForEveryone' },
    { packageName: 'com.example.music', name: 'Music and radio for the whole house' },
  ]);
  const states = [
    { entity_id: 'light.long', state: 'on', attributes: { friendly_name: 'Kitchen shelf reading lamp beside the dining table', brightness: 180, supported_color_modes: ['brightness'] } },
    { entity_id: 'light.unbroken', state: 'on', attributes: { friendly_name: 'BedroomReadingLampWithVeryLongUnbrokenDeviceName', brightness: 128, supported_color_modes: ['brightness'] } },
    { entity_id: 'climate.long', state: 'heat', attributes: { friendly_name: 'Upstairs family room underfloor heating thermostat', current_temperature: 21.4, temperature: 23, min_temp: 7, max_temp: 35, hvac_modes: ['off', 'heat'], hvac_action: 'heating' } },
    { entity_id: 'cover.long', state: 'open', attributes: { friendly_name: 'FloorToCeilingTerraceWindowPrivacyBlinds', current_position: 65, supported_features: 15 } },
    { entity_id: 'switch.long', state: 'on', attributes: { friendly_name: 'Garden irrigation and outdoor lighting power supply' } },
    { entity_id: 'media_player.long', state: 'playing', attributes: { friendly_name: 'Family room Sonos stereo pair and television', media_title: 'An exceptionally long song title to test readable music controls', media_artist: 'A band with a long name and several featured artists', volume_level: 0.32, is_volume_muted: false, supported_features: 1 | 4 | 8 | 16 | 32 | 16384 } },
    { entity_id: 'scene.long', state: 'unknown', attributes: { friendly_name: 'A cosy evening with friends in the living room' } },
    { entity_id: 'scene.unbroken', state: 'unknown', attributes: { friendly_name: 'EverythingOffBeforeLeavingHomeForTheWeekend' } },
  ];
  await page.routeWebSocket('ws://style-audit.test/api/websocket', (socket) => {
    const send = (value: unknown) => socket.send(JSON.stringify(value));
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      if (command.type === 'auth') { send({ type: 'auth_ok' }); return; }
      if (command.type === 'ping') { send({ id: command.id, type: 'pong' }); return; }
      let result: unknown = null;
      if (command.type === 'get_states') result = states;
      else if (command.type === 'get_config') result = { location_name: 'Style audit family home', unit_system: { temperature: '°C' } };
      else if (command.type === 'config/area_registry/list') result = [{ area_id: 'family', name: longRoom }, { area_id: 'upstairs', name: unbrokenRoom }];
      else if (command.type === 'config/device_registry/list') result = [];
      else if (command.type === 'config/entity_registry/list') result = states.map((entity, index) => ({ entity_id: entity.entity_id, area_id: index % 2 ? 'upstairs' : 'family', device_id: null }));
      send({ id: command.id, type: 'result', success: true, result });
    });
    send({ type: 'auth_required' });
  });
}

async function measure(page: Page, width: number) {
  return page.evaluate((expectedWidth) => {
    const identify = (element: Element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${typeof element.className === 'string' && element.className ? `.${element.className.trim().replace(/\s+/g, '.')}` : ''}`;
    const offenders = [...document.querySelectorAll('main *, .main-shell')].flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!rect.width || !rect.height || style.visibility === 'hidden' || (rect.right <= expectedWidth + 1 && rect.left >= -1)) return [];
      let clip: Element | null = element.parentElement;
      while (clip && clip !== document.body) {
        if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(clip).overflowX)) break;
        clip = clip.parentElement;
      }
      return [{ node: identify(element), text: element.textContent?.trim().slice(0, 90), left: rect.left, right: rect.right,
        width: rect.width, minWidth: style.minWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        clippedBy: clip && clip !== document.body ? identify(clip) : null }];
    });
    const main = document.querySelector('main')!;
    const cards = [...document.querySelectorAll('.device-card, .room-card, .scene-button, .concierge-input-wrap, .settings-card')]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => ({ node: identify(element), text: element.textContent?.trim().slice(0, 90), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
    return {
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      layoutWidth: window.innerWidth,
      scale: window.visualViewport?.scale ?? 1,
      mainWidth: main.scrollWidth,
      mainClientWidth: main.clientWidth,
      mainRight: main.getBoundingClientRect().right,
      cards, offenders,
    };
  }, width);
}

async function auditPages(page: Page, testInfo: TestInfo) {
  const sizes = testInfo.project.name === 'phone'
    ? [{ width: 320, height: 740 }, { width: 360, height: 800 }, { width: 390, height: 844 }, { width: 700, height: 900 }]
    : [{ width: 768, height: 1024 }, { width: 1024, height: 1000 }, { width: 1280, height: 800 }, { width: 844, height: 390 }];
  const report: unknown[] = [];
  for (const [index, size] of sizes.entries()) {
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme: index % 2 ? 'dark' : 'light', reducedMotion: 'reduce' });
    for (const destination of pages) {
      await navigate(page, destination);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      const geometry = await measure(page, size.width);
      const label = `${destination} at ${size.width}×${size.height}`;
      report.push({ page: destination, ...size, ...geometry });
      expect.soft(geometry.documentWidth, `${label}: document width`).toBeLessThanOrEqual(size.width + 1);
      expect.soft(geometry.bodyWidth, `${label}: body width`).toBeLessThanOrEqual(size.width + 1);
      expect.soft(geometry.scale, `${label}: navigation must not auto-zoom the page`).toBeCloseTo(1, 2);
      expect.soft(geometry.mainWidth, `${label}: main content must fit without clipping controls`).toBeLessThanOrEqual(geometry.mainClientWidth + 1);
      expect.soft(geometry.cards, `${label}: card contents must fit their cards`).toEqual([]);
      if (destination === 'Controls' || size.width === 320 || size.width === 768 || size.height === 390 || geometry.documentWidth > size.width + 1 || geometry.cards.length) {
        await page.screenshot({ path: testInfo.outputPath(`${destination.toLowerCase()}-${size.width}.png`), scale: 'css' });
      }
      await page.evaluate(() => window.scrollTo(10000, 0));
      expect.soft(await page.evaluate(() => window.scrollX), `${label}: horizontal panning remains disabled by fitting content`).toBe(0);
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    // Return from the longest page to Controls to catch persistent mobile
    // auto-zoom caused by a previously wider layout viewport.
    await navigate(page, 'Controls');
    const afterNavigation = await measure(page, size.width);
    expect.soft(afterNavigation.documentWidth, `Controls return at ${size.width}`).toBeLessThanOrEqual(size.width + 1);
  }
  const reportPath = testInfo.outputPath('layout-geometry.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await testInfo.attach('layout-geometry', { path: reportPath, contentType: 'application/json' });
}

test('all demo pages preserve viewport width and readable card contents across responsive breakpoints', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  await page.route('https://openrouter.ai/**', (route) => route.fulfill({
    headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: '{"data":[]}',
  }));
  await page.goto('/');
  await auditPages(page, testInfo);
});

test('connected pages contain long device room media and app names without expanding the viewport', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  await connectedHome(page);
  await page.goto('/');
  await expect(page.locator('.connection-notice')).toHaveCount(0);
  await expect(page.getByRole('tablist', { name: 'Speakers', exact: true })).toBeVisible();
  await auditPages(page, testInfo);
});
