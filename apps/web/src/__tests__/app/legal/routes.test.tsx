/**
 * Server-component tests for the legal routes: the one page, and the two
 * redirects into it.
 *
 * The redirects matter more than they look: `/privacy` and `/terms` are the
 * paths operators have already shared over SMS and email (Signals-DPG#637), so
 * they have to keep landing readers on the right section now that both
 * documents live on one page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { loadLegalGroups } = vi.hoisted(() => ({ loadLegalGroups: vi.fn() }));
vi.mock('@/components/legal/load-legal-groups.server', () => ({ loadLegalGroups }));

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    // Mirrors Next's own behaviour: it throws, so nothing after it runs.
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect }));

import LegalPage from '@/app/legal/page';
import PrivacyRedirect from '@/app/privacy/page';
import TermsRedirect from '@/app/terms/page';

describe('legal routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the one page with every audience that loaded', async () => {
    const groups = [{ audience: 'participant', label: 'For participants', content: {} }];
    loadLegalGroups.mockResolvedValue(groups);

    const el = await LegalPage();

    expect(el.props.groups).toBe(groups);
    // No `doc`: the fragment decides where the reader lands, not the route.
    expect(el.props.doc).toBeUndefined();
  });

  it.each([
    ['/privacy', PrivacyRedirect, '/legal#privacy'],
    ['/terms', TermsRedirect, '/legal#terms'],
  ])('%s redirects to %s', (_from, Component, to) => {
    expect(() => Component()).toThrow(`NEXT_REDIRECT:${to}`);
    // A 307, not a 308: a permanent redirect is cached indefinitely, which
    // would make the `/legal` naming call irreversible in practice.
    expect(redirect).toHaveBeenCalledWith(to);
  });
});
