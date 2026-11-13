/**
 * The console's error and not-found screens: plain words and a way back,
 * never the framework's error text.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import ConsoleError from '@/app/(console)/console/error';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) => (key: string) => {
    const scope = ns
      .split('.')
      .reduce<Record<string, unknown>>(
        (o, k) => o[k] as Record<string, unknown>,
        messages as unknown as Record<string, unknown>,
      );
    return scope[key] as string;
  }),
}));

import ConsoleNotFound from '@/app/(console)/console/not-found';

describe('console error screens', () => {
  it('explains a failed page and retries', () => {
    const reset = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ConsoleError error={new Error('boom: stack details')} reset={reset} />
      </NextIntlClientProvider>,
    );
    expect(
      screen.getByRole('heading', { name: messages.console.page_error.title }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: messages.console.page_error.retry }));
    expect(reset).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: messages.console.page_error.home })).toHaveAttribute(
      'href',
      '/console',
    );
  });

  it('explains a missing record', async () => {
    render(await ConsoleNotFound());
    expect(
      screen.getByRole('heading', { name: messages.console.page_not_found.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: messages.console.page_not_found.home }),
    ).toHaveAttribute('href', '/console');
  });
});
