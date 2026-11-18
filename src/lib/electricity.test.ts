import { describe, expect, it, vi } from 'vitest';
import {
  cheapestWindow,
  demoElectricity,
  intervalAt,
  loadElectricity,
  monthEstimate,
  parseConsumption,
  parseLatestInvoice,
  parseLocations,
  parsePriceDay,
  parseRatedCost,
  parseStandby,
  priceLevel,
  type ElectricityRequest,
  type PriceInterval,
} from './electricity';

// The documented examples from the Osmund API (v1.0.0-beta).
const priceExample = {
  complete: true, currency: 'DKK', date: '2026-11-17', locationId: 'loc', priceArea: 'DK1', reason: null, resolution: 'PT1H', unit: 'kr/kWh',
  intervals: [
    { start: '2026-11-17T00:00:00+01:00', end: '2026-11-17T01:00:00+01:00', spot: 0.412, totalExVat: 0.779, totalIncVat: 0.97375,
      components: [{ description: 'Spotpris', perKwh: 0.412, type: 'spot' }, { description: 'Nettarif', perKwh: 0.287, type: 'tariff' }] },
    { start: '2026-11-17T01:00:00+01:00', end: '2026-11-17T02:00:00+01:00', spot: 0.389, totalExVat: 0.756, totalIncVat: 0.945,
      components: [{ description: 'Spotpris', perKwh: 0.389, type: 'spot' }], futureField: 'ignored' },
  ],
};
const ratedExample = {
  complete: false, currency: 'DKK', daysInMonth: 30, daysWithData: 2, locationId: 'loc', missingDays: ['2026-11-03'], month: '2026-11',
  subscriptions: { exVat: 6.22, incVat: 7.78 }, subscriptionsComplete: true, total: { exVat: 39.63, incVat: 49.54 }, totalKwh: 29.1,
  totalWithSubscriptions: { exVat: 45.85, incVat: 57.32 }, days: [],
};

function hours(prices: number[], startHour = 0): PriceInterval[] {
  return prices.map((price, index) => ({
    start: new Date(2026, 10, 18, startHour + index).toISOString(),
    end: new Date(2026, 10, 18, startHour + index + 1).toISOString(),
    spot: price, totalExVat: price, totalIncVat: price, components: [],
  }));
}

describe('reading Osmund answers', () => {
  it('parses the documented examples and ignores unknown fields', () => {
    const day = parsePriceDay(priceExample);
    expect(day.intervals).toHaveLength(2);
    expect(day.intervals[0]).toMatchObject({ totalIncVat: 0.97375, components: [{ type: 'spot', perKwh: 0.412 }, { type: 'tariff' }] });
    expect(parseRatedCost(ratedExample)).toMatchObject({ month: '2026-11', daysWithData: 2, totalWithSubscriptions: { incVat: 57.32 } });
    expect(parseConsumption({ from: '2026-11-01', to: '2026-11-03', resolution: 'P1D', totalKwh: 42.3, unit: 'kWh',
      values: [{ start: '2026-11-01T00:00:00+01:00', end: '2026-11-02T00:00:00+01:00', kwh: 13.9 }] }).values).toHaveLength(1);
    expect(parseStandby({ locationId: 'loc', unit: 'kW', months: [{ month: '2026-10', standbyKw: 0.151 }, { month: 7 }] })).toEqual([{ month: '2026-10', standbyKw: 0.151 }]);
    expect(parseLatestInvoice({ hasMore: false, page: 1, perPage: 1, invoices: [{ currency: 'DKK', dueDate: '2026-11-26', invoiceDate: '2026-11-12',
      invoiceNo: 'F1234', outstanding: 0, paid: true, total: { exVat: 662.38, incVat: 827.98 }, type: 'invoice' }] })).toMatchObject({ invoiceNo: 'F1234', paid: true });
    expect(parseLatestInvoice({ invoices: [] })).toBeNull();
    expect(parseLocations({ locations: [{ apiAccess: 'closed', id: 'b', plan: null, priceArea: 'DK2', state: 'upcoming' }, { id: 7 }] }))
      .toEqual([{ id: 'b', priceArea: 'DK2', state: 'upcoming', plan: null, apiAccess: 'closed' }]);
  });

  it('rejects malformed values instead of showing wrong numbers', () => {
    expect(() => parsePriceDay({ ...priceExample, intervals: [{ ...priceExample.intervals[0], totalIncVat: '1.2' }] })).toThrow('could not read');
    expect(() => parsePriceDay({ ...priceExample, intervals: [{ ...priceExample.intervals[0], start: 'soon' }] })).toThrow('could not read');
    expect(() => parseRatedCost({ ...ratedExample, total: null })).toThrow('could not read');
  });
});

