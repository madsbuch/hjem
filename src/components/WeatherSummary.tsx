import {
  Cloud,
  CloudFog,
  CloudHail,
  CloudLightning,
  CloudRain,
  CloudRainWind,
  CloudSnow,
  CloudSun,
  Moon,
  Sun,
  Thermometer,
  TriangleAlert,
  Wind,
} from 'lucide-react';
import type { HassSnapshot } from '../lib/home-assistant';
import { domainOf, isUnavailable } from '../lib/entities';

interface WeatherReading {
  entityId: string;
  condition: string;
  temperature: number;
  unit: string;
}

export function selectWeather(snapshot: HassSnapshot): WeatherReading | null {
  for (const entity of snapshot.entities) {
    if (domainOf(entity) !== 'weather' || isUnavailable(entity) || !entity.state.trim()) continue;
    const registration = snapshot.registry.find((item) => item.entity_id === entity.entity_id);
    if (registration?.hidden_by || registration?.disabled_by) continue;
    const temperature = entity.attributes.temperature;
    if (typeof temperature !== 'number' || !Number.isFinite(temperature)) continue;
    const reportedUnit = entity.attributes.temperature_unit;
    const unit = typeof reportedUnit === 'string' && reportedUnit.trim()
      ? reportedUnit.trim() : snapshot.unitSystem?.temperature.trim();
    if (!unit) continue;
    return { entityId: entity.entity_id, condition: entity.state, temperature, unit };
  }
  return null;
}

// Conditions use Home Assistant's weather entity state, not a forecast or clock.
const conditions: Record<string, { label: string; Icon: typeof Sun }> = {
  'clear-night': { label: 'Clear night', Icon: Moon },
  cloudy: { label: 'Cloudy', Icon: Cloud },
  fog: { label: 'Fog', Icon: CloudFog },
  hail: { label: 'Hail', Icon: CloudHail },
  lightning: { label: 'Lightning', Icon: CloudLightning },
  'lightning-rainy': { label: 'Lightning and rain', Icon: CloudLightning },
  partlycloudy: { label: 'Partly cloudy', Icon: CloudSun },
  pouring: { label: 'Heavy rain', Icon: CloudRainWind },
  rainy: { label: 'Rainy', Icon: CloudRain },
  snowy: { label: 'Snowy', Icon: CloudSnow },
  'snowy-rainy': { label: 'Snow and rain', Icon: CloudSnow },
  sunny: { label: 'Sunny', Icon: Sun },
  windy: { label: 'Windy', Icon: Wind },
  'windy-variant': { label: 'Windy and cloudy', Icon: Wind },
  exceptional: { label: 'Exceptional weather', Icon: TriangleAlert },
};

export function WeatherSummary({ weather }: { weather: WeatherReading | null }) {
  if (!weather) return null;
  const condition = Object.hasOwn(conditions, weather.condition) ? conditions[weather.condition] : undefined;
  const Icon = condition?.Icon ?? Thermometer;
  const label = condition?.label ?? weather.condition.replaceAll('_', ' ').replaceAll('-', ' ');
  return (
    <div className="weather">
      <Icon size={29} strokeWidth={1.5} aria-hidden="true" />
      <div>
        <strong>{weather.temperature}{weather.unit}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}
