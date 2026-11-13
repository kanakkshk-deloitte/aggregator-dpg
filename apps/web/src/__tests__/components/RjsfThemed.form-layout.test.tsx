/**
 * Renders the schema's `x-form-layout` as numbered sections.
 *
 * The same block drives the Signals profile form, and the point of honouring it
 * here is that the two surfaces render one schema identically. So these tests
 * use the real blue_dot seeker layout — its sections, its field order and its
 * `twoColumn` list — rather than a convenient fixture, because the thing most
 * likely to regress is a pairing rule that looks right against a toy schema and
 * wrong against the one that ships.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { RJSFSchema } from '@rjsf/utils';
import messages from '@/i18n/messages/en.json';
import { RjsfThemedForm } from '@/components/forms/RjsfThemed';

/** The shape the deployed blue_dot seeker profile schema carries, trimmed. */
const SCHEMA = {
  type: 'object',
  required: ['name', 'phone'],
  properties: {
    name: { type: 'string', title: 'Full Name' },
    age: { type: 'string', title: 'Age' },
    gender: { type: 'string', title: 'Gender', enum: ['Male', 'Female'] },
    phone: { type: 'string', title: 'Mobile Number' },
    email: { type: 'string', title: 'Email' },
    location: { type: 'string', title: 'Location', location: 'primary' },
    workExperience: { type: 'string', title: 'Work Experience', enum: ['0-1', '1-3'] },
    educationCategory: { type: 'string', title: 'Highest Qualification', enum: ['ITI'] },
    itiTrade: { type: 'string', title: 'ITI Trade', enum: ['Fitter'] },
  },
  'x-form-layout': {
    sections: [
      {
        title: 'Personal Details',
        fields: ['name', 'age', 'gender', 'phone', 'email', 'location'],
      },
      { title: 'Work Experience & Preferences', fields: ['workExperience'] },
      { title: 'Education & Skills', fields: ['educationCategory', 'itiTrade'] },
    ],
    twoColumn: ['age', 'gender', 'phone', 'itiTrade'],
  },
} as unknown as RJSFSchema;

function renderForm(schema: RJSFSchema = SCHEMA, formData: Record<string, unknown> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RjsfThemedForm schema={schema} formData={formData} onSubmit={vi.fn()} />
    </NextIntlClientProvider>,
  );
}

describe('RjsfThemedForm — x-form-layout sections', () => {
  it('renders one heading per section, in schema order', () => {
    renderForm();

    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toEqual([
      'Personal Details',
      'Work Experience & Preferences',
      'Education & Skills',
    ]);
  });

  it('numbers the sections from one', () => {
    const { container } = renderForm();

    const sections = [...container.querySelectorAll('section')];
    expect(sections.map((s) => s.textContent?.trim().charAt(0))).toEqual(['1', '2', '3']);
  });

  it('puts each field under its declared section', () => {
    const { container } = renderForm();
    const [personal, work, education] = [...container.querySelectorAll('section')];

    expect(within(personal!).getByText('Full Name')).toBeInTheDocument();
    expect(within(personal!).getByText('Location')).toBeInTheDocument();
    expect(within(work!).getByText('Work Experience')).toBeInTheDocument();
    expect(within(education!).getByText('ITI Trade')).toBeInTheDocument();
    expect(within(personal!).queryByText('ITI Trade')).not.toBeInTheDocument();
  });

  it('pairs two adjacent two-column fields into one row', () => {
    // age + gender are adjacent and both two-column, so they share a row.
    const { container } = renderForm();
    const personal = container.querySelector('section')!;

    const paired = [...personal.querySelectorAll('.md\\:grid-cols-2')];
    expect(paired).toHaveLength(1);
    expect(paired[0]!.textContent).toContain('Age');
    expect(paired[0]!.textContent).toContain('Gender');
  });

  it('leaves a two-column field full width when its neighbour is not one', () => {
    // `phone` is marked two-column but sits next to `email`, which is not — so
    // it must NOT be paired, or the grid strands a half-empty cell.
    const { container } = renderForm();
    const personal = container.querySelector('section')!;

    const pairedText = [...personal.querySelectorAll('.md\\:grid-cols-2')]
      .map((el) => el.textContent)
      .join(' ');
    expect(pairedText).not.toContain('Mobile Number');
    expect(pairedText).not.toContain('Email');
  });

  it('omits a section entirely when x-show-if has pruned every one of its fields', () => {
    // Otherwise an untouched form shows a heading above nothing at all.
    const gated = JSON.parse(JSON.stringify(SCHEMA)) as RJSFSchema & {
      properties: Record<string, Record<string, unknown>>;
    };
    gated.properties.educationCategory!['x-show-if'] = { workExperience: ['1-3'] };
    gated.properties.itiTrade!['x-show-if'] = { workExperience: ['1-3'] };

    renderForm(gated as RJSFSchema, {});

    expect(screen.queryByText('Education & Skills')).not.toBeInTheDocument();
    expect(screen.getByText('Personal Details')).toBeInTheDocument();
  });

  it('renumbers so a hidden section does not leave a gap in the sequence', () => {
    const gated = JSON.parse(JSON.stringify(SCHEMA)) as RJSFSchema & {
      properties: Record<string, Record<string, unknown>>;
    };
    gated.properties.workExperience!['x-show-if'] = { gender: ['Male'] };

    const { container } = renderForm(gated as RJSFSchema, {});

    const sections = [...container.querySelectorAll('section')];
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.textContent?.trim().charAt(0))).toEqual(['1', '2']);
  });

  it('still renders a field the layout forgot, rather than dropping it', () => {
    // Losing an input outright is far worse than rendering it unlabelled.
    const withOrphan = JSON.parse(JSON.stringify(SCHEMA)) as RJSFSchema & {
      properties: Record<string, unknown>;
    };
    withOrphan.properties.strayField = { type: 'string', title: 'Stray Field' };

    renderForm(withOrphan as RJSFSchema, {});

    expect(screen.getByText('Stray Field')).toBeInTheDocument();
  });

  it('falls back to the flat grid for a schema with no layout', () => {
    const plain = {
      type: 'object',
      properties: { name: { type: 'string', title: 'Full Name' } },
    } as unknown as RJSFSchema;

    const { container } = renderForm(plain, {});

    expect(container.querySelector('section')).toBeNull();
    expect(screen.getByText('Full Name')).toBeInTheDocument();
  });
});
