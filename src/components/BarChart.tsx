import { useId, useState, type ReactNode } from 'react';

export interface BarItem {
  key: string;
  value: number;
  /** The row heading in the table view, e.g. "17:00". */
  name: string;
  /** Read aloud for the column, e.g. "17:00–18:00, 2.31 kr per kWh". */
  label: string;
  /** Shown under the column; leave empty to skip a tick. */
  tick?: string;
  tone?: 'past' | 'normal' | 'now';
  /** Part of a highlighted band, such as the cheapest hours. */
  band?: boolean;
  tooltip: ReactNode;
}

interface Props {
  items: BarItem[];
  /** The value at the top of the scale; shared across days so they compare. */
  max: number;
  /** Formats axis ticks. */
  format: (value: number) => string;
  title: string;
  unit: string;
  /** A key or note shown directly under the plot. */
  children?: ReactNode;
}

/** Up to five clean ticks, e.g. 0, 0.5, 1, 1.5, 2. */
function ticks(max: number): number[] {
  if (!(max > 0)) return [0];
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? rough;
  // Always end at or above the largest value, so no bar is cut off.
  const count = Math.max(1, Math.ceil(max / step - 1e-9));
  return Array.from({ length: count + 1 }, (_, index) => Math.round(index * step * 1000) / 1000);
}

/**
 * A single-series column chart in plain HTML: columns grow from one baseline,
 * and each column is a focusable hit target. Tapping, hovering, or focusing a
 * column shows its exact value; tapping elsewhere hides it.
 */
export function BarChart({ items, max, format, title, unit, children }: Props) {
  const [active, setActive] = useState<string | null>(null);
  const id = useId();
  const scale = ticks(max);
  const top = scale[scale.length - 1] ?? max;
  const activeIndex = items.findIndex((item) => item.key === active);
  const activeItem = items[activeIndex];
  return (
    <figure className="bar-chart" aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`} className="visually-hidden">{title}, in {unit}</figcaption>
      {/* Hover only follows a real mouse; touch devices send compatibility mouse events that would close a tapped tooltip. */}
      <div className="bar-chart-plot" onPointerLeave={(event) => { if (event.pointerType === 'mouse') setActive(null); }}>
        <div className="bar-chart-grid" aria-hidden="true">
          {scale.map((value) => (
            <span key={value} style={{ bottom: `${(value / top) * 100}%` }}>
              <i>{format(value)}</i>
            </span>
          ))}
        </div>
        <div className="bar-chart-columns" role="list">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="listitem"
              className={`bar-chart-column ${item.tone ?? 'normal'} ${item.band ? 'band' : ''} ${active === item.key ? 'active' : ''}`}
              aria-label={item.label}
              onPointerEnter={(event) => { if (event.pointerType === 'mouse') setActive(item.key); }}
              onFocus={() => setActive(item.key)}
              onBlur={() => setActive((current) => current === item.key ? null : current)}
              // A tap focuses and then clicks; both must leave the column selected.
              onClick={() => setActive(item.key)}
            >
              <span className="bar-chart-bar" style={{ height: `${Math.max(0, Math.min(1, item.value / top)) * 100}%` }} />
              <span className="bar-chart-tick" aria-hidden="true">{item.tick ?? ''}</span>
            </button>
          ))}
        </div>
        {activeItem && (
          <div
            className={`bar-chart-tooltip ${activeIndex > items.length / 2 ? 'left' : 'right'}`}
            style={{ [activeIndex > items.length / 2 ? 'right' : 'left']: `${activeIndex > items.length / 2 ? ((items.length - activeIndex - 1) / items.length) * 100 : ((activeIndex + 1) / items.length) * 100}%` }}
            role="status"
          >
            {activeItem.tooltip}
          </div>
        )}
      </div>
      {children}
    </figure>
  );
}
