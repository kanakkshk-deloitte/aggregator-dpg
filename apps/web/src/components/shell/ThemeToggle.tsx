'use client';

import { useTranslations } from 'next-intl';
import { I } from '../../icons';
import { useThemeMode } from '../../lib/theme-mode';

/**
 * Light/dark switch. Used by `Topbar` and the public login page.
 *
 * Has no text label; the icon and `title`/`aria-label` carry the state.
 */
export function ThemeToggle() {
  const { mode, toggle } = useThemeMode();
  const t = useTranslations('theme');
  return (
    <button
      type="button"
      onClick={toggle}
      title={mode === 'dark' ? t('switch_to_light') : t('switch_to_dark')}
      aria-label={t('toggle_aria')}
      className="w-9 h-9 rounded-[10px] flex items-center justify-center border border-(--bd-border) bg-(--bd-card) text-(--bd-fg-muted) hover:text-(--bd-fg) hover:bg-(--bd-border-soft) transition-colors"
    >
      {mode === 'dark' ? <I.sun size={16} /> : <I.moon size={16} />}
    </button>
  );
}
