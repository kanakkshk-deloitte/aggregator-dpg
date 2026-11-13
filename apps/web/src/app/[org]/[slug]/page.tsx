import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RJSFSchema } from '@rjsf/utils';
import { resolveSchemaRoot } from '@/lib/config-paths';
import { loadParticipantConsent } from '@/lib/participant-consent.server';
import { PublicRegistrationView } from './PublicRegistrationView';

export const metadata: Metadata = {
  title: 'Register',
};

export const dynamic = 'force-dynamic';

interface ResolveResponse {
  slug: string;
  // Signalstack network id (e.g. 'blue_dot'). May be absent.
  network?: string;
  // Domain id declared by the active network (e.g. 'seeker', 'provider').
  domain: string;
  context: Record<string, unknown>;
  schema_id: string | null;
  schema_version: string | null;
  // JSON Schema for the link's domain, from the network config. `null` for
  // `account_only` links, which render the identity-only form.
  schema: RJSFSchema | null;
  // Identity field names for the domain, used by the account-only form.
  identity?: { name?: string; phone?: string; email?: string };
  // Registration mode key (e.g. `voice`, `form`).
  registration_mode?: string;
  // Resolved form shape. Absent means `'account_and_profile'`.
  submission_shape?: 'account_only' | 'account_and_profile';
  // Optional i18n key for a hint rendered beneath the public form.
  public_hint_i18n_key?: string | null;
  expires_at: string | null;
}

interface PageProps {
  params: Promise<{ org: string; slug: string }>;
}

/**
 * Public anonymous registration page for a registration link.
 *
 * `org` is the aggregator's `org_slug` and `slug` is the link slug. Resolves the
 * link through the public API, loads the optional UI schema, and renders the
 * client view.
 */
export default async function PublicRegistrationPage({ params }: PageProps) {
  const { org, slug } = await params;

  // 1. Resolve link metadata via the public API.
  const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';
  let resolved: ResolveResponse;
  // Only the fetch is inside the try. `notFound()` throws, so it must be
  // called outside the try or the catch would swallow it.
  let res: Response;
  try {
    res = await fetch(
      `${apiBase}/public/v1/aggregators/${encodeURIComponent(org)}/links/${encodeURIComponent(slug)}`,
      { cache: 'no-store' },
    );
  } catch (err) {
    return (
      <ErrorShell
        title="Cannot reach registration service"
        message={err instanceof Error ? err.message : 'Network error.'}
      />
    );
  }
  if (res.status === 404) notFound();
  if (!res.ok) {
    return (
      <ErrorShell
        title="Link unavailable"
        message={`The registration link is not currently active (HTTP ${res.status}).`}
      />
    );
  }
  try {
    resolved = (await res.json()) as ResolveResponse;
  } catch (err) {
    return (
      <ErrorShell
        title="Cannot reach registration service"
        message={err instanceof Error ? err.message : 'Malformed response.'}
      />
    );
  }

  // 2. The schema comes in the resolve response. It must be an object unless
  // the link is `account_only`, where `null` is valid.
  const submissionShape = resolved.submission_shape ?? 'account_and_profile';
  const hintKey = resolved.public_hint_i18n_key ?? null;
  if (submissionShape !== 'account_only') {
    if (!resolved.schema || typeof resolved.schema !== 'object') {
      return (
        <ErrorShell
          title="Form unavailable"
          message={`Registration schema for "${resolved.domain}" is missing.`}
        />
      );
    }
  }
  if (!/^[a-z0-9_-]+$/i.test(resolved.domain)) {
    notFound();
  }
  // The view ignores `schema` for account_only links.
  const schema: RJSFSchema = resolved.schema ?? ({} as RJSFSchema);
  // Optional UI schema from config/<network>/schemas/participant/. Not read
  // for account_only links.
  let uiSchema: Record<string, unknown> = {};
  if (submissionShape !== 'account_only') {
    const uiFile = `${resolved.domain}.v1.ui.json`;
    try {
      uiSchema = JSON.parse(await readFile(resolveParticipantSchemaPath(uiFile), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      // UI schema is optional.
    }
  }

  // Participant Terms/Privacy content for the consent modal, read from config.
  const participantConsent = await loadParticipantConsent();

  return (
    <PublicRegistrationView
      org={org}
      slug={slug}
      network={resolved.network ?? ''}
      domain={resolved.domain}
      context={resolved.context}
      schema={schema}
      uiSchema={uiSchema}
      identity={resolved.identity}
      submissionShape={submissionShape}
      publicHintI18nKey={hintKey}
      registrationMode={resolved.registration_mode ?? null}
      consentContent={participantConsent}
    />
  );
}

function resolveParticipantSchemaPath(file: string): string {
  // Try several roots so this works in dev (cwd = apps/web) and in Docker
  // (cwd = /app). The first root comes from resolveSchemaRoot().
  const root = resolveSchemaRoot();
  const candidates = [
    path.resolve(root, 'participant', file),
    path.resolve(process.cwd(), 'config/schemas/participant', file),
    path.resolve(process.cwd(), '../../config/schemas/participant', file),
    path.resolve(process.cwd(), '../config/schemas/participant', file),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

function ErrorShell({ title, message }: { title: string; message: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-[#FBFCFE]">
      <div className="max-w-md text-center">
        <h1 className="font-display font-bold text-[22px] text-ink-900">{title}</h1>
        <p className="mt-3 text-[14px] text-ink-500 leading-relaxed">{message}</p>
      </div>
    </div>
  );
}
