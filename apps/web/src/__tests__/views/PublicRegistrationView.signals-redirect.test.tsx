/**
 * View test: the post-submit hand-off to the Signals UI (#635).
 *
 * Covers the countdown, which rides on the `Continue to Signals` button's own
 * visible label rather than a standalone notice line, clicking that button to
 * go immediately, the `Register another` cancel (a field operator registering
 * people back-to-back must not be thrown out of the form), the dedup-hit
 * outcome, and the unconfigured-domain no-op.
 *
 * The RJSF shim, the fixture config, and the render helper come from
 * `./publicRegistrationView.testHelpers` — shared with
 * `PublicRegistrationView.signals-cta.test.tsx`, which exercises the same
 * two config gates that decide whether this hand-off is armed at all.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act, cleanup } from '@testing-library/react';
import type { ParticipantConsent } from '@/components/consent/consent-types';
import {
  RjsfShim,
  CFG,
  SIGNALS_URL,
  renderPublicRegistrationView,
} from './publicRegistrationView.testHelpers';

// jsdom does not implement scrollIntoView; the error banner's focus effect
// calls it whenever state transitions to 'error'.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('@/components/forms/RjsfThemed', () => ({ RjsfThemedForm: RjsfShim }));

// Shim ConsentGate exactly as PublicRegistrationView.account-only-consent-submit.test.tsx
// does: capture the props and let a test fire `onAccept` directly, bypassing
// the real gate's scroll-to-unlock mechanics (jsdom lays out no geometry for
// it). Only the "gate → hand-off" describe block below ever opens it — every
// other test in this file uses a domain config with no `consent_required`
// gate, so `open` stays `false` and this mock is inert for them.
let capturedGateProps: { open: boolean; onAccept: () => void; onCancel?: () => void } | undefined;

vi.mock('@/components/consent/ConsentGate', () => ({
  ConsentGate: (props: { open: boolean; onAccept: () => void; onCancel?: () => void }) => {
    capturedGateProps = props;
    return null;
  },
}));

// Config drives the hand-off entirely; each test supplies its own payload.
const cfgMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({ data: cfgMock.value }),
  DEFAULT_AGGREGATOR_CONFIG: cfgMock.value,
}));

// Pull the view after mocks register.
import { PublicRegistrationView } from '@/app/[org]/[slug]/PublicRegistrationView';

const CONSENT_CONTENT: ParticipantConsent = {
  terms: { version: 1, title: 'Terms of Service', content: 'Terms body' },
  privacy: { version: 1, title: 'Privacy Policy', content: 'Privacy body' },
  profileCreation: { version: 1, statement: 'We will use your data to build a profile.' },
};

/**
 * Render the public registration view for one link shape. Everything the
 * hand-off depends on comes from the mocked config; the props here only
 * select which form surface renders and which mode/domain the link declares.
 */
function renderView(opts: {
  domain: string;
  registrationMode: string | null;
  submissionShape: 'account_only' | 'account_and_profile';
}) {
  return renderPublicRegistrationView(PublicRegistrationView, opts);
}

/**
 * Render the view, stub the submit POST, and drive one submit to completion
 * so the green success panel is on screen.
 *
 * @param opts.status - HTTP status the stubbed submit returns (409 for a
 *   dedup hit, which the view treats as a success outcome, not an error).
 * @param opts.outcome - `passed` (new registration) or `skipped` (dedup hit).
 */
async function submitSuccessfully(opts: {
  domain: string;
  registrationMode: string | null;
  submissionShape?: 'account_only' | 'account_and_profile';
  status?: number;
  outcome?: 'passed' | 'skipped';
}): Promise<void> {
  const status = opts.status ?? 200;
  const outcome = opts.outcome ?? 'passed';
  fetchMock.mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => ({ submission_id: 'SUB-0001', outcome }),
  } as unknown as Response);
  renderView({
    domain: opts.domain,
    registrationMode: opts.registrationMode,
    submissionShape: opts.submissionShape ?? 'account_and_profile',
  });
  // #652: when the Signals hand-off is configured for this domain/mode, the
  // view opens on the pre-form chooser instead of the form. Only the
  // "Register" option reveals the form; the redirect tests care about the
  // post-submit countdown, not the chooser itself, so step past it here
  // rather than in every test. The unconfigured-domain case never renders
  // this button, so `queryByRole` leaves that path untouched.
  const registerCta = screen.queryByRole('button', { name: /^register$/i });
  if (registerCta) {
    fireEvent.click(registerCta);
  }
  await act(async () => {
    fireEvent.submit(screen.getByTestId('rjsf-shim'));
  });
}

