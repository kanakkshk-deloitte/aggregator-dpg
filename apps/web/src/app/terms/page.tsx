import { redirect } from 'next/navigation';

/**
 * Redirects to the terms section of `/legal` with a temporary 307 redirect.
 */
export default function TermsRedirect(): never {
  redirect('/legal#terms');
}
