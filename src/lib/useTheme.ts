import { useEffect, useLayoutEffect, useState } from 'react';
import { readPreference, savePreference } from './entities';

export type Theme = 'system' | 'light' | 'dark';

export function useTheme() {
  const [theme, setPreference] = useState<Theme>(() => {
    const saved = readPreference<string>('hjem.theme', 'system');
    return saved === 'dark' || saved === 'light' ? saved : 'system';
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const resolvedTheme =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        'content',
        resolvedTheme === 'dark' ? '#18231d' : '#214c40',
      );
  }, [resolvedTheme]);
  const setTheme = (next: Theme) => {
    setPreference(next);
    savePreference('hjem.theme', next);
  };
  return { theme, resolvedTheme, setTheme };
}
