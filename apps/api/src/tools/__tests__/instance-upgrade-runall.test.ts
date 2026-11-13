import { describe, it, expect } from 'vitest';
import { planRunAll, executeRunAll, type RunAllStep } from '../instance-upgrade.js';

const label = (s: RunAllStep) => [s.cmd, ...s.args].join(' ');

describe('planRunAll', () => {
  it('from 0022: check + run --dry-run + real run, then validate+run the online steps', () => {
    const p = planRunAll('start', 'snap-1');
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.steps.map(label)).toEqual([
      'check',
      'run --dry-run',
      'run --snapshot-taken snap-1',
      'data --dry-run',
      'enrich --dry-run',
      'enable-owners --dry-run',
      'data',
      'enrich',
      'enable-owners',
      'check',
    ]);
    // Every online dry-run comes after the real run commits.
    const realRun = p.steps.findIndex((s) => s.cmd === 'run' && s.args[0] === '--snapshot-taken');
    const firstOnline = p.steps.findIndex((s) => s.cmd === 'data' && s.args.includes('--dry-run'));
    expect(realRun).toBeLessThan(firstOnline);
  });

  it('refuses to start from 0022 without a snapshot id', () => {
    const p = planRunAll('start', undefined);
    expect(p).toEqual({ ok: false, reason: expect.stringContaining('--snapshot-taken'), code: 2 });
  });

  it('at head: resumes with the online block only (no schema steps)', () => {
    const p = planRunAll('done', undefined);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.steps.some((s) => s.cmd === 'run')).toBe(false);
    expect(p.steps.map(label)).toEqual([
      'data --dry-run',
      'enrich --dry-run',
      'enable-owners --dry-run',
      'data',
      'enrich',
      'enable-owners',
      'check',
    ]);
  });

  it.each(['partial', 'fresh', 'other'] as const)('refuses an unexpected level: %s', (state) => {
    const p = planRunAll(state, 'snap-1');
    expect(p).toEqual({ ok: false, reason: expect.stringContaining(state), code: 1 });
  });
});

describe('executeRunAll', () => {
  it('runs every step in order and reports complete', async () => {
    const out: string[] = [];
    const ran: string[] = [];
    const steps: RunAllStep[] = [
      { cmd: 'check', args: [] },
      { cmd: 'run', args: ['--snapshot-taken', 's'] },
      { cmd: 'enrich', args: [] },
    ];
    const code = await executeRunAll(
      steps,
      async (s) => {
        ran.push(label(s));
        return 0;
      },
      (l) => out.push(l),
    );
    expect(code).toBe(0);
    expect(ran).toEqual(['check', 'run --snapshot-taken s', 'enrich']);
    expect(out.join('\n')).toContain('run-all COMPLETE');
  });

  it('stops at the first non-zero step (e.g. enrich conflicts) and returns its code', async () => {
    const out: string[] = [];
    const ran: string[] = [];
    const steps: RunAllStep[] = [
      { cmd: 'run', args: ['--snapshot-taken', 's'] },
      { cmd: 'enrich', args: [] },
      { cmd: 'enable-owners', args: [] },
    ];
    const code = await executeRunAll(
      steps,
      async (s) => {
        ran.push(label(s));
        return s.cmd === 'enrich' ? 1 : 0;
      },
      (l) => out.push(l),
    );
    expect(code).toBe(1);
    // enrich ran and failed; enable-owners never ran.
    expect(ran).toEqual(['run --snapshot-taken s', 'enrich']);
    expect(out.join('\n')).toContain("run-all STOPPED at 'enrich'");
  });
});
