/**
 * Unit tests for OrgEditForm.
 *
 * Renders against the repository's default org-registration schema, so the
 * schema-driven fields (website, GST number, domains) are the ones a default
 * deployment shows. Covers: the owner's form (fixed and schema fields in one
 * patch, clearing a schema field, schema checks before sending, server field
 * errors, the stored GSTIN after save), the "known as" value (shown
 * read-only, never sent), and read-only rendering (the Default org, an org
 * below the viewer's own, a non-owner).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { RJSFSchema } from '@rjsf/utils';
import messages from '@/i18n/messages/en.json';
import type { Org } from '@aggregator-dpg/shared-primitives/user-org';
import { applyNetworkDomains } from '@/lib/org-schema';
import defaultSchema from '../../../../../../config/schemas/aggregator/org-registration.v1.json';
import defaultUi from '../../../../../../config/schemas/aggregator/org-registration.v1.ui.json';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { OrgEditForm } from '@/components/console/OrgEditForm';

const ORG_SCHEMA = applyNetworkDomains(
  defaultSchema as unknown as RJSFSchema,
  defaultUi as Record<string, unknown>,
  [
    { id: 'seeker', label: 'Seekers' },
    { id: 'provider', label: 'Providers' },
  ],
);

const baseOrg: Org = {
  id: '00000000-0000-4000-8000-0000000000a1',
  slug: 'acme',
  name: 'Acme Org',
  org_type: 'aggregator',
  status: 'active',
  is_default: false,
  locations: [
    {
      geo: { type: 'Point', coordinates: [77, 12] },
      address: { streetAddress: '1 Main St', addressLocality: 'Bengaluru', addressRegion: 'KA' },
    },
  ],
  legal_name: 'Acme Private Ltd',
  known_as: 'aggregator',
  known_as_name: 'Aggregator',
  depth: 3,
  parent_id: 'd1',
  parent_name: null,
  description: null,
  profile: { website: 'https://acme.example.org' },
  profile_ref: 'org-registration.v1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

interface Viewer {
  editable?: boolean;
  /** The org's owner. */
  canEdit?: boolean;
  orgSchema?: typeof ORG_SCHEMA | null;
  /** The page shows the "known as" picker. */
  knownAsPicked?: boolean;
}

const OWNER: Viewer = { editable: true, canEdit: true };

function form(org: Org, v: Viewer) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <OrgEditForm
        org={org}
        editable={v.editable ?? false}
        canEdit={v.canEdit ?? false}
        orgSchema={v.orgSchema === undefined ? ORG_SCHEMA : v.orgSchema}
        knownAsPicked={v.knownAsPicked ?? false}
      />
    </NextIntlClientProvider>
  );
}

const renderForm = (org: Org, v: Viewer) => render(form(org, v));

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

const save = () => fireEvent.click(screen.getByRole('button', { name: messages.console.org.save }));

/** The JSON body of the first PATCH sent. */
function sentBody(): unknown {
  const call = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
  return JSON.parse(String((call?.[1] as { body: string }).body));
}

