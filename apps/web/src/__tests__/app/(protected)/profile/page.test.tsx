/**
 * Server-component test: `(protected)/profile/page.tsx`.
 *
 * Per CLAUDE.md's "aggregator-schema.server.ts is the single source" note,
 * `/profile` loads the same registration schema `/register` uses and hands
 * it to the read-only `ProfileFormView` unchanged. Invokes the async page
 * function directly (no React render needed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { loadRegistrationSchema } = vi.hoisted(() => ({ loadRegistrationSchema: vi.fn() }));
vi.mock('@/lib/aggregator-schema.server', () => ({ loadRegistrationSchema }));

import ProfilePage from '@/app/(protected)/profile/page';

describe('ProfilePage (server component)', () => {
  beforeEach(() => {
    loadRegistrationSchema.mockReset();
  });

  it('passes the loaded registration schema pair straight through to ProfileFormView', async () => {
    const schema = { title: 'Aggregator Registration', properties: { name: { type: 'string' } } };
    const uiSchema = { name: { 'ui:autofocus': true } };
    loadRegistrationSchema.mockResolvedValue({ schema, uiSchema });

    const el = await ProfilePage();

    expect(el.props.schema).toBe(schema);
    expect(el.props.uiSchema).toBe(uiSchema);
  });
});
