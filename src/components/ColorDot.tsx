import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { HassEntity } from '../lib/home-assistant';
import { colorName, colorOf, hsToRgb, kelvinToCss, lightColorCss, numberAttribute, supportsColor, supportsColorTemperature, whiteRange } from '../lib/entities';
import { choicePosition, wheelChoice, wheelLayout, type WheelChoice, type WheelLayout, type WheelOptions } from '../lib/color-wheel';

interface Props {
  entity: HassEntity;
  name: string;
  on: boolean;
  disabled: boolean;
  onAction: (entity: HassEntity, service: string, data?: Record<string, unknown>) => Promise<boolean>;
}

/** A press must travel this far before letting go chooses anything, so a plain tap changes nothing. */
const MOVE = 10;
const css = (choice: WheelChoice) => {
  if (choice.kind === 'white') return kelvinToCss(choice.kelvin);
  const [r, g, b] = hsToRgb(choice.hue, choice.saturation);
  return `rgb(${r}, ${g}, ${b})`;
};
const label = (choice: WheelChoice) => choice.kind === 'white'
  ? `${choice.kelvin < 3300 ? 'Warm' : choice.kelvin < 5000 ? 'Neutral' : 'Cool'} white`
  : colorName(choice.hue, choice.saturation);

/**
 * A light's colour dot. Press and hold to open the colour wheel under your
 * finger, slide to a colour or a white, and let go to set it; the wheel is
 * only there while you hold. With a keyboard, Enter opens it, the arrow keys
 * move around the wheel, Page Up and Page Down move along the whites, Enter
 * sets it and Escape leaves it.
 */
export function ColorDot({ entity, name, on, disabled, onAction }: Props) {
  const options: WheelOptions = {
    colour: supportsColor(entity),
    white: supportsColorTemperature(entity) ? whiteRange(entity) : null,
  };
  const [layout, setLayout] = useState<WheelLayout | null>(null);
  const [choice, setChoice] = useState<WheelChoice | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const current = on ? colorOf(entity) : null;
  const shown = current ? colorName(current[0], current[1]) : 'White';

  const close = () => {
    setLayout(null);
    setChoice(null);
    start.current = null;
    moved.current = false;
  };
  // A wheel left open by a lost pointer or a scroll would sit over the page.
  useEffect(() => {
    if (!layout) return;
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [layout]);

  const apply = (picked: WheelChoice) => {
    void onAction(entity, 'turn_on', picked.kind === 'white'
      ? { color_temp_kelvin: picked.kelvin }
      : { hs_color: [picked.hue, picked.saturation] });
  };
  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

  const down = (event: PointerEvent<HTMLButtonElement>) => {
    if (disabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    start.current = { x: event.clientX, y: event.clientY };
    moved.current = false;
    setLayout(wheelLayout(start.current, options, viewport()));
    setChoice(null);
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    if (!layout || !start.current) return;
    const point = { x: event.clientX, y: event.clientY };
    if (!moved.current && Math.hypot(point.x - start.current.x, point.y - start.current.y) < MOVE) return;
    moved.current = true;
    setChoice(wheelChoice(point, layout, options));
  };
  const up = () => {
    if (start.current && moved.current && choice) apply(choice);
    if (start.current) close();
  };

  const key = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!layout) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      setLayout(wheelLayout({ x: box.left + box.width / 2, y: box.top + box.height / 2 }, options, viewport()));
      setChoice(current && options.colour
        ? { kind: 'colour', hue: Math.round(current[0]), saturation: Math.round(current[1]) }
        : options.white ? { kind: 'white', kelvin: Math.max(options.white[0], Math.min(options.white[1], numberAttribute(entity, 'color_temp_kelvin', 2700))) }
          : { kind: 'colour', hue: 0, saturation: 100 });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (choice) apply(choice);
      close();
    } else if (options.colour && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const from = choice?.kind === 'colour' ? choice : { hue: 0, saturation: 100 };
      const turn = event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0;
      const reach = event.key === 'ArrowUp' ? 10 : event.key === 'ArrowDown' ? -10 : 0;
      setChoice({ kind: 'colour', hue: (from.hue + turn + 360) % 360, saturation: Math.max(0, Math.min(100, from.saturation + reach)) });
    } else if (options.white && (event.key === 'PageUp' || event.key === 'PageDown')) {
      event.preventDefault();
      const [warmest, coolest] = options.white;
      const from = choice?.kind === 'white' ? choice.kelvin : numberAttribute(entity, 'color_temp_kelvin', 2700);
      setChoice({ kind: 'white', kelvin: Math.max(warmest, Math.min(coolest, from + (event.key === 'PageUp' ? 250 : -250))) });
    }
  };

  const marker = layout && choice ? choicePosition(choice, layout, options) : null;
  return (
    <>
      <button
        className="controls-color"
        aria-expanded={!!layout}
        aria-label={`${name} colour${on ? `, ${shown.toLowerCase()}` : ''}. Hold and slide to change.`}
        disabled={disabled}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={close}
        onKeyDown={key}
        onBlur={() => { if (!start.current) close(); }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <i aria-hidden="true" style={choice ? { background: css(choice) } : on ? { background: lightColorCss(entity) } : undefined} />
      </button>
      {layout && createPortal(
        <div className="color-wheel" style={{ left: layout.left, top: layout.top, width: layout.width, height: layout.height }}>
          <p className="color-wheel-choice" role="status">
            <i aria-hidden="true" style={choice ? { background: css(choice) } : undefined} />
            {choice ? label(choice) : 'Slide to a colour'}
          </p>
          {layout.wheel && <div className="color-wheel-disc" aria-hidden="true" style={{ left: layout.wheel.x, top: layout.wheel.y }} />}
          {layout.bar && options.white && (
            <div
              className="color-wheel-white"
              aria-hidden="true"
              style={{
                left: layout.bar.x, top: layout.bar.y, width: layout.bar.width, height: layout.bar.height,
                background: `linear-gradient(to right, ${kelvinToCss(options.white[0])}, ${kelvinToCss(options.white[1])})`,
              }}
            />
          )}
          {marker && <span className="color-wheel-marker" aria-hidden="true" style={{ left: marker.x, top: marker.y, background: choice ? css(choice) : undefined }} />}
        </div>,
        document.body,
      )}
    </>
  );
}
