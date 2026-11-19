import { describe, expect, it } from 'vitest';
import { WHEEL, choicePosition, wheelChoice, wheelLayout, type WheelOptions } from './color-wheel';

const both: WheelOptions = { colour: true, white: [2200, 6500] };
const screen = { width: 1280, height: 800 };
const at = (layout: ReturnType<typeof wheelLayout>, dx: number, dy: number) => {
  if (!layout.wheel) throw new Error('No wheel');
  return { x: layout.left + layout.wheel.x + dx, y: layout.top + layout.wheel.y + dy };
};

describe('the colour wheel', () => {
  it('opens with its centre under the finger, and stays on the screen near an edge', () => {
    const middle = wheelLayout({ x: 600, y: 400 }, both, screen);
    expect(at(middle, 0, 0)).toEqual({ x: 600, y: 400 });
    const corner = wheelLayout({ x: 1270, y: 790 }, both, screen);
    expect(corner.left + corner.width).toBeLessThanOrEqual(screen.width - 8);
    expect(corner.top + corner.height).toBeLessThanOrEqual(screen.height - 8);
    const top = wheelLayout({ x: 5, y: 5 }, both, { width: 390, height: 844 });
    expect([top.left, top.top]).toEqual([8, 8]);
  });

  it('reads hue from the direction and saturation from the distance', () => {
    const layout = wheelLayout({ x: 600, y: 400 }, both, screen);
    const half = WHEEL / 2;
    expect(wheelChoice(at(layout, 0, -half), layout, both)).toEqual({ kind: 'colour', hue: 0, saturation: 100 });
    expect(wheelChoice(at(layout, half, 0), layout, both)).toEqual({ kind: 'colour', hue: 90, saturation: 100 });
    expect(wheelChoice(at(layout, 0, half / 2), layout, both)).toEqual({ kind: 'colour', hue: 180, saturation: 50 });
    expect(wheelChoice(at(layout, -half, 0), layout, both)).toEqual({ kind: 'colour', hue: 270, saturation: 100 });
    expect(wheelChoice(at(layout, 0, 0), layout, both)).toMatchObject({ kind: 'colour', saturation: 0 });
    // Just past the rim still means the rim; well outside means nothing.
    expect(wheelChoice(at(layout, half + 10, 0), layout, both)).toEqual({ kind: 'colour', hue: 90, saturation: 100 });
    expect(wheelChoice(at(layout, half + 60, -half), layout, both)).toBeNull();
  });

  it('reads a white from along the bar, within the light’s range', () => {
    const layout = wheelLayout({ x: 600, y: 400 }, both, screen);
    const bar = layout.bar;
    if (!bar) throw new Error('No bar');
    const on = (share: number) => ({ x: layout.left + bar.x + share * bar.width, y: layout.top + bar.y + bar.height / 2 });
    expect(wheelChoice(on(0), layout, both)).toEqual({ kind: 'white', kelvin: 2200 });
    expect(wheelChoice(on(1), layout, both)).toEqual({ kind: 'white', kelvin: 6500 });
    expect(wheelChoice(on(0.5), layout, both)).toEqual({ kind: 'white', kelvin: 4350 });
    expect(wheelChoice({ x: on(0).x - 5, y: on(0).y }, layout, both)).toEqual({ kind: 'white', kelvin: 2200 });
  });

  it('draws only what the light has', () => {
    const whiteOnly: WheelOptions = { colour: false, white: [2200, 4000] };
    const layout = wheelLayout({ x: 600, y: 400 }, whiteOnly, screen);
    expect(layout.wheel).toBeNull();
    expect(layout.height).toBeLessThan(120);
    // The bar is under the finger instead.
    expect(wheelChoice({ x: 600, y: 400 }, layout, whiteOnly)).toEqual({ kind: 'white', kelvin: 3100 });
    const colourOnly: WheelOptions = { colour: true, white: null };
    const wheel = wheelLayout({ x: 600, y: 400 }, colourOnly, screen);
    expect(wheel.bar).toBeNull();
    expect(wheelChoice({ x: 600, y: 400 + WHEEL }, wheel, colourOnly)).toBeNull();
  });

  it('puts the marker where the choice is', () => {
    const layout = wheelLayout({ x: 600, y: 400 }, both, screen);
    for (const point of [at(layout, 40, -60), at(layout, -70, 20)]) {
      const choice = wheelChoice(point, layout, both);
      if (!choice) throw new Error('No choice');
      const marker = choicePosition(choice, layout, both);
      expect(Math.abs((marker?.x ?? 0) + layout.left - point.x)).toBeLessThan(2);
      expect(Math.abs((marker?.y ?? 0) + layout.top - point.y)).toBeLessThan(2);
    }
  });
});
