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
  // Active signalstack network id (e.g. 'blue_dot' / 'orange_dot').
  // Optional in the type for back-compat with older API builds; the
  // lookup BFF gracefully no-ops when missing.
  network?: string;
  // Domain id is whatever the active network declares (e.g. 'seeker' /
  // 'provider' on blue/purple, 'tourist' / 'practitioner' on orange_dot).
  // No client-side allowlist — the API only returns domains it knows.
  domain: string;
  context: Record<string, unknown>;
  schema_id: string | null;
  schema_version: string | null;
  // JSON Schema for the link's domain, sourced from the network config
  // (signalstack network.json item_schemas). Inlined so the public page
  // renders the form without a second fetch and without reading from
  // disk — aggregator no longer keeps per-domain schema files.
  // `null` when the resolved `submission_shape === 'account_only'`: the
  // link is locked to identity-only capture and the form does not render
  // the RJSF profile tree.
  schema: RJSFSchema | null;
  // Identity field selectors for the domain. Used to relax required-field
  // validation for the account-only form. Optional for back-compat.
  identity?: { name?: string; phone?: string; email?: string };
  // Per-link admin-facing registration mode key (e.g. `voice`, `form`).
  registration_mode?: string;
  // Resolved form shape (from network config). Optional for back-compat
  // with older API builds — absent means `'account_and_profile'`.
  submission_shape?: 'account_only' | 'account_and_profile';
  // Optional i18n key for a hint rendered beneath the public form.
  public_hint_i18n_key?: string | null;
  expires_at: string | null;
}

interface PageProps {
  params: Promise<{ org: string; slug: string }>;
}

/**
 * Public anonymous registration page. The `(org, slug)` pair is the access
 * token — `org` is the aggregator's `org_slug`, `slug` is the per-link slug.
 * Resolves the link metadata against the public API, loads the matching
 * participant JSON Schema from disk, and hands both to the client renderer.
 */
export default async function PublicRegistrationPage({ params }: PageProps) {
  const { org, slug } = await params;

  // 1. Resolve link metadata via the public API.
  const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';
  let resolved: ResolveResponse;
  try {
    const res = await fetch(
      `${apiBase}/public/v1/aggregators/${encodeURIComponent(org)}/links/${encodeURIComponent(slug)}`,
      { cache: 'no-store' },
    );
    if (res.status === 404) notFound();
    if (!res.ok) {
      return (
        <ErrorShell
          title="Link unavailable"
          message={`The registration link is not currently active (HTTP ${res.status}).`}
        />
      );
    }
    resolved = (await res.json()) as ResolveResponse;
  } catch (err) {
    return (
      <ErrorShell
        title="Cannot reach registration service"
        message={err instanceof Error ? err.message : 'Network error.'}
      />
    );
  }

  // 2. Schema arrives inlined in the resolve response (sourced from the
  // network config). Aggregator no longer keeps per-domain schema files
  // on disk — signalstack network.json is the single source of truth.
  // Defence in depth: bail if the API returned a non-null but non-object
  // schema (malformed). `null` is valid for `account_only` links and
  // means the MinimalIdentityForm renders instead of the RJSF tree.
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
  // `schema` is null for account_only links — the RJSF form is not
  // rendered in that path. Cast to satisfy the view prop's RJSFSchema
  // type; the view ignores it when submissionShape === 'account_only'.
  const schema: RJSFSchema = resolved.schema ?? ({} as RJSFSchema);
  // Aggregator-side optional UI schema overlay (e.g. widget hints,
  // ordering). Lives under config/<network>/schemas/participant/.
  // Optional — RJSF renders defaults when absent. Skip the disk read
  // entirely for account_only links since no RJSF form is rendered.
  let uiSchema: Record<string, unknown> = {};
  if (submissionShape !== 'account_only') {
    const uiFile = `${resolved.domain}.v1.ui.json`;
    try {
      uiSchema = JSON.parse(await readFile(resolveParticipantSchemaPath(uiFile), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      // UI schema is optional — RJSF renders defaults without it.
    }
  }

  // Participant Terms/Privacy copy for the consent modal (interim: read from
  // the Signals-copied config file; later the Signals /consent/active API).
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
  // Walk a small set of plausible roots so the same code works in dev
  // (`pnpm --filter web dev`, cwd = apps/web) and in the docker standalone
  // build (cwd = /app, config copied via Dockerfile). Derives the schema
  // root from AGGREGATOR_NETWORK/AGGREGATOR_BRAND (or explicit SCHEMA_ROOT_DIR
  // override) via resolveSchemaRoot() so only two brand vars are needed.
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
