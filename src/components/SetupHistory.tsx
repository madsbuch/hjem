import { RotateCcw } from 'lucide-react';
import type { SetupChange } from '../lib/home-setup-types';

interface Props {
  changes: SetupChange[];
  demo: boolean;
  disabled: boolean;
  onUndo: (id: string) => void;
}

export function SetupHistory({ changes, demo, disabled, onUndo }: Props) {
  if (!changes.length) return null;
  return (
    <details className="setup-history">
      <summary>Recent setup changes <span>{changes.length}</span></summary>
      <p>{demo ? 'These changes are simulated in your demo home.' : 'Changes are saved in Home Assistant.'} You can undo them here while this home stays open.</p>
      <ul>
        {changes.map((change) => (
          <li key={change.id}>
            <span>{change.description}</span>
            <button
              className="setup-link"
              disabled={disabled}
              onClick={() => onUndo(change.id)}
              aria-label={`Undo ${change.description}`}
            >
              <RotateCcw size={15} /> Undo
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
