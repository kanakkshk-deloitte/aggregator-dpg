/**
 * Unit tests for the client-side support-attachment rules (#551). Mirrors
 * signals-dpg's `apps/ui/src/lib/__tests__/support-attachments.test.ts`, since
 * the two products must accept exactly the same files.
 */
import { describe, expect, it } from 'vitest';
import {
  encodeAttachments,
  fileToBase64,
  formatBytes,
  matchesAllowedType,
  pickerAccept,
  validateAttachmentSelection,
} from '@/lib/support-attachments';

const CONFIG = {
  maxFiles: 3,
  maxTotalBytes: 5 * 1024 * 1024,
  allowedTypes: ['image/png', 'image/jpeg', 'audio/mpeg'],
};

const file = (name: string, type: string, bytes = 64) =>
  new File([new Uint8Array(bytes)], name, { type });

describe('pickerAccept', () => {
  it('lists extensions alongside MIME types', () => {
    // macOS resolves `accept` through its UTI table, which does not map .m4a
    // onto audio/mp4 — an iPhone voice memo showed up greyed out in the picker
    // until the extensions were listed too.
    const accept = pickerAccept({
      allowedTypes: ['audio/mp4', 'image/png'],
      allowedExtensions: ['.m4a', '.png'],
    });
    expect(accept.split(',')).toEqual(['audio/mp4', 'image/png', '.m4a', '.png']);
  });

  it('tolerates an API that does not serve extensions yet', () => {
    expect(pickerAccept({ allowedTypes: ['image/png'] })).toBe('image/png');
  });
});

describe('matchesAllowedType', () => {
  it('matches exact types and wildcards', () => {
    expect(matchesAllowedType('image/png', CONFIG.allowedTypes)).toBe(true);
    expect(matchesAllowedType('image/gif', CONFIG.allowedTypes)).toBe(false);
    expect(matchesAllowedType('image/heic', ['image/*'])).toBe(true);
  });

  it('rejects an empty type, which the browser gives for unknown files', () => {
    expect(matchesAllowedType('', ['image/*'])).toBe(false);
  });
});

describe('validateAttachmentSelection', () => {
  it('counts and sizes the combined selection, not just the new files', () => {
    const current = [file('a.png', 'image/png'), file('b.png', 'image/png')];
    expect(
      validateAttachmentSelection(
        current,
        [file('c.png', 'image/png'), file('d.png', 'image/png')],
        CONFIG,
      ),
    ).toMatchObject({ ok: false, reason: 'count' });

    expect(
      validateAttachmentSelection(
        [file('a.png', 'image/png', 3000)],
        [file('b.png', 'image/png', 3000)],
        {
          ...CONFIG,
          maxTotalBytes: 4096,
        },
      ),
    ).toMatchObject({ ok: false, reason: 'size' });
  });

  it('names the offending file when the type is wrong', () => {
    expect(
      validateAttachmentSelection([], [file('notes.pdf', 'application/pdf')], CONFIG),
    ).toMatchObject({ ok: false, reason: 'type', filename: 'notes.pdf' });
  });
});

describe('fileToBase64 / encodeAttachments', () => {
  it('round-trips content, including past the chunk boundary', async () => {
    expect(atob(await fileToBase64(new File(['hello'], 'a.txt', { type: 'text/plain' })))).toBe(
      'hello',
    );
    // 0x8000 is the chunk size; spreading this many bytes at once would blow
    // the call stack, which is why the encoder chunks.
    const big = new Uint8Array(200_000).fill(7);
    const encoded = await fileToBase64(new File([big], 'big.bin', { type: 'image/png' }));
    expect(atob(encoded)).toHaveLength(200_000);
  });

  it('substitutes a concrete content type when the browser gives none', async () => {
    const encoded = await encodeAttachments([file('mystery', '', 3)]);
    expect(encoded[0]!.contentType).toBe('application/octet-stream');
  });
});

describe('formatBytes', () => {
  it('matches the API formatting so both messages read the same', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
