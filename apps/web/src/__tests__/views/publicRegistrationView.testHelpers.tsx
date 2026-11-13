/**
 * Shared test scaffolding for the public registration view's Signals
 * hand-off tests — the #652 sign-in CTA
 * (`PublicRegistrationView.signals-cta.test.tsx`) and the #635 post-submit
 * redirect (`PublicRegistrationView.signals-redirect.test.tsx`) exercise the
 * same two config gates (`registration_modes.*.signals_cta` and
 * `signals_ui_urls`), so both import the RJSF shim, the fixture config, and
 * the render helper from here instead of each keeping its own copy.
 *
 * Deliberately holds no `vi.mock(...)` calls itself: those must stay in each
 * test file (Vitest hoists them per-file, above that file's own imports), and
 * this module has no dependency on `PublicRegistrationView` at the value
 * level — only a type-only import — so pulling it in can never race the
 * mock registration order.
 */
import type { ComponentType } from 'react';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';
import type { PublicRegistrationViewProps } from '@/app/[org]/[slug]/PublicRegistrationView';
import type { ParticipantConsent } from '@/components/consent/consent-types';

/**
 * Deterministic stand-in for `RjsfThemedForm`: renders a plain `<form>`
 * whose submit invokes the real `onSubmit` handler with a formData object
 * built from the schema's field defaults. Keeps RJSF's own render tree out
 * of these tests — they exercise the Signals hand-off gating, not RJSF
 * itself (covered by RJSF's own tests). Register it via
 * `vi.mock('@/components/forms/RjsfThemed', () => ({ RjsfThemedForm: RjsfShim }))`
 * in each test file.
 */
export function RjsfShim({
  schema,
  onSubmit,
  children,
}: {
  schema: { properties?: Record<string, { default?: unknown }> };
  onSubmit: (e: { formData: Record<string, unknown> }, ev: unknown) => void;
  children?: React.ReactNode;
}) {
  const formData: Record<string, unknown> = {};
  for (const [field, def] of Object.entries(schema.properties ?? {})) {
    if (def && 'default' in def && def.default !== undefined) {
      formData[field] = def.default;
    }
  }
  return (
    <form
      data-testid="rjsf-shim"
      onSubmit={(ev) => {
        ev.preventDefault();
        onSubmit({ formData }, ev);
      }}
    >
      {children}
    </form>
  );
}

/**
 * Config fixture driving both the CTA gates and the hand-off URL lookup.
 * `signals_ui_urls.seeker` resolves to {@link SIGNALS_URL}.
 */
export const CFG = {
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

/** The hand-off URL {@link CFG}'s `seeker` domain resolves to. */
export const SIGNALS_URL = 'https://signals-seeker.example/auth/login';

/**
 * Render the public registration view for one link shape. Everything the
 * CTA / hand-off depends on comes from the mocked config; the props here
 * only select which form surface renders and which mode/domain the link
 * declares.
 *
 * @param View - The (mock-wired) `PublicRegistrationView` component, passed
 *   in by the caller so this helper never imports it directly — that import
 *   must happen in the test file, after its own `vi.mock` calls register.
 * @param opts.consentContent - Participant consent copy, threaded straight
 *   through to the view. Omitted/`null` (the default) matches every existing
 *   caller, which never exercises the consent gate; a caller proving the gate
 *   → post-submit hand-off composition supplies real content here so the
 *   gate opens instead of the `CONSENT_UNAVAILABLE` error path.
 */
export function renderPublicRegistrationView(
  View: ComponentType<PublicRegistrationViewProps>,
  opts: {
    domain: string;
    registrationMode: string | null;
    submissionShape: 'account_only' | 'account_and_profile';
    consentContent?: ParticipantConsent | null;
  },
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
        <View
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
          consentContent={opts.consentContent ?? null}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}
