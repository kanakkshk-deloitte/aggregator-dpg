import { describe, it, expect, vi } from 'vitest';
import { ConfigServiceFake } from '../testing/index.js';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';

describe('ConfigServiceFake', () => {
  describe('load', () => {
    it('is a no-op — store remains populated after load', async () => {
      const cfg = new ConfigServiceFake({ db: { host: 'localhost' } });
      await cfg.load('test');
      expect(cfg.get('db.host')).toBe('localhost');
    });
  });

  describe('get', () => {
    it('returns value at dotted path', () => {
      const cfg = new ConfigServiceFake({ a: { b: { c: 42 } } });
      expect(cfg.get('a.b.c')).toBe(42);
    });

    it('returns undefined for missing path', () => {
      const cfg = new ConfigServiceFake({});
      expect(cfg.get('missing.key')).toBeUndefined();
    });

    it('returns undefined when intermediate key is not an object', () => {
      const cfg = new ConfigServiceFake({ a: 'string' });
      expect(cfg.get('a.b')).toBeUndefined();
    });
  });

  describe('require', () => {
    it('returns value when path exists', () => {
      const cfg = new ConfigServiceFake({ host: 'example.com' });
      expect(cfg.require<string>('host')).toBe('example.com');
    });

    it('throws ConfigError with CONFIG_KEY_MISSING when path is absent', () => {
      const cfg = new ConfigServiceFake({});
      expect(() => cfg.require('missing')).toThrow(ConfigError);
      expect(() => cfg.require('missing')).toThrow('missing');
    });

    it('thrown error has correct code', () => {
      const cfg = new ConfigServiceFake({});
      try {
        cfg.require('x');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe('CONFIG_KEY_MISSING');
      }
    });
  });

  describe('seed', () => {
    it('replaces the store entirely', () => {
      const cfg = new ConfigServiceFake({ old: 'value' });
      cfg.seed({ new: 'value' });
      expect(cfg.get('old')).toBeUndefined();
      expect(cfg.get('new')).toBe('value');
    });
  });

  describe('reload', () => {
    it('notifies onChange listeners', async () => {
      const cfg = new ConfigServiceFake({});
      const cb = vi.fn();
      cfg.onChange(cb);
      await cfg.reload();
      expect(cb).toHaveBeenCalledOnce();
    });

    it('does not call unsubscribed listener', async () => {
      const cfg = new ConfigServiceFake({});
      const cb = vi.fn();
      const unsub = cfg.onChange(cb);
      unsub();
      await cfg.reload();
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('onChange', () => {
    it('returns an unsubscribe function', () => {
      const cfg = new ConfigServiceFake({});
      const unsub = cfg.onChange(() => {});
      expect(typeof unsub).toBe('function');
    });
  });

  describe('watch', () => {
    it('returns a no-op unsubscribe function', () => {
      const cfg = new ConfigServiceFake({});
      const unsubscribe = cfg.watch();
      expect(typeof unsubscribe).toBe('function');
      expect(() => unsubscribe()).not.toThrow();
    });
  });

  describe('slice', () => {
    it('returns the typed top-level slice', () => {
      const cfg = new ConfigServiceFake({ db: { host: 'localhost', port: 5432 } });
      const db = cfg.slice<{ host: string; port: number }>('db');
      expect(db).toEqual({ host: 'localhost', port: 5432 });
    });

    it('throws ConfigError with CONFIG_KEY_MISSING when key absent', () => {
      const cfg = new ConfigServiceFake({});
      expect(() => cfg.slice('missing')).toThrow(ConfigError);
      try {
        cfg.slice('missing');
      } catch (err) {
        expect((err as ConfigError).code).toBe('CONFIG_KEY_MISSING');
      }
    });
  });
});
