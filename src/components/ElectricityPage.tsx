import { useState } from 'react';
import { ArrowDown, ArrowUp, ArrowRight, LoaderCircle, Minus, Plug, Receipt, RefreshCw, Zap } from 'lucide-react';
import { BarChart, type BarItem } from './BarChart';
import {
  cheapestWindow,
  intervalAt,
  monthEstimate,
  priceLevel,
  type PriceDay,
  type PriceInterval,
  type PriceWindow,
} from '../lib/electricity';
import type { ElectricityState } from '../lib/useElectricity';
import '../electricity.css';

interface Props {
  electricity: ElectricityState;
  now: Date;
  onOpenSettings: () => void;
}

const WINDOW_HOURS = 3;
const kr = (value: number, digits = 2) =>
  value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** Osmund's price as given, e.g. 0.97375, never rounded away. */
const exact = (value: number) =>
  value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 });
const time = (value: string | Date) =>
  new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hourTick = (value: string) => String(new Date(value).getHours()).padStart(2, '0');
const dayName = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const monthName = (value: string) => new Date(`${value}-15T12:00:00`).toLocaleDateString(undefined, { month: 'long' });

function priceTooltip(interval: PriceInterval) {
  return (
    <>
      <strong>{time(interval.start)}–{time(interval.end)}</strong>
      <span className="tooltip-value">{exact(interval.totalIncVat)} kr/kWh</span>
      <span>incl. VAT · {exact(interval.totalExVat)} kr excl. VAT</span>
      <dl>
        {interval.components.map((component) => (
          <div key={`${component.type}-${component.description}`}>
            <dt>{component.description}</dt>
            <dd>{kr(component.perKwh, 3)}</dd>
          </div>
        ))}
      </dl>
      <small>Parts in kr/kWh excl. VAT</small>
    </>
  );
}

function PriceChart({ day, now, max, cheapest }: { day: PriceDay; now: Date; max: number; cheapest: PriceWindow | null }) {
  const inWindow = (interval: PriceInterval) => !!cheapest &&
    Date.parse(interval.start) >= Date.parse(cheapest.start) && Date.parse(interval.end) <= Date.parse(cheapest.end);
  const items: BarItem[] = day.intervals.map((interval, index) => {
    const ended = Date.parse(interval.end) <= now.getTime();
    const current = Date.parse(interval.start) <= now.getTime() && !ended;
    return {
      key: interval.start,
      value: interval.totalIncVat,
      name: time(interval.start),
      label: `${time(interval.start)}–${time(interval.end)}, ${exact(interval.totalIncVat)} kr per kWh${current ? ', now' : ''}${inWindow(interval) ? ', cheapest hours' : ''}`,
      tick: index % 3 === 0 ? hourTick(interval.start) : '',
      tone: current ? 'now' : ended ? 'past' : 'normal',
      band: inWindow(interval),
      tooltip: priceTooltip(interval),
    };
  });
  return (
    <>
      <BarChart
        items={items}
        max={max}
        format={(value) => kr(value, value < 10 && value % 1 !== 0 ? 1 : 0)}
        title={`Electricity price, ${dayName(day.date)}`}
        unit="kr per kWh incl. VAT"
      >
      <div className="chart-key" aria-hidden="true">
        {day.intervals.some((interval) => intervalAt([interval], now)) && <span><i className="key-now" />Now</span>}
        {day.intervals.some(inWindow) && <span><i className="key-band" />Cheapest {WINDOW_HOURS} hours</span>}
        <span className="chart-unit">kr/kWh incl. VAT</span>
      </div>
      </BarChart>
    </>
  );
}

function LevelIcon({ level }: { level: 'low' | 'normal' | 'high' }) {
  const Icon = level === 'low' ? ArrowDown : level === 'high' ? ArrowUp : Minus;
  return <Icon size={15} aria-hidden="true" />;
}

