'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Topbar } from '../../../../components/shell/Topbar';
import { I } from '../../../../icons';
import { CSVUpload } from './CSVUpload';
import type { BulkAttestationContent } from '../../../../lib/bulk-attestation.server';

/** Props for {@link BulkUploadsClient}. */
export interface BulkUploadsClientProps {
  /** Operator attestation copy shown before upload; null → generic label. */
  attestation: BulkAttestationContent | null;
}

/**
 * Client body of the bulk-uploads page. The attestation statement is loaded
 * server-side (page.tsx) and threaded into {@link CSVUpload} as a prop — no
 * API round-trip, matching the registration consent flow.
 */
export function BulkUploadsClient({ attestation }: BulkUploadsClientProps): JSX.Element {
  const t = useTranslations('onboarding');
  const router = useRouter();
  return (
    <div className="fade-up flex flex-col gap-5">
      <Topbar
        title={t('bulk_uploads_page.title')}
        subtitle={t('bulk_uploads_page.subtitle')}
        right={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.push('/onboarding')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-[var(--bd-border)] bg-white text-[12.5px] font-semibold text-ink-700 hover:text-primary-600 hover:bg-[var(--bd-primary-50)] transition-colors"
            >
              <I.chevL size={14} />
              {t('bulk_uploads_page.back')}
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              title={t('refresh')}
              aria-label={t('refresh')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-[var(--bd-border)] bg-white text-[12.5px] font-semibold text-ink-700 hover:text-primary-600 hover:bg-[var(--bd-primary-50)] transition-colors"
            >
              <I.refresh size={14} />
              {t('refresh')}
            </button>
          </div>
        }
      />
      <CSVUpload attestation={attestation} />
    </div>
  );
}
