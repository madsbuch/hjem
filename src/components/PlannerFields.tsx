import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { HassArea } from '../lib/home-assistant';

/** Edit in place: Enter or leaving the field saves, Escape cancels. */
export function NameField({ value, label, disabled, onSave }: {
  value: string;
  label: string;
  disabled: boolean;
  onSave: (name: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  const commit = async () => {
    setEditing(false);
    const next = draft.trim();
    if (cancelled.current || !next || next === value) {
      cancelled.current = false;
      setDraft(value);
      return;
    }
    if (!(await onSave(next))) setDraft(value);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') {
      cancelled.current = true;
      event.currentTarget.blur();
    }
  };
  return (
    <input
      className="planner-name"
      value={draft}
      aria-label={label}
      maxLength={80}
      autoComplete="off"
      spellCheck={false}
      disabled={disabled}
      onFocus={() => setEditing(true)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={keyDown}
    />
  );
}

export function RoomSelect({ value, label, areas, disabled, onChange }: {
  value: string | null;
  label: string;
  areas: HassArea[];
  disabled: boolean;
  onChange: (areaId: string | null) => void;
}) {
  return (
    <select
      className={`planner-room ${value ? '' : 'needs-room'}`}
      aria-label={label}
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">No room yet</option>
      {areas.map((area) => (
        <option key={area.area_id} value={area.area_id}>{area.name}</option>
      ))}
    </select>
  );
}