describe('<OrgEditForm />', () => {
  const original = global.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
    // Radix Popover (the domains multi-select) reads these; jsdom lacks them.
    Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    global.fetch = original;
  });

  describe('the owner', () => {
    it('renders fixed inputs and the schema fields', () => {
      renderForm(baseOrg, OWNER);
      expect(screen.getByLabelText(messages.console.org.name)).toHaveValue('Acme Org');
      expect(screen.getByLabelText(messages.console.org.legal_name)).toHaveValue(
        'Acme Private Ltd',
      );
      expect(screen.getByLabelText(messages.console.org.description)).toHaveValue('');
      expect(screen.getByLabelText(/Website/)).toHaveValue('https://acme.example.org');
      expect(screen.getByLabelText(/GST number/)).toHaveValue('');
      expect(screen.getByText('Domains')).toBeInTheDocument();
      expect(screen.getByText('1 Main St, Bengaluru, KA')).toBeInTheDocument();
    });

    it('shows known_as read-only with the parent-owner hint', () => {
      renderForm(baseOrg, OWNER);
      const field = screen.getByLabelText(messages.console.org.known_as);
      expect(field).toBeDisabled();
      expect(field).toHaveValue('Aggregator');
      expect(screen.getByText(messages.console.org.known_as_parent_sets)).toBeInTheDocument();
    });

    it('leaves known_as and its hint out when the page shows the picker', () => {
      renderForm(baseOrg, { ...OWNER, knownAsPicked: true });
      expect(screen.queryByLabelText(messages.console.org.known_as)).toBeNull();
      expect(screen.queryByText(messages.console.org.known_as_parent_sets)).toBeNull();
      expect(screen.getByLabelText(messages.console.org.name)).toBeInTheDocument();
    });

    it('shows the newer org the page passes after a refresh', () => {
      const { rerender } = renderForm(baseOrg, OWNER);
      rerender(
        form(
          {
            ...baseOrg,
            known_as: 'district',
            known_as_name: 'District',
            updated_at: '2026-02-01T00:00:00Z',
          },
          OWNER,
        ),
      );
      expect(screen.getByLabelText(messages.console.org.known_as)).toHaveValue('District');
    });

    it('skips the network call and reports saved when nothing changed', async () => {
      global.fetch = respond({}, 200) as never;
      renderForm(baseOrg, OWNER);
      save();
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(messages.console.org.saved),
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('sends fixed fields and changed schema fields in one patch, never known_as', async () => {
      global.fetch = respond(baseOrg, 200) as never;
      renderForm(baseOrg, OWNER);
      fireEvent.change(screen.getByLabelText(messages.console.org.name), {
        target: { value: 'Acme Renamed' },
      });
      fireEvent.change(screen.getByLabelText(messages.console.org.legal_name), {
        target: { value: 'New Legal Ltd' },
      });
      fireEvent.change(screen.getByLabelText(/Website/), {
        target: { value: 'https://new.example.org' },
      });
      save();
      await waitFor(() => expect(global.fetch).toHaveBeenCalled());
      expect(sentBody()).toEqual({
        name: 'Acme Renamed',
        legal_name: 'New Legal Ltd',
        profile: { website: 'https://new.example.org' },
      });
      await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it('sends null to clear a schema field', async () => {
      global.fetch = respond({ ...baseOrg, profile: {} }, 200) as never;
      renderForm(baseOrg, OWNER);
      fireEvent.change(screen.getByLabelText(/Website/), { target: { value: '' } });
      save();
      await waitFor(() => expect(global.fetch).toHaveBeenCalled());
      expect(sentBody()).toEqual({ profile: { website: null } });
    });

    it.each(['acme.example.org', 'http://acme.example.org'])(
      'refuses the website %s before sending, with the schema message',
      async (value) => {
        global.fetch = respond({}, 200) as never;
        renderForm(baseOrg, OWNER);
        fireEvent.change(screen.getByLabelText(/Website/), { target: { value } });
        save();
        expect(
          await screen.findByText('Please enter a website starting with https://'),
        ).toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent(messages.console.org.fix_fields);
        expect(global.fetch).not.toHaveBeenCalled();
      },
    );

    it('saves another change when stored values do not meet the field rules', async () => {
      // Values saved before the rules existed: an http website, a bad check character.
      const legacy = {
        ...baseOrg,
        profile: { website: 'http://old.example.org', gst_number: '29ABCDE1234F1ZX' },
      };
      global.fetch = respond({ ...legacy, description: 'We train people.' }, 200) as never;
      renderForm(legacy, OWNER);
      fireEvent.change(screen.getByLabelText(messages.console.org.description), {
        target: { value: 'We train people.' },
      });
      save();
      await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
      expect(sentBody()).toEqual({ description: 'We train people.' });
    });

    it('still refuses a stored website the owner changes to another bad value', async () => {
      global.fetch = vi.fn() as never;
      renderForm({ ...baseOrg, profile: { website: 'http://old.example.org' } }, OWNER);
      fireEvent.change(screen.getByLabelText(/Website/), {
        target: { value: 'http://other.example.org' },
      });
      save();
      expect(
        await screen.findByText('Please enter a website starting with https://'),
      ).toBeInTheDocument();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses a GSTIN with a wrong check character before sending', async () => {
      global.fetch = respond({}, 200) as never;
      renderForm(baseOrg, OWNER);
      fireEvent.change(screen.getByLabelText(/GST number/), {
        target: { value: '29ABCDE1234F1Z5' },
      });
      save();
      expect(await screen.findByText('Please enter a valid GSTIN.')).toBeInTheDocument();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('shows the stored, upper-cased GSTIN after saving', async () => {
      global.fetch = respond(
        {
          ...baseOrg,
          profile: { ...baseOrg.profile, gst_number: '29ABCDE1234F1ZW' },
          updated_at: '2026-01-02T00:00:00Z',
        },
        200,
      ) as never;
      renderForm(baseOrg, OWNER);
      const gst = screen.getByLabelText(/GST number/);
      fireEvent.change(gst, { target: { value: '29abcde1234f1zw' } });
      save();
      await waitFor(() => expect(gst).toHaveValue('29ABCDE1234F1ZW'));
      expect(sentBody()).toEqual({ profile: { gst_number: '29abcde1234f1zw' } });
    });

    it('picks domains from the multi-select and sends them', async () => {
      global.fetch = respond(baseOrg, 200) as never;
      const { container } = renderForm(baseOrg, OWNER);
      const trigger = container.querySelector('button[aria-haspopup="listbox"]') as HTMLElement;
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole('button', { name: 'Seekers', exact: true }));
      save();
      await waitFor(() => expect(global.fetch).toHaveBeenCalled());
      expect(sentBody()).toEqual({ profile: { domains: ['seeker'] } });
    });

    it('shows the server field errors under the matching schema fields', async () => {
      global.fetch = respond(
        {
          error: {
            code: 'SCHEMA_VALIDATION',
            fields: { field_errors: { gst_number: 'Server says no.' } },
          },
        },
        400,
      ) as never;
      renderForm(baseOrg, OWNER);
      fireEvent.change(screen.getByLabelText(/GST number/), {
        target: { value: '27AAPFU0939F1ZV' },
      });
      save();
      expect(await screen.findByText('Server says no.')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(messages.console.org.fix_fields);
    });

    it('shows the name-taken error when the API rejects a rename', async () => {
      global.fetch = respond({ error: { code: 'ORG_NAME_TAKEN' } }, 409) as never;
      renderForm(baseOrg, OWNER);
      fireEvent.change(screen.getByLabelText(messages.console.org.name), {
        target: { value: 'Taken Name' },
      });
      save();
      expect(await screen.findByText(messages.console.errors.name_taken)).toBeInTheDocument();
    });

    it('still renders the fixed fields when the schema cannot be loaded', () => {
      renderForm(baseOrg, { ...OWNER, orgSchema: null });
      expect(screen.getByLabelText(messages.console.org.name)).toBeInTheDocument();
      expect(screen.queryByLabelText(/Website/)).toBeNull();
    });
  });

  describe('read-only', () => {
    it('says the Default org is not editable, with no inputs or save button', () => {
      renderForm({ ...baseOrg, is_default: true }, { canEdit: true });
      expect(screen.getByText(messages.console.org.read_only)).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('button', { name: messages.console.org.save })).toBeNull();
    });

    it('shows an org below the viewer read-only, with no note', () => {
      renderForm(baseOrg, { editable: false });
      expect(screen.queryByText(messages.console.org.read_only)).toBeNull();
      expect(screen.queryByText(messages.console.org.details_owner_only)).toBeNull();
      expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('shows every detail read-only to a non-owner without the known_as choice', () => {
      renderForm(
        {
          ...baseOrg,
          description: 'Line one\nLine two',
          profile: {
            website: 'https://acme.example.org',
            gst_number: '29ABCDE1234F1ZW',
            domains: ['provider', 'seeker'],
          },
        },
        { editable: true },
      );
      expect(screen.getByText(messages.console.org.details_owner_only)).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.getByText('Aggregator')).toBeInTheDocument();
      expect(screen.getByText('https://acme.example.org')).toBeInTheDocument();
      expect(screen.getByText('29ABCDE1234F1ZW')).toBeInTheDocument();
      expect(screen.getByText('Providers, Seekers')).toBeInTheDocument();
      expect(screen.getByText(/Line one/)).toHaveClass('whitespace-pre-line');
    });

    it('leaves known_as out of the read-only details when the page shows the picker', () => {
      renderForm(baseOrg, { editable: false, knownAsPicked: true });
      expect(screen.queryByText(messages.console.org.known_as)).toBeNull();
      expect(screen.queryByText('Aggregator')).toBeNull();
      expect(screen.getByText('Acme Org')).toBeInTheDocument();
    });

    it('omits known_as for the root, and shows "—" and "no description" when empty', () => {
      renderForm(
        { ...baseOrg, known_as: null, known_as_name: null, depth: 0, profile: {} },
        { editable: false },
      );
      expect(screen.queryByText(messages.console.org.known_as)).toBeNull();
      expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
      expect(screen.getByText(messages.console.org.no_description)).toBeInTheDocument();
    });
  });
});
