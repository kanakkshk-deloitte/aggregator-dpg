import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SubmitBlockers } from '@/components/ui/SubmitBlockers';

describe('<SubmitBlockers />', () => {
  it('renders nothing when reasons is empty', () => {
    const { container } = render(<SubmitBlockers reasons={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders each reason as a list item', () => {
    render(<SubmitBlockers reasons={['Missing phone number', 'Missing consent']} />);
    expect(screen.getByText('Missing phone number')).toBeInTheDocument();
    expect(screen.getByText('Missing consent')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders the optional heading when provided', () => {
    render(<SubmitBlockers reasons={['One issue']} heading="To submit:" />);
    expect(screen.getByText('To submit:')).toBeInTheDocument();
  });

  it('omits the heading block when not provided', () => {
    render(<SubmitBlockers reasons={['One issue']} />);
    expect(screen.queryByText('To submit:')).toBeNull();
  });

  it('exposes an accessible live region for screen readers', () => {
    render(<SubmitBlockers reasons={['One issue']} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
