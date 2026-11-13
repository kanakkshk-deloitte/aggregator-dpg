import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const readFileMock = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  default: { readFile: readFileMock },
}));

const existsSyncMock = vi.fn();
vi.mock('node:fs', () => ({ existsSync: existsSyncMock, default: { existsSync: existsSyncMock } }));

vi.mock('@/lib/config-paths', () => ({ resolveSchemaRoot: () => '/config/schemas' }));

// Silence structured logging in the API-fetch path.
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { loadParticipantConsent } = await import('@/lib/participant-consent.server');

function validDoc(overrides: Record<string, unknown> = {}) {
  return {
    documents: {
      terms: {
        current_version: 2,
        versions: [
          { version: 1, title: 'Terms v1', content: 'old' },
          { version: 2, title: 'Terms v2', content: 'Contact us at __SUPPORT_EMAIL__' },
        ],
      },
      privacy: {
        current_version: 1,
        versions: [{ version: 1, title: 'Privacy v1', content: 'privacy body' }],
      },
      ...overrides,
    },
  };
}

/** Fetch mock for `GET /v1/participant-consent` returning `{ participant_consent }`. */
function apiConsent(doc: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ participant_consent: doc }),
  } as unknown as Response;
}

describe('loadParticipantConsent', () => {
  beforeEach(() => {
    readFileMock.mockReset();
    existsSyncMock.mockReset();
    delete process.env.CONSENT_SUPPORT_EMAIL;
    // Default: API serves no document, so tests exercise the on-disk fallback
    // unless they opt into an API document explicitly.
    global.fetch = vi.fn().mockResolvedValue(apiConsent(null)) as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env.CONSENT_SUPPORT_EMAIL;
    vi.restoreAllMocks();
  });

  describe('API source', () => {
    it('shapes the API document, rendering __SUPPORT_EMAIL__ (no disk read)', async () => {
      existsSyncMock.mockReturnValue(false);
      global.fetch = vi.fn().mockResolvedValue(apiConsent(validDoc())) as unknown as typeof fetch;
      const result = await loadParticipantConsent();
      expect(result!.terms).toEqual({
        version: 2,
        title: 'Terms v2',
        content: 'Contact us at hello@bluedotseconomy.org',
      });
      expect(result!.privacy).toEqual({ version: 1, title: 'Privacy v1', content: 'privacy body' });
      expect(readFileMock).not.toHaveBeenCalled();
    });

    it('includes profileCreation from the API document', async () => {
      existsSyncMock.mockReturnValue(false);
      global.fetch = vi.fn().mockResolvedValue(
        apiConsent(
          validDoc({
            profile_creation: {
              current_version: 1,
              versions: [{ version: 1, statement: 'I consent, contact __SUPPORT_EMAIL__' }],
            },
          }),
        ),
      ) as unknown as typeof fetch;
      const result = await loadParticipantConsent();
      expect(result!.profileCreation).toEqual({
        version: 1,
        statement: 'I consent, contact hello@bluedotseconomy.org',
      });
    });

    it('renders CONSENT_SUPPORT_EMAIL when set', async () => {
      process.env.CONSENT_SUPPORT_EMAIL = 'support@example.org';
      existsSyncMock.mockReturnValue(false);
      global.fetch = vi.fn().mockResolvedValue(apiConsent(validDoc())) as unknown as typeof fetch;
      const result = await loadParticipantConsent();
      expect(result!.terms.content).toBe('Contact us at support@example.org');
    });
  });

  describe('on-disk fallback', () => {
    it('falls back to the on-disk copy when the API serves no document', async () => {
      existsSyncMock.mockReturnValue(true);
      readFileMock.mockResolvedValue(JSON.stringify(validDoc()));
      const result = await loadParticipantConsent();
      expect(result!.terms.title).toBe('Terms v2');
      expect(readFileMock).toHaveBeenCalled();
    });

    it('falls back to disk when the API fetch fails', async () => {
      existsSyncMock.mockReturnValue(true);
      readFileMock.mockResolvedValue(JSON.stringify(validDoc()));
      global.fetch = vi
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
      const result = await loadParticipantConsent();
      expect(result!.terms.title).toBe('Terms v2');
    });

    it('falls back to disk when the API returns a non-2xx', async () => {
      existsSyncMock.mockReturnValue(true);
      readFileMock.mockResolvedValue(JSON.stringify(validDoc()));
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      }) as unknown as typeof fetch;
      const result = await loadParticipantConsent();
      expect(result!.terms.title).toBe('Terms v2');
    });

    it('falls back to disk when the API document lacks terms/privacy', async () => {
      existsSyncMock.mockReturnValue(true);
      readFileMock.mockResolvedValue(JSON.stringify(validDoc()));
      global.fetch = vi
        .fn()
        .mockResolvedValue(apiConsent({ documents: {} })) as unknown as typeof fetch;
      const result = await loadParticipantConsent();
      expect(result!.terms.title).toBe('Terms v2');
    });

    it('returns null when neither API nor disk has a document', async () => {
      existsSyncMock.mockReturnValue(false);
      await expect(loadParticipantConsent()).resolves.toBeNull();
      expect(readFileMock).not.toHaveBeenCalled();
    });

    it('falls back to the first version when current_version does not match', async () => {
      existsSyncMock.mockReturnValue(true);
      readFileMock.mockResolvedValue(
        JSON.stringify({
          documents: {
            terms: { current_version: 99, versions: [{ version: 1, title: 'T', content: 'c' }] },
            privacy: { current_version: 1, versions: [{ version: 1, title: 'P', content: 'p' }] },
          },
        }),
      );
      const result = await loadParticipantConsent();
      expect(result!.terms).toEqual({ version: 1, title: 'T', content: 'c' });
    });

    it('returns null when the on-disk file is malformed JSON', async () => {
      existsSyncMock.mockReturnValue(true);
      readFileMock.mockResolvedValue('{not-json');
      await expect(loadParticipantConsent()).resolves.toBeNull();
    });

    it('returns null when disk readFile throws', async () => {
      existsSyncMock.mockReturnValue(true);
      readFileMock.mockRejectedValue(new Error('EACCES'));
      await expect(loadParticipantConsent()).resolves.toBeNull();
    });

    it('does not throw when an on-disk profile_creation version lacks statement', async () => {
      // On-disk copies are not schema-validated; a missing `statement` must not
      // 500 the public page (regression: unguarded replaceAll threw TypeError).
      existsSyncMock.mockReturnValue(true);
      readFileMock.mockResolvedValue(
        JSON.stringify(
          validDoc({
            profile_creation: { current_version: 1, versions: [{ version: 1 }] },
          }),
        ),
      );
      const result = await loadParticipantConsent();
      expect(result).not.toBeNull();
      expect(result!.profileCreation).toEqual({ version: 1, statement: '' });
    });
  });
});
