import { expect, test } from '@playwright/test';
import { nativeStorage } from './helpers/native-storage';

test.use({ timezoneId: 'Europe/Copenhagen' });
test('24-hour calendar tracks now and shares the top row with music above full-width moods', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-11-15T11:00:00Z') });
  // A connected calendar renders the refresh control, which must not enlarge
  // only its heading row and push its card below the Music card.
  const calendarUrl = 'https://calendar.example.test/layout-fixture.ics';
  const storage = await nativeStorage(page, {
    calendarFeeds: [{ id: 1, name: 'Layout fixture', url: calendarUrl }],
  });
  storage.setFeedResponse(calendarUrl, [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hjem//Layout fixture//EN',
    'BEGIN:VEVENT',
    'UID:layout-fixture',
    'DTSTAMP:20261101T090000Z',
    'DTSTART:20261115T113000Z',
    'DTEND:20261115T123000Z',
    'SUMMARY:Lunch',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n'));
  await page.goto('/');
  const calendar = page.getByRole('region', { name: 'Today’s calendar' });
  const music = page.getByRole('region', { name: 'Music controls' });
  const moods = page.locator('.quick-scenes');
  await expect(calendar.getByRole('button', { name: 'Refresh calendar', exact: true })).toBeVisible();
  await expect(calendar.locator('.calendar-hour')).toHaveCount(25);
  await expect(calendar.locator('.calendar-hour').first()).toHaveText('00:00');
  await expect(calendar.locator('.calendar-hour').last()).toHaveText('24:00');
  const now = calendar.getByRole('img', { name: 'Now, 12:00', exact: true });
  await expect(now).toBeVisible();
  expect(await now.evaluate((el) => (el as HTMLElement).style.top)).toBe('50%');
  expect(
    await now.locator('i').evaluate((el) => el.getBoundingClientRect().height),
  ).toBeGreaterThan(
    await calendar
      .locator('.calendar-hour i')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height),
  );
  const [c, m, scenes, calendarTitle, musicTitle, agenda, player] = await Promise.all([
    calendar.boundingBox(),
    music.boundingBox(),
    moods.boundingBox(),
    calendar.getByRole('heading', { name: 'Today’s calendar', exact: true }).boundingBox(),
    music.getByRole('heading', { name: 'Music', exact: true }).boundingBox(),
    calendar.locator('.calendar-agenda').boundingBox(),
    music.locator('.music-player').boundingBox(),
  ]);
  expect(c).not.toBeNull();
  expect(m).not.toBeNull();
  expect(scenes).not.toBeNull();
  if (page.viewportSize()!.width > 700) {
    expect(Math.abs(c!.y - m!.y)).toBeLessThan(2);
    expect(Math.abs(calendarTitle!.y - musicTitle!.y)).toBeLessThan(1);
    expect(Math.abs(calendarTitle!.y + calendarTitle!.height - musicTitle!.y - musicTitle!.height)).toBeLessThan(1);
    expect(Math.abs(agenda!.y - player!.y)).toBeLessThan(1);
    expect(Math.abs(agenda!.y + agenda!.height - player!.y - player!.height)).toBeLessThan(1);
    expect(c!.x).toBeGreaterThan(m!.x + m!.width);
    expect(scenes!.width).toBeGreaterThan(c!.width * 1.9);
  } else expect(c!.y).toBeGreaterThan(m!.y + m!.height);
  expect(scenes!.y).toBeGreaterThanOrEqual(
    Math.max(c!.y + c!.height, m!.y + m!.height),
  );
  await page.clock.fastForward(30 * 60_000);
  const later = calendar.getByRole('img', { name: 'Now, 12:30', exact: true });
  await expect(later).toBeVisible();
  expect(
    Number.parseFloat(
      await later.evaluate((el) => (el as HTMLElement).style.top),
    ),
  ).toBeCloseTo(52.0833, 3);
});

test('compact calendar allows a held peek and returns to the current time after release', async ({
  page,
}) => {
  await page.goto('/');
  const calendar = page.getByRole('region', {
    name: 'Today’s calendar',
    exact: true,
  });
  const scroll = calendar.locator('.calendar-scroll');
  await expect(scroll).toBeVisible();
  const agenda = await calendar.locator('.calendar-agenda').boundingBox();
  expect(agenda!.height).toBeLessThanOrEqual(264);
  expect(
    await page
      .locator('.home-music .track-title')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(16);
  expect(
    await page
      .locator('.home-music .track-artist')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(12);
  await page.waitForTimeout(120);
  const initial = await scroll.evaluate((el) => el.scrollTop);
  const target = await scroll.evaluate((el) =>
    el.scrollTop < 80 ? el.scrollHeight - el.clientHeight : 0,
  );
  await scroll.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
  });
  await scroll.evaluate((el, top) => {
    el.scrollTop = top;
  }, target);
  await page.waitForTimeout(1100);
  expect(await scroll.evaluate((el) => el.scrollTop)).toBeCloseTo(target, 0);
  await scroll.dispatchEvent('pointerup', {
    pointerId: 1,
    pointerType: 'touch',
  });
  await expect
    .poll(async () =>
      Math.abs((await scroll.evaluate((el) => el.scrollTop)) - initial),
    )
    .toBeLessThan(2);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await scroll.dispatchEvent('pointerdown', {
    pointerId: 2,
    pointerType: 'touch',
  });
  await scroll.evaluate((el, top) => {
    el.scrollTop = top;
  }, target);
  await scroll.dispatchEvent('pointerup', {
    pointerId: 2,
    pointerType: 'touch',
  });
  await expect
    .poll(async () =>
      Math.abs((await scroll.evaluate((el) => el.scrollTop)) - initial),
    )
    .toBeLessThan(2);
});
