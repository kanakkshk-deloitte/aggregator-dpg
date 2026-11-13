import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownContent } from '@/components/forms/MarkdownContent';

describe('<MarkdownContent />', () => {
  it('renders a heading from Markdown source', () => {
    render(<MarkdownContent content="# Terms of Service" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Terms of Service' })).toBeInTheDocument();
  });

  it('renders a paragraph', () => {
    render(<MarkdownContent content="Plain paragraph text." />);
    expect(screen.getByText('Plain paragraph text.')).toBeInTheDocument();
  });

  it('renders GFM lists', () => {
    render(<MarkdownContent content={'- one\n- two\n- three'} />);
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('renders links without enabling raw HTML execution', () => {
    render(<MarkdownContent content="[a link](https://example.com)" />);
    const link = screen.getByRole('link', { name: 'a link' });
    expect(link).toHaveAttribute('href', 'https://example.com');
  });

  it('does not render raw HTML tags (rehype-raw disabled)', () => {
    render(<MarkdownContent content="<script>window.__xss = true;</script>" />);
    expect(document.querySelector('script[data-injected]')).toBeNull();
    expect((window as unknown as { __xss?: boolean }).__xss).toBeUndefined();
  });

  it('renders an empty string without throwing', () => {
    const { container } = render(<MarkdownContent content="" />);
    expect(container.querySelector('div')).toBeInTheDocument();
  });
});
