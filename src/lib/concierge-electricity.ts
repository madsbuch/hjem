import type { ToolDefinition } from './concierge-agent';
import {
  cheapestHours,
  cheapestWindow,
  intervalAt,
  localDate,
  monthEstimate,
  priceLevel,
  type ElectricityData,
  type PriceDay,
  type PriceInterval,
  type PriceLevel,
} from './electricity';

/** What Concierge may read about electricity: the data the Electricity page already loaded. */
export interface ElectricityContext {
  source: 'live' | 'demo' | 'setup';
  data: ElectricityData | null;
  loading: boolean;
  error: string;
}

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

const timeHelp = 'Local time as HH:MM (the next time that clock time occurs) or YYYY-MM-DDTHH:MM.';

export const electricityTools: ToolDefinition[] = [
  tool(
    'get_electricity_prices',
    'Read the electricity price for every hour of today and, once published in the afternoon, tomorrow, plus the price right now. Prices are kr/kWh; incl_vat is what the household pays per kWh: spot price, grid tariffs, taxes, and the supplier’s charge, with VAT. Read-only.',
    { day: { type: 'string', enum: ['today', 'tomorrow', 'both'], description: 'Default both.' } },
  ),
  tool(
    'find_cheapest_hours',
    'Find the cheapest hours to use electricity, computed exactly from the published hourly prices. Use this for any “when is it cheapest” question instead of calculating yourself. together=true finds one consecutive block (dishwasher, washing machine); together=false finds the cheapest separate hours (charging that can pause). Only hours that have not started are considered. Read-only: it cannot schedule devices.',
    {
      hours: { type: 'integer', minimum: 1, maximum: 24, description: 'How many hours are needed.' },
      together: { type: 'boolean', description: 'Default true: one consecutive block.' },
      earliest: { type: 'string', description: `Earliest start. Default now. ${timeHelp}` },
      latest: { type: 'string', description: `Everything must be finished by then. Default the end of the published prices. ${timeHelp}` },
    },
    ['hours'],
  ),
  tool(
    'get_electricity_usage',
    'Read the household’s electricity use and cost from the supplier: kWh per day for the last two weeks; this month’s cost so far day by day, split into the per-kWh charges and each day’s share of fixed subscriptions, plus days not costed yet; average price per kWh; standby power; and the latest invoice. Read-only.',
    {},
  ),
];
export const electricityToolNames = new Set(electricityTools.map((definition) => definition.function.name));

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;
const pad = (value: number) => String(value).padStart(2, '0');
const clock = (value: string | Date) => {
  const date = new Date(value);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const stamp = (value: string | Date) => `${localDate(new Date(value))} ${clock(value)}`;
const levelName: Record<PriceLevel, string> = { low: 'cheap', normal: 'average', high: 'expensive' };

function partSum(interval: PriceInterval, type: string) {
  return round(interval.components.filter((component) => component.type === type).reduce((sum, component) => sum + component.perKwh, 0));
}

function describeDay(day: PriceDay) {
  const prices = day.intervals.map((interval) => interval.totalIncVat);
  const cheapest = day.intervals.reduce<PriceInterval | undefined>((best, interval) => !best || interval.totalIncVat < best.totalIncVat ? interval : best, undefined);
  const dearest = day.intervals.reduce<PriceInterval | undefined>((best, interval) => !best || interval.totalIncVat > best.totalIncVat ? interval : best, undefined);
  return {
    date: day.date,
    complete: day.complete,
    average_incl_vat: prices.length ? round(prices.reduce((sum, price) => sum + price, 0) / prices.length) : null,
    cheapest_hour: cheapest ? { start: clock(cheapest.start), incl_vat: round(cheapest.totalIncVat) } : null,
    most_expensive_hour: dearest ? { start: clock(dearest.start), incl_vat: round(dearest.totalIncVat) } : null,
    hours: day.intervals.map((interval) => ({
      start: clock(interval.start),
      end: clock(interval.end),
      incl_vat: round(interval.totalIncVat),
      excl_vat: round(interval.totalExVat),
      spot: round(interval.spot),
      tariffs: partSum(interval, 'tariff'),
      taxes: partSum(interval, 'tax'),
      supplier: partSum(interval, 'supplier'),
    })),
  };
}

/** Accept HH:MM (its next occurrence from now) or a local YYYY-MM-DDTHH:MM. */
export function parseLocalTime(value: unknown, now: Date, name: string): Date {
  if (typeof value !== 'string') throw new Error(`${name} must be a time such as 07:00.`);
  const short = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (short) {
    const hour = Number(short[1]);
    const minute = Number(short[2]);
    if (hour > 23 || minute > 59) throw new Error(`${name} must be a valid time.`);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
    return today.getTime() >= now.getTime() ? today : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, minute);
  }
  const full = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(value.trim());
  if (full) {
    const date = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4]), Number(full[5]));
    if (!Number.isNaN(date.getTime()) && localDate(date) === `${full[1]}-${full[2]}-${full[3]}`) return date;
  }
  throw new Error(`${name} must be HH:MM or YYYY-MM-DDTHH:MM in local time.`);
}

