import { useEffect, useRef, useState } from 'react';
import {
  Lightbulb,
  Power,
  Star,
  Thermometer,
  Minus,
  Plus,
  Music2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Blinds,
  ChevronUp,
  ChevronDown,
  Square,
  Coffee,
  Fan,
  DoorClosed,
  Activity,
  Droplets,
  Zap,
  LoaderCircle,
} from 'lucide-react';
import type { HassEntity } from '../lib/home-assistant';
import {
  domainOf,
  isUnavailable,
  isActive,
  nameOf,
  supports,
  supportsBrightness,
} from '../lib/entities';

export type ServiceAction = (
  entity: HassEntity,
  service: string,
  data?: Record<string, unknown>,
) => Promise<boolean>;

interface Props {
  entity: HassEntity;
  room: string;
  unit: string;
  favourite: boolean;
  onFavourite: () => void;
  onAction: ServiceAction;
  disabled: boolean;
  pending: boolean;
  platform?: string;
  compact?: boolean;
}

export function DeviceCard({
  entity,
  room,
  unit,
  favourite,
  onFavourite,
  onAction,
  disabled,
  pending,
  platform,
  compact = false,
}: Props) {
  const domain = domainOf(entity);
  const active = isActive(entity);
  const unavailable = isUnavailable(entity);
  const locked = disabled || pending || unavailable;
  const name = nameOf(entity);
  const brightness = Math.round(
    Number(entity.attributes.brightness || 0) / 2.55,
  );
  const [level, setLevel] = useState(brightness);
  const position = Number(entity.attributes.current_position ?? 0);
  const [coverPosition, setCoverPosition] = useState(position);
  const rawVolume = Number(entity.attributes.volume_level);
  const volumeKnown =
    entity.attributes.volume_level != null && Number.isFinite(rawVolume);
  const volume = volumeKnown
    ? Math.round(Math.min(1, Math.max(0, rawVolume)) * 100)
    : 0;
  const [volumeLevel, setVolumeLevel] = useState(volume);
  const latestVolume = useRef(volume);
  latestVolume.current = volume;
  const muted = entity.attributes.is_volume_muted === true;
  const canSetVolume = supports(entity, 4);
  const canMute = supports(entity, 8);
  useEffect(() => setLevel(brightness), [brightness]);
  useEffect(() => setCoverPosition(position), [position]);
  useEffect(() => setVolumeLevel(volume), [volume]);
  const action = (service: string, data?: Record<string, unknown>) => {
    void onAction(entity, service, data).then((success) => {
      if (!success) {
        setLevel(brightness);
        setCoverPosition(position);
        setVolumeLevel(latestVolume.current);
      }
    });
  };
  const Icon =
    domain === 'light'
      ? Lightbulb
      : domain === 'climate'
        ? Thermometer
        : domain === 'media_player'
          ? Music2
          : domain === 'cover'
            ? Blinds
            : domain === 'fan'
              ? Fan
              : domain === 'binary_sensor'
                ? DoorClosed
                : domain === 'sensor'
                  ? entity.attributes.device_class === 'humidity'
                    ? Droplets
                    : entity.attributes.device_class === 'temperature'
                      ? Thermometer
                      : Activity
                  : name.toLowerCase().includes('coffee')
                    ? Coffee
                    : Zap;
  const toggleable = ['light', 'switch', 'input_boolean', 'fan'].includes(
    domain,
  );
  const temp =
    entity.attributes.temperature == null
      ? NaN
      : Number(entity.attributes.temperature);
  const canSetTemperature =
    domain === 'climate' && supports(entity, 1) && Number.isFinite(temp);
  const step = Number(
    entity.attributes.target_temp_step || (unit === '°F' ? 1 : 0.5),
  );
  const mediaCanToggle =
    entity.state === 'playing' ? supports(entity, 1) : supports(entity, 16384);
  let status = entity.state.replaceAll('_', ' ');
  if (toggleable)
    status = active
      ? domain === 'light' && supportsBrightness(entity)
        ? `On · ${brightness}%`
        : 'On'
      : 'Off';
  if (domain === 'binary_sensor')
    status = ['door', 'window', 'opening', 'garage_door'].includes(
      entity.attributes.device_class,
    )
      ? active
        ? 'Open'
        : 'Closed'
      : ['motion', 'occupancy', 'presence'].includes(
            entity.attributes.device_class,
          )
        ? active
          ? 'Detected'
          : 'Clear'
        : active
          ? 'On'
          : 'Off';
  if (domain === 'climate')
    status = entity.attributes.hvac_action
      ? String(entity.attributes.hvac_action)
      : entity.state;
  if (unavailable) status = 'Unavailable';

  return (
    <article
      className={`device-card ${domain} ${active ? 'is-active' : ''} ${unavailable ? 'is-unavailable' : ''}`}
      aria-label={name}
    >
      {!compact && (
        <>
          <div className="device-top">
            <span className="device-icon">
              {pending ? (
                <LoaderCircle size={22} className="spin" />
              ) : (
                <Icon size={22} strokeWidth={1.7} />
              )}
            </span>
            <button
              className={`icon-button favourite ${favourite ? 'saved' : ''}`}
              onClick={onFavourite}
              aria-label={`${favourite ? 'Unpin' : 'Pin'} ${name}`}
              aria-pressed={favourite}
            >
              <Star size={17} fill={favourite ? 'currentColor' : 'none'} />
            </button>
          </div>
          <div className="device-heading">
            <span className="eyebrow">{room}</span>
            <h3>{name}</h3>
          </div>
        </>
      )}
      {domain === 'climate' ? (
        <>
          <div className="temperature-display">
            {Number.isFinite(temp) ? temp : '—'}
            <span>{unit}</span>
          </div>
          <div className="climate-info">
            <span className={active ? 'heat-dot' : ''} />
            {unavailable
              ? 'Unavailable'
              : `${status.charAt(0).toUpperCase() + status.slice(1)}${entity.attributes.current_temperature != null ? ` · Currently ${entity.attributes.current_temperature}${unit}` : ''}`}
          </div>
          {canSetTemperature && (
            <div className="stepper">
              <button
                aria-label={`Lower ${name} temperature`}
                disabled={
                  locked || temp <= Number(entity.attributes.min_temp ?? 7)
                }
                onClick={() =>
                  action('set_temperature', {
                    temperature: Math.max(
                      Number(entity.attributes.min_temp ?? 7),
                      Math.round((temp - step) * 10) / 10,
                    ),
                  })
                }
              >
                <Minus size={19} />
              </button>
              <span>Set temperature</span>
              <button
                aria-label={`Raise ${name} temperature`}
                disabled={
                  locked || temp >= Number(entity.attributes.max_temp ?? 35)
                }
                onClick={() =>
                  action('set_temperature', {
                    temperature: Math.min(
                      Number(entity.attributes.max_temp ?? 35),
                      Math.round((temp + step) * 10) / 10,
                    ),
                  })
                }
              >
                <Plus size={19} />
              </button>
            </div>
          )}
        </>
      ) : domain === 'media_player' ? (
        <>
          <div
            className={`sound-wave ${entity.state === 'playing' ? 'playing' : ''}`}
            aria-hidden="true"
          >
            {Array.from({ length: 23 }, (_, i) => (
              <i
                key={i}
                style={{
                  height: `${10 + ((i * 17) % 31)}px`,
                  animationDelay: `${i * -0.13}s`,
                }}
              />
            ))}
          </div>
          <p className="track-title">
            {entity.attributes.media_title || 'Ready when you are'}
          </p>
          <p className="track-artist">
            {entity.attributes.media_artist || status}
          </p>
          {(canSetVolume || canMute) && (
            <div className="media-volume">
              <div className="volume-caption">
                <span>Volume</span>
                <span>
                  {muted ? 'Muted' : volumeKnown ? `${volumeLevel}%` : '—'}
                </span>
              </div>
              <div className="volume-row">
                {canMute && (
                  <button
                    className={`media-icon-button volume-mute ${muted ? 'muted' : ''}`}
                    disabled={locked}
                    aria-label={`${muted ? 'Unmute' : 'Mute'} ${name}`}
                    aria-pressed={muted}
                    onClick={() =>
                      action('volume_mute', { is_volume_muted: !muted })
                    }
                  >
                    {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
                  </button>
                )}
                {canSetVolume && (
                  <input
                    className="device-range volume-range"
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={volumeLevel}
                    disabled={locked}
                    aria-label={`${name} volume`}
                    aria-valuetext={`${volumeLevel}%${muted ? ', muted' : ''}`}
                    onChange={(event) =>
                      setVolumeLevel(Number(event.target.value))
                    }
                    onPointerUp={(event) =>
                      action('volume_set', {
                        volume_level: Number(event.currentTarget.value) / 100,
                      })
                    }
                    onPointerCancel={() => setVolumeLevel(latestVolume.current)}
                    onKeyUp={(event) => {
                      if (
                        [
                          'ArrowLeft',
                          'ArrowRight',
                          'ArrowUp',
                          'ArrowDown',
                          'Home',
                          'End',
                          'PageUp',
                          'PageDown',
                        ].includes(event.key)
                      ) {
                        action('volume_set', {
                          volume_level: Number(event.currentTarget.value) / 100,
                        });
                      }
                    }}
                  />
                )}
              </div>
            </div>
          )}
          <div className="media-controls">
            <div className="media-meta">
              <span className="device-status">{status}</span>
              {platform === 'sonos' && (
                <span className="platform-label">Sonos</span>
              )}
            </div>
            <div className="transport-controls">
              <button
                className="media-icon-button"
                disabled={locked || !supports(entity, 16)}
                aria-label={`Previous track on ${name}`}
                onClick={() => action('media_previous_track')}
              >
                <SkipBack size={17} fill="currentColor" />
              </button>
              <button
                className="play-button"
                disabled={locked || !mediaCanToggle}
                aria-label={`${entity.state === 'playing' ? 'Pause' : 'Play'} ${name}`}
                onClick={() => action('media_play_pause')}
              >
                {entity.state === 'playing' ? (
                  <Pause size={18} fill="currentColor" />
                ) : (
                  <Play size={18} fill="currentColor" />
                )}
              </button>
              <button
                className="media-icon-button"
                disabled={locked || !supports(entity, 32)}
                aria-label={`Next track on ${name}`}
                onClick={() => action('media_next_track')}
              >
                <SkipForward size={17} fill="currentColor" />
              </button>
            </div>
          </div>
        </>
      ) : domain === 'cover' ? (
        <>
          <div className="cover-value">
            {unavailable
              ? '—'
              : entity.attributes.current_position != null
                ? `${position}%`
                : status}
            <span>
              {entity.attributes.current_position != null ? 'open' : ''}
            </span>
          </div>
          {supports(entity, 4) && (
            <input
              className="device-range"
              type="range"
              min="0"
              max="100"
              value={coverPosition}
              disabled={locked}
              aria-label={`${name} position`}
              onChange={(e) => setCoverPosition(Number(e.target.value))}
              onPointerUp={(e) =>
                action('set_cover_position', {
                  position: Number(e.currentTarget.value),
                })
              }
              onKeyUp={(e) => {
                if (
                  [
                    'ArrowLeft',
                    'ArrowRight',
                    'ArrowUp',
                    'ArrowDown',
                    'Home',
                    'End',
                    'PageUp',
                    'PageDown',
                  ].includes(e.key)
                )
                  action('set_cover_position', {
                    position: Number(e.currentTarget.value),
                  });
              }}
            />
          )}
          <div className="cover-controls">
            <button
              disabled={locked || !supports(entity, 1)}
              onClick={() => action('open_cover')}
              aria-label={`Open ${name}`}
            >
              <ChevronUp size={20} />
            </button>
            <button
              disabled={locked || !supports(entity, 8)}
              onClick={() => action('stop_cover')}
              aria-label={`Stop ${name}`}
            >
              <Square size={13} />
            </button>
            <button
              disabled={locked || !supports(entity, 2)}
              onClick={() => action('close_cover')}
              aria-label={`Close ${name}`}
            >
              <ChevronDown size={20} />
            </button>
          </div>
        </>
      ) : toggleable ? (
        <>
          {domain === 'light' && supportsBrightness(entity) && (
            <div className="brightness-control">
              <div>
                <span>Brightness</span>
                <span>{level}%</span>
              </div>
              <input
                className="device-range"
                type="range"
                min="1"
                max="100"
                value={level || 1}
                disabled={locked || !active}
                aria-label={`${name} brightness`}
                onChange={(e) => setLevel(Number(e.target.value))}
                onPointerUp={(e) =>
                  action('turn_on', {
                    brightness_pct: Number(e.currentTarget.value),
                  })
                }
                onKeyUp={(e) => {
                  if (
                    [
                      'ArrowLeft',
                      'ArrowRight',
                      'ArrowUp',
                      'ArrowDown',
                      'Home',
                      'End',
                      'PageUp',
                      'PageDown',
                    ].includes(e.key)
                  )
                    action('turn_on', {
                      brightness_pct: Number(e.currentTarget.value),
                    });
                }}
              />
            </div>
          )}
          <div className="device-bottom">
            <span className="device-status">{status}</span>
            <button
              className={`toggle ${active ? 'on' : ''}`}
              role="switch"
              aria-checked={active}
              aria-label={`Toggle ${name}`}
              disabled={locked}
              onClick={() => action(active ? 'turn_off' : 'turn_on')}
            >
              <span>
                <Power size={12} />
              </span>
            </button>
          </div>
        </>
      ) : (
        <div className="sensor-reading">
          {domain === 'sensor' ? (
            <>
              {unavailable ? '—' : entity.state}
              <span>{entity.attributes.unit_of_measurement || ''}</span>
            </>
          ) : (
            <span className="binary-state">{status}</span>
          )}
          <p>
            {domain === 'binary_sensor' ? 'Live status' : 'Current reading'}
          </p>
        </div>
      )}
    </article>
  );
}
