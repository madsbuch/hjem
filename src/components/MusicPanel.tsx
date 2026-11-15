import { useRef } from 'react';
import { DeviceCard, type ServiceAction } from './DeviceCard';
import type { HassEntity, HassSnapshot } from '../lib/home-assistant';
import { nameOf, roomFor } from '../lib/entities';

export function MusicPanel({
  speakers,
  snapshot,
  selectedId,
  onSelect,
  onAction,
  disabled,
  pending,
}: {
  speakers: HassEntity[];
  snapshot: HassSnapshot;
  selectedId: string;
  onSelect: (entityId: string) => void;
  onAction: ServiceAction;
  disabled: boolean;
  pending: Set<string>;
}) {
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const selected =
    speakers.find((speaker) => speaker.entity_id === selectedId) || speakers[0];
  if (!selected) return null;
  const roomName = (speaker: HassEntity) =>
    snapshot.areas.find((area) => area.area_id === roomFor(speaker, snapshot))
      ?.name;
  const label = (speaker: HassEntity) => {
    const room = roomName(speaker);
    return room &&
      speakers.filter((item) => roomName(item) === room).length === 1
      ? room
      : nameOf(speaker);
  };
  const select = (index: number) => {
    const speaker = speakers[(index + speakers.length) % speakers.length];
    onSelect(speaker.entity_id);
    tabs.current.get(speaker.entity_id)?.focus();
  };

  return (
    <div className="music-player">
      <div className="speaker-tabs" role="tablist" aria-label="Speakers">
        {speakers.map((speaker, index) => (
          <button
            key={speaker.entity_id}
            ref={(node) => {
              if (node) tabs.current.set(speaker.entity_id, node);
              else tabs.current.delete(speaker.entity_id);
            }}
            id={`speaker-tab-${speaker.entity_id}`}
            role="tab"
            aria-selected={selected.entity_id === speaker.entity_id}
            aria-controls="speaker-controls"
            tabIndex={selected.entity_id === speaker.entity_id ? 0 : -1}
            title={nameOf(speaker)}
            onClick={() => onSelect(speaker.entity_id)}
            onKeyDown={(event) => {
              if (
                !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
              )
                return;
              event.preventDefault();
              select(
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? speakers.length - 1
                    : index + (event.key === 'ArrowRight' ? 1 : -1),
              );
            }}
          >
            {label(speaker)}
          </button>
        ))}
      </div>
      <div
        id="speaker-controls"
        className="speaker-panel"
        role="tabpanel"
        aria-labelledby={`speaker-tab-${selected.entity_id}`}
      >
        <DeviceCard
          key={selected.entity_id}
          entity={selected}
          room={roomName(selected) || ''}
          unit={snapshot.unitSystem?.temperature || '°C'}
          favourite={false}
          onFavourite={() => {}}
          onAction={onAction}
          disabled={disabled}
          pending={pending.has(selected.entity_id)}
          platform={
            snapshot.registry.find(
              (item) => item.entity_id === selected.entity_id,
            )?.platform
          }
          compact
        />
      </div>
    </div>
  );
}
