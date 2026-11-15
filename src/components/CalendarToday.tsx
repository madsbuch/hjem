import { useEffect, useLayoutEffect, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import type { useCalendar } from '../lib/useCalendar';
import type { HassSnapshot } from '../lib/home-assistant';
import { calendarDate, calendarPosition } from '../lib/calendar';

const time = (value: string | Date) =>
  (typeof value === 'string' ? calendarDate(value) : value).toLocaleTimeString(
    undefined,
    { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  );

export function CalendarToday({
  calendar,
  snapshot,
  now,
}: {
  calendar: ReturnType<typeof useCalendar>;
  snapshot: HassSnapshot;
  now: Date;
}) {
  const allDay = calendar.events.filter((event) => event.allDay);
  const timed = calendarPosition(calendar.events, calendar.day);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const scrollArea = useRef<HTMLDivElement>(null);
  const currentTime = useRef<HTMLDivElement>(null);
  const pointerHeld = useRef(false);
  const returning = useRef(false);
  const returnTimer = useRef<number | undefined>(undefined);
  const settleTimer = useRef<number | undefined>(undefined);
  const anchorNow = (smooth: boolean) => {
    const area = scrollArea.current;
    const marker = currentTime.current;
    if (!area || !marker) return;
    window.clearTimeout(settleTimer.current);
    returning.current = true;
    const top =
      area.scrollTop +
      marker.getBoundingClientRect().top +
      marker.clientHeight / 2 -
      area.getBoundingClientRect().top -
      area.clientHeight / 2;
    const animate =
      smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    area.scrollTo({ top, behavior: animate ? 'smooth' : 'auto' });
    settleTimer.current = window.setTimeout(
      () => {
        returning.current = false;
      },
      animate ? 600 : 80,
    );
  };
  const release = () => {
    pointerHeld.current = false;
    window.clearTimeout(returnTimer.current);
    returnTimer.current = window.setTimeout(() => {
      returnTimer.current = undefined;
      anchorNow(true);
    }, 900);
  };
  const hold = () => {
    pointerHeld.current = true;
    returning.current = false;
    window.clearTimeout(returnTimer.current);
    returnTimer.current = undefined;
    window.clearTimeout(settleTimer.current);
    // Stop an in-progress return as soon as another peek begins.
    const area = scrollArea.current;
    area?.scrollTo({ top: area.scrollTop, behavior: 'auto' });
  };
  useLayoutEffect(() => {
    if (!pointerHeld.current && returnTimer.current === undefined)
      anchorNow(false);
  }, [
    nowMinutes,
    calendar.day.date,
    allDay.length,
    calendar.error,
    calendar.loading,
  ]);
  useEffect(
    () => () => {
      window.clearTimeout(returnTimer.current);
      window.clearTimeout(settleTimer.current);
    },
    [],
  );

  return (
    <section className="today-calendar" aria-label="Today’s calendar">
      <div className="section-heading">
        <h2>Today’s calendar</h2>
        <div className="calendar-heading-actions">
          {calendar.demo && (
            <span className="calendar-sample">Sample events</span>
          )}
          {!calendar.demo && calendar.calendarCount > 0 && (
            <button
              className="icon-button calendar-refresh"
              onClick={calendar.refresh}
              disabled={calendar.loading}
              aria-label="Refresh calendar"
            >
              <RefreshCw size={16} className={calendar.loading ? 'spin' : ''} />
            </button>
          )}
        </div>
      </div>
      <div className="calendar-agenda" aria-busy={calendar.loading}>
        {calendar.error && (
          <p className="calendar-error" role="alert">
            {calendar.error}
          </p>
        )}
        {calendar.loading && !calendar.events.length && (
          <p className="calendar-empty">Loading today’s events…</p>
        )}
        {!calendar.loading && !calendar.events.length && !calendar.error && (
          <p className="calendar-empty">
            {calendar.calendarCount
              ? 'Nothing scheduled today'
              : 'Add a calendar in Home Assistant to see today’s events here.'}
          </p>
        )}
        {allDay.length > 0 && (
          <div className="calendar-all-day">
            <span>All day</span>
            <ul>
              {allDay.map((event) => (
                <li key={event.id}>{event.summary}</li>
              ))}
            </ul>
          </div>
        )}
        <div
          ref={scrollArea}
          className="calendar-scroll"
          tabIndex={0}
          role="region"
          aria-label="Scroll the day to peek; returns to now after release"
          onPointerDown={hold}
          onPointerUp={release}
          onPointerCancel={release}
          onPointerLeave={() => {
            if (pointerHeld.current) release();
          }}
          onKeyDown={(event) => {
            if (
              [
                'ArrowUp',
                'ArrowDown',
                'PageUp',
                'PageDown',
                'Home',
                'End',
                ' ',
              ].includes(event.key)
            )
              hold();
          }}
          onKeyUp={(event) => {
            if (
              [
                'ArrowUp',
                'ArrowDown',
                'PageUp',
                'PageDown',
                'Home',
                'End',
                ' ',
              ].includes(event.key)
            )
              release();
          }}
          onScroll={() => {
            if (!returning.current && !pointerHeld.current) release();
          }}
        >
          <div className="calendar-timeline-padding">
            <div className="calendar-timeline" aria-label="24-hour timeline">
              {Array.from({ length: 25 }, (_, hour) => (
                <div
                  className="calendar-hour"
                  key={hour}
                  style={{ top: `${(hour / 24) * 100}%` }}
                  aria-hidden="true"
                >
                  <span>{hour.toString().padStart(2, '0')}:00</span>
                  <i />
                </div>
              ))}
              <div className="calendar-timed-events">
                {timed.map(({ event, start, end, lane, columns }) => {
                  const calendarName = snapshot.entities.find(
                    (entity) => entity.entity_id === event.entityId,
                  )?.attributes.friendly_name;
                  const ended =
                    calendarDate(event.end).getTime() <= now.getTime();
                  const detail = [
                    time(event.start) + ' – ' + time(event.end),
                    calendarName,
                    event.location,
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <article
                      key={event.id}
                      className={`calendar-time-block ${ended ? 'past-event' : ''} ${end - start < 90 ? 'short-event' : ''}`}
                      aria-label={`${event.summary}, ${detail}`}
                      title={`${event.summary}\n${detail}`}
                      style={{
                        top: `${(start / 1440) * 100}%`,
                        height: `${((end - start) / 1440) * 100}%`,
                        left: `${(lane / columns) * 100}%`,
                        width: `calc(${100 / columns}% - 5px)`,
                      }}
                    >
                      <h3>{event.summary}</h3>
                      <p>
                        {time(event.start)} – {time(event.end)}
                        {event.location && (
                          <>
                            {' '}
                            · <span>{event.location}</span>
                          </>
                        )}
                      </p>
                    </article>
                  );
                })}
              </div>
              <div
                ref={currentTime}
                className="calendar-now"
                style={{ top: `${(nowMinutes / 1440) * 100}%` }}
                role="img"
                aria-label={`Now, ${time(now)}`}
              >
                <span>{time(now)}</span>
                <i />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
