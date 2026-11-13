/**
 * `components/login/BrandAttribution` — the "Owned by / Managed by" rows on the
 * login page's right pane (signals-dpg#720).
 *
 * The behaviour worth pinning is the opt-in: this renders nothing at all unless
 * a brand declares `attribution`, which is every brand but alimco. A regression
 * that rendered an empty wrapper would put a stray gap on every other
 * deployment's login page.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { BrandAttribution } from '@/components/login/BrandAttribution';
import { ThemeModeProvider, THEME_STORAGE_KEY } from '@/lib/theme-mode';

describe('BrandAttribution', () => {
  it('renders nothing when the brand declares no attribution', () => {
    const { container } = render(
      <ThemeModeProvider>
        <BrandAttribution rows={undefined} />
      </ThemeModeProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an empty array, not an empty wrapper', () => {
    const { container } = render(
      <ThemeModeProvider>
        <BrandAttribution rows={[]} />
      </ThemeModeProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders each row as its mark alone, with the org name as the accessible name', () => {
    render(
      <ThemeModeProvider>
        <BrandAttribution
          rows={[
            { label: 'Owned by', name: 'Swavlamban', logo: '/brand/alimco/swavlamban-mark.png' },
            { label: 'Managed by', name: 'ALIMCO', logo: '/brand/alimco/alimco-mark.png' },
          ]}
        />
      </ThemeModeProvider>,
    );

    expect(screen.getByText('Owned by')).toBeInTheDocument();
    expect(screen.getByText('Managed by')).toBeInTheDocument();

    // The name is the image's alt text, NOT visible copy beside the mark —
    // "only logo is enough, not text" was the explicit ask.
    expect(screen.getByAltText('Swavlamban')).toBeInTheDocument();
    expect(screen.getByAltText('ALIMCO')).toBeInTheDocument();
    expect(screen.queryByText('Swavlamban')).not.toBeInTheDocument();
    expect(screen.queryByText('ALIMCO')).not.toBeInTheDocument();
  });

  it('falls back to the name as text when a row ships no logo', () => {
    render(
      <ThemeModeProvider>
        <BrandAttribution rows={[{ label: 'Owned by', name: 'Swavlamban' }]} />
      </ThemeModeProvider>,
    );

    expect(screen.getByText('Swavlamban')).toBeInTheDocument();
    expect(screen.queryByAltText('Swavlamban')).not.toBeInTheDocument();
  });

  it('uses logoLight in dark mode, and falls back to logo when a row ships none', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(
      <ThemeModeProvider>
        <BrandAttribution
          rows={[
            {
              label: 'Owned by',
              name: 'Swavlamban',
              logo: '/brand/alimco/swavlamban-mark.png',
              logoLight: '/brand/alimco/swavlamban-mark-light.png',
            },
            { label: 'Managed by', name: 'ALIMCO', logo: '/brand/alimco/alimco-mark.png' },
          ]}
        />
      </ThemeModeProvider>,
    );

    // Swavlamban's gold measures ~1.6:1 on light and ~11:1 on dark, so it ships
    // two crops; ALIMCO's deep purple works on both and declares only `logo`.
    const swav = await screen.findByAltText('Swavlamban');
    await waitFor(() => expect(swav.getAttribute('src')).toContain('swavlamban-mark-light'));
    expect(screen.getByAltText('ALIMCO').getAttribute('src')).toContain('alimco-mark');
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  });
});
