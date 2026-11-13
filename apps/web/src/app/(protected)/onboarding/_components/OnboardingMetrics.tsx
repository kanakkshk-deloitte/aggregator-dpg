'use client';

/**
 * Coordinator-wide onboarding metrics section for the Onboarding page (`web` app).
 *
 * Renders the Total / Verified / Failed / Skipped stat cards and the
 * joins-by-entry-mode bar. Data comes from `/v1/onboarding/summary` and
 * `/v1/onboarding/by-source`, not signalstack.
 */
import { useTranslations } from 'next-intl';
import { Button } from '../../../../components/ui/Button';
import { I, type IconName } from '../../../../icons';
import { useOnboardingSummary, useOnboardingBySource } from '../../../../hooks/useOnboarding';

/** Tone classes per onboarding outcome card (colored chip + value). */
const ONBOARDING_TONES = {
  total: {
    chip: 'bg-(--bd-primary-50) text-(--bd-primary-600)',
    value: 'text-ink-900',
  },
  passed: { chip: 'bg-emerald-50 text-emerald-600', value: 'text-emerald-700' },
  failed: { chip: 'bg-rose-50 text-rose-600', value: 'text-rose-600' },
  skipped: { chip: 'bg-ink-100 text-ink-500', value: 'text-ink-400' },
} as const;

type OnboardingTone = keyof typeof ONBOARDING_TONES;

/**
 * Display settings for each `onboarding_source` value.
 *
 * A new source needs an entry here and a `dashboard.onboardingGroup.mode_<source>`
 * i18n string. Sources missing here still render with a fallback.
 */
const ONBOARDING_MODES: Record<string, { icon: IconName; color: string; labelKey: string }> = {
  bulk: { icon: 'upload', color: '#10B981', labelKey: 'onboardingGroup.mode_bulk' },
  link: { icon: 'link', color: 'var(--bd-primary-600)', labelKey: 'onboardingGroup.mode_link' },
  qr: { icon: 'qr', color: '#F59E0B', labelKey: 'onboardingGroup.mode_qr' },
};

/** Fallback colours for sources missing from the registry. */
const ONBOARDING_FALLBACK_COLORS = ['#8B91A3', '#0EA5E9', '#EC4899', '#8B5CF6'];

/**
 * Resolves the display settings for one entry source, with a fallback for unknown sources.
 *
 * @param source - The `onboarding_source` value from the API.
 * @param index - The slice's position, used to cycle fallback colours.
 * @returns Icon name, colour, and i18n label key (or null when unregistered).
 */
function onboardingModeMeta(
  source: string,
  index: number,
): { icon: IconName; color: string; labelKey: string | null } {
  return (
    ONBOARDING_MODES[source] ?? {
      icon: 'spark',
      color: ONBOARDING_FALLBACK_COLORS[index % ONBOARDING_FALLBACK_COLORS.length]!,
      labelKey: null,
    }
  );
}

/**
 * Title-cases an entry-source key for display when no i18n label exists.
 *
 * @param key - Raw source key (e.g. `partner_referral`).
 * @returns The key with separators stripped and each word capitalised.
 */
