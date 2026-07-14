'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { useTranslations, useFormatter } from 'next-intl';
import { Button } from '../../../../components/ui/Button';
import { Dropzone } from '../../../../components/ui/Dropzone';
import { I } from '../../../../icons';
import { useBulkUpload, useRecentBulkUploads } from '../../../../hooks/useOnboarding';
import { useProfileRaw } from '../../../../hooks/useProfile';
import {
  useAggregatorConfig,
  DEFAULT_AGGREGATOR_CONFIG,
} from '../../../../hooks/useAggregatorConfig';
import type { BulkUploadStatus } from '../../../../services/onboarding.service';
import { onboardingService } from '../../../../services/onboarding.service';

// Module-level so its identity is stable across CSVUpload re-renders. Defining
// it inline re-created the component every render, remounting the toast and
// restarting its timer — which read as the message flickering/switching fast.
function UploadToast({ message, onDone }: { message: string; onDone: () => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const timer = setTimeout(onDone, 6000);
    return () => clearTimeout(timer);
  }, [onDone]);
  if (!mounted) return null;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 right-4 z-[100] max-w-sm rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700 shadow-lg inline-flex items-start gap-2"
    >
      <I.check size={14} className="mt-0.5 shrink-0" /> <span>{message}</span>
    </div>,
    document.body,
  );
}

