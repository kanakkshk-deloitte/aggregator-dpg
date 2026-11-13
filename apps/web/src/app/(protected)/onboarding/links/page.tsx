'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Topbar } from '../../../../components/shell/Topbar';
import { I } from '../../../../icons';
import { CreateLinkSection } from '../_components/RegistrationLinksSection';

export default function RegistrationLinksPage() {
  const t = useTranslations('onboarding');
  const router = useRouter();
  return (
    <div className="fade-up flex flex-col gap-5">
      <Topbar
        title={t('links_page.title')}
        subtitle={t('links_page.subtitle')}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => router.push('/onboarding')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-(--bd-border) bg-white text-[12.5px] font-semibold text-ink-700 hover:text-primary-600 hover:bg-(--bd-primary-50) transition-colors"
            >
              <I.chevL size={14} />
              {t('links_page.back')}
            </button>
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
          </div>
        }
      />
      <CreateLinkSection />
    </div>
  );
}
