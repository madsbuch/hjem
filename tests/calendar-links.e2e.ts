import { expect, test, type Page } from '@playwright/test';
import { nativeStorage } from './helpers/native-storage';

test.use({ timezoneId: 'Europe/Copenhagen' });

const familyUrl = 'https://calendar.example.test/private-family-secret/basic.ics';
const workUrl = 'https://calendar.example.test/private-work-secret/basic.ics';

const calendar = (uid: string, title: string, allDay = false) => [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Hjem//Calendar link browser test//EN',
  'BEGIN:VEVENT',
  `UID:${uid}@example.test`,
  'DTSTAMP:20261101T090000Z',
  allDay ? 'DTSTART;VALUE=DATE:20261115' : 'DTSTART:20261115T120000Z',
  allDay ? 'DTEND;VALUE=DATE:20261116' : 'DTEND:20261115T133000Z',
  `SUMMARY:${title}`,
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

async function navigate(page: Page, name: 'Overview' | 'Settings') {
  await page.locator('nav:visible').first().waitFor();
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const nav = await mobile.isVisible()
    ? mobile
    : page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('button', { name, exact: true }).click();
}

async function addLink(page: Page, name: string, url: string) {
  const settings = page.getByRole('region', { name: 'Calendars', exact: true });
  await settings.getByLabel('Calendar name', { exact: true }).fill(name);
  await settings.getByLabel('iCal / ICS link', { exact: true }).fill(url);
  await settings.getByRole('button', { name: 'Add calendar', exact: true }).click();
  await expect(settings.getByRole('button', { name: `Remove ${name} calendar`, exact: true })).toBeVisible();
  await expect(settings.getByLabel('iCal / ICS link', { exact: true })).toHaveValue('');
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-15T12:15:00Z'));
});

test('saves two calendar links, shows their real events in demo mode, and persists removal', async ({ page }) => {
  const storage = await nativeStorage(page);
  storage.setFeedResponse(familyUrl, calendar('family-lunch', 'Family lunch from iCal'));
  storage.setFeedResponse(workUrl, calendar('work-day', 'Work planning day', true));
  await page.goto('/');
  await navigate(page, 'Settings');
  await addLink(page, 'Family', familyUrl);
  await addLink(page, 'Work', workUrl);
  expect(storage.snapshot.calendarFeeds).toEqual([
    { id: 1, name: 'Family', url: familyUrl },
    { id: 2, name: 'Work', url: workUrl },
  ]);
  expect(storage.snapshot.connection).toBeNull();

  const beforeCheck = storage.feedFetches.filter((id) => id === 1).length;
  await page.getByRole('button', { name: 'Check Family calendar', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected · 1 event today' })).toBeVisible();
  await expect.poll(() => storage.feedFetches.filter((id) => id === 1).length).toBeGreaterThan(beforeCheck);

  await navigate(page, 'Overview');
  const agenda = page.getByRole('region', { name: 'Today’s calendar', exact: true });
  await expect(agenda.getByRole('article', { name: /^Family lunch from iCal,/ })).toBeVisible();
  await expect(agenda.getByText('Work planning day', { exact: true })).toBeVisible();
  await expect(agenda.getByText('Sample events', { exact: true })).toHaveCount(0);
  const webStorage = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  expect(webStorage).not.toContain(familyUrl);
  expect(webStorage).not.toContain(workUrl);
  expect(webStorage).not.toContain('private-family-secret');

  await page.reload();
  await page.locator('nav:visible').first().waitFor();
  await expect(agenda.getByRole('article', { name: /^Family lunch from iCal,/ })).toBeVisible();
  await expect(agenda.getByText('Work planning day', { exact: true })).toBeVisible();
  await navigate(page, 'Settings');
  await page.getByRole('button', { name: 'Remove Work calendar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Work calendar', exact: true })).toHaveCount(0);
  expect(storage.snapshot.calendarFeeds).toEqual([{ id: 1, name: 'Family', url: familyUrl }]);
  await page.reload();
  await page.locator('nav:visible').first().waitFor();
  await expect(agenda.getByRole('article', { name: /^Family lunch from iCal,/ })).toBeVisible();
  await expect(agenda.getByText('Work planning day', { exact: true })).toHaveCount(0);
  await expect(agenda.getByText('Sample events', { exact: true })).toHaveCount(0);
});

test('isolates malformed and unreachable feeds and refreshes repaired links through native IPC', async ({ page }) => {
  const storage = await nativeStorage(page, { calendarFeeds: [
    { id: 10, name: 'Family', url: familyUrl },
    { id: 11, name: 'Work', url: workUrl },
  ] });
  storage.setFeedResponse(familyUrl, calendar('family', 'Family event stays available'));
  storage.setFeedResponse(workUrl, 'This response is not an iCalendar document.');
  await page.goto('/');
  await page.locator('nav:visible').first().waitFor();
  const agenda = page.getByRole('region', { name: 'Today’s calendar', exact: true });
  await expect(agenda.getByRole('article', { name: /^Family event stays available,/ })).toBeVisible();
  await expect(agenda.getByRole('alert')).toContainText('Work:');
  await expect(agenda.getByText('Sample events', { exact: true })).toHaveCount(0);

  storage.setFeedResponse(workUrl, calendar('work', 'Repaired work event'));
  const beforeRefresh = storage.feedFetches.length;
  await agenda.getByRole('button', { name: 'Refresh calendar', exact: true }).click();
  await expect(agenda.getByRole('article', { name: /^Repaired work event,/ })).toBeVisible();
  await expect(agenda.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => storage.feedFetches.length).toBeGreaterThanOrEqual(beforeRefresh + 2);

  storage.setFeedError(workUrl, 'Fixture calendar is unreachable');
  storage.setFeedResponse(familyUrl, calendar('family-updated', 'Updated family event'));
  await agenda.getByRole('button', { name: 'Refresh calendar', exact: true }).click();
  await expect(agenda.getByRole('article', { name: /^Updated family event,/ })).toBeVisible();
  await expect(agenda.getByRole('alert')).toContainText('Work:');
  await expect(agenda.getByRole('article', { name: /^Family event stays available,/ })).toHaveCount(0);
  expect(storage.snapshot.calendarFeeds).toHaveLength(2);
});

test('reports a failed calendar save without claiming the link was added', async ({ page }) => {
  const storage = await nativeStorage(page);
  storage.fail('calendar_add_feed');
  await page.goto('/');
  await navigate(page, 'Settings');
  const settings = page.getByRole('region', { name: 'Calendars', exact: true });
  await settings.getByLabel('Calendar name', { exact: true }).fill('Unsaved calendar');
  await settings.getByLabel('iCal / ICS link', { exact: true }).fill(familyUrl);
  await settings.getByRole('button', { name: 'Add calendar', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText('Could not save settings');
  await expect(settings.getByRole('button', { name: 'Remove Unsaved calendar calendar' })).toHaveCount(0);
  expect(storage.snapshot.calendarFeeds).toEqual([]);
  await page.reload();
  await page.locator('nav:visible').first().waitFor();
  await expect(page.getByText('Sample events', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain(familyUrl);
});
