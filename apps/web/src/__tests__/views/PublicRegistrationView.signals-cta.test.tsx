/**
 * View test: the pre-form registration chooser and its Signals
 * "Already Registered — Sign In" option (#652).
 *
 * The chooser is what a participant meets first when the Signals hand-off is
 * configured for the link's domain + registration mode; the form is revealed
 * only after they pick Register. Both live at the same URL, because printed QR
 * codes encode `/<org>/<slug>` verbatim — one case asserts that explicitly.
 *
 * Covers the two config gates (per-mode `signals_cta`, per-domain
 * `signals_ui_urls`) across both form surfaces — the full-profile RJSF form
 * and the account-only MinimalIdentityForm. RJSF is mocked to the same thin
 * shim used by PublicRegistrationView.lookup.test.tsx.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';

// jsdom does not implement scrollIntoView; the error banner's focus effect
// calls it whenever state transitions to 'error'.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

/** The public link URL a printed QR code encodes. */
const PAGE_URL = '/acme/winter25';

// jsdom shares one `window.location` across the file, so a test that navigated
// would poison the next one's baseline. Reset to the link URL before each.
beforeEach(() => {
  window.history.replaceState({}, '', PAGE_URL);
});

// Shim RjsfThemedForm: render a deterministic <form> tagged with a testid so
// "is the form visible yet" is a single unambiguous assertion. Keeps RJSF's
// render tree out of the test — we exercise the chooser, not RJSF rendering.
vi.mock('@/components/forms/RjsfThemed', () => {
  return {
    RjsfThemedForm: ({
      onSubmit,
      children,
    }: {
      onSubmit: (e: { formData: Record<string, unknown> }, ev: unknown) => void;
      children?: React.ReactNode;
    }) => (
      <form
        data-testid="rjsf-shim"
        onSubmit={(ev) => {
          ev.preventDefault();
          onSubmit({ formData: {} }, ev);
        }}
      >
        {children}
      </form>
    ),
  };
});

// Config drives the chooser entirely; each test supplies its own payload.
// `value: undefined` models the query still being in flight, which is when the
// view must commit to neither surface.
const cfgMock = vi.hoisted(() => ({
  value: undefined as Record<string, unknown> | undefined,
  // Stand-in for the real DEFAULT_AGGREGATOR_CONFIG: enough shape for the
  // header to render while `data` is undefined, and no signals_ui_urls.
  fallback: { brand: { short_name: 'Blue Dots' }, domains: [] },
}));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({ data: cfgMock.value, isError: false }),
  DEFAULT_AGGREGATOR_CONFIG: cfgMock.fallback,
}));

// Pull the view after mocks register.
import { PublicRegistrationView } from '@/app/[org]/[slug]/PublicRegistrationView';

const CFG = {
  aggregator: { name: 'Test' },
  brand: {
    short_name: 'Blue Dots',
    long_name: 'Blue Dots',
    url_slug: 'bd',
    primary_color: '#2563EB',
  },
  network: { id: 'blue_dot' },
  domains: [{ id: 'seeker', label: 'Seeker', plural_label: 'Seekers', item_type: 'profile_1.0' }],
  registration_modes: {
    form: {
      label_i18n_key: 'x',
      submission_shape: 'account_and_profile',
      public_hint_i18n_key: null,
      signals_cta: true,
    },
    voice: {
      label_i18n_key: 'y',
      submission_shape: 'account_only',
      public_hint_i18n_key: null,
      signals_cta: false,
    },
  },
  signals_ui_urls: { seeker: 'https://signals-seeker.example/auth/login' },
};

/**
 * Render the public registration view for one link shape. Everything the
 * chooser depends on comes from the mocked config; the props here only select
 * which form surface renders and which mode/domain the link declares.
 */
