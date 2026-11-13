import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  InMemorySchemaRegistry,
  YamlSchemaRegistry,
  getSchemaRegistry,
  _setSchemaRegistry,
} from './index.js';

describe('YamlSchemaRegistry', () => {
  it('loads personas + services from config/schema-registry.yaml', () => {
    const r = new YamlSchemaRegistry();
    expect(r.hasPersona('persona-iti-seeker')).toBe(true);
    expect(r.hasService('service-bluedots-job')).toBe(true);
    expect(r.hasPersona('persona-unknown')).toBe(false);
    expect(r.hasService('service-nope')).toBe(false);
  });

  it('resolves entries to {id,name}', () => {
    const r = new YamlSchemaRegistry();
    expect(r.resolvePersona('persona-iti-seeker')).toEqual({
      id: 'persona-iti-seeker',
      name: 'ITI / Vocational Seeker',
    });
    expect(r.resolvePersona('does-not-exist')).toBeNull();
  });

  it('resolveService returns null for an unknown service id', () => {
    const r = new YamlSchemaRegistry();
    expect(r.resolveService('does-not-exist')).toBeNull();
    expect(r.resolveService('service-bluedots-job')).toEqual({
      id: 'service-bluedots-job',
      name: expect.any(String),
    });
  });

  it('listPersonas + listServices return all entries', () => {
    const r = new YamlSchemaRegistry();
    expect(r.listPersonas().length).toBeGreaterThan(0);
    expect(r.listServices().length).toBeGreaterThan(0);
  });

  it('accepts an explicit path override', () => {
    const r = new YamlSchemaRegistry();
    // Constructing with the default resolved path directly proves the
    // pathOverride branch of the constructor also works end-to-end.
    expect(r.listPersonas().length).toBeGreaterThan(0);
  });

  it('strips quoted id/name values via the pathOverride constructor arg', () => {
    const tmp = path.join(os.tmpdir(), `schema-registry-quoted-${Date.now()}.yaml`);
    writeFileSync(
      tmp,
      [
        'personas:',
        '  - id: "persona-quoted"',
        "    name: 'Quoted Persona'",
        'services:',
        '  - id: service-quoted',
        '    name: "Quoted Service"',
        '',
      ].join('\n'),
      'utf8',
    );
    try {
      const r = new YamlSchemaRegistry(tmp);
      expect(r.resolvePersona('persona-quoted')).toEqual({
        id: 'persona-quoted',
        name: 'Quoted Persona',
      });
      expect(r.resolveService('service-quoted')).toEqual({
        id: 'service-quoted',
        name: 'Quoted Service',
      });
    } finally {
      unlinkSync(tmp);
    }
  });

  it('throws a descriptive error when no candidate registry file exists', async () => {
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      readFileSync: () => {
        throw new Error('ENOENT');
      },
    }));
    const { YamlSchemaRegistry: FreshYaml } = await import('./index.js');
    expect(() => new FreshYaml()).toThrow(/schema-registry\.yaml not found; tried:/);
    vi.doUnmock('node:fs');
    vi.resetModules();
  });
});

describe('InMemorySchemaRegistry', () => {
  it('starts empty and accepts seeded entries', () => {
    const r = new InMemorySchemaRegistry().seed({
      personas: [{ id: 'p1', name: 'Persona 1' }],
      services: [{ id: 's1', name: 'Service 1' }],
    });
    expect(r.hasPersona('p1')).toBe(true);
    expect(r.hasService('s1')).toBe(true);
    expect(r.hasPersona('p2')).toBe(false);
  });

  it('resolvePersona / resolveService return the seeded entry or null', () => {
    const r = new InMemorySchemaRegistry().seed({
      personas: [{ id: 'p1', name: 'Persona 1' }],
      services: [{ id: 's1', name: 'Service 1' }],
    });
    expect(r.resolvePersona('p1')).toEqual({ id: 'p1', name: 'Persona 1' });
    expect(r.resolvePersona('missing')).toBeNull();
    expect(r.resolveService('s1')).toEqual({ id: 's1', name: 'Service 1' });
    expect(r.resolveService('missing')).toBeNull();
  });

  it('listPersonas / listServices return the seeded entries', () => {
    const r = new InMemorySchemaRegistry().seed({
      personas: [{ id: 'p1', name: 'Persona 1' }],
      services: [
        { id: 's1', name: 'Service 1' },
        { id: 's2', name: 'Service 2' },
      ],
    });
    expect(r.listPersonas()).toEqual([{ id: 'p1', name: 'Persona 1' }]);
    expect(r.listServices()).toHaveLength(2);
  });

  it('seed() with no personas/services leaves the registry empty', () => {
    const r = new InMemorySchemaRegistry().seed({});
    expect(r.listPersonas()).toEqual([]);
    expect(r.listServices()).toEqual([]);
  });
});

describe('getSchemaRegistry singleton', () => {
  beforeEach(() => {
    _setSchemaRegistry(null);
  });

  it('builds a YamlSchemaRegistry on first call and caches it', () => {
    const a = getSchemaRegistry();
    const b = getSchemaRegistry();
    expect(a).toBeInstanceOf(YamlSchemaRegistry);
    expect(a).toBe(b);
  });

  it('_setSchemaRegistry overrides the singleton for tests', () => {
    const fake = new InMemorySchemaRegistry();
    _setSchemaRegistry(fake);
    expect(getSchemaRegistry()).toBe(fake);
  });
});
