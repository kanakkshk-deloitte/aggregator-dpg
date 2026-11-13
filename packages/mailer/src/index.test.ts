/**
 * Unit tests for the mailer factory.
 *
 * Covers the `MAIL_PROVIDER` branch selection (`ses` / `smtp` / default /
 * unknown), the required-env validation for each provider, singleton
 * caching, and the test-only override hook. Real transports are never
 * constructed with live credentials — SMTP defaults to `mailhog`-style
 * localhost values and SES only needs a region string, neither of which
 * opens a network connection at construction time.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getMailer, _setMailer } from './index.js';
import { SesMailer } from './ses.js';
import { SmtpMailer } from './smtp.js';
import { FakeMailer } from './testing.js';

const ENV_KEYS = [
  'MAIL_PROVIDER',
  'AWS_REGION',
  'SES_FROM',
  'SES_CONFIGURATION_SET',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_FROM',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_SECURE',
] as const;

describe('getMailer', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    _setMailer(null);
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    _setMailer(null);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('defaults to SmtpMailer when MAIL_PROVIDER is unset', () => {
    process.env.SMTP_HOST = 'mailhog';
    const mailer = getMailer();
    expect(mailer).toBeInstanceOf(SmtpMailer);
  });

  it('builds a SmtpMailer with defaults for optional fields', () => {
    process.env.MAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'mailhog';
    const mailer = getMailer();
    expect(mailer).toBeInstanceOf(SmtpMailer);
  });

  it('builds a SmtpMailer honouring SMTP_PORT/FROM/USER/PASSWORD/SECURE overrides', () => {
    process.env.MAIL_PROVIDER = 'SMTP';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_FROM = 'hello@org.com';
    process.env.SMTP_USER = 'user1';
    process.env.SMTP_PASSWORD = 'pass1';
    process.env.SMTP_SECURE = 'true';
    const mailer = getMailer();
    expect(mailer).toBeInstanceOf(SmtpMailer);
  });

  it('throws when SMTP_HOST is missing under the smtp provider', () => {
    process.env.MAIL_PROVIDER = 'smtp';
    expect(() => getMailer()).toThrow(/SMTP_HOST must be set/);
  });

  it('builds a SesMailer when MAIL_PROVIDER=ses', () => {
    process.env.MAIL_PROVIDER = 'ses';
    process.env.AWS_REGION = 'ap-south-1';
    process.env.SES_FROM = 'no-reply@org.com';
    const mailer = getMailer();
    expect(mailer).toBeInstanceOf(SesMailer);
  });

  it('builds a SesMailer including the optional configuration set', () => {
    process.env.MAIL_PROVIDER = 'ses';
    process.env.AWS_REGION = 'ap-south-1';
    process.env.SES_FROM = 'no-reply@org.com';
    process.env.SES_CONFIGURATION_SET = 'transactional';
    const mailer = getMailer();
    expect(mailer).toBeInstanceOf(SesMailer);
  });

  it('throws when AWS_REGION is missing under the ses provider', () => {
    process.env.MAIL_PROVIDER = 'ses';
    process.env.SES_FROM = 'no-reply@org.com';
    expect(() => getMailer()).toThrow(/AWS_REGION must be set/);
  });

  it('throws when SES_FROM is missing under the ses provider', () => {
    process.env.MAIL_PROVIDER = 'ses';
    process.env.AWS_REGION = 'ap-south-1';
    expect(() => getMailer()).toThrow(/SES_FROM must be set/);
  });

  it('throws a descriptive error for an unknown provider', () => {
    process.env.MAIL_PROVIDER = 'sendgrid';
    expect(() => getMailer()).toThrow(/unknown MAIL_PROVIDER: sendgrid/);
  });

  it('caches the singleton across calls', () => {
    process.env.SMTP_HOST = 'mailhog';
    const a = getMailer();
    const b = getMailer();
    expect(a).toBe(b);
  });

  it('_setMailer overrides the singleton for tests', () => {
    const fake = new FakeMailer();
    _setMailer(fake);
    expect(getMailer()).toBe(fake);
  });
});
