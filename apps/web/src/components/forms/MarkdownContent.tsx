'use client';
/**
 * Renders sanitised GFM Markdown content using react-markdown.
 *
 * Does not enable rehype-raw so no raw HTML in the source is executed.
 * Safe for untrusted content coming from config files.
 *
 * @module apps/web/src/components/forms/MarkdownContent
 */
import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Props for {@link MarkdownContent}. */
export interface MarkdownContentProps {
  /** GFM Markdown string to render. */
  content: string;
}

/**
 * Renders a GFM Markdown string as sanitised HTML inside a prose container.
 *
 * @param props - The Markdown content string to render.
 * @returns A div containing the rendered Markdown.
 */
export function MarkdownContent({ content }: MarkdownContentProps): JSX.Element {
  // No @tailwindcss/typography here and preflight strips default styles, so each
  // element is styled with descendant variants. Matches the Signals-DPG renderer.
  return (
    <div
      className="text-[14px] leading-relaxed text-ink-700 space-y-3
        [&_h1]:text-xl [&_h1]:font-bold [&_h1]:text-ink-900 [&_h1]:mt-1
        [&_h2]:text-lg [&_h2]:font-bold [&_h2]:text-ink-900 [&_h2]:mt-1
        [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:text-ink-900 [&_h3]:mt-4 [&_h3]:mb-1
        [&_p]:text-ink-700
        [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1
        [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:space-y-1
        [&_li]:text-ink-700
        [&_a]:font-medium [&_a]:text-(--bd-primary) [&_a]:underline
        [&_strong]:font-semibold [&_strong]:text-ink-900
        [&_table]:w-full [&_table]:border-collapse [&_table]:my-3 [&_table]:text-[13px]
        [&_th]:border [&_th]:border-slate-200 [&_th]:p-2 [&_th]:text-left [&_th]:font-semibold [&_th]:text-ink-900 [&_th]:bg-slate-50
        [&_td]:border [&_td]:border-slate-200 [&_td]:p-2 [&_td]:align-top
        [&_img]:max-w-full [&_img]:rounded [&_img]:my-2
        [&_blockquote]:border-l-4 [&_blockquote]:border-slate-200 [&_blockquote]:pl-4 [&_blockquote]:italic
        [&_code]:bg-slate-100 [&_code]:rounded-sm [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[13px]
        [&_hr]:border-slate-200 [&_hr]:my-4"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
