import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Dropzone } from '@/components/ui/Dropzone';

function makeFile(name: string): File {
  return new File(['content'], name, { type: 'text/csv' });
}

describe('<Dropzone />', () => {
  it('renders its children', () => {
    render(
      <Dropzone>
        <span>drop here</span>
      </Dropzone>,
    );
    expect(screen.getByText('drop here')).toBeInTheDocument();
  });

  it('calls onFiles with the dropped files', () => {
    const onFiles = vi.fn();
    render(
      <Dropzone onFiles={onFiles}>
        <span>drop zone</span>
      </Dropzone>,
    );
    const zone = screen.getByText('drop zone').parentElement as HTMLElement;
    const file = makeFile('a.csv');
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0]![0]).toEqual([file]);
  });

  it('does not throw when onFiles is not provided', () => {
    render(
      <Dropzone>
        <span>no handler</span>
      </Dropzone>,
    );
    const zone = screen.getByText('no handler').parentElement as HTMLElement;
    expect(() =>
      fireEvent.drop(zone, { dataTransfer: { files: [makeFile('b.csv')] } }),
    ).not.toThrow();
  });

  it('handles dragOver and dragLeave without throwing', () => {
    render(
      <Dropzone>
        <span>hover me</span>
      </Dropzone>,
    );
    const zone = screen.getByText('hover me').parentElement as HTMLElement;
    fireEvent.dragOver(zone);
    fireEvent.dragLeave(zone);
    // No visible assertion beyond "did not throw" — hover state is purely
    // internal and not surfaced as a class in this component's markup.
    expect(zone).toBeInTheDocument();
  });

  it('merges a custom className', () => {
    render(
      <Dropzone className="extra">
        <span>styled</span>
      </Dropzone>,
    );
    const zone = screen.getByText('styled').parentElement as HTMLElement;
    expect(zone).toHaveClass('dropzone');
    expect(zone).toHaveClass('extra');
  });
});
