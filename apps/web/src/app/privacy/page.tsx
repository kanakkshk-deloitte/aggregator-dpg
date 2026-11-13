import { redirect } from 'next/navigation';

/**
 * Redirects to the privacy section of `/legal`.
 *
 * Uses a temporary 307 redirect, because browsers cache a 308 indefinitely.
 */
export default function PrivacyRedirect(): never {
  redirect('/legal#privacy');
}
