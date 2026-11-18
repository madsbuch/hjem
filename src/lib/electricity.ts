import { invoke, isTauri } from '@tauri-apps/api/core';

/** Osmund data, validated from unknown JSON. Unknown fields are ignored (the API is in beta). */
export interface Amount { exVat: number; incVat: number }
export interface PriceComponent { type: string; description: string; perKwh: number }
export interface PriceInterval {
  start: string;
  end: string;
  spot: number;
  totalExVat: number;
  totalIncVat: number;
  components: PriceComponent[];
}
export interface PriceDay {
  date: string;
  resolution: string;
  priceArea: string | null;
  complete: boolean;
  reason: string | null;
  intervals: PriceInterval[];
}
export interface ConsumptionValue { start: string; end: string; kwh: number }
export interface Consumption { resolution: string; totalKwh: number; values: ConsumptionValue[] }
export interface RatedCost {
  month: string;
  complete: boolean;
  daysInMonth: number;
  daysWithData: number;
  totalKwh: number;
  total: Amount;
  totalWithSubscriptions: Amount;
  subscriptionsComplete: boolean;
}
export interface StandbyMonth { month: string; standbyKw: number }
export interface InvoiceSummary {
  invoiceNo: string;
  type: string;
  paid: boolean;
  invoiceDate: string | null;
  dueDate: string | null;
  total: Amount;
  outstanding: number;
}
export interface OsmundLocation {
  id: string;
  priceArea: string | null;
  state: string;
  plan: string | null;
  apiAccess: string;
}
export interface ElectricitySettings { hasApiKey: boolean; locationId: string | null }

export type ElectricityRequest =
  | { kind: 'locations' }
  | { kind: 'prices'; date?: string; resolution?: 'PT1H' | 'PT15M' }
  | { kind: 'consumption'; resolution: 'PT1H' | 'P1D' | 'P1M'; from: string; to: string }
  | { kind: 'standby' }
  | { kind: 'ratedCost'; month?: string }
  | { kind: 'invoices'; page?: number; perPage?: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const unreadable = () => new Error('Osmund returned data Hjem could not read.');
const timeText = (value: unknown): string => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw unreadable();
  return value;
};
function amount(value: unknown): Amount {
  if (!isRecord(value) || !finite(value.exVat) || !finite(value.incVat)) throw unreadable();
  return { exVat: value.exVat, incVat: value.incVat };
}

