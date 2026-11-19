import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoElectricity, type ElectricityData, type PriceDay } from './electricity';
import { electricityToolNames, parseLocalTime, runElectricityTool, type ElectricityContext } from './concierge-electricity';
import { conciergeTools, conciergeSystemPrompt, createConciergeExecutor, type ConciergeContext } from './concierge-tools';
import { demoSnapshot } from './demo';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) throw new Error(`Missing ${path.join('.')}`);
    current = current[key];
  }
  return current;
}

/** Today 0.5 kr at night (00–04), 2 kr in the evening (17–21), 1 kr otherwise; tomorrow the same. */
function day(date: Date): PriceDay {
  const intervals = Array.from({ length: 24 }, (_, hour) => {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour);
    const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour + 1);
    const total = hour >= 17 && hour < 21 ? 2 : hour < 4 ? 0.5 : 1;
    return {
      start: start.toISOString(), end: end.toISOString(), spot: total / 2, totalExVat: total / 1.25, totalIncVat: total,
      components: [
        { type: 'spot', description: 'Spotpris', perKwh: total / 2 },
        { type: 'tariff', description: 'Nettarif', perKwh: 0.2 },
        { type: 'tariff', description: 'Systemtarif', perKwh: 0.05 },
        { type: 'tax', description: 'Elafgift', perKwh: 0.008 },
      ],
    };
  });
  return { date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, resolution: 'PT1H', priceArea: 'DK2', complete: true, reason: null, intervals };
}

const now = new Date(2026, 10, 18, 15, 20);
afterEach(() => vi.useRealTimers());
function context(overrides: Partial<ElectricityData> = {}, source: ElectricityContext['source'] = 'live'): ElectricityContext {
  const base = demoElectricity(now);
  return {
    source,
    loading: false,
    error: '',
    data: { ...base, today: day(now), tomorrow: day(new Date(2026, 10, 19)), ...overrides },
  };
}
const run = (name: string, args: Record<string, unknown> = {}, electricity = context()) => runElectricityTool(name, args, electricity, now);

