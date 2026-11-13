/**
 * Unit tests for the "known as" helpers.
 *
 * Covers: the store's tree rules, the default key,
 * name resolution, key validity, key generation from names (Latin, Hindi,
 * Kannada, digits first, empty, clashes, length) and filling a requested list.
 */
import { describe, expect, it } from 'vitest';
import type { OrganisationConfig } from '@aggregator-dpg/network-config/interface';
import { KnownAsKeySchema } from '@aggregator-dpg/shared-primitives/user-org';
import {
  defaultKnownAsKey,
  fillKnownAsKeys,
  knownAsKeyFrom,
  knownAsKeyValid,
  knownAsNameOf,
  treeRules,
} from '../known-as.js';

const list = [
  { key: 'state', name: 'State' },
  { key: 'district', name: 'District', default: true as const },
];

describe('treeRules', () => {
  it('maps the limits; max_children unset is no limit', () => {
    const org: OrganisationConfig = { hierarchy: { max_depth: 3, max_total_orgs: 40 } };
    expect(treeRules(org)).toEqual({ maxDepth: 3, maxChildren: null, maxTotalOrgs: 40 });
    expect(
      treeRules({ hierarchy: { max_depth: 1, max_total_orgs: 5, max_children: 2 } }).maxChildren,
    ).toBe(2);
  });
});

describe('defaultKnownAsKey', () => {
  it('is the default entry, else aggregator', () => {
    expect(defaultKnownAsKey(list)).toBe('district');
    expect(defaultKnownAsKey([{ key: 'state', name: 'State' }])).toBe('aggregator');
    expect(defaultKnownAsKey([])).toBe('aggregator');
  });
});

describe('knownAsNameOf', () => {
  it("takes the parent's entry, aggregator included", () => {
    expect(knownAsNameOf(list, 'state')).toBe('State');
    expect(knownAsNameOf([{ key: 'aggregator', name: 'Partner' }], 'aggregator')).toBe('Partner');
  });

  it('reads aggregator and an unknown key as Aggregator', () => {
    expect(knownAsNameOf(list, 'aggregator')).toBe('Aggregator');
    expect(knownAsNameOf(list, 'gone')).toBe('Aggregator');
    expect(knownAsNameOf([], 'state')).toBe('Aggregator');
  });
});

describe('knownAsKeyValid', () => {
  it('accepts a listed key and aggregator; refuses any other key', () => {
    expect(knownAsKeyValid(list, 'state')).toBe(true);
    expect(knownAsKeyValid(list, 'aggregator')).toBe(true);
    expect(knownAsKeyValid([], 'aggregator')).toBe(true);
    expect(knownAsKeyValid(list, 'block')).toBe(false);
  });
});

describe('knownAsKeyFrom', () => {
  const none = new Set<string>();

  it('lower-cases Latin names and joins words with _', () => {
    expect(knownAsKeyFrom('Training Partner', none)).toBe('training_partner');
    expect(knownAsKeyFrom('  State / UT  ', none)).toBe('state_ut');
    expect(knownAsKeyFrom('Café Owner', none)).toBe('cafe_owner');
  });

  it('transliterates Hindi and Kannada', () => {
    const hindi = knownAsKeyFrom('जिला', none);
    const kannada = knownAsKeyFrom('ಜಿಲ್ಲೆ', none);
    expect(hindi).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(kannada).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(hindi).toBe('jila');
    expect(kannada).toBe('jille');
    expect(knownAsKeyFrom('ತಾಲ್ಲೂಕು', none)).toBe('talluku');
    // A nukta transliterates to an apostrophe, which is dropped.
    expect(knownAsKeyFrom('ज़िला', none)).toBe('jila');
    expect(knownAsKeyFrom("O'Brien Block", none)).toBe('obrien_block');
  });

  it('prefixes v_ when the key would start with a digit', () => {
    expect(knownAsKeyFrom('2nd Tier', none)).toBe('v_2nd_tier');
  });

  it('gives value_<n> when nothing is left', () => {
    expect(knownAsKeyFrom('!!!', none)).toBe('value_1');
    expect(knownAsKeyFrom('***', new Set(['value_1', 'value_2']))).toBe('value_3');
  });

  it('adds _2, _3 on a clash', () => {
    expect(knownAsKeyFrom('State', new Set(['state']))).toBe('state_2');
    expect(knownAsKeyFrom('State', new Set(['state', 'state_2']))).toBe('state_3');
  });

  it('cuts the key to 64 characters, the clash suffix included', () => {
    const long = 'a'.repeat(80);
    const key = knownAsKeyFrom(long, none);
    expect(key).toHaveLength(64);
    const clash = knownAsKeyFrom(long, new Set([key]));
    expect(clash).toHaveLength(64);
    expect(clash.endsWith('_2')).toBe(true);
    expect(KnownAsKeySchema.safeParse(clash).success).toBe(true);
  });
});

describe('fillKnownAsKeys', () => {
  it('keeps sent keys and makes keys for new entries without clashes', () => {
    const r = fillKnownAsKeys(
      [{ name: 'State' }, { key: 'state', name: 'State (old)', default: true }, { name: 'Block' }],
      [{ key: 'state', name: 'State' }],
    );
    expect(r).toEqual({
      ok: true,
      value: [
        { key: 'state_2', name: 'State' },
        { key: 'state', name: 'State (old)', default: true },
        { key: 'block', name: 'Block' },
      ],
    });
  });

  it('never gives a new entry the key of an entry the save drops', () => {
    const r = fillKnownAsKeys(
      [{ key: 'district', name: 'District' }, { name: 'State' }],
      [
        { key: 'state', name: 'State' },
        { key: 'district', name: 'District' },
      ],
    );
    expect(r).toEqual({
      ok: true,
      value: [
        { key: 'district', name: 'District' },
        { key: 'state_2', name: 'State' },
      ],
    });
  });

  it('never makes the key aggregator', () => {
    expect(fillKnownAsKeys([{ name: 'Aggregator' }, { name: 'aggregator' }], [])).toEqual({
      ok: true,
      value: [
        { key: 'aggregator_2', name: 'Aggregator' },
        { key: 'aggregator_3', name: 'aggregator' },
      ],
    });
  });

  it('refuses a sent key that is not saved', () => {
    expect(fillKnownAsKeys([{ name: 'A' }, { key: 'made_up', name: 'B' }], [])).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_KEY', index: 1 },
    });
  });

  it('accepts an empty list', () => {
    expect(fillKnownAsKeys([], list)).toEqual({ ok: true, value: [] });
  });
});
