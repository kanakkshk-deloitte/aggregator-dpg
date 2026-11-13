'use client';

import { useMemo, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '../../../components/ui/Button';
import { Topbar } from '../../../components/shell/Topbar';
import { I, type IconName } from '../../../icons';
import { useRecentBulkUploads, useRegistrationLinks } from '../../../hooks/useOnboarding';
import { useProfileRaw } from '../../../hooks/useProfile';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';
import { RecentUploadsBody } from './_components/CSVUpload';
import { YourLinksBody } from './_components/RegistrationLinksSection';
import { OnboardingMetrics } from './_components/OnboardingMetrics';

export default function OnboardingPage() {
  const t = useTranslations('onboarding');
  return (
    <div className="fade-up flex flex-col gap-3">
      <Topbar
        title={t('title')}
        subtitle={t('subtitle')}
        right={
          <button
            type="button"
            onClick={() => window.location.reload()}
            title={t('refresh')}
            aria-label={t('refresh')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-(--bd-border) bg-white text-[12.5px] font-semibold text-ink-700 hover:text-primary-600 hover:bg-(--bd-primary-50) transition-colors"
          >
            <I.refresh size={14} />
            {t('refresh')}
          </button>
        }
      />
      {/* Onboarding summary and joins by entry mode. */}
      <OnboardingMetrics />
      <BulkUploadCard />
      <RegistrationLinkCard />
    </div>
  );
}

/**
 * Summary card for bulk uploads, linking to /onboarding/bulk-uploads.
 *
 * Counts come from the recent uploads list.
 */
function BulkUploadCard() {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const recent = useRecentBulkUploads(50);
  const metrics = useMemo(() => {
    const items = recent.data?.items ?? [];
    let total = 0;
    let passed = 0;
    let failed = 0;
    let lastUploadAt: string | null = null;
    for (const it of items) {
      total += it.total_rows ?? 0;
      passed += it.passed ?? 0;
      failed += it.failed ?? 0;
      if (!lastUploadAt || it.created_at > lastUploadAt) lastUploadAt = it.created_at;
    }
    return { uploads: items.length, total, passed, failed, lastUploadAt };
  }, [recent.data]);

  return (
    <SummaryCard
      icon="upload"
      accent="primary"
      title={t('bulk_upload.title')}
      subtitle={t('bulk_upload.subtitle')}
      footnote={
        metrics.lastUploadAt
          ? t('bulk_upload.last_upload', { when: formatRelative(metrics.lastUploadAt) })
          : recent.isLoading
            ? t('bulk_upload.loading')
            : t('bulk_upload.no_uploads_yet')
      }
      metrics={[
        { label: t('bulk_upload.metrics.files_uploaded'), value: metrics.uploads, tone: 'ink' },
        { label: t('bulk_upload.metrics.rows'), value: metrics.total, tone: 'ink' },
        { label: t('bulk_upload.metrics.passed'), value: metrics.passed, tone: 'emerald' },
        { label: t('bulk_upload.metrics.failed'), value: metrics.failed, tone: 'rose' },
      ]}
      loading={recent.isLoading}
      ctaLabel={t('bulk_upload.cta')}
      onCta={() => router.push('/onboarding/bulk-uploads')}
      body={<RecentUploadsBody />}
    />
  );
}

/**
 * Summary card for registration links, linking to /onboarding/links.
 *
 * Counts come from the links list for the aggregator's type.
 */
function RegistrationLinkCard() {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const rawProfile = useProfileRaw();
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  // Use the network's first domain until the profile's type loads.
  const aggregatorType: string = rawProfile.data?.type ?? cfg.domains[0]?.id ?? '';
  const links = useRegistrationLinks(aggregatorType);
  const metrics = useMemo(() => {
    const items = links.data ?? [];
    let total = 0;
    let passed = 0;
    let active = 0;
    let lastCreatedAt: string | null = null;
    for (const l of items) {
      if (l.status === 'live') active += 1;
      total += l.metrics?.total ?? 0;
      passed += l.metrics?.passed ?? 0;
      if (!lastCreatedAt || l.created_at > lastCreatedAt) lastCreatedAt = l.created_at;
    }
    return { links: items.length, active, total, passed, lastCreatedAt };
  }, [links.data]);

  return (
    <SummaryCard
      icon="link"
      accent="amber"
      title={t('links.title')}
      subtitle={t('links.subtitle')}
      footnote={
        metrics.lastCreatedAt
          ? t('links.last_link', { when: formatRelative(metrics.lastCreatedAt) })
          : links.isLoading
            ? t('links.loading')
            : t('links.no_links_yet')
      }
      metrics={[
        { label: t('links.metrics.links'), value: metrics.links, tone: 'ink' },
        { label: t('links.metrics.active'), value: metrics.active, tone: 'emerald' },
        { label: t('links.metrics.registrations'), value: metrics.total, tone: 'ink' },
        { label: t('links.metrics.verified'), value: metrics.passed, tone: 'emerald' },
      ]}
      loading={links.isLoading}
      ctaLabel={t('links.cta')}
      onCta={() => router.push('/onboarding/links')}
      body={<YourLinksBody />}
    />
  );
}

type Accent = 'primary' | 'amber';

interface MetricItem {
  label: string;
  value: number;
  tone: 'ink' | 'emerald' | 'rose';
}

const ACCENT_BG: Record<Accent, string> = {
  primary: 'linear-gradient(180deg, var(--bd-tint-primary) 0%, var(--bd-card) 55%)',
  amber: 'linear-gradient(180deg, var(--bd-tint-amber) 0%, var(--bd-card) 55%)',
};

const ACCENT_ICON_RING: Record<Accent, string> = {
  primary: 'bg-(--bd-card) border border-(--bd-primary-100) text-primary-600',
  amber: 'bg-(--bd-card) border border-(--bd-border) text-amber-500',
};

interface SummaryCardProps {
  icon: IconName;
  accent: Accent;
  title: string;
  subtitle: string;
  footnote: ReactNode;
  metrics: MetricItem[];
  loading: boolean;
  ctaLabel: string;
  onCta: () => void;
  /** Optional body rendered below the action row inside the same card. */
  body?: ReactNode;
}

function SummaryCard({
  icon,
  accent,
  title,
  subtitle,
  footnote,
  metrics,
  loading,
  ctaLabel,
  onCta,
  body,
}: SummaryCardProps) {
  const Ic = I[icon];
  return (
    <div
      className="bd-card bd-shadow overflow-hidden flex flex-col transition-shadow hover:shadow-lg"
      style={{ background: ACCENT_BG[accent] }}
    >
      <div className="px-5 py-4 flex flex-col gap-3 flex-1">
        <div className="flex items-start gap-3">
          <div
            className={`w-10 h-10 rounded-[12px] flex items-center justify-center shrink-0 bd-shadow ${ACCENT_ICON_RING[accent]}`}
          >
            <Ic size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-display font-bold text-[15px] text-ink-900 leading-tight">
              {title}
            </div>
            <div className="text-[12px] text-ink-500 mt-0.5 leading-snug">{subtitle}</div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {metrics.map((m) => (
            <MetricTile key={m.label} {...m} loading={loading} />
          ))}
        </div>

        <div className="pt-2 border-t border-(--bd-border-soft) flex items-center justify-between gap-3 flex-wrap">
          <span className="text-[11.5px] text-ink-400">{footnote}</span>
          <Button onClick={onCta} icon={<I.arrowR size={14} />}>
            {ctaLabel}
          </Button>
        </div>

        {body && (
          <div className="pt-3 border-t border-(--bd-border-soft) bg-(--bd-card) -mx-5 -mb-4 px-5 pb-4 mt-1">
            {body}
          </div>
        )}
      </div>
    </div>
  );
}

function MetricTile({ label, value, tone, loading }: MetricItem & { loading: boolean }) {
  const toneCls =
    tone === 'emerald' ? 'text-emerald-600' : tone === 'rose' ? 'text-rose-600' : 'text-ink-900';
  return (
    <div className="bg-(--bd-card) border border-(--bd-border) rounded-[10px] px-3 py-2 flex flex-col gap-0.5">
      <div
        className={`font-display font-bold text-[18px] tabular-nums leading-none tracking-tight ${toneCls}`}
      >
        {loading ? '…' : value}
      </div>
      <div className="text-[11px] text-ink-500 font-medium">{label}</div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}