export function parsePriceDay(value: unknown): PriceDay {
  if (!isRecord(value) || typeof value.date !== 'string' || typeof value.complete !== 'boolean') throw unreadable();
  return {
    date: value.date,
    resolution: text(value.resolution) ?? 'PT1H',
    priceArea: text(value.priceArea),
    complete: value.complete,
    reason: text(value.reason),
    intervals: list(value.intervals).map((item) => {
      if (!isRecord(item) || !finite(item.spot) || !finite(item.totalExVat) || !finite(item.totalIncVat)) throw unreadable();
      return {
        start: timeText(item.start),
        end: timeText(item.end),
        spot: item.spot,
        totalExVat: item.totalExVat,
        totalIncVat: item.totalIncVat,
        components: list(item.components).flatMap((component) =>
          isRecord(component) && typeof component.description === 'string' && finite(component.perKwh)
            ? [{ type: text(component.type) ?? 'other', description: component.description, perKwh: component.perKwh }]
            : []),
      };
    }),
  };
}
export function parseConsumption(value: unknown): Consumption {
  if (!isRecord(value) || !finite(value.totalKwh)) throw unreadable();
  return {
    resolution: text(value.resolution) ?? 'P1D',
    totalKwh: value.totalKwh,
    values: list(value.values).map((item) => {
      if (!isRecord(item) || !finite(item.kwh)) throw unreadable();
      return { start: timeText(item.start), end: timeText(item.end), kwh: item.kwh };
    }),
  };
}
export function parseRatedCost(value: unknown): RatedCost {
  if (!isRecord(value) || typeof value.month !== 'string' || !finite(value.daysInMonth) || !finite(value.daysWithData) || !finite(value.totalKwh))
    throw unreadable();
  return {
    month: value.month,
    complete: value.complete === true,
    daysInMonth: value.daysInMonth,
    daysWithData: value.daysWithData,
    totalKwh: value.totalKwh,
    total: amount(value.total),
    totalWithSubscriptions: amount(value.totalWithSubscriptions),
    subscriptionsComplete: value.subscriptionsComplete !== false,
  };
}
export function parseStandby(value: unknown): StandbyMonth[] {
  if (!isRecord(value)) throw unreadable();
  return list(value.months).flatMap((item) =>
    isRecord(item) && typeof item.month === 'string' && finite(item.standbyKw) ? [{ month: item.month, standbyKw: item.standbyKw }] : []);
}
export function parseLatestInvoice(value: unknown): InvoiceSummary | null {
  if (!isRecord(value)) throw unreadable();
  const [first] = list(value.invoices);
  if (first === undefined) return null;
  if (!isRecord(first) || typeof first.invoiceNo !== 'string' || typeof first.paid !== 'boolean' || !finite(first.outstanding)) throw unreadable();
  return {
    invoiceNo: first.invoiceNo,
    type: text(first.type) ?? 'invoice',
    paid: first.paid,
    invoiceDate: text(first.invoiceDate),
    dueDate: text(first.dueDate),
    total: amount(first.total),
    outstanding: first.outstanding,
  };
}
export function parseLocations(value: unknown): OsmundLocation[] {
  if (!isRecord(value)) throw unreadable();
  return list(value.locations).flatMap((item) =>
    isRecord(item) && typeof item.id === 'string'
      ? [{ id: item.id, priceArea: text(item.priceArea), state: text(item.state) ?? 'unknown', plan: text(item.plan), apiAccess: text(item.apiAccess) ?? 'closed' }]
      : []);
}

// ---- Native bridge. The key is stored and used by Rust only. ----

export const electricityAvailable = () => isTauri();
const reason = (error: unknown) =>
  new Error(typeof error === 'string' ? error : error instanceof Error ? error.message : 'Osmund could not be reached.');
function settingsFrom(value: unknown): ElectricitySettings {
  if (!isRecord(value) || typeof value.hasApiKey !== 'boolean') throw unreadable();
  return { hasApiKey: value.hasApiKey, locationId: text(value.locationId) };
}
async function call(command: string, args?: Record<string, unknown>): Promise<unknown> {
  try {
    return await invoke<unknown>(command, args);
  } catch (error) {
    throw reason(error);
  }
}
export async function getElectricitySettings(): Promise<ElectricitySettings> {
  if (!isTauri()) return { hasApiKey: false, locationId: null };
  return settingsFrom(await call('electricity_get_settings'));
}
export async function saveElectricityKey(apiKey: string): Promise<ElectricitySettings> {
  if (!isTauri()) throw new Error('Connect Osmund in the installed Hjem app.');
  return settingsFrom(await call('electricity_save_key', { apiKey }));
}
export async function setElectricityLocation(locationId: string): Promise<ElectricitySettings> {
  return settingsFrom(await call('electricity_set_location', { locationId }));
}
export async function clearElectricity(): Promise<ElectricitySettings> {
  return settingsFrom(await call('electricity_clear'));
}
export const fetchElectricity = (request: ElectricityRequest): Promise<unknown> =>
  call('electricity_fetch', { request });

// ---- Dates (Danish local time; the tablet lives in the home) ----

const pad = (value: number) => String(value).padStart(2, '0');
export const localDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const localMonth = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
export const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

// ---- Loading ----

