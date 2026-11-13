/**
 * Regression test for the two-column pairing of the marker-driven widgets.
 *
 * Adding `ui:colSpan: 2` to the single-value location field pushed it onto its
 * own full-width row and left the cell beside Gender empty — a visible layout
 * regression against the form as it shipped before autocomplete existed. The
 * scalar widgets must keep the half-width cell a plain input would have had;
 * only the array row-builder spans both columns.
 */
import { describe, it, expect } from 'vitest';
import { resolveMarkerUiSchema } from '@/app/[org]/[slug]/PublicRegistrationView';

describe('resolveMarkerUiSchema — column spans', () => {
  it('leaves a single-value location field at its default half width', () => {
    const ui = resolveMarkerUiSchema({ location: 'primary' }, 'string');
    expect(ui).toMatchObject({ 'ui:widget': 'location-autocomplete' });
    expect(ui).not.toHaveProperty('ui:colSpan');
  });

  it('leaves a secondary location field at its default half width', () => {
    expect(resolveMarkerUiSchema({ location: 'secondary' }, 'string')).not.toHaveProperty(
      'ui:colSpan',
    );
  });

  it('spans the array row-builder across both columns', () => {
    const ui = resolveMarkerUiSchema({ location: 'primary' }, 'array');
    expect(ui).toMatchObject({ 'ui:widget': 'location-multi', 'ui:colSpan': 2 });
  });

  it('leaves the reference autocomplete at its default half width', () => {
    const ui = resolveMarkerUiSchema({ 'x-reference-source': 'colleges' }, 'string');
    expect(ui).toMatchObject({ 'ui:widget': 'reference-autocomplete' });
    expect(ui).not.toHaveProperty('ui:colSpan');
  });

  it('marks only a primary field as feeding the coordinate', () => {
    expect(resolveMarkerUiSchema({ location: 'primary' }, 'string')).toMatchObject({
      'ui:options': { isPrimaryLocation: true },
    });
    expect(resolveMarkerUiSchema({ location: 'secondary' }, 'string')).toMatchObject({
      'ui:options': { isPrimaryLocation: false },
    });
  });

  it('carries the reference subtitle config through, object form', () => {
    expect(
      resolveMarkerUiSchema(
        { 'x-reference-source': { source: 'colleges', subtitle: ['district', 'state'] } },
        'string',
      ),
    ).toMatchObject({
      'ui:options': { source: 'colleges', subtitleFields: ['district', 'state'] },
    });
  });

  it('returns null for a field carrying no marker', () => {
    expect(resolveMarkerUiSchema({ type: 'string' }, 'string')).toBeNull();
  });
});
