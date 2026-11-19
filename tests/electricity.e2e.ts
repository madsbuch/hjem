import { expect, test, type Page } from '@playwright/test';
import { openSettings } from './helpers/settings';
import { nativeStorage } from './helpers/native-storage';

async function navigate(page: Page, name: string) {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  const navigation = await mobile.isVisible() ? mobile : page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name, exact: true }).click();
}

/** Osmund-shaped prices for a day: 2 kr in the evening, 0.5 kr at night, 1 kr otherwise. */
function prices(date: string) {
  const intervals = Array.from({ length: 24 }, (_, hour) => {
    const start = new Date(`${date}T00:00:00`);
    start.setHours(hour);
    const end = new Date(start);
    end.setHours(hour + 1);
    const total = hour >= 17 && hour < 21 ? 2 : hour < 4 ? 0.5 : 1;
    return {
      start: start.toISOString(), end: end.toISOString(), spot: total / 2, totalExVat: total / 1.25, totalIncVat: total,
      components: [{ type: 'spot', description: 'Spotpris', perKwh: total / 2 }, { type: 'tariff', description: 'Nettarif', perKwh: 0.3 }],
    };
  });
  return { date, resolution: 'PT1H', priceArea: 'DK2', currency: 'DKK', unit: 'kr/kWh', complete: true, reason: null, intervals, locationId: 'home' };
}

test('the demo home shows sample prices, the cheapest hours, and use', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-18T15:20:00') });
  await page.goto('/');
  await navigate(page, 'Electricity');
  await expect(page.getByRole('heading', { name: 'Power, priced by the hour.' })).toBeVisible();
  await expect(page.getByText('ELECTRICITY · DK1 · SAMPLE PRICES')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Price right now' })).toContainText('kr/kWh');
  await expect(page.getByRole('region', { name: 'Cheapest 3 hours' })).toContainText(/\d\d:\d\d–\d\d:\d\d/);
  await expect(page.getByRole('region', { name: 'Latest invoice' })).toContainText('827.98');

  const chart = page.getByRole('figure', { name: /Electricity price/ });
  // Tapping a column shows Osmund's exact price, not a rounded one, and it stays shown.
  const evening = chart.getByRole('listitem', { name: /^18:00–19:00, \d\.\d{3,5} kr per kWh/ });
  await evening.tap();
  await page.waitForTimeout(300);
  const tooltip = chart.getByRole('status');
  await expect(tooltip).toContainText('18:00–19:00');
  await expect(tooltip).toContainText(/\d\.\d{3,5} kr\/kWh/);
  await expect(tooltip).toContainText('Spotpris');
  await expect(page.getByText('Show as a table')).toHaveCount(0);

  await page.getByRole('button', { name: 'Tomorrow', exact: true }).click();
  await expect(page.getByRole('figure', { name: /Electricity price, Thursday/ })).toBeVisible();
});

test('tomorrow waits for the afternoon', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-18T09:05:00') });
  await page.goto('/');
  await navigate(page, 'Electricity');
  await expect(page.getByRole('button', { name: 'Tomorrow', exact: true })).toBeDisabled();
  await expect(page.getByText('Tomorrow’s prices arrive in the afternoon.')).toBeVisible();
});

test('connects an Osmund key on the tablet and shows the home’s own data', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-18T10:30:00') });
  const storage = await nativeStorage(page);
  storage.setElectricityResponse('locations', { locations: [
    { id: 'home-0192f3a1', priceArea: 'DK2', state: 'active', plan: 'osmund_rolig', apiAccess: 'open' },
    { id: 'cabin-0192f3a1', priceArea: 'DK1', state: 'active', plan: null, apiAccess: 'closed' },
  ] });
  storage.setElectricityResponse('prices', (request: Record<string, unknown>) =>
    request.date === '2026-11-18' ? prices('2026-11-18') : new Error('Osmund could not answer this request.'));
  storage.setElectricityResponse('consumption', { resolution: 'P1D', totalKwh: 28, values: [
    { start: '2026-11-16T00:00:00+01:00', end: '2026-11-17T00:00:00+01:00', kwh: 12 },
    { start: '2026-11-17T00:00:00+01:00', end: '2026-11-18T00:00:00+01:00', kwh: 16 },
  ] });
  storage.setElectricityResponse('ratedCost', {
    month: '2026-11', complete: false, daysInMonth: 30, daysWithData: 17, totalKwh: 220, missingDays: [],
    total: { exVat: 300, incVat: 375 }, subscriptions: { exVat: 40, incVat: 50 }, totalWithSubscriptions: { exVat: 340, incVat: 425 }, subscriptionsComplete: true, days: [],
  });
  storage.setElectricityResponse('standby', { unit: 'kW', months: [{ month: '2026-10', standbyKw: 0.12 }] });
  storage.setElectricityResponse('invoices', { invoices: [{ invoiceNo: 'F99', type: 'invoice', paid: false, invoiceDate: '2026-11-12', dueDate: '2026-11-26', total: { exVat: 400, incVat: 500 }, outstanding: 500 }] });
  await page.goto('/');

  // Without Osmund, the demo home shows sample prices and points to Settings.
  await navigate(page, 'Electricity');
  await expect(page.getByText('Sample prices for the demo home. Connect Osmund in Settings to see your own.')).toBeVisible();
  await openSettings(page, 'Electricity');

  const card = page.getByRole('region', { name: 'Electricity' });
  await card.getByLabel('Osmund API key').fill('osm_wrong');
  await card.getByRole('button', { name: 'Connect Osmund' }).click();
  await expect(page.getByText('Osmund did not accept the API key.')).toBeVisible();
  await card.getByLabel('Osmund API key').fill('osm_fixture');
  await card.getByRole('button', { name: 'Connect Osmund' }).click();
  // The only location with API access is chosen automatically.
  await expect(page.getByText('Osmund connected.')).toBeVisible();
  await expect(card.getByText('Connected · DK2')).toBeVisible();
  expect(storage.electricity).toEqual({ hasApiKey: true, locationId: 'home-0192f3a1' });

  await navigate(page, 'Electricity');
  await expect(page.getByText('ELECTRICITY · DK2')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Price right now' })).toContainText('1.00');
  await expect(page.getByRole('region', { name: 'Cheapest 3 hours' })).toContainText('11:00–14:00');
  await expect(page.getByRole('region', { name: 'This month so far' })).toContainText('425');
  await expect(page.getByRole('region', { name: 'This month so far' })).toContainText('about 750 kr for the month');
  await expect(page.getByRole('region', { name: 'Standby' })).toContainText('120');
  await expect(page.getByRole('region', { name: 'Latest invoice' })).toContainText('500.00 kr to pay by November 26');
  await expect(page.getByRole('button', { name: 'Tomorrow', exact: true })).toBeDisabled();
  // Six requests per load; the key never appears in what the page sends.
  expect(storage.electricityRequests.filter((request) => request.kind !== 'locations')).toHaveLength(6);
  expect(JSON.stringify(storage.electricityRequests)).not.toContain('osm_');

  await openSettings(page, 'Electricity');
  await card.getByRole('button', { name: 'Remove key' }).click();
  await expect(page.getByText('Osmund key removed.')).toBeVisible();
  await navigate(page, 'Electricity');
  await expect(page.getByText('ELECTRICITY · DK1 · SAMPLE PRICES')).toBeVisible();
});