export interface ElectricityData {
  today: PriceDay | null;
  tomorrow: PriceDay | null;
  recent: Consumption | null;
  month: RatedCost | null;
  standby: StandbyMonth[] | null;
  invoice: InvoiceSummary | null;
  /** Section errors; one failing route never hides the others. */
  errors: Partial<Record<'prices' | 'recent' | 'month' | 'standby' | 'invoice', string>>;
  loadedAt: number;
}

/** Six requests: well inside Osmund's 60 a minute and 120 an hour. */
export async function loadElectricity(now: Date, fetcher: (request: ElectricityRequest) => Promise<unknown> = fetchElectricity): Promise<ElectricityData> {
  const settle = async <T>(run: () => Promise<T>): Promise<{ value: T | null; error?: string }> => {
    try {
      return { value: await run() };
    } catch (error) {
      return { value: null, error: error instanceof Error ? error.message : 'Osmund could not answer.' };
    }
  };
  const [today, tomorrow, recent, month, standby, invoice] = await Promise.all([
    settle(async () => parsePriceDay(await fetcher({ kind: 'prices', date: localDate(now), resolution: 'PT1H' }))),
    // Tomorrow is published in the afternoon; until then this is expected to be missing.
    settle(async () => parsePriceDay(await fetcher({ kind: 'prices', date: localDate(addDays(now, 1)), resolution: 'PT1H' }))),
    settle(async () => parseConsumption(await fetcher({ kind: 'consumption', resolution: 'P1D', from: localDate(addDays(now, -14)), to: localDate(addDays(now, -1)) }))),
    settle(async () => parseRatedCost(await fetcher({ kind: 'ratedCost', month: localMonth(now) }))),
    settle(async () => parseStandby(await fetcher({ kind: 'standby' }))),
    settle(async () => parseLatestInvoice(await fetcher({ kind: 'invoices', page: 1, perPage: 1 }))),
  ]);
  const errors: ElectricityData['errors'] = {};
  if (today.error) errors.prices = today.error;
  if (recent.error) errors.recent = recent.error;
  if (month.error) errors.month = month.error;
  if (standby.error) errors.standby = standby.error;
  if (invoice.error) errors.invoice = invoice.error;
  return {
    today: today.value,
    tomorrow: tomorrow.value && tomorrow.value.intervals.length ? tomorrow.value : null,
    recent: recent.value,
    month: month.value,
    standby: standby.value,
    invoice: invoice.value,
    errors,
    loadedAt: now.getTime(),
  };
}

// ---- Reading the prices ----

export const intervalAt = (intervals: PriceInterval[], at: Date): PriceInterval | undefined =>
  intervals.find((interval) => Date.parse(interval.start) <= at.getTime() && at.getTime() < Date.parse(interval.end));

export interface PriceWindow { start: string; end: string; average: number }

/** The cheapest run of `hours` consecutive hourly intervals that has not started yet, so it is still usable. */
export function cheapestWindow(intervals: PriceInterval[], hours: number, from: Date): PriceWindow | null {
  const upcoming = intervals.filter((interval) => Date.parse(interval.start) >= from.getTime());
  let best: PriceWindow | null = null;
  for (let index = 0; index + hours <= upcoming.length; index++) {
    const run = upcoming.slice(index, index + hours);
    const first = run[0];
    const last = run[run.length - 1];
    if (!first || !last) continue;
    // Only consecutive intervals form a window.
    if (run.some((interval, offset) => offset > 0 && Date.parse(interval.start) !== Date.parse(run[offset - 1]?.end ?? ''))) continue;
    const average = run.reduce((sum, interval) => sum + interval.totalIncVat, 0) / run.length;
    if (!best || average < best.average) best = { start: first.start, end: last.end, average };
  }
  return best;
}

export type PriceLevel = 'low' | 'normal' | 'high';
/** Compare a price with the day's average, so "cheap" means cheap for today. */
export function priceLevel(price: number, intervals: PriceInterval[]): PriceLevel {
  if (!intervals.length) return 'normal';
  const average = intervals.reduce((sum, interval) => sum + interval.totalIncVat, 0) / intervals.length;
  if (price <= average * 0.85) return 'low';
  if (price >= average * 1.15) return 'high';
  return 'normal';
}

