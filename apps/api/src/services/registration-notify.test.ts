/**
 * Unit tests for the admin-review registration notifier.
 *
 * `./approval-token.js`, `./email-templates/index.js`, `@aggregator-dpg/mailer`,
 * and `../config.js` are mocked so no real JWT signing, template rendering,
 * or mail transport is exercised — this module's own orchestration (token
 * mint → render → send → failure logging) is the unit under test. Covers
 * `parseAdminEmails`'s quote/whitespace/newline handling, the
 * `TOKEN_MINT_FAILED` wrap-and-throw on a minting failure, and the
 * delivery-failure warning path that must not throw (a failed send still
 * leaves the registration record saved).
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const { mockMintApprovalToken, mockFormatApprovalTtl, mockRenderAdminReview, mockGetMailer } =
  vi.hoisted(() => ({
    mockMintApprovalToken: vi.fn(),
    mockFormatApprovalTtl: vi.fn(() => '7 days'),
    mockRenderAdminReview: vi.fn(),
    mockGetMailer: vi.fn(),
  }));

vi.mock('./approval-token.js', () => ({
  mintApprovalToken: mockMintApprovalToken,
  formatApprovalTtl: mockFormatApprovalTtl,
}));

vi.mock('./email-templates/index.js', () => ({
  renderAdminReview: mockRenderAdminReview,
}));

vi.mock('@aggregator-dpg/mailer', () => ({
  getMailer: mockGetMailer,
}));

vi.mock('../config.js', () => ({
  config: {
    PUBLIC_API_URL: 'https://api.example.com',
    APPROVAL_TOKEN_TTL_SECONDS: 604800,
  },
}));

function fakeLogger(): FastifyBaseLogger {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

describe('parseAdminEmails', () => {
  const saved = process.env.ADMIN_EMAILS;

  beforeEach(() => {
    delete process.env.ADMIN_EMAILS;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = saved;
  });

  it('defaults to admin@bluedots.local when unset', async () => {
    const { parseAdminEmails } = await import('./registration-notify.js');
    expect(parseAdminEmails()).toEqual(['admin@bluedots.local']);
  });

  it('splits a comma-separated list and trims entries', async () => {
    process.env.ADMIN_EMAILS = 'a@x.com, b@y.com ,c@z.com';
    const { parseAdminEmails } = await import('./registration-notify.js');
    expect(parseAdminEmails()).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
  });

  it('splits on newlines too', async () => {
    process.env.ADMIN_EMAILS = 'a@x.com\nb@y.com';
    const { parseAdminEmails } = await import('./registration-notify.js');
    expect(parseAdminEmails()).toEqual(['a@x.com', 'b@y.com']);
  });

  it('strips wrapping double quotes left by Helm/ConfigMap `| quote`', async () => {
    process.env.ADMIN_EMAILS = '"a@x.com,b@y.com"';
    const { parseAdminEmails } = await import('./registration-notify.js');
    expect(parseAdminEmails()).toEqual(['a@x.com', 'b@y.com']);
  });

  it('strips wrapping single quotes', async () => {
    process.env.ADMIN_EMAILS = "'a@x.com'";
    const { parseAdminEmails } = await import('./registration-notify.js');
    expect(parseAdminEmails()).toEqual(['a@x.com']);
  });

  it('falls back to the default when the value is blank after trimming', async () => {
    process.env.ADMIN_EMAILS = '   ';
    const { parseAdminEmails } = await import('./registration-notify.js');
    expect(parseAdminEmails()).toEqual(['admin@bluedots.local']);
  });
});

describe('mintReviewToken', () => {
  beforeEach(() => {
    mockMintApprovalToken.mockReset();
  });

  it('mints a single review token with the configured TTL', async () => {
    mockMintApprovalToken.mockResolvedValueOnce({ token: 'review-tok', expiresAt: new Date() });
    const { mintReviewToken } = await import('./registration-notify.js');
    const token = await mintReviewToken('agg-1');
    expect(token).toBe('review-tok');
    expect(mockMintApprovalToken).toHaveBeenCalledTimes(1);
    expect(mockMintApprovalToken).toHaveBeenNthCalledWith(1, {
      aggregatorId: 'agg-1',
      intent: 'approve',
      ttlSec: 604800,
    });
  });

  it('includes the org claim when provided', async () => {
    mockMintApprovalToken.mockResolvedValueOnce({ token: 'a', expiresAt: new Date() });
    const { mintReviewToken } = await import('./registration-notify.js');
    await mintReviewToken('agg-1', 'org-1');
    expect(mockMintApprovalToken).toHaveBeenNthCalledWith(1, {
      aggregatorId: 'agg-1',
      intent: 'approve',
      ttlSec: 604800,
      org: 'org-1',
    });
  });

  it('throws HttpError TOKEN_MINT_FAILED when minting throws', async () => {
    mockMintApprovalToken.mockRejectedValueOnce(new Error('signing key missing'));
    const { mintReviewToken } = await import('./registration-notify.js');
    await expect(mintReviewToken('agg-1')).rejects.toMatchObject({
      code: 'TOKEN_MINT_FAILED',
    });
  });
});

describe('sendReviewEmail', () => {
  beforeEach(() => {
    mockMintApprovalToken.mockReset();
    mockRenderAdminReview.mockReset();
    mockGetMailer.mockReset();
    mockMintApprovalToken
      .mockResolvedValueOnce({ token: 'approve-tok', expiresAt: new Date() })
      .mockResolvedValueOnce({ token: 'reject-tok', expiresAt: new Date() });
    mockRenderAdminReview.mockReturnValue({
      subject: 'Review needed',
      html: '<p>review</p>',
      text: 'review',
    });
  });

  it('builds the review url under the read path and sends to all recipients', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, value: { messageId: 'm-1' } });
    mockGetMailer.mockReturnValue({ send });
    const { sendReviewEmail } = await import('./registration-notify.js');
    const log = fakeLogger();
    await sendReviewEmail(
      {
        subjectId: 'agg-1',
        readPath: 'aggregator-registrations',
        applicantName: 'Acme',
        applicantEmail: 'a@acme.com',
        applicantPhone: '+911234567890',
        recipients: ['admin@bluedots.local'],
        logOperation: 'test.sendReviewEmail',
      },
      log,
    );
    const renderArgs = mockRenderAdminReview.mock.calls[0]?.[0] as { reviewUrl: string };
    expect(renderArgs.reviewUrl).toBe(
      'https://api.example.com/admin/v1/aggregator-registrations/read/agg-1?token=approve-tok',
    );
    // One link, both actions — no intent in the URL.
    expect(renderArgs.reviewUrl).not.toContain('intent=');
    expect(send).toHaveBeenCalledWith({
      to: ['admin@bluedots.local'],
      subject: 'Review needed',
      html: '<p>review</p>',
      text: 'review',
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs a warning (not a throw) when mail delivery fails', async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'TRANSPORT_FAILED', message: 'smtp down' } });
    mockGetMailer.mockReturnValue({ send });
    const { sendReviewEmail } = await import('./registration-notify.js');
    const log = fakeLogger();
    await expect(
      sendReviewEmail(
        {
          subjectId: 'agg-1',
          readPath: 'aggregator-registrations',
          applicantName: 'Acme',
          applicantEmail: 'a@acme.com',
          applicantPhone: '+911234567890',
          recipients: ['admin@bluedots.local'],
          logOperation: 'test.sendReviewEmail',
        },
        log,
      ),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'test.sendReviewEmail',
        status: 'failure',
        sub_operation: 'mailer.send',
        code: 'TRANSPORT_FAILED',
        cause: 'smtp down',
      }),
      expect.any(String),
    );
  });

  it('labels the coordinator review email "aggregator coordinator", not "aggregator"', async () => {
    // A reviewer who also handles org registrations cannot tell the two apart
    // from "New aggregator registration" alone, so sendAdminReviewEmail states
    // the label rather than falling through to the template default.
    const send = vi.fn().mockResolvedValue({ ok: true, value: { messageId: 'm-1' } });
    mockGetMailer.mockReturnValue({ send });
    const { sendAdminReviewEmail } = await import('./registration-notify.js');
    await sendAdminReviewEmail(
      {
        aggregatorId: 'agg-1',
        applicantName: 'SkillBridge Network',
        applicantEmail: 'admin@skillbridge.in',
        applicantPhone: '+911234567890',
        recipientEmail: 'admin@bluedots.local',
      },
      fakeLogger(),
    );
    const renderArgs = mockRenderAdminReview.mock.calls[0]?.[0] as { entityLabel?: string };
    expect(renderArgs.entityLabel).toBe('aggregator coordinator');
  });

  it('passes entityLabel through to the template when set', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, value: { messageId: 'm-1' } });
    mockGetMailer.mockReturnValue({ send });
    const { sendReviewEmail } = await import('./registration-notify.js');
    await sendReviewEmail(
      {
        subjectId: 'org-1',
        readPath: 'orgs',
        applicantName: 'Acme Org',
        applicantEmail: 'owner@acme.com',
        applicantPhone: '+911234567890',
        recipients: ['admin@bluedots.local'],
        entityLabel: 'organisation',
        logOperation: 'test.org',
      },
      fakeLogger(),
    );
    const renderArgs = mockRenderAdminReview.mock.calls[0]?.[0] as { entityLabel?: string };
    expect(renderArgs.entityLabel).toBe('organisation');
  });
});

describe('sendAdminReviewEmail', () => {
  beforeEach(() => {
    mockMintApprovalToken.mockReset();
    mockRenderAdminReview.mockReset();
    mockGetMailer.mockReset();
    mockMintApprovalToken
      .mockResolvedValueOnce({ token: 'a', expiresAt: new Date() })
      .mockResolvedValueOnce({ token: 'r', expiresAt: new Date() });
    mockRenderAdminReview.mockReturnValue({ subject: 's', html: 'h', text: 't' });
    delete process.env.ADMIN_EMAILS;
  });

  it('routes to the recipientEmail override when set (org-owner routing)', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, value: { messageId: 'm' } });
    mockGetMailer.mockReturnValue({ send });
    const { sendAdminReviewEmail } = await import('./registration-notify.js');
    await sendAdminReviewEmail(
      {
        aggregatorId: 'agg-1',
        applicantName: 'A',
        applicantEmail: 'a@b.com',
        applicantPhone: '+911234567890',
        recipientEmail: 'owner@org.com',
      },
      fakeLogger(),
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: ['owner@org.com'] }));
  });

  it('falls back to parseAdminEmails() when no recipientEmail override is given', async () => {
    process.env.ADMIN_EMAILS = 'admin1@x.com,admin2@x.com';
    const send = vi.fn().mockResolvedValue({ ok: true, value: { messageId: 'm' } });
    mockGetMailer.mockReturnValue({ send });
    const { sendAdminReviewEmail } = await import('./registration-notify.js');
    await sendAdminReviewEmail(
      {
        aggregatorId: 'agg-1',
        applicantName: 'A',
        applicantEmail: 'a@b.com',
        applicantPhone: '+911234567890',
      },
      fakeLogger(),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['admin1@x.com', 'admin2@x.com'] }),
    );
  });

  it('includes the org claim when the coordinator is under a parent org', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, value: { messageId: 'm' } });
    mockGetMailer.mockReturnValue({ send });
    const { sendAdminReviewEmail } = await import('./registration-notify.js');
    await sendAdminReviewEmail(
      {
        aggregatorId: 'agg-1',
        applicantName: 'A',
        applicantEmail: 'a@b.com',
        applicantPhone: '+911234567890',
        org: 'org-1',
      },
      fakeLogger(),
    );
    expect(mockMintApprovalToken).toHaveBeenCalledWith(expect.objectContaining({ org: 'org-1' }));
  });
});