describe('Concierge electricity tools', () => {
  it('are offered to the model with read-only guidance', () => {
    const names = conciergeTools.map((definition) => definition.function.name);
    for (const name of electricityToolNames) expect(names).toContain(name);
    expect(conciergeSystemPrompt).toContain('find_cheapest_hours');
    expect(conciergeSystemPrompt).toContain('cannot schedule devices');
  });

  it('reads hourly prices with their parts and the current hour', () => {
    const result = run('get_electricity_prices');
    expect(field(result, 'current')).toEqual({ start: '15:00', end: '16:00', incl_vat: 1, excl_vat: 0.8, compared_with_today: 'average' });
    expect(field(result, 'today', 'hours')).toHaveLength(24);
    expect(field(result, 'today', 'cheapest_hour')).toEqual({ start: '00:00', incl_vat: 0.5 });
    expect(field(result, 'today', 'most_expensive_hour')).toEqual({ start: '17:00', incl_vat: 2 });
    const hours = field(result, 'today', 'hours');
    if (!Array.isArray(hours)) throw new Error('hours');
    expect(hours[18]).toEqual({ start: '18:00', end: '19:00', incl_vat: 2, excl_vat: 1.6, spot: 1, tariffs: 0.25, taxes: 0.008, supplier: 0 });
    const onlyToday = run('get_electricity_prices', { day: 'today' });
    expect(field(onlyToday, 'tomorrow')).toBeUndefined();
    expect(field(run('get_electricity_prices', {}, context({ tomorrow: null })), 'tomorrow', 'unavailable')).toContain('afternoon');
    expect(() => run('get_electricity_prices', { day: 'yesterday' })).toThrow('today, tomorrow, or both');
  });

  it('finds the cheapest block or separate hours, with deadlines', () => {
    const block = run('find_cheapest_hours', { hours: 3 });
    expect(block).toMatchObject({ found: true, start: '2026-11-19 00:00', end: '2026-11-19 03:00', average_incl_vat: 0.5 });
    // Starting in the current hour (15–18) would average (1 + 1 + 2) / 3.
    expect(field(block, 'starting_this_hour_instead')).toEqual({ average_incl_vat: 1.3333, saving_per_kwh: 0.8333 });

    // "Done before 7 tomorrow, not before 1" — 01:00–04:00 is the cheapest that fits.
    expect(run('find_cheapest_hours', { hours: 2, earliest: '01:00', latest: '07:00' })).toMatchObject({ start: '2026-11-19 01:00', end: '2026-11-19 03:00' });
    // Before the evening peak today, only 1 kr hours remain.
    expect(run('find_cheapest_hours', { hours: 1, latest: '17:00' })).toMatchObject({ start: '2026-11-18 16:00', average_incl_vat: 1 });

    const separate = run('find_cheapest_hours', { hours: 5, together: false });
    expect(field(separate, 'chosen_hours')).toEqual([
      { start: '2026-11-19 00:00', end: '2026-11-19 01:00', incl_vat: 0.5 },
      { start: '2026-11-19 01:00', end: '2026-11-19 02:00', incl_vat: 0.5 },
      { start: '2026-11-19 02:00', end: '2026-11-19 03:00', incl_vat: 0.5 },
      { start: '2026-11-19 03:00', end: '2026-11-19 04:00', incl_vat: 0.5 },
      { start: '2026-11-18 16:00', end: '2026-11-18 17:00', incl_vat: 1 },
    ].sort((first, second) => first.start.localeCompare(second.start)));

    expect(run('find_cheapest_hours', { hours: 3 }, context({ tomorrow: null }))).toMatchObject({ found: true, start: '2026-11-18 21:00' });
    expect(field(run('find_cheapest_hours', { hours: 12 }, context({ tomorrow: null })), 'reason')).toContain('afternoon');
    expect(() => run('find_cheapest_hours', { hours: 0 })).toThrow('1 to 24');
    expect(() => run('find_cheapest_hours', { hours: 2, latest: 'soon' })).toThrow('HH:MM');
    expect(() => run('find_cheapest_hours', { hours: 2, earliest: '2026-11-19T03:00', latest: '2026-11-19T02:00' })).toThrow('after earliest');
  });

  it('explains month-to-date cost day by day, with subscriptions and missing days', () => {
    const month = {
      month: '2026-11', complete: false, daysInMonth: 30, daysWithData: 2, totalKwh: 16, missingDays: ['2026-11-01', '2026-11-02'],
      total: { exVat: 28, incVat: 35 }, subscriptions: { exVat: 6.4, incVat: 8 }, totalWithSubscriptions: { exVat: 34.4, incVat: 43 }, subscriptionsComplete: true,
      days: [
        { date: '2026-11-16', kwh: 7, incVat: 15, subscriptionsIncVat: 4, totalIncVat: 19 },
        { date: '2026-11-17', kwh: 9, incVat: 20, subscriptionsIncVat: 4, totalIncVat: 24 },
      ],
    };
    const result = run('get_electricity_usage', {}, context({ month }));
    expect(field(result, 'month_so_far')).toMatchObject({
      days_costed: 2, kwh: 16, total_with_subscriptions: 43, per_kwh_charges: 35, subscriptions_share: 8,
      average_price_per_kwh_with_subscriptions: 2.6875, average_price_per_kwh_charges_only: 2.1875,
      days_not_costed_yet: ['2026-11-01', '2026-11-02'], straight_line_estimate_for_month: null,
    });
    expect(field(result, 'month_so_far', 'days')).toHaveLength(2);
    expect(field(result, 'standby')).toEqual({ month: expect.any(String), watts: 151, kwh_per_year: 1323 });
    expect(field(result, 'latest_invoice')).toMatchObject({ number: 'F1234', paid: true, total: 827.98 });
  });

  it('says plainly when electricity is not connected, loading, or sample data', () => {
    expect(run('get_electricity_prices', {}, { source: 'setup', data: null, loading: false, error: '' })).toMatchObject({ available: false, message: expect.stringContaining('Settings → Electricity') });
    expect(run('get_electricity_usage', {}, { source: 'live', data: null, loading: true, error: '' })).toMatchObject({ available: false, message: expect.stringContaining('loading') });
    expect(run('get_electricity_prices', {}, context({}, 'demo'))).toMatchObject({ available: true, sample_data: true });
  });

  it('parses local times as their next occurrence', () => {
    expect(parseLocalTime('07:00', now, 'latest')).toEqual(new Date(2026, 10, 19, 7));
    expect(parseLocalTime('18:30', now, 'latest')).toEqual(new Date(2026, 10, 18, 18, 30));
    expect(parseLocalTime('2026-11-19T06:15', now, 'latest')).toEqual(new Date(2026, 10, 19, 6, 15));
    expect(() => parseLocalTime('2026-02-30T06:15', now, 'latest')).toThrow();
    expect(() => parseLocalTime('25:00', now, 'latest')).toThrow();
  });

  it('runs through the Concierge executor without touching the home', async () => {
    // The executor reads the clock; pin it to the fixture's day.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const actions: string[] = [];
    const conciergeContext: ConciergeContext = {
      sessionId: 'test', snapshot: structuredClone(demoSnapshot), demo: true, connected: true, apps: [], appsPreview: true,
      action: async (_entity, service) => { actions.push(service); return true; },
      launch: async () => undefined,
      electricity: context(),
    };
    const execute = createConciergeExecutor(() => conciergeContext);
    const result = await execute('find_cheapest_hours', { hours: 2 }, new AbortController().signal);
    expect(result).toMatchObject({ found: true, start: '2026-11-19 00:00' });
    await expect(execute('find_cheapest_hours', { hours: 2, device: 'dishwasher' }, new AbortController().signal)).rejects.toThrow('unsupported arguments');
    expect(actions).toEqual([]);
  });
});