export function ElectricityPage({ electricity, now, onOpenSettings }: Props) {
  const [day, setDay] = useState<'today' | 'tomorrow'>('today');
  const { data, source, loading, error } = electricity;

  if (source === 'setup') {
    return (
      <div className="electricity">
        <Intro />
        <section className="electricity-card electricity-setup">
          <Plug size={28} strokeWidth={1.6} />
          <h2>Connect your electricity</h2>
          <p>
            Hjem can show today’s electricity prices, the cheapest hours, and what your home uses and costs, using an
            API key from Osmund. The key stays on this tablet.
          </p>
          <button className="primary-button" onClick={onOpenSettings}>
            Connect Osmund <ArrowRight size={17} />
          </button>
        </section>
      </div>
    );
  }

  const today = data?.today ?? null;
  const tomorrow = data?.tomorrow ?? null;
  const shown = day === 'tomorrow' && tomorrow ? tomorrow : today;
  const current = today ? intervalAt(today.intervals, now) : undefined;
  const level = current && today ? priceLevel(current.totalIncVat, today.intervals) : 'normal';
  const upcoming = [...(today?.intervals ?? []), ...(tomorrow?.intervals ?? [])];
  const cheapest = cheapestWindow(upcoming, WINDOW_HOURS, now);
  const max = Math.max(0, ...upcoming.map((interval) => interval.totalIncVat));
  const month = data?.month ?? null;
  const estimate = month ? monthEstimate(month) : null;
  const recent = data?.recent ?? null;
  const standby = data?.standby ?? [];
  const latestStandby = standby[standby.length - 1];
  const previousStandby = standby[standby.length - 2];
  const invoice = data?.invoice ?? null;
  const errors = data?.errors ?? {};
  const sameDay = (value: string) => new Date(value).toDateString() === now.toDateString();

  return (
    <div className="electricity">
      <Intro
        area={today?.priceArea ?? null}
        demo={source === 'demo'}
        updated={data && source === 'live' ? new Date(data.loadedAt) : null}
        loading={loading}
        onRefresh={source === 'live' ? electricity.refresh : undefined}
      />
      {error && <p className="electricity-error" role="alert">{error}</p>}
      {!data && loading && (
        <p className="electricity-loading" role="status"><LoaderCircle size={16} className="spin" /> Getting prices from Osmund…</p>
      )}

      {data && (
        <>
          <div className="electricity-tiles">
            <section className="electricity-card electricity-tile" aria-label="Price right now">
              <span className="tile-label">Right now</span>
              {current ? (
                <>
                  <strong className="tile-value">{kr(current.totalIncVat)}<small> kr/kWh</small></strong>
                  <span className={`tile-note level-${level}`}>
                    <LevelIcon level={level} />
                    {level === 'low' ? 'Cheap for today' : level === 'high' ? 'Expensive for today' : 'About average for today'}
                  </span>
                </>
              ) : (
                <span className="tile-note">{errors.prices ?? 'Today’s prices are not ready yet.'}</span>
              )}
            </section>
            <section className="electricity-card electricity-tile" aria-label={`Cheapest ${WINDOW_HOURS} hours`}>
              <span className="tile-label">Cheapest {WINDOW_HOURS} hours</span>
              {cheapest ? (
                <>
                  <strong className="tile-value">{time(cheapest.start)}–{time(cheapest.end)}</strong>
                  <span className="tile-note">
                    {sameDay(cheapest.start) ? 'Today' : 'Tomorrow'} · {kr(cheapest.average)} kr/kWh on average
                  </span>
                </>
              ) : (
                <span className="tile-note">Not enough prices yet.</span>
              )}
            </section>
            <section className="electricity-card electricity-tile" aria-label="This month so far">
              <span className="tile-label">{month ? `${monthName(month.month)} so far` : 'This month'}</span>
              {month ? (
                <>
                  <strong className="tile-value">{kr(month.totalWithSubscriptions.incVat, 0)}<small> kr</small></strong>
                  <span className="tile-note">
                    {kr(month.totalKwh, 0)} kWh over {month.daysWithData} {month.daysWithData === 1 ? 'day' : 'days'}
                    {estimate !== null && ` · about ${kr(estimate, 0)} kr for the month`}
                  </span>
                </>
              ) : (
                <span className="tile-note">{errors.month ?? 'No cost yet this month.'}</span>
              )}
            </section>
          </div>

          <section className="electricity-card electricity-prices" aria-labelledby="prices-title">
            <div className="electricity-card-heading">
              <div>
                <h2 id="prices-title">Prices by the hour</h2>
                <p>Spot price, grid tariffs, and taxes together, incl. VAT. Tap a bar for its exact price.</p>
              </div>
              <div className="room-tabs electricity-days" role="group" aria-label="Day">
                <button className={day === 'today' ? 'active' : ''} aria-pressed={day === 'today'} onClick={() => setDay('today')}>Today</button>
                <button
                  className={day === 'tomorrow' ? 'active' : ''}
                  aria-pressed={day === 'tomorrow'}
                  disabled={!tomorrow}
                  title={tomorrow ? undefined : 'Tomorrow’s prices arrive in the afternoon.'}
                  onClick={() => setDay('tomorrow')}
                >
                  Tomorrow
                </button>
              </div>
            </div>
            {shown ? (
              <PriceChart day={shown} now={now} max={max} cheapest={cheapest} />
            ) : (
              <p className="electricity-empty">{errors.prices ?? 'Prices are not available right now.'}</p>
            )}
            {!tomorrow && <p className="electricity-footnote">Tomorrow’s prices arrive in the afternoon.</p>}
          </section>

          <div className="electricity-row">
            <section className="electricity-card" aria-labelledby="use-title">
              <div className="electricity-card-heading">
                <div>
                  <h2 id="use-title">Your use, last two weeks</h2>
                  <p>{recent && recent.values.length
                    ? `${kr(recent.totalKwh / recent.values.length, 1)} kWh a day on average. Readings arrive a day later.`
                    : 'Readings arrive a day later.'}</p>
                </div>
              </div>
              {recent && recent.values.length ? (
                <BarChart
                  items={recent.values.map((value, index) => ({
                    key: value.start,
                    value: value.kwh,
                    name: new Date(value.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
                    label: `${new Date(value.start).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}, ${kr(value.kwh, 1)} kWh`,
                    tick: index % 2 === recent.values.length % 2 ? String(new Date(value.start).getDate()) : '',
                    tooltip: (
                      <>
                        <strong>{new Date(value.start).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
                        <span className="tooltip-value">{kr(value.kwh, 1)} kWh</span>
                      </>
                    ),
                  }))}
                  max={Math.max(...recent.values.map((value) => value.kwh))}
                  format={(value) => kr(value, 0)}
                  title="Daily electricity use, last two weeks"
                  unit="kWh"
                />
              ) : (
                <p className="electricity-empty">{errors.recent ?? 'No readings for the last two weeks yet.'}</p>
              )}
            </section>

            <div className="electricity-stack">
              <section className="electricity-card electricity-tile" aria-label="Standby">
                <span className="tile-label"><Zap size={15} aria-hidden="true" /> With everything off</span>
                {latestStandby ? (
                  <>
                    <strong className="tile-value">{kr(latestStandby.standbyKw * 1000, 0)}<small> W</small></strong>
                    <span className="tile-note">
                      About {kr(latestStandby.standbyKw * 24 * 365, 0)} kWh a year, in {monthName(latestStandby.month)}
                      {previousStandby && ` · ${latestStandby.standbyKw > previousStandby.standbyKw ? 'up' : latestStandby.standbyKw < previousStandby.standbyKw ? 'down' : 'unchanged'} from ${kr(previousStandby.standbyKw * 1000, 0)} W in ${monthName(previousStandby.month)}`}
                    </span>
                  </>
                ) : (
                  <span className="tile-note">{errors.standby ?? 'Shown after the first full month.'}</span>
                )}
              </section>
              <section className="electricity-card electricity-tile" aria-label="Latest invoice">
                <span className="tile-label"><Receipt size={15} aria-hidden="true" /> Latest invoice</span>
                {invoice ? (
                  <>
                    <strong className="tile-value">{kr(invoice.total.incVat)}<small> kr</small></strong>
                    <span className="tile-note">
                      {invoice.type === 'credit_note' ? 'Credit note' : `Invoice ${invoice.invoiceNo}`}
                      {invoice.invoiceDate && ` · ${new Date(`${invoice.invoiceDate}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`}
                      {' · '}
                      {invoice.paid
                        ? 'Paid'
                        : `${kr(invoice.outstanding)} kr to pay${invoice.dueDate ? ` by ${new Date(`${invoice.dueDate}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}` : ''}`}
                    </span>
                  </>
                ) : (
                  <span className="tile-note">{errors.invoice ?? 'No invoices yet.'}</span>
                )}
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Intro({ area = null, demo = false, updated = null, loading = false, onRefresh }: {
  area?: string | null;
  demo?: boolean;
  updated?: Date | null;
  loading?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <section className="page-intro electricity-intro">
      <div>
        <span className="eyebrow date-label">ELECTRICITY{area ? ` · ${area}` : ''}{demo ? ' · SAMPLE PRICES' : ''}</span>
        <h1>Power, priced by the hour.</h1>
        <p>{demo ? 'Sample prices for the demo home. Connect Osmund in Settings to see your own.' : 'Prices and use from Osmund, updated through the day.'}</p>
      </div>
      {onRefresh ? (
        <button className="secondary-button electricity-refresh" onClick={onRefresh} disabled={loading} aria-label="Refresh electricity data">
          {loading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
          <span>{updated ? `Updated ${time(updated)}` : 'Refresh'}</span>
        </button>
      ) : (
        <Zap className="intro-icon" size={32} strokeWidth={1.3} />
      )}
    </section>
  );
}
