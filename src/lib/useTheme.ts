import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { saveTheme, useStorage } from './storage';
export type { Theme } from './storage';

export function useTheme() {
  const { theme } = useStorage();
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const resolvedTheme =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  const appliedTheme = useRef<'light' | 'dark' | null>(null);
  const animationTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () =>
      setSystemDark(window.matchMedia('(prefers-color-scheme: dark)').matches);
    const onVisible = () => {
      if (document.visibilityState === 'visible') onChange();
    };
    media.addEventListener('change', onChange);
    const poll = window.setInterval(onChange, 10 * 60_000);
    window.addEventListener('focus', onChange);
    document.addEventListener('visibilitychange', onVisible);
    // Catch a system change between the initial render and subscription.
    onChange();
    return () => {
      media.removeEventListener('change', onChange);
      window.clearInterval(poll);
      window.removeEventListener('focus', onChange);
      document.removeEventListener('visibilitychange', onVisible);
    };
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

  return { theme, resolvedTheme, setTheme: saveTheme };
}