function statusLabel(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Formats a metric count for display, capping fractional values at 2 dp.
 *
 * @param n - The raw count (nullable while loading).
 * @returns Localised number string, or an em dash when absent.
 */
function fmtCount(n: number | null | undefined): string {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** One onboarding-outcome stat card (colored chip + value + sub-label). */
function OnboardingStatCard({
  tone,
  icon,
  label,
  value,
  sub,
}: {
  tone: OnboardingTone;
  icon: IconName;
  label: string;
  value: string;
  sub: string;
}) {
  const t = ONBOARDING_TONES[tone];
  const Ic = I[icon];
  return (
    <div className="bd-card p-4 flex flex-col gap-2.5">
      <div className={`w-8 h-8 rounded-[9px] flex items-center justify-center ${t.chip}`}>
        <Ic size={16} />
      </div>
      <div className="text-[13px] text-ink-500 font-semibold">{label}</div>
      <div
        className={`font-display font-bold text-[26px] leading-none tracking-tight -mt-0.5 ${t.value}`}
      >
        {value}
      </div>
      <div className="text-[12px] text-ink-400 font-medium -mt-1">{sub}</div>
    </div>
  );
}

/**
 * Coordinator-wide onboarding metrics: summary stat cards + joins-by-mode bar.
 *
 * @returns The onboarding metrics section for the Onboarding page.
 */
export function OnboardingMetrics() {
  const t = useTranslations('dashboard');
  const summary = useOnboardingSummary();
  const bySource = useOnboardingBySource();

  const slices = bySource.data?.by_source ?? [];
  const totalJoins = slices.reduce((acc, s) => acc + s.passed, 0);
  const pct = (n: number): string =>
    totalJoins > 0 ? `${Math.round((n / totalJoins) * 1000) / 10}%` : '0%';

  return (
    <section>
      <div className="flex items-center justify-between gap-4 flex-wrap mb-1">
        <span className="text-[11.5px] font-bold uppercase tracking-[.09em] text-ink-400">
          {t('onboardingGroup.title')}
        </span>
      </div>
      <div className="text-[13px] text-ink-400 font-medium mb-3.5">
        {t('onboardingGroup.helper')}
      </div>

      {summary.isError ? (
        <div className="bd-card p-5 flex items-center gap-4 flex-wrap border-rose-200 bg-rose-50/50">
          <div className="w-10 h-10 rounded-[11px] bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
            <I.alert size={19} />
          </div>
          <div className="flex-1 min-w-[200px]">
            <div className="text-[14.5px] font-bold text-ink-900">
              {t('onboardingGroup.error_title')}
            </div>
            <div className="text-[13px] text-ink-500 mt-0.5">{t('onboardingGroup.error_body')}</div>
          </div>
          <Button
            kind="ghost"
            icon={<I.refresh size={14} />}
            onClick={() => {
              void summary.refetch();
              void bySource.refetch();
            }}
          >
            {t('onboardingGroup.retry')}
          </Button>
        </div>
      ) : summary.isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="bd-card p-4 animate-pulse">
              <div className="w-8 h-8 rounded-[9px] bg-ink-100" />
              <div className="h-3 w-2/3 rounded-md bg-ink-100 mt-3.5" />
              <div className="h-6 w-2/5 rounded-md bg-ink-100 mt-3" />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <OnboardingStatCard
              tone="total"
              icon="users"
              label={t('onboardingGroup.total')}
              value={fmtCount(summary.data?.total)}
              sub={t('onboardingGroup.total_sub')}
            />
            <OnboardingStatCard
              tone="passed"
              icon="shield"
              label={t('onboardingGroup.passed')}
              value={fmtCount(summary.data?.passed)}
              sub={t('onboardingGroup.passed_sub')}
            />
            <OnboardingStatCard
              tone="failed"
              icon="alert"
              label={t('onboardingGroup.failed')}
              value={fmtCount(summary.data?.failed)}
              sub={t('onboardingGroup.failed_sub')}
            />
            <OnboardingStatCard
              tone="skipped"
              icon="pause"
              label={t('onboardingGroup.skipped')}
              value={fmtCount(summary.data?.skipped)}
              sub={t('onboardingGroup.skipped_sub')}
            />
          </div>

          {slices.length > 0 && (
            <div className="bd-card p-5 mt-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[14px] font-bold text-ink-700">
                  {t('onboardingGroup.byMode')}
                </div>
                <div className="text-[12.5px] text-ink-400 tabular-nums">
                  {t('onboardingGroup.joins', { count: totalJoins })}
                </div>
              </div>
              <div className="flex h-3 rounded-full overflow-hidden bg-ink-100 mt-3.5 mb-4 gap-0.5">
                {slices.map((s, i) => (
                  <div
                    key={s.source}
                    className="rounded-full"
                    style={{
                      width: pct(s.passed),
                      background: onboardingModeMeta(s.source, i).color,
                    }}
                  />
                ))}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {slices.map((s, i) => {
                  const meta = onboardingModeMeta(s.source, i);
                  const Ic = I[meta.icon];
                  return (
                    <div key={s.source} className="flex items-center gap-3 min-w-0">
                      <span
                        className="w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0 bg-ink-50"
                        style={{ color: meta.color }}
                      >
                        <Ic size={17} />
                      </span>
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-semibold text-ink-500 whitespace-nowrap">
                          {meta.labelKey ? t(meta.labelKey) : statusLabel(s.source)}
                        </div>
                        <div className="flex items-baseline gap-2 mt-0.5">
                          <span className="font-display font-bold text-[20px] text-ink-900 tabular-nums leading-none">
                            {s.passed}
                          </span>
                          <span className="text-[12px] text-ink-400 tabular-nums">
                            {pct(s.passed)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
