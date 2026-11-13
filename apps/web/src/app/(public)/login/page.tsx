import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession } from '../../../lib/server-session';
import { LoginView } from './LoginView';

const LOGOUT_REASON_COOKIE = 'bd_logout_reason';
const LOGOUT_RETURN_COOKIE = 'bd_logout_return';

export const metadata: Metadata = {
  title: 'Sign in',
};

interface LoginPageProps {
  searchParams: Promise<{
    returnTo?: string;
    return?: string;
    error?: string;
    reason?: string;
  }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await getSession();
  if (session) redirect('/dashboard');

  const params = await searchParams;
  const cookieJar = await cookies();
  // Logout sets these one-shot cookies because Keycloak drops query strings
  // from `post_logout_redirect_uri`. Cookie values win over the query string.
  const cookieReturn = cookieJar.get(LOGOUT_RETURN_COOKIE)?.value;
  const cookieReason = cookieJar.get(LOGOUT_REASON_COOKIE)?.value;

  const returnCandidate = cookieReturn ?? params.return ?? params.returnTo;
  const returnTo = isSafePath(returnCandidate) ? returnCandidate! : '/dashboard';
  const reason = cookieReason ?? (typeof params.reason === 'string' ? params.reason : null);
  // Reasons passed through as error codes LoginView understands. They arrive
  // as `?error=` from the callback or `?reason=` from a layout sign-out.
  const PORTAL_GATE_REASONS = new Set([
    'signals_account_no_portal',
    'no_portal_access',
    // Set by `/api/auth/login?switch=1` after it ends the realm session.
    'account_switch',
    // Set by the console layout when the API does not know the admin, or they
    // manage no active organisation.
    'console_not_provisioned',
    'console_no_org',
  ]);
  // Order: expired session, then a portal-gate reason, then `?error=`.
  function resolveError(): string | null {
    if (reason === 'expired') return 'session_expired';
    if (reason && PORTAL_GATE_REASONS.has(reason)) return reason;
    return typeof params.error === 'string' ? params.error : null;
  }
  const error = resolveError();

  return <LoginView returnTo={returnTo} error={error} />;
}

function isSafePath(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
}
