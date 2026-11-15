import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  const appliedTheme = useRef<'light' | 'dark' | null>(null);
  const animationTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener('change', onChange);
    // Catch a system change between the initial render and subscription.
    onChange();
    return () => media.removeEventListener('change', onChange);
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const changed =
      appliedTheme.current !== null && appliedTheme.current !== resolvedTheme;
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    window.clearTimeout(animationTimer.current);

    if (changed && !reducedMotion) {
      // CSS retargets an in-progress fade from its current colours, so rapid
      // changes do not queue animations or briefly restore an older theme.
      root.classList.add('theme-changing');
      animationTimer.current = window.setTimeout(() => {
        root.classList.remove('theme-changing');
        animationTimer.current = undefined;
      }, 900); // Allow the 800 ms CSS fade to finish before restoring hover transitions.
    } else {
      root.classList.remove('theme-changing');
      animationTimer.current = undefined;
    }

    root.dataset.theme = resolvedTheme;
    appliedTheme.current = resolvedTheme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        'content',
        resolvedTheme === 'dark' ? '#181d23' : '#21354c',
      );
  }, [resolvedTheme]);

  useEffect(
    () => () => {
      window.clearTimeout(animationTimer.current);
      document.documentElement.classList.remove('theme-changing');
    },
    [],
  );

  const setTheme = (next: Theme) => {
    setPreference(next);
    savePreference('hjem.theme', next);
  };
  return { theme, resolvedTheme, setTheme };
}
