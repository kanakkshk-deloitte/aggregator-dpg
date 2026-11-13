import { describe, it, expect } from 'vitest';
import { renderOrgDetails } from '../org-details.js';

const loc = (street: string) => [
  { geo: { type: 'Point' as const, coordinates: [1, 2] }, address: { streetAddress: street } },
];
const org = {
  url: 'https://org.example',
  locations: loc('Org st'),
  legalName: 'Org Ltd',
  gstNumber: 'G-ORG',
};

describe('renderOrgDetails', () => {
  it("renders the org's values over the coordinator's own", () => {
    expect(
      renderOrgDetails(org, {
        url: 'https://own.example',
        locations: loc('Own st'),
        company: 'Own',
      }),
    ).toEqual({ url: org.url, locations: org.locations, company: 'Org Ltd', gstNumber: 'G-ORG' });
  });

  it('falls back per field when the org has none', () => {
    expect(
      renderOrgDetails(
        { url: null, locations: [], legalName: null, gstNumber: 'G-ORG' },
        {
          url: 'https://own.example',
          locations: loc('Own st'),
          company: 'Own',
          gstNumber: 'G-OWN',
        },
      ),
    ).toEqual({
      url: 'https://own.example',
      locations: loc('Own st'),
      company: 'Own',
      gstNumber: 'G-ORG',
    });
  });

  it('treats blank strings and recorded empties as absent', () => {
    expect(
      renderOrgDetails(
        { url: '  ', locations: [], legalName: '', gstNumber: null },
        { url: null, locations: [], company: null },
      ),
    ).toEqual({ url: null, locations: [], company: undefined, gstNumber: undefined });
  });

  it('handles an unknown org and no legacy values', () => {
    expect(renderOrgDetails(null, null)).toEqual({
      url: null,
      locations: [],
      company: undefined,
      gstNumber: undefined,
    });
  });
});