function unavailable(electricity: ElectricityContext | undefined) {
  if (!electricity || electricity.source === 'setup')
    return { available: false, message: 'Electricity data is not connected. The user can add an Osmund API key in Settings → Electricity.' };
  if (!electricity.data)
    return { available: false, message: electricity.error || (electricity.loading ? 'Electricity data is still loading. Try again in a moment.' : 'Electricity data is not available right now.') };
  return null;
}

export function runElectricityTool(name: string, args: Record<string, unknown>, electricity: ElectricityContext | undefined, now: Date): unknown {
  const missing = unavailable(electricity);
  if (missing || !electricity?.data) return missing;
  const { data } = electricity;
  const common = {
    available: true,
    sample_data: electricity.source === 'demo',
    now: stamp(now),
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    loaded_at: stamp(new Date(data.loadedAt)),
  };
  const today = data.today;
  const tomorrow = data.tomorrow;
  const intervals = [...(today?.intervals ?? []), ...(tomorrow?.intervals ?? [])];

  if (name === 'get_electricity_prices') {
    const day = args.day === undefined ? 'both' : args.day;
    if (day !== 'today' && day !== 'tomorrow' && day !== 'both') throw new Error('day must be today, tomorrow, or both.');
    const current = today ? intervalAt(today.intervals, now) : undefined;
    return {
      ...common,
      unit: 'kr/kWh',
      price_area: today?.priceArea ?? tomorrow?.priceArea ?? null,
      current: current && today
        ? { start: clock(current.start), end: clock(current.end), incl_vat: round(current.totalIncVat), excl_vat: round(current.totalExVat), compared_with_today: levelName[priceLevel(current.totalIncVat, today.intervals)] }
        : null,
      today: day !== 'tomorrow' ? (today ? describeDay(today) : { unavailable: data.errors.prices ?? 'Today’s prices are not available.' }) : undefined,
      tomorrow: day !== 'today'
        ? (tomorrow ? describeDay(tomorrow) : { unavailable: 'Tomorrow’s prices are usually published in the afternoon and are not available yet.' })
        : undefined,
    };
  }

  if (name === 'find_cheapest_hours') {
    const count = args.hours;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 24) throw new Error('hours must be a whole number from 1 to 24.');
    if (args.together !== undefined && typeof args.together !== 'boolean') throw new Error('together must be true or false.');
    const together = args.together !== false;
    const from = args.earliest === undefined ? now : parseLocalTime(args.earliest, now, 'earliest');
    const until = args.latest === undefined ? undefined : parseLocalTime(args.latest, now, 'latest');
    if (until && until.getTime() <= from.getTime()) throw new Error('latest must be after earliest.');
    const start = from.getTime() < now.getTime() ? now : from;
    const lastPublished = intervals.at(-1)?.end;
    const range = { from: stamp(start), until: until ? stamp(until) : lastPublished ? stamp(lastPublished) : null };
    const notFound = (reason: string) => ({ ...common, found: false, together, hours: count, range, reason });
    if (together) {
      const best = cheapestWindow(intervals, count, start, until);
      if (!best) return notFound(tomorrow ? 'There are not enough hours in that range.' : 'There are not enough published hours in that range. Tomorrow’s prices are usually published in the afternoon.');
      // What the same block would cost if started in the current hour, for comparison.
      const currentIndex = intervals.findIndex((interval) => intervalAt([interval], now));
      const block = currentIndex >= 0 ? intervals.slice(currentIndex, currentIndex + count) : [];
      const nowAverage = block.length === count ? block.reduce((sum, interval) => sum + interval.totalIncVat, 0) / count : null;
      return {
        ...common,
        found: true,
        together,
        hours: count,
        range,
        unit: 'kr/kWh incl. VAT',
        start: stamp(best.start),
        end: stamp(best.end),
        average_incl_vat: round(best.average),
        starting_this_hour_instead: nowAverage === null ? null : { average_incl_vat: round(nowAverage), saving_per_kwh: round(nowAverage - best.average) },
      };
    }
    const chosen = cheapestHours(intervals, count, start, until);
    if (!chosen.length) return notFound('There are not enough published hours in that range.');
    return {
      ...common,
      found: true,
      together,
      hours: count,
      range,
      unit: 'kr/kWh incl. VAT',
      chosen_hours: chosen.map((interval) => ({ start: stamp(interval.start), end: stamp(interval.end), incl_vat: round(interval.totalIncVat) })),
      average_incl_vat: round(chosen.reduce((sum, interval) => sum + interval.totalIncVat, 0) / chosen.length),
    };
  }

  if (name === 'get_electricity_usage') {
    const month = data.month;
    const recent = data.recent;
    const standby = data.standby?.at(-1);
    const invoice = data.invoice;
    const energy = month ? month.days.reduce((sum, day) => sum + day.incVat, 0) : 0;
    return {
      ...common,
      currency: 'DKK, incl. VAT',
      month_so_far: month
        ? {
          month: month.month,
          days_costed: month.daysWithData,
          days_in_month: month.daysInMonth,
          days_not_costed_yet: month.missingDays,
          kwh: round(month.totalKwh, 2),
          total_with_subscriptions: round(month.totalWithSubscriptions.incVat, 2),
          per_kwh_charges: round(month.total.incVat, 2),
          subscriptions_share: round(month.subscriptions.incVat, 2),
          subscriptions_complete: month.subscriptionsComplete,
          average_price_per_kwh_with_subscriptions: month.totalKwh > 0 ? round(month.totalWithSubscriptions.incVat / month.totalKwh) : null,
          average_price_per_kwh_charges_only: month.totalKwh > 0 ? round(month.total.incVat / month.totalKwh) : null,
          straight_line_estimate_for_month: (() => { const value = monthEstimate(month); return value === null ? null : round(value, 0); })(),
          days: month.days.map((day) => ({ date: day.date, kwh: round(day.kwh, 2), per_kwh_charges: round(day.incVat, 2), subscriptions_share: round(day.subscriptionsIncVat, 2), total: round(day.totalIncVat, 2) })),
          days_sum_of_per_kwh_charges: round(energy, 2),
          note: 'Matches the supplier’s app. Fees such as payment fees appear on the invoice only.',
        }
        : { unavailable: data.errors.month ?? 'No cost this month yet.' },
      last_two_weeks: recent
        ? {
          total_kwh: round(recent.totalKwh, 2),
          average_kwh_per_day: recent.values.length ? round(recent.totalKwh / recent.values.length, 2) : null,
          days: recent.values.map((value) => ({ date: localDate(new Date(value.start)), kwh: round(value.kwh, 2) })),
          note: 'Meter readings arrive about a day later.',
        }
        : { unavailable: data.errors.recent ?? 'No readings yet.' },
      standby: standby
        ? { month: standby.month, watts: round(standby.standbyKw * 1000, 0), kwh_per_year: round(standby.standbyKw * 24 * 365, 0) }
        : { unavailable: data.errors.standby ?? 'Shown after the first full month.' },
      latest_invoice: invoice
        ? { number: invoice.invoiceNo, type: invoice.type, date: invoice.invoiceDate, due: invoice.dueDate, total: round(invoice.total.incVat, 2), paid: invoice.paid, outstanding: round(invoice.outstanding, 2) }
        : { unavailable: data.errors.invoice ?? 'No invoices yet.' },
    };
  }
  throw new Error('This tool is not available.');
}