/**
 * Advance the fake clock by whole seconds, one second per `act` flush.
 *
 * The countdown re-arms its `setTimeout` from an effect, so the next tick's
 * timer does not exist until React has rendered the previous one. A single
 * `advanceTimersByTime(n * 1000)` would therefore fire exactly one tick, no
 * matter how large `n` is; each second needs its own flush.
 */
async function tick(seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i += 1) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
  }
}

const assign = vi.fn();
const fetchMock = vi.fn();
let originalLocation: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  assign.mockReset();
  fetchMock.mockReset();
  capturedGateProps = undefined;
  vi.stubGlobal('fetch', fetchMock);
  originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
});

/**
 * The hand-off button, located by its accessible name — which is pinned to
 * the plain label and never carries the count, so this lookup keeps working
 * on every tick.
 *
 * @returns The button element, or `null` when the hand-off is unconfigured.
 */
function continueButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: /^continue to signals$/i });
}

/**
 * The hand-off button's *visible* label, which is where the countdown lives.
 *
 * @returns The rendered text, or `null` when the button is absent.
 */
function continueLabel(): string | null {
  return continueButton()?.textContent ?? null;
}

describe('Signals post-submit redirect', () => {
  it('counts down 4 -> 3 -> 2 -> 1 on the button label and then navigates', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    expect(continueLabel()).toBe('Continue to Signals (4)');
    await tick(1);
    expect(continueLabel()).toBe('Continue to Signals (3)');
    await tick(1);
    expect(continueLabel()).toBe('Continue to Signals (2)');
    await tick(1);
    expect(continueLabel()).toBe('Continue to Signals (1)');
    // Still on the panel a full second before the last tick: the participant
    // needs the whole window to read the reference id, which the hand-off
    // navigates away from.
    expect(assign).not.toHaveBeenCalled();
    await tick(1);
    expect(assign).toHaveBeenCalledWith(SIGNALS_URL);
  });

  it('shows no standalone countdown line — the button is the only countdown', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    // The pre-#652 notice paragraph ("Redirecting to Signals in N…") is gone;
    // testers read straight past it, so the count moved onto the button.
    expect(screen.queryByText(/Redirecting to Signals/i)).toBeNull();
    // Exactly one element carries the visible count.
    expect(screen.getAllByText(/Continue to Signals \(4\)/)).toHaveLength(1);
  });

  it('navigates immediately when the button is clicked, ignoring the remaining count', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    // Full countdown still on the clock — the click must not wait it out.
    expect(continueLabel()).toBe('Continue to Signals (4)');
    fireEvent.click(continueButton() as HTMLElement);
    expect(assign).toHaveBeenCalledWith(SIGNALS_URL);
    // Clicking cancels the tick, so a slow or blocked navigation cannot be
    // followed by a second `assign` when the countdown would have hit zero.
    await tick(6);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('never shows a bare "0" on the button, even at the terminal tick', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    // Advance through 4 -> 3 -> 2 -> 1 -> 0. The 4th tick both lands the
    // state at 0 AND fires `assign` in the same effect pass, so the render at
    // `redirectIn === 0` is the one left on screen afterwards.
    await tick(4);
    expect(assign).toHaveBeenCalledWith(SIGNALS_URL);
    // The number-less label takes over rather than "(0)".
    expect(continueLabel()).toBe('Continue to Signals');
    expect(continueLabel()).not.toMatch(/\d/);
  });

  it('keeps the accessible name static so the per-second relabel is never announced', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    const button = continueButton() as HTMLElement;
    // Accessible name is pinned to the plain label; the counting text is
    // decorative, so a screen reader on the focused button hears nothing new
    // when the number changes.
    expect(button).toHaveAttribute('aria-label', 'Continue to Signals');
    expect(button.getAttribute('aria-label')).not.toMatch(/\d/);
    const counter = screen.getByText(/Continue to Signals \(4\)/);
    expect(counter).toHaveAttribute('aria-hidden', 'true');
    await tick(1);
    // Same element, new number, unchanged accessible name.
    expect(continueLabel()).toBe('Continue to Signals (3)');
    expect(continueButton()).toHaveAttribute('aria-label', 'Continue to Signals');
  });

  it('announces once via a static live region that never carries the count', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    const announcement = screen.getByText(/You'll be taken to Signals shortly/);
    expect(announcement).toHaveAttribute('aria-live', 'polite');
    // One announcement per remaining second would interrupt itself
    // (WCAG 4.1.3), so no digit may ever enter the live region...
    expect(announcement).not.toHaveTextContent(/\d/);
    // ...and the ticking button must sit outside it.
    expect(announcement.contains(continueButton())).toBe(false);
    // Ticking must not re-announce: the live region's text is unchanged.
    const announced = announcement.textContent;
    await tick(1);
    expect(continueLabel()).toBe('Continue to Signals (3)');
    expect(screen.getByText(/You'll be taken to Signals shortly/).textContent).toBe(announced);
  });

  it('mounts the aria-live region even when no hand-off is configured, empty, before it could ever be populated', async () => {
    // No `signals_ui_urls` entry for `seeker` — the countdown never arms, so
    // if the live region were still gated on `redirectIn !== null` (the
    // pre-fix behaviour) it would never enter the DOM at all. Screen readers
    // only pick up mutations inside a region that was already present, so
    // proving the element exists independently of the countdown arming is
    // the discriminating check for the mount-order fix.
    cfgMock.value = { ...CFG, signals_ui_urls: {} };
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    const region = document.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region).toHaveClass('sr-only');
    expect(region?.textContent).toBe('');
  });

  it('populates the pre-mounted live region once the countdown arms', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    const region = document.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toMatch(/You'll be taken to Signals shortly/);
  });

  it('cancels the countdown when Register another is clicked', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    fireEvent.click(screen.getByRole('button', { name: /register another/i }));
    await tick(6);
    expect(assign).not.toHaveBeenCalled();
    expect(continueButton()).toBeNull();
    // The form is back, so the operator can key in the next person.
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
  });

  it('redirects on a dedup hit (outcome=skipped) too', async () => {
    cfgMock.value = CFG;
    await submitSuccessfully({
      domain: 'seeker',
      registrationMode: 'form',
      status: 409,
      outcome: 'skipped',
    });
    expect(continueLabel()).toBe('Continue to Signals (4)');
    await tick(4);
    expect(assign).toHaveBeenCalledWith(SIGNALS_URL);
  });

  it('keeps the plain success panel when the domain has no configured URL', async () => {
    cfgMock.value = { ...CFG, signals_ui_urls: {} };
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    // The success panel itself still renders — only the hand-off is absent.
    expect(screen.getByRole('button', { name: /register another/i })).toBeInTheDocument();
    expect(continueButton()).toBeNull();
    expect(screen.queryByText(/Continue to Signals/i)).toBeNull();
    expect(screen.queryByText(/You'll be taken to Signals shortly/)).toBeNull();
    await tick(6);
    expect(assign).not.toHaveBeenCalled();
  });

  it('keeps the plain success panel when the mode has signals_cta off but a URL exists', async () => {
    // `signalsHandoffUrl` fuses two independent gates: the per-domain URL and
    // the per-mode `signals_cta`. Every other no-op test here starves the
    // *URL* gate, so a regression that made the mode gate always-on would
    // leave them all green while redirecting voice / account-only links that
    // deliberately opted out. This test starves only the mode gate: the
    // `seeker` URL is present and valid.
    cfgMock.value = {
      ...CFG,
      registration_modes: {
        ...CFG.registration_modes,
        form: { ...CFG.registration_modes.form, signals_cta: false },
      },
    };
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    expect(screen.getByRole('button', { name: /register another/i })).toBeInTheDocument();
    expect(continueButton()).toBeNull();
    expect(screen.queryByText(/Continue to Signals/i)).toBeNull();
    expect(screen.queryByText(/You'll be taken to Signals shortly/)).toBeNull();
    await tick(6);
    expect(assign).not.toHaveBeenCalled();
  });

  it('navigates exactly once on the natural countdown, even if the hop never completes', async () => {
    // Only the click path pinned the call count before. On the timed path a
    // cross-origin `assign` that is deferred or blocked (a dismissed
    // `beforeunload`, an extension intercept) leaves the component mounted and
    // still ticking-capable, so the fire has to be terminal, not just
    // "happened once so far".
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    await tick(4);
    expect(assign).toHaveBeenCalledTimes(1);
    // Nothing left on the clock: no second hop, and no negative count leaking
    // onto the label.
    await tick(6);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(continueLabel()).toBe('Continue to Signals');
  });

  it('does not navigate after the view unmounts mid-countdown', async () => {
    // A participant who closes the tab (or a router-level unmount) mid-window
    // must not be navigated by a surviving timer.
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    expect(continueLabel()).toBe('Continue to Signals (4)');
    cleanup();
    await tick(6);
    expect(assign).not.toHaveBeenCalled();
  });

  it('navigates to the URL captured at arm time even if the config drops it mid-countdown', async () => {
    // The hand-off URL comes from the `useAggregatorConfig` query cache. A
    // background refetch landing inside the 4s window used to be read live on
    // the next tick: the countdown froze with the button unmounted and the
    // participant was stranded on the success panel, never handed off and
    // never told. The destination is snapshotted when the countdown arms, so
    // the hop still completes.
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    await tick(1);
    expect(continueLabel()).toBe('Continue to Signals (3)');
    // The refetch lands: this domain no longer resolves to a hand-off URL.
    // Every subsequent render reads the emptied config.
    cfgMock.value = { ...CFG, signals_ui_urls: {} };
    await tick(1);
    // Countdown carries on rather than freezing, and the button is still up.
    expect(continueLabel()).toBe('Continue to Signals (2)');
    await tick(2);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(SIGNALS_URL);
  });

  it('loses the final tick to a Register another click that lands in the same flush', async () => {
    // The narrow race the null-guard exists for: the pending 1 -> 0 macrotask
    // runs before React has re-rendered the cancel. Both are driven inside one
    // outer `act` so the click's state update is still queued when the timer
    // fires — an operator who just cancelled must not be thrown to Signals.
    cfgMock.value = CFG;
    await submitSuccessfully({ domain: 'seeker', registrationMode: 'form' });
    await tick(3);
    expect(continueLabel()).toBe('Continue to Signals (1)');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /register another/i }));
      vi.advanceTimersByTime(1000);
    });
    await tick(6);
    expect(assign).not.toHaveBeenCalled();
    expect(continueButton()).toBeNull();
    expect(screen.getByTestId('rjsf-shim')).toBeInTheDocument();
  });
});

