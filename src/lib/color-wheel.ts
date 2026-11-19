/** Geometry of the colour wheel that opens under a finger: where it sits and what a point on it means. */
export const WHEEL = 208;
const BAR = 30;
const GAP = 12;
const PAD = 14;
const HEADER = 34;
const MARGIN = 8;
/** A finger slightly off the wheel's edge still means the edge. */
const SLACK = 14;

export interface WheelOptions {
  /** The light shows colours: the wheel is drawn. */
  colour: boolean;
  /** The light moves between warm and cool white: the bar is drawn, with this range in kelvin. */
  white: [number, number] | null;
}
export interface WheelLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Centre of the wheel, relative to the panel; null without a wheel. */
  wheel: { x: number; y: number } | null;
  /** The white bar, relative to the panel; null without one. */
  bar: { x: number; y: number; width: number; height: number } | null;
}
export type WheelChoice =
  | { kind: 'colour'; hue: number; saturation: number }
  | { kind: 'white'; kelvin: number };

/** Put the wheel's centre (or the bar's, without a wheel) under the point, kept inside the screen. */
export function wheelLayout(point: { x: number; y: number }, options: WheelOptions, viewport: { width: number; height: number }): WheelLayout {
  const width = WHEEL + 2 * PAD;
  const wheelTop = PAD + HEADER + GAP;
  const barTop = wheelTop + (options.colour ? WHEEL + GAP : 0);
  const height = barTop + (options.white ? BAR : -GAP) + PAD;
  const anchor = options.colour ? wheelTop + WHEEL / 2 : barTop + BAR / 2;
  const clamp = (value: number, size: number, limit: number) => Math.max(MARGIN, Math.min(value, limit - size - MARGIN));
  return {
    left: clamp(point.x - width / 2, width, viewport.width),
    top: clamp(point.y - anchor, height, viewport.height),
    width,
    height,
    wheel: options.colour ? { x: width / 2, y: wheelTop + WHEEL / 2 } : null,
    bar: options.white ? { x: PAD, y: barTop, width: WHEEL, height: BAR } : null,
  };
}

/** What a point on the screen chooses: a colour on the wheel, a white on the bar, or nothing. */
export function wheelChoice(point: { x: number; y: number }, layout: WheelLayout, options: WheelOptions): WheelChoice | null {
  const x = point.x - layout.left;
  const y = point.y - layout.top;
  if (layout.wheel) {
    const dx = x - layout.wheel.x;
    const dy = y - layout.wheel.y;
    const radius = Math.hypot(dx, dy);
    if (radius <= WHEEL / 2 + SLACK) {
      // Red is at the top and the hues run clockwise, as the wheel is drawn.
      const hue = (Math.round(Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360;
      return { kind: 'colour', hue, saturation: Math.min(100, Math.round(radius / (WHEEL / 2) * 100)) };
    }
  }
  if (layout.bar && options.white && y >= layout.bar.y - SLACK && y <= layout.bar.y + layout.bar.height + SLACK &&
      x >= layout.bar.x - SLACK && x <= layout.bar.x + layout.bar.width + SLACK) {
    const [warmest, coolest] = options.white;
    const share = Math.max(0, Math.min(1, (x - layout.bar.x) / layout.bar.width));
    return { kind: 'white', kelvin: Math.round((warmest + share * (coolest - warmest)) / 50) * 50 };
  }
  return null;
}

/** Where a choice sits, relative to the panel, for the marker. */
export function choicePosition(choice: WheelChoice, layout: WheelLayout, options: WheelOptions): { x: number; y: number } | null {
  if (choice.kind === 'colour' && layout.wheel) {
    const angle = choice.hue * Math.PI / 180;
    const radius = choice.saturation / 100 * (WHEEL / 2);
    return { x: layout.wheel.x + Math.sin(angle) * radius, y: layout.wheel.y - Math.cos(angle) * radius };
  }
  if (choice.kind === 'white' && layout.bar && options.white) {
    const [warmest, coolest] = options.white;
    return { x: layout.bar.x + (choice.kelvin - warmest) / (coolest - warmest) * layout.bar.width, y: layout.bar.y + layout.bar.height / 2 };
  }
  return null;
}