function renderView(opts: {
  domain: string;
  registrationMode: string | null;
  submissionShape: 'account_only' | 'account_and_profile';
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
        <PublicRegistrationView
          org="acme"
          slug="winter25"
          network="blue_dot"
          domain={opts.domain}
          context={{ title: 'Winter 2025 Registration', org_name: 'Acme' }}
          schema={{
            type: 'object',
            properties: { email: { type: 'string' }, name: { type: 'string' } },
          }}
          uiSchema={{}}
          identity={{ name: 'name', phone: 'phone', email: 'email' }}
          submissionShape={opts.submissionShape}
          publicHintI18nKey={null}
          registrationMode={opts.registrationMode}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** The chooser's primary action. */
const registerButton = () => screen.getByRole('button', { name: /^register$/i });
/** The chooser's secondary action. */
const signInLink = () => screen.queryByRole('link', { name: /already registered/i });

describe('pre-form registration chooser', () => {
  it('renders the chooser instead of the form when the hand-off is configured', () => {
    cfgMock.value = CFG;
    renderView({
      domain: 'seeker',
      registrationMode: 'form',
      submissionShape: 'account_and_profile',
    });
    expect(screen.getByTestId('registration-chooser')).toBeInTheDocument();
    expect(screen.getByText(/how would you like to continue/i)).toBeInTheDocument();
    // The form must not be rendered behind the chooser.
    expect(screen.queryByTestId('rjsf-shim')).toBeNull();
    expect(screen.queryByRole('button', { name: /submit registration/i })).toBeNull();
  });

  it('reveals the form on Register and drops the sign-in CTA from the form view', async () => {
    cfgMock.value = CFG;
    const user = userEvent.setup();
    renderView({
      domain: 'seeker',
      registrationMode: 'form',
      submissionShape: 'account_and_profile',
    });
    await user.click(registerButton());
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
    expect(screen.queryByTestId('registration-chooser')).toBeNull();
    // The old below-submit CTA is gone: no sign-in link anywhere in the form view.
    expect(signInLink()).toBeNull();
  });

  it('keeps the URL unchanged when Register is chosen (printed QR codes)', async () => {
    cfgMock.value = CFG;
    const user = userEvent.setup();
    renderView({
      domain: 'seeker',
      registrationMode: 'form',
      submissionShape: 'account_and_profile',
    });
    const before = {
      href: window.location.href,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
    };
    expect(before.pathname).toBe(PAGE_URL);
    await user.click(registerButton());
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
    expect(window.location.href).toBe(before.href);
    // Spelled out so a route, query param or hash added by the transition each
    // fail on their own rather than hiding inside one href comparison.
    expect(window.location.pathname).toBe(PAGE_URL);
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
  });

  it('offers a way back to the chooser from the form', async () => {
    cfgMock.value = CFG;
    const user = userEvent.setup();
    renderView({
      domain: 'seeker',
      registrationMode: 'form',
      submissionShape: 'account_and_profile',
    });
    await user.click(registerButton());
    await user.click(screen.getByRole('button', { name: /back to options/i }));
    expect(screen.getByTestId('registration-chooser')).toBeInTheDocument();
    expect(screen.queryByTestId('rjsf-shim')).toBeNull();
  });

  it('points the sign-in option at the per-domain URL in a new tab', () => {
    cfgMock.value = {
      ...CFG,
      domains: [
        ...CFG.domains,
        { id: 'provider', label: 'Provider', plural_label: 'Providers', item_type: 'profile_1.0' },
      ],
      signals_ui_urls: {
        seeker: 'https://signals-seeker.example/auth/login',
        provider: 'https://signals-provider.example/auth/login',
      },
    };
    renderView({
      domain: 'provider',
      registrationMode: 'form',
      submissionShape: 'account_and_profile',
    });
    const link = signInLink();
    expect(link).toHaveAttribute('href', 'https://signals-provider.example/auth/login');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders the form directly when the domain has no configured URL', () => {
    cfgMock.value = { ...CFG, signals_ui_urls: {} };
    renderView({
      domain: 'seeker',
      registrationMode: 'form',
      submissionShape: 'account_and_profile',
    });
    expect(screen.queryByTestId('registration-chooser')).toBeNull();
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
    expect(signInLink()).toBeNull();
    expect(screen.queryByRole('button', { name: /back to options/i })).toBeNull();
  });

  it('sends an account-only voice link (signals_cta false) straight to the minimal form', () => {
    cfgMock.value = CFG;
    renderView({ domain: 'seeker', registrationMode: 'voice', submissionShape: 'account_only' });
    expect(screen.queryByTestId('registration-chooser')).toBeNull();
    expect(signInLink()).toBeNull();
    // MinimalIdentityForm's own submit button, not the RJSF one.
    expect(screen.getByRole('button', { name: /submit/i })).toBeInTheDocument();
    expect(screen.queryByTestId('rjsf-shim')).toBeNull();
  });

  it('shows the chooser in front of the account-only form when signals_cta is on', async () => {
    cfgMock.value = {
      ...CFG,
      registration_modes: {
        ...CFG.registration_modes,
        voice: { ...CFG.registration_modes.voice, signals_cta: true },
      },
    };
    const user = userEvent.setup();
    renderView({ domain: 'seeker', registrationMode: 'voice', submissionShape: 'account_only' });
    expect(screen.getByTestId('registration-chooser')).toBeInTheDocument();
    expect(signInLink()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull();
    await user.click(registerButton());
    expect(screen.getByRole('button', { name: /submit/i })).toBeInTheDocument();
    expect(signInLink()).toBeNull();
  });

  it('falls back to the submission shape when the mode is unknown to the config', () => {
    cfgMock.value = CFG;
    renderView({
      domain: 'seeker',
      registrationMode: 'kiosk',
      submissionShape: 'account_and_profile',
    });
    expect(screen.getByTestId('registration-chooser')).toBeInTheDocument();
  });

  it('honours an explicit signals_cta:false on a full-profile mode that has a URL', () => {
    // The override branch: the shape default would switch the chooser ON for
    // account_and_profile, and a URL *is* configured for the domain, so the
    // only thing that can suppress it is the explicit false being read.
    cfgMock.value = {
      ...CFG,
      registration_modes: {
        ...CFG.registration_modes,
        form: { ...CFG.registration_modes.form, signals_cta: false },
      },
    };
    renderView({
      domain: 'seeker',
      registrationMode: 'form',
      submissionShape: 'account_and_profile',
    });
    expect(screen.queryByTestId('registration-chooser')).toBeNull();
    expect(signInLink()).toBeNull();
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
  });

  it('refuses a non-http(s) hand-off URL rather than putting it in an href', () => {
    // Defence in depth: the api already rejects these at boot, so this can
    // only fire if that guarantee breaks. Assert on the rendered outcome, not
    // on the guard's internals.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      cfgMock.value = { ...CFG, signals_ui_urls: { seeker: 'javascript:alert(1)' } };
      renderView({
        domain: 'seeker',
        registrationMode: 'form',
        submissionShape: 'account_and_profile',
      });
      expect(screen.queryByTestId('registration-chooser')).toBeNull();
      expect(signInLink()).toBeNull();
      // Degrades to the plain form, exactly as an unconfigured domain does.
      expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('still renders the chooser for a plain http URL (the guard is scheme-only)', () => {
    // Guards against the re-validation over-reaching: a local/dev http origin
    // is valid config and must behave exactly as https does.
    cfgMock.value = { ...CFG, signals_ui_urls: { seeker: 'http://localhost:5173/auth/login' } };
    renderView({
      domain: 'seeker',
      registrationMode: 'form',
      submissionShape: 'account_and_profile',
    });
    expect(screen.getByTestId('registration-chooser')).toBeInTheDocument();
    expect(signInLink()).toHaveAttribute('href', 'http://localhost:5173/auth/login');
  });

  it('shows neither surface until the aggregator config resolves', () => {
    // Config still in flight: `data` is undefined and the query has not errored.
    cfgMock.value = undefined;
    renderView({
      domain: 'seeker',
      registrationMode: 'form',
      submissionShape: 'account_and_profile',
    });
    expect(screen.getByTestId('public-reg-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('registration-chooser')).toBeNull();
    expect(screen.queryByTestId('rjsf-shim')).toBeNull();
  });
});