export function CSVUpload() {
  const t = useTranslations('onboarding');
  const rawProfile = useProfileRaw();
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  // Aggregator registered participant focus, mirrored from the
  // `aggregator_type` KC claim. Falls back to the network's first declared
  // domain (networks.json order) while the profile loads — the upload submit
  // path is gated by the API anyway, so a transient mismatch is harmless.
  const aggregatorType: string = rawProfile.data?.type ?? cfg.domains[0]?.id ?? '';
  // Plural label for the scoped domain, sourced from network config.
  const aggregatorTypeLabel =
    cfg.domains.find((d) => d.id === aggregatorType)?.plural_label ?? aggregatorType;
  const [participantType, setParticipantType] = useState<string>(aggregatorType);
  useEffect(() => {
    if (rawProfile.data?.type) setParticipantType(rawProfile.data.type);
  }, [rawProfile.data?.type]);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = useBulkUpload();
  const recent = useRecentBulkUploads(10);
  const router = useRouter();

  const acceptFile = (f: File) => {
    if (!/\.csv$/i.test(f.name)) {
      setUploadError('Only .csv files are accepted.');
      return;
    }
    setPickedFile(f);
    setUploadError(null);
    setUploadNotice(null);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) acceptFile(f);
  };

  const onDropFiles = (files: File[]) => {
    const f = files[0];
    if (f) acceptFile(f);
  };

  const onUpload = async () => {
    if (!pickedFile) return;
    setUploadError(null);
    setUploadNotice(null);
    try {
      const result = await upload.mutateAsync({ file: pickedFile, participantType });
      setPickedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (result.duplicate) {
        setUploadNotice(
          result.message ?? 'This CSV was already uploaded earlier — showing the existing run.',
        );
        recent.refetch();
        return;
      }
      // Stay on the page so the success note is readable and the just-uploaded
      // run appears in the recent-uploads list below. Processing continues in
      // the worker. (Previously navigated to /onboarding immediately, which
      // unmounted the toast before it could be read.)
      setToast(t('csv.success_note'));
      recent.refetch();
      // Let the success toast be read, then return to the onboarding overview.
      // A short delay (not an immediate push) avoids unmounting the toast the
      // instant it appears — the bug the previous "navigate immediately" had.
      setTimeout(() => router.push('/onboarding'), 2500);
    } catch (err) {
      setUploadError((err as Error).message);
    }
  };

  const downloadTemplate = () => {
    window.location.href = `/api/bulk-uploads/template?participant_type=${participantType}`;
  };

  return (
    <div className="bd-card bd-shadow p-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <div className="font-display font-bold text-[16px] text-ink-900">{t('csv.title')}</div>
          <div className="text-[12.5px] text-ink-400 mt-0.5">{t('csv.subtitle')}</div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/*
           * Aggregators are scoped to a single participant type (seeker OR
           * provider). The opposite button is omitted, not just disabled, so
           * the UI matches what the API enforces: one tile per aggregator.
           */}
          {/*
           * Render as a passive label, not a button — aggregators are
           * scoped to one participant type so the chip is informational
           * only. Plain <div> avoids hover/cursor cues that suggest
           * the value is changeable.
           */}
          <div
            className="flex items-center bg-ink-50 border border-[var(--bd-border)] rounded-[10px] p-0.5"
            aria-label={`Participant type: ${aggregatorTypeLabel}`}
          >
            {aggregatorTypeLabel && (
              <div className="px-3 py-1.5 rounded-[8px] text-[12.5px] font-semibold bg-white text-primary-600 bd-shadow select-none">
                {aggregatorTypeLabel}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={downloadTemplate}
            className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary-600 hover:underline"
          >
            <I.download size={14} /> {t('csv.download_template')}
          </button>
        </div>
      </div>

      <Dropzone onFiles={onDropFiles}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          onChange={onPick}
          className="hidden"
          id="csv-file-input"
        />
        {pickedFile ? (
          // Selected-file chip with explicit × dismissal. Cleared state +
          // resets the file input so the same filename can be re-picked.
          <div className="flex items-center justify-center gap-2">
            <div className="inline-flex items-center gap-2 max-w-full px-3 py-2 rounded-[10px] bg-[var(--bd-primary-50)] border border-[var(--bd-primary-100)]">
              <I.upload size={14} className="text-primary-600 shrink-0" />
              <span className="text-[13.5px] font-semibold text-primary-700 truncate">
                {pickedFile.name}
              </span>
              <span className="text-[11.5px] text-ink-400 shrink-0">
                {(pickedFile.size / 1024).toFixed(1)} KB
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setPickedFile(null);
                  setUploadError(null);
                  setUploadNotice(null);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
                title={t('csv.remove_file')}
                aria-label={t('csv.remove_file')}
                className="inline-flex items-center justify-center w-6 h-6 rounded-full text-ink-500 hover:text-rose-600 hover:bg-rose-50 transition-colors shrink-0"
              >
                <I.x size={13} />
              </button>
            </div>
          </div>
        ) : (
          <label htmlFor="csv-file-input" className="cursor-pointer block text-center">
            <div className="w-12 h-12 mx-auto rounded-full bg-white border border-[var(--bd-border)] flex items-center justify-center text-primary-600 mb-3 bd-shadow">
              <I.upload size={20} />
            </div>
            <div className="text-[14px] font-semibold text-ink-700">
              {t('csv.drag_prompt')}{' '}
              <span className="text-primary-600 underline-offset-2">{t('csv.browse')}</span>
            </div>
            <div className="text-[12px] text-ink-400 mt-1">
              {t('csv.hint', { type: participantType })}
            </div>
          </label>
        )}
      </Dropzone>

      <div className="flex items-center justify-between mt-4">
        <div className="text-[12px] text-ink-400 flex items-center gap-2">
          <I.shield size={14} className="text-emerald-500" /> {t('csv.security_note')}
        </div>
        <Button onClick={onUpload} disabled={!pickedFile || upload.isPending}>
          {upload.isPending ? t('csv.uploading') : t('csv.upload_button')}
        </Button>
      </div>

      {uploadError && (
        <div className="mt-3 text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-[10px] px-3 py-2">
          {uploadError}
        </div>
      )}
      {uploadNotice && (
        <div className="mt-3 text-[12.5px] text-amber-800 bg-amber-50 border border-amber-200 rounded-[10px] px-3 py-2">
          {uploadNotice}
        </div>
      )}
      {toast && <UploadToast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

/**
 * Body-only "Recent uploads" table. Designed to be rendered INSIDE another
 * card shell (the merged Bulk Upload section on the onboarding landing).
 * No outer card padding/border — the parent owns the chrome.
 */
export function RecentUploadsBody() {
  const t = useTranslations('onboarding');
  const recent = useRecentBulkUploads(10);
  const items = recent.data?.items ?? [];
  const error = recent.error as Error | null;
  const loading = recent.isLoading;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="font-display font-bold text-[14px] text-ink-700">
          {t('csv.recent.title')}
        </div>
        <span className="text-[12px] text-ink-400">
          {t('csv.recent.shown_count', { count: items.length })}
        </span>
      </div>
      <div className="overflow-auto scroll-x" style={{ maxHeight: 360 }}>
        <table className="bd-table" style={{ minWidth: 800 }}>
          <thead
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 2,
              background: 'var(--bd-table-head-bg)',
            }}
          >
            <tr>
              <th>{t('csv.recent.col_uploaded')}</th>
              <th style={{ textAlign: 'center' }}>{t('csv.recent.col_type')}</th>
              <th style={{ textAlign: 'center' }}>{t('csv.recent.col_status')}</th>
              <th style={{ textAlign: 'center' }}>{t('csv.recent.col_total')}</th>
              <th style={{ textAlign: 'center' }}>{t('csv.recent.col_passed')}</th>
              <th style={{ textAlign: 'center' }}>{t('csv.recent.col_failed')}</th>
              <th style={{ textAlign: 'center' }}>{t('csv.recent.col_skipped')}</th>
              <th style={{ minWidth: 240 }}>{t('csv.recent.col_reason')}</th>
            </tr>
          </thead>
          <tbody>
            {error && (
              <tr>
                <td colSpan={8} className="text-rose-600 text-[13px] py-6 text-center">
                  {error.message}
                </td>
              </tr>
            )}
            {!error && items.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="text-ink-400 text-[13px] py-8 text-center">
                  {t('csv.recent.no_uploads')}
                </td>
              </tr>
            )}
            {items.map((it) => (
              <UploadRow key={it.upload_id} upload={it} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UploadRow({ upload }: { upload: BulkUploadStatus }) {
  const t = useTranslations('onboarding');
  const format = useFormatter();
  const [downloading, setDownloading] = useState(false);

  const onDownloadErrors = async () => {
    setDownloading(true);
    try {
      const res = await onboardingService.errorsCsvUrl(upload.upload_id);
      window.open(res.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      console.warn('errors download failed', err);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <tr>
      <td className="text-[12.5px] text-ink-700 whitespace-nowrap">
        <div className="font-semibold">{formatRelative(upload.created_at)}</div>
        <div className="text-[11px] text-ink-400">
          {format.dateTime(new Date(upload.created_at), {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
      </td>
      <td style={{ textAlign: 'center' }}>
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-[11.5px] ${
            upload.participant_type === 'seeker'
              ? 'bg-amber-50 text-amber-700'
              : 'bg-sky-50 text-sky-700'
          }`}
        >
          {upload.participant_type}
        </span>
      </td>
      <td style={{ textAlign: 'center' }}>
        <UploadStatusBadge status={upload.status} />
      </td>
      <td style={{ textAlign: 'center' }} className="tabular-nums font-semibold">
        {upload.total_rows ?? '—'}
      </td>
      <td style={{ textAlign: 'center' }} className="tabular-nums text-emerald-600 font-semibold">
        {upload.passed}
      </td>
      <td style={{ textAlign: 'center' }} className="tabular-nums text-rose-600 font-semibold">
        {upload.failed}
      </td>
      <td style={{ textAlign: 'center' }} className="tabular-nums text-amber-700 font-semibold">
        {upload.skipped}
      </td>
      <td className="text-[12px]">
        {upload.status === 'completed' && upload.failed > 0 && upload.errors_csv_s3_key ? (
          <button
            type="button"
            onClick={onDownloadErrors}
            disabled={downloading}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[8px] bg-[var(--bd-primary-50)] text-primary-600 font-semibold hover:bg-[var(--bd-primary-100)] disabled:opacity-60"
          >
            <I.download size={12} />
            {downloading ? t('csv.recent.signing') : 'errors.csv'}
          </button>
        ) : upload.status === 'completed' ? (
          <span className="text-emerald-600">{t('csv.recent.all_rows_passed')}</span>
        ) : upload.status_reason ? (
          <span
            title={upload.status_reason}
            className="text-rose-600 block whitespace-pre-line break-words max-w-[240px] align-middle leading-snug"
          >
            {upload.status_reason.replace(/,\s*/g, ',\n')}
          </span>
        ) : (
          <span className="text-ink-300">—</span>
        )}
      </td>
    </tr>
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

function UploadStatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; tone: string }> = {
    pending: { bg: 'bg-ink-50', tone: 'text-ink-600' },
    uploaded: { bg: 'bg-sky-50', tone: 'text-sky-700' },
    file_validating: { bg: 'bg-amber-50', tone: 'text-amber-700' },
    file_failed: { bg: 'bg-rose-50', tone: 'text-rose-700' },
    row_processing: { bg: 'bg-amber-50', tone: 'text-amber-700' },
    finalising: { bg: 'bg-amber-50', tone: 'text-amber-700' },
    completed: { bg: 'bg-emerald-50', tone: 'text-emerald-700' },
    failed: { bg: 'bg-rose-50', tone: 'text-rose-700' },
  };
  const cfg = map[status] ?? { bg: 'bg-ink-50', tone: 'text-ink-600' };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-[11.5px] ${cfg.bg} ${cfg.tone}`}
    >
      {status}
    </span>
  );
}
