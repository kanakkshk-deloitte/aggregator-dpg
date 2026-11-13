/**
 * Unit tests for orgReviewRecipients: who reviews a new organisation.
 *
 * Covers: no parent and the root go to the network admins quietly; an
 * aggregator parent goes to its owner; any other parent goes to the network
 * admins with a warning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const findById = vi.fn();
const findRoot = vi.fn();
vi.mock('./organisation-store/index.js', () => ({
  getOrganisationStore: () => ({ findById, findRoot }),
}));
vi.mock('./registration-notify.js', () => ({
  parseAdminEmails: () => ['admin@example.org'],
  sendReviewEmail: vi.fn(),
}));

import { orgReviewRecipients } from './org-registration-notify.js';

const ROOT = '00000000-0000-4000-8000-000000000001';
const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;

describe('orgReviewRecipients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findRoot.mockResolvedValue({ ok: true, value: { id: ROOT } });
  });

  it('sends a top-level registration with no parent to the network admins', async () => {
    expect(await orgReviewRecipients(null, log)).toEqual(['admin@example.org']);
    expect(findById).not.toHaveBeenCalled();
  });

  it("sends to the parent org's owner", async () => {
    findById.mockResolvedValue({ ok: true, value: { ownerEmail: 'owner@example.org' } });
    expect(await orgReviewRecipients('p1', log)).toEqual(['owner@example.org']);
    expect(findRoot).not.toHaveBeenCalled();
  });

  it('sends to the network admins without a warning when the parent is the root', async () => {
    findById.mockResolvedValue({ ok: true, value: null });
    expect(await orgReviewRecipients(ROOT, log)).toEqual(['admin@example.org']);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns when the parent is neither an aggregator org nor the root', async () => {
    findById.mockResolvedValue({ ok: true, value: null });
    expect(await orgReviewRecipients('missing', log)).toEqual(['admin@example.org']);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ parent_id: 'missing' }),
      expect.any(String),
    );
  });

  it('fails with DB_UNAVAILABLE when the root cannot be read', async () => {
    findById.mockResolvedValue({ ok: true, value: null });
    findRoot.mockResolvedValue({ ok: false, error: { message: 'down' } });
    await expect(orgReviewRecipients('missing', log)).rejects.toMatchObject({
      code: 'DB_UNAVAILABLE',
    });
  });
});