/**
 * Proves the #636 consent gate and the #654 hand-off actually compose:
 * `handleGateAccept` re-enters `performSubmit` from a different call site
 * than a direct (no-gate-needed) submit, and the hand-off's arming effect
 * only watches `state.status === 'done'` — not which call site produced it.
 * These tests exercise the gated path end to end and would fail if the
 * hand-off were (a) wired to the direct-submit call site only, (b) armed
 * twice by the submitting → idle → submitting → done sequence the gate
 * causes, or (c) armed before `performSubmit`'s POST — which carries
 * `consent_terms: true` — actually resolves.
 */
describe('Signals post-submit redirect through the consent gate', () => {
  const CFG_WITH_CONSENT = {
    ...CFG,
    domains: [
      {
        ...CFG.domains[0],
        go_live_required: ['schema_required', 'consent_required'],
      },
    ],
  };

  it('still arms and fires the hand-off after the gate is accepted', async () => {
    cfgMock.value = CFG_WITH_CONSENT;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ submission_id: 'SUB-GATE-1', outcome: 'passed' }),
    } as unknown as Response);
    renderPublicRegistrationView(PublicRegistrationView, {
      domain: 'seeker',
      registrationMode: 'form',
      submissionShape: 'account_and_profile',
      consentContent: CONSENT_CONTENT,
    });
    const registerCta = screen.queryByRole('button', { name: /^register$/i });
    if (registerCta) fireEvent.click(registerCta);

    // Submitting without prior consent must open the gate, not post directly.
    // Fake timers are active in this file (for `tick`), so `waitFor`'s real-time
    // polling is avoided throughout — every async step here is a microtask
    // (probe short-circuit, mocked `fetch`), which a plain `await act` drains.
    await act(async () => {
      fireEvent.submit(screen.getByTestId('rjsf-shim'));
    });
    expect(capturedGateProps?.open).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(continueButton()).toBeNull();

    // Accepting re-enters performSubmit from handleGateAccept, a different
    // call site than the direct-submit tests above use.
    await act(async () => {
      capturedGateProps!.onAccept();
    });

    // Consent must already be on the wire, as `true`, before the hand-off
    // is even eligible to arm (the POST is awaited inside performSubmit,
    // which only sets state to 'done' once it resolves).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as {
      consent_terms?: boolean;
    };
    expect(body.consent_terms).toBe(true);

    // The countdown arms exactly once and counts down normally.
    expect(continueLabel()).toBe('Continue to Signals (4)');
    await tick(4);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(SIGNALS_URL);
  });

  it('does not open the gate a second time or double-arm the countdown', async () => {
    cfgMock.value = CFG_WITH_CONSENT;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ submission_id: 'SUB-GATE-2', outcome: 'passed' }),
    } as unknown as Response);
    renderPublicRegistrationView(PublicRegistrationView, {
      domain: 'seeker',
      registrationMode: 'form',
      submissionShape: 'account_and_profile',
      consentContent: CONSENT_CONTENT,
    });
    const registerCta = screen.queryByRole('button', { name: /^register$/i });
    if (registerCta) fireEvent.click(registerCta);

    await act(async () => {
      fireEvent.submit(screen.getByTestId('rjsf-shim'));
    });
    expect(capturedGateProps?.open).toBe(true);
    await act(async () => {
      capturedGateProps!.onAccept();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(4);
    expect(assign).toHaveBeenCalledTimes(1);
    // Nothing left to fire: the countdown does not restart or fire again.
    await tick(6);
    expect(assign).toHaveBeenCalledTimes(1);
  });
});