describe('reading the prices', () => {
  it('finds the cheapest consecutive window that has not started yet', () => {
    const intervals = hours([3, 1, 1, 1, 5, 0.5, 0.5, 9, 0.2, 0.2, 0.2]);
    expect(cheapestWindow(intervals, 3, new Date(2026, 10, 18, 0, 30))?.average).toBeCloseTo(0.2);
    // A gap between days is not a window.
    const gapped = [...hours([2, 2]), ...hours([0.1, 0.1], 5)];
    expect(cheapestWindow(gapped, 3, new Date(2026, 10, 18, 0))).toBeNull();
    expect(cheapestWindow(intervals, 3, new Date(2026, 10, 18, 23))).toBeNull();
    // At 8:30 the 8:00 hour is under way, so only 9:00–11:00 remains: too short for three hours.
    expect(cheapestWindow(intervals, 3, new Date(2026, 10, 18, 8, 30))).toBeNull();
    expect(cheapestWindow(intervals, 2, new Date(2026, 10, 18, 8, 30))?.start).toBe(new Date(2026, 10, 18, 9).toISOString());
    expect(intervalAt(intervals, new Date(2026, 10, 18, 4, 59))?.totalIncVat).toBe(5);
  });

  it('describes a price relative to the day and estimates the month', () => {
    const intervals = hours([1, 1, 1, 1]);
    expect(priceLevel(0.8, intervals)).toBe('low');
    expect(priceLevel(1, intervals)).toBe('normal');
    expect(priceLevel(1.2, intervals)).toBe('high');
    expect(monthEstimate(parseRatedCost(ratedExample))).toBeNull();
    expect(monthEstimate(parseRatedCost({ ...ratedExample, daysWithData: 10, totalWithSubscriptions: { exVat: 80, incVat: 100 } }))).toBe(300);
  });
});

describe('loading', () => {
  it('makes six requests and keeps sections independent', async () => {
    const requests: ElectricityRequest[] = [];
    const fetcher = vi.fn(async (request: ElectricityRequest) => {
      requests.push(request);
      if (request.kind === 'prices') {
        if (request.date === '2026-11-19') throw new Error('Osmund could not answer this request.');
        return priceExample;
      }
      if (request.kind === 'ratedCost') return ratedExample;
      if (request.kind === 'standby') throw new Error('API access is not included for this Osmund location.');
      if (request.kind === 'invoices') return { invoices: [] };
      return { totalKwh: 0, values: [] };
    });
    const data = await loadElectricity(new Date(2026, 10, 18, 9), fetcher);
    expect(requests).toHaveLength(6);
    expect(requests).toContainEqual({ kind: 'consumption', resolution: 'P1D', from: '2026-11-04', to: '2026-11-17' });
    expect(requests).toContainEqual({ kind: 'ratedCost', month: '2026-11' });
    // Tomorrow's prices are simply not published yet; that is not an error.
    expect(data.tomorrow).toBeNull();
    expect(data.errors).toEqual({ standby: 'API access is not included for this Osmund location.' });
    expect(data.today?.intervals).toHaveLength(2);
    expect(data.invoice).toBeNull();
  });

  it('has demo data for a whole day, with tomorrow only in the afternoon', () => {
    const morning = demoElectricity(new Date(2026, 10, 18, 9));
    expect(morning.today?.intervals).toHaveLength(24);
    expect(morning.tomorrow).toBeNull();
    expect(demoElectricity(new Date(2026, 10, 18, 14)).tomorrow?.intervals).toHaveLength(24);
    expect(morning.recent?.values).toHaveLength(14);
  });
});