/** A simple straight-line estimate for the whole month from the rated days. */
export function monthEstimate(month: RatedCost): number | null {
  if (month.daysWithData < 3 || month.daysWithData >= month.daysInMonth) return null;
  return (month.totalWithSubscriptions.incVat / month.daysWithData) * month.daysInMonth;
}

// ---- Demo data, shaped like a Danish winter day in DK1 ----

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const isoLocal = (date: Date) => {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:00${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
};

function demoDay(day: Date, seed: number): PriceDay {
  const intervals: PriceInterval[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour + 1);
    const wave = Math.sin((hour - 3 + seed) / 24 * Math.PI * 2);
    const spot = round(0.55 + 0.25 * wave + (hour >= 7 && hour <= 9 ? 0.25 : 0) + (hour >= 17 && hour <= 20 ? 0.45 : 0) - (hour <= 4 ? 0.2 : 0));
    const tariff = hour < 6 ? 0.15 : hour >= 17 && hour < 21 ? 0.6 : 0.25;
    const components = [
      { type: 'spot', description: 'Spotpris', perKwh: spot },
      { type: 'tariff', description: 'Nettarif', perKwh: tariff },
      { type: 'tariff', description: 'Systemtarif', perKwh: 0.072 },
      { type: 'tax', description: 'Elafgift', perKwh: 0.008 },
      { type: 'supplier', description: 'Osmund', perKwh: 0.02 },
    ];
    const totalExVat = round(components.reduce((sum, component) => sum + component.perKwh, 0));
    intervals.push({ start: isoLocal(start), end: isoLocal(end), spot, totalExVat, totalIncVat: round(totalExVat * 1.25, 5), components });
  }
  return { date: localDate(day), resolution: 'PT1H', priceArea: 'DK1', complete: true, reason: null, intervals };
}

export function demoElectricity(now: Date): ElectricityData {
  const values = Array.from({ length: 14 }, (_, index) => {
    const day = addDays(now, index - 14);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    return { start: isoLocal(day), end: isoLocal(addDays(day, 1)), kwh: round(11 + (weekend ? 3.4 : 0) + Math.sin(index * 1.7) * 1.6, 1) };
  });
  const daysWithData = Math.max(0, now.getDate() - 1);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthKwh = round(daysWithData * 12.6, 1);
  const perKwh = round(monthKwh * 1.71, 2);
  const subscriptions = round(daysWithData * 3.89, 2);
  return {
    today: demoDay(now, 0),
    tomorrow: now.getHours() >= 13 ? demoDay(addDays(now, 1), 1.3) : null,
    recent: { resolution: 'P1D', totalKwh: round(values.reduce((sum, value) => sum + value.kwh, 0), 1), values },
    month: {
      month: localMonth(now),
      complete: false,
      daysInMonth,
      daysWithData,
      totalKwh: monthKwh,
      total: { exVat: round(perKwh / 1.25, 2), incVat: perKwh },
      totalWithSubscriptions: { exVat: round((perKwh + subscriptions) / 1.25, 2), incVat: round(perKwh + subscriptions, 2) },
      subscriptionsComplete: true,
    },
    standby: [
      { month: localMonth(new Date(now.getFullYear(), now.getMonth() - 2, 1)), standbyKw: 0.142 },
      { month: localMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1)), standbyKw: 0.151 },
    ],
    invoice: {
      invoiceNo: 'F1234',
      type: 'invoice',
      paid: true,
      invoiceDate: localDate(new Date(now.getFullYear(), now.getMonth(), 12)),
      dueDate: localDate(new Date(now.getFullYear(), now.getMonth(), 26)),
      total: { exVat: 662.38, incVat: 827.98 },
      outstanding: 0,
    },
    errors: {},
    loadedAt: now.getTime(),
  };
}
