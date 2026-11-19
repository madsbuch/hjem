import { describe, expect, it } from 'vitest';
import { demoSnapshot } from './demo';
import { colorName, colorOf, hsToRgb, kelvinToCss, lightColorCss, supportsColor, supportsColorTemperature, whiteRange } from './entities';

const light = (id: string) => {
  const entity = demoSnapshot.entities.find((item) => item.entity_id === id);
  if (!entity) throw new Error('Missing demo light');
  return entity;
};

describe('light colour', () => {
  it('tells colour lights, white-only lights, and plain lights apart', () => {
    expect([supportsColor(light('light.kitchen')), supportsColorTemperature(light('light.kitchen'))]).toEqual([true, true]);
    expect([supportsColor(light('light.reading_lamp')), supportsColorTemperature(light('light.reading_lamp'))]).toEqual([false, true]);
    expect([supportsColor(light('light.living_pendant')), supportsColorTemperature(light('light.living_pendant'))]).toEqual([false, false]);
    // IKEA colour bulbs report xy through ZHA.
    expect(supportsColor({ entity_id: 'light.ikea', state: 'on', attributes: { supported_color_modes: ['color_temp', 'xy'] } })).toBe(true);
    expect(whiteRange(light('light.reading_lamp'))).toEqual([2200, 6500]);
    expect(whiteRange({ entity_id: 'light.x', state: 'on', attributes: { min_color_temp_kelvin: 4000, max_color_temp_kelvin: 4000 } })).toEqual([2200, 6500]);
  });

  it('converts hue and saturation to a screen colour', () => {
    expect(hsToRgb(0, 100)).toEqual([255, 0, 0]);
    expect(hsToRgb(120, 100)).toEqual([0, 255, 0]);
    expect(hsToRgb(225, 100)).toEqual([0, 64, 255]);
    expect(hsToRgb(360, 100)).toEqual([255, 0, 0]);
    expect(hsToRgb(200, 0)).toEqual([255, 255, 255]);
    expect(kelvinToCss(2000)).toBe('rgb(255, 176, 92)');
    expect(kelvinToCss(6500)).toBe('rgb(214, 228, 255)');
  });

  it('shows what a light is showing: a colour, or its white', () => {
    const coloured = { entity_id: 'light.a', state: 'on', attributes: { color_mode: 'hs', hs_color: [120, 100], color_temp_kelvin: 2700 } };
    const white = { entity_id: 'light.a', state: 'on', attributes: { color_mode: 'color_temp', hs_color: [28, 60], color_temp_kelvin: 6500 } };
    expect(colorOf(coloured)).toEqual([120, 100]);
    expect(lightColorCss(coloured)).toBe('rgb(0, 255, 0)');
    // In white mode Home Assistant still reports a hue; it is the white that counts.
    expect(colorOf(white)).toBeNull();
    expect(lightColorCss(white)).toBe('rgb(214, 228, 255)');
  });

  it('names a colour as a person would', () => {
    expect(colorName(2, 95)).toBe('Red');
    expect(colorName(355, 95)).toBe('Red');
    expect(colorName(230, 80)).toBe('Blue');
    expect(colorName(180, 90)).toBe('Turquoise');
    expect(colorName(40, 8)).toBe('White');
  });
});
