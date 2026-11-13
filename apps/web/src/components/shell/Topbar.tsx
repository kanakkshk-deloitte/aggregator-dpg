'use client';

import type { ReactNode } from 'react';
import { ThemeToggle } from './ThemeToggle';
import { LanguageSwitcher } from './LanguageSwitcher';

interface TopbarProps {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  /** Shown before the title, such as an avatar. */
  leading?: ReactNode;
}

export function Topbar({ title, subtitle, right, leading }: Readonly<TopbarProps>) {
  return (
    // Below `sm` the title and actions stack and the actions wrap.
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6 mb-6">
      <div className="flex min-w-0 items-center gap-4">
        {leading}
        <div className="min-w-0">
          <h1 className="font-display font-bold text-[26px] text-ink-900 tracking-tight leading-tight">
            {title}
          </h1>
          {subtitle && <div className="text-[14px] text-ink-400 mt-1">{subtitle}</div>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
        {right}
        <LanguageSwitcher />
        <ThemeToggle />
      </div>
    </div>
  );
}
