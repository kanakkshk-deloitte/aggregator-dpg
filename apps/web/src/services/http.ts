/**
 * Client-side HTTP wrapper for BFF calls from the browser (web app).
 *
 * `jsonFetch` sets JSON headers, sends the session cookie, and logs the
 * user out on a 401 `NO_ACTIVE_SESSION` response (see `lib/bff-errors.ts`).
 */

let redirecting = false;

interface UnauthorizedBody {
  error?: unknown;
  code?: unknown;
}

/**
 * Returns true when the response body matches the standard
 * `NO_ACTIVE_SESSION` shape from `bff-errors.ts`.
 */
function isSessionExpired(body: unknown): body is UnauthorizedBody {
  if (!body || typeof body !== 'object') return false;
  const code = (body as UnauthorizedBody).code;
  return code === 'NO_ACTIVE_SESSION';
}

/** Redirects to logout. Runs once per page, even with concurrent 401s. */
function forceLogout(): void {
  if (redirecting) return;
  redirecting = true;
  if (typeof window === 'undefined') return;
  // Skip when already on the login flow.
  const path = window.location.pathname;
  if (path.startsWith('/login') || path.startsWith('/api/auth/')) {
    redirecting = false;
    return;
  }
  const ret = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/api/auth/logout?reason=expired&return=${ret}`;
}

/**
 * Fetches a BFF endpoint and parses the JSON response.
 *
 * Redirects to logout when the server reports `NO_ACTIVE_SESSION`.
 *
 * @param input - The request URL or object.
 * @param init - Extra fetch options; headers are merged.
 * @returns The parsed JSON body.
 * @throws {Error} When the response is not OK, with the status and body text.
 */
export async function jsonFetch<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
    credentials: 'include',
  });

  if (res.status === 401) {
    // Log out only for the session-expired body; other 401s fall through as errors.
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as unknown;
    if (isSessionExpired(body)) {
      forceLogout();
      throw new Error('session expired');
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`request failed (${res.status}): ${text || res.statusText}`);
  }

  return (await res.json()) as T;
}
