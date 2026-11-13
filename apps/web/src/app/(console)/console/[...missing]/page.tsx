/**
 * Any console path with no page of its own. Answers with the console's own
 * not-found screen, inside the console layout, instead of the bare app 404.
 */

import { notFound } from 'next/navigation';

export default function ConsoleMissingPage(): never {
  notFound();
}
