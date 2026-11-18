import { invoke } from '@tauri-apps/api/core';
import { MAX_CONFIGURATION_BYTES } from './home-configuration';

/**
 * Save a configuration file. On Android the person chooses where (Downloads,
 * a cloud drive, …) through the system picker; elsewhere the browser downloads it.
 * Resolves to false when the person cancels.
 */
export async function saveConfigurationFile(fileName: string, text: string, native: boolean): Promise<boolean> {
  if (native) {
    const saved = await invoke<unknown>('plugin:launcher|save_document', { fileName, text });
    if (typeof saved !== 'boolean') throw new Error('Android returned an unreadable result.');
    return saved;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Give the browser a moment to start the download before releasing the data.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return true;
}

/** Let the person pick a configuration file. Resolves to null when cancelled. */
export async function openConfigurationFile(native: boolean): Promise<string | null> {
  if (native) {
    const text = await invoke<unknown>('plugin:launcher|open_document');
    if (text !== null && typeof text !== 'string') throw new Error('Android returned an unreadable file.');
    return text;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  const file = await new Promise<File | null>((resolve) => {
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
  if (!file) return null;
  if (file.size > MAX_CONFIGURATION_BYTES) throw new Error('This file is too large to be a Hjem configuration.');
  return file.text();
}
