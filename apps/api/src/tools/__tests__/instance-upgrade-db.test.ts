import { describe, expect, it } from 'vitest';
import { isFailing, sqlStatements } from '../instance-upgrade-db.js';

describe('sqlStatements', () => {
  it('drops psql meta lines and comments and splits on line-ending semicolons', () => {
    const script = [
      '\\set ON_ERROR_STOP on',
      '-- a comment',
      "SELECT 'a;b' AS x;",
      'SELECT 1',
      '  FROM t;',
      '',
    ].join('\n');
    expect(sqlStatements(script)).toEqual(["SELECT 'a;b' AS x", 'SELECT 1\n  FROM t']);
  });

  it('keeps a final statement without a trailing newline', () => {
    expect(sqlStatements('SELECT 1;')).toEqual(['SELECT 1']);
  });

  it('returns nothing for an empty or comment-only script', () => {
    expect(sqlStatements('')).toEqual([]);
    expect(sqlStatements('-- only\n\\echo hi\n')).toEqual([]);
  });
});

describe('sqlStatements with dollar-quoted bodies', () => {
  it('keeps a DO block whole and splits around it', () => {
    const script = [
      'DO $$',
      'BEGIN',
      '  PERFORM 1;',
      "  EXECUTE 'SELECT 2';",
      'END $$;',
      'SELECT $t$a;\nb$t$ AS x;',
    ].join('\n');
    expect(sqlStatements(script)).toEqual([
      "DO $$\nBEGIN\n  PERFORM 1;\n  EXECUTE 'SELECT 2';\nEND $$",
      'SELECT $t$a;\nb$t$ AS x',
    ]);
  });

  it('does not end a statement inside a quoted string', () => {
    expect(sqlStatements("SELECT 'x;\ny' AS v;\nSELECT 2;")).toEqual([
      "SELECT 'x;\ny' AS v",
      'SELECT 2',
    ]);
  });
});

describe('isFailing', () => {
  it('fails a blocker or gate above 0, never an info row', () => {
    expect(isFailing({ checkId: 'D1', category: 'blocker', n: 1 })).toBe(true);
    expect(isFailing({ checkId: 'V1', category: 'gate', n: 2 })).toBe(true);
    expect(isFailing({ checkId: 'V1', category: 'gate', n: 0 })).toBe(false);
    expect(isFailing({ checkId: 'F3', category: 'info', n: 9 })).toBe(false);
  });
});

describe('VERIFY_FILES', () => {
  it('lists every train verify script in scripts/sql', async () => {
    const { readdir } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../../../../../scripts/sql', import.meta.url));
    const onDisk = (await readdir(dir)).filter(
      (f) => f.endsWith('-verify.sql') && !f.startsWith('contact-'),
    );
    const { VERIFY_FILES } = await import('../instance-upgrade.js');
    expect([...VERIFY_FILES].sort()).toEqual(onDisk.sort());
  });
});
