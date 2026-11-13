import { describe, it, expect } from 'vitest';
import { buildDecryptedProfilesCsv, buildContactExportCsv } from '../index.js';
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';

const row = (over: Partial<SignalStackDecryptedProfileRow>): SignalStackDecryptedProfileRow => ({
  item_id: 'i1',
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  item_state: {},
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('buildDecryptedProfilesCsv', () => {
  it('puts item_id first, then name/phone, then remaining keys sorted', () => {
    const csv = buildDecryptedProfilesCsv([
      row({
        item_id: 'i1',
        item_state: { age: 19, phone: '+91987', name: 'Imran', city: 'Bengaluru' },
      }),
    ]);
    const [header] = csv.split('\r\n');
    expect(header).toBe('item_id,name,phone,age,city');
  });

  it('unions keys across rows and leaves missing cells empty', () => {
    const csv = buildDecryptedProfilesCsv([
      row({ item_id: 'i1', item_state: { name: 'A', age: 19 } }),
      row({ item_id: 'i2', item_state: { name: 'B', city: 'X' } }),
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('item_id,name,age,city');
    expect(lines[1]).toBe('i1,A,19,');
    expect(lines[2]).toBe('i2,B,,X');
  });

  it('escapes commas, quotes, and newlines; stringifies objects', () => {
    const csv = buildDecryptedProfilesCsv([
      row({
        item_id: 'i1',
        item_state: { name: 'Last, First', note: 'he said "hi"', meta: { a: 1 } },
      }),
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('item_id,name,meta,note');
    expect(lines[1]).toBe('i1,"Last, First","{""a"":1}","he said ""hi"""');
  });

  it('returns just the item_id header for an empty input', () => {
    expect(buildDecryptedProfilesCsv([])).toBe('item_id');
  });

  it('leads with network-specific identity fields (beneficiary_name, mobile_number)', () => {
    const csv = buildDecryptedProfilesCsv([
      row({
        item_id: 'i1',
        item_state: { age: 31, mobile_number: '9000000315', beneficiary_name: 'Divya', city: 'X' },
      }),
    ]);
    const [header] = csv.split('\r\n');
    // name-like field first, then phone/mobile-like, then the rest alphabetical
    expect(header).toBe('item_id,beneficiary_name,mobile_number,age,city');
  });

  it('neutralizes spreadsheet formula injection in cell values', () => {
    const csv = buildDecryptedProfilesCsv([
      row({
        item_id: 'i1',
        item_state: {
          beneficiary_name: '=HYPERLINK("http://evil.com","x")',
          mobile_number: '+919876801011',
          handle: '@admin',
          score: '-5',
        },
      }),
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('item_id,beneficiary_name,mobile_number,handle,score');
    // Every formula-triggering value is prefixed with a single quote; the
    // HYPERLINK value also needs RFC-4180 quoting because it contains quotes.
    expect(lines[1]).toBe(`i1,"'=HYPERLINK(""http://evil.com"",""x"")",'+919876801011,'@admin,'-5`);
  });

  it('does not alter normal values (no false-positive neutralization)', () => {
    const csv = buildDecryptedProfilesCsv([
      row({
        item_id: 'i1',
        item_state: { beneficiary_name: 'Divya Test', mobile_number: '9000000315' },
      }),
    ]);
    expect(csv.split('\r\n')[1]).toBe('i1,Divya Test,9000000315');
  });
});

describe('buildContactExportCsv (#579)', () => {
  it('emits the fixed 7-column contact header', () => {
    const csv = buildContactExportCsv([]);
    expect(csv).toBe('item_id,name,name_source,email,email_source,phone,phone_source');
  });

  it('maps value + provenance per field (item→profile, user→user)', () => {
    const csv = buildContactExportCsv([
      row({
        item_id: 'i1',
        contact: {
          name: { value: 'Asha', source: 'item' },
          email: { value: 'asha@example.com', source: 'user' },
          phone: { value: '+9190', source: 'item' },
        },
      }),
    ]);
    // phone starts with '+', so the CSV formula-injection guard prefixes a single quote
    expect(csv.split('\r\n')[1]).toBe("i1,Asha,profile,asha@example.com,user,'+9190,profile");
  });

  it('renders absent/null contact fields as empty value + none', () => {
    const csv = buildContactExportCsv([
      row({
        item_id: 'i2',
        contact: {
          name: { value: 'Meena', source: 'item' },
          email: { value: null, source: null },
          // phone omitted entirely
        },
      }),
    ]);
    expect(csv.split('\r\n')[1]).toBe('i2,Meena,profile,,none,,none');
  });

  it('emits only header + empty cells when no contact block is present', () => {
    const csv = buildContactExportCsv([row({ item_id: 'i3' })]);
    expect(csv.split('\r\n')[1]).toBe('i3,,none,,none,,none');
  });

  it('handles mixed domains in one export (fixed schema)', () => {
    const csv = buildContactExportCsv([
      row({
        item_id: 'a',
        item_domain: 'seeker',
        contact: { name: { value: 'A', source: 'item' } },
      }),
      row({
        item_id: 'b',
        item_domain: 'provider',
        contact: { name: { value: 'B', source: 'user' } },
      }),
    ]);
    const lines = csv.split('\r\n');
    expect(lines[1]).toBe('a,A,profile,,none,,none');
    expect(lines[2]).toBe('b,B,user,,none,,none');
  });
});
