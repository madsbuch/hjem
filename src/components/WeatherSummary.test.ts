import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { selectWeather, WeatherSummary } from './WeatherSummary';
import type { HassEntity, HassSnapshot } from '../lib/home-assistant';

const entity = (id: string, state: string, temperature: unknown): HassEntity => ({
  entity_id: id, state, attributes: { temperature, temperature_unit: '°C' },
});
const snapshot = (entities: HassEntity[]): HassSnapshot => ({
  entities, areas: [], devices: [], registry: [], locationName: 'Home',
});

describe('weather uses reported Home Assistant readings', () => {
  it.each([undefined, null, '14', {}, NaN, Infinity, -Infinity])('does not turn malformed temperature %j into zero', (temperature) => {
    const weather = selectWeather(snapshot([entity('weather.home', 'sunny', temperature)]));
    expect(weather).toBeNull();
    expect(renderToStaticMarkup(createElement(WeatherSummary, { weather }))).toBe('');
  });

  it('skips unavailable, unknown, hidden, disabled and malformed entities for an available reading', () => {
    const home = snapshot([
      entity('weather.offline', 'unavailable', 40),
      entity('weather.unknown', 'unknown', 40),
      entity('weather.hidden', 'sunny', 40),
      entity('weather.disabled', 'sunny', 40),
      entity('weather.invalid', 'sunny', '40'),
      entity('weather.real', 'snowy', 0),
    ]);
    home.registry = [
      { entity_id: 'weather.hidden', area_id: null, device_id: null, hidden_by: 'user' },
      { entity_id: 'weather.disabled', area_id: null, device_id: null, disabled_by: 'integration' },
    ];
    expect(selectWeather(home)).toEqual({ entityId: 'weather.real', temperature: 0, condition: 'snowy', unit: '°C' });
  });

  it('requires a reported temperature unit and uses the Home Assistant unit when the entity omits it', () => {
    const reading = entity('weather.home', 'rainy', 44);
    delete reading.attributes.temperature_unit;
    const home = snapshot([reading]);
    expect(selectWeather(home)).toBeNull();
    home.unitSystem = { temperature: '°F' };
    expect(selectWeather(home)?.unit).toBe('°F');
    reading.attributes.temperature_unit = '°C';
    expect(selectWeather(home)?.unit).toBe('°C');
  });

  it.each([
    ['rainy', 'lucide-cloud-rain', 'Rainy'],
    ['clear-night', 'lucide-moon', 'Clear night'],
    ['snowy', 'lucide-cloud-snow', 'Snowy'],
    ['partlycloudy', 'lucide-cloud-sun', 'Partly cloudy'],
  ])('renders %s with its corresponding condition icon', (state, icon, label) => {
    const weather = selectWeather(snapshot([entity('weather.home', state, 14)]));
    const html = renderToStaticMarkup(createElement(WeatherSummary, { weather }));
    expect(html).toContain(icon);
    expect(html).toContain(label);
    expect(html).toContain('14°C');
    expect(html).toContain('aria-hidden="true"');
  });
});
