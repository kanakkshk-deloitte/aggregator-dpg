import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluate, listCapabilities } from '../evaluate.js';
import { CAPABILITIES } from '../interface.js';
import type { Decision, DecisionInput } from '../interface.js';

// The same vectors run against policy/rbac/rbac.rego in `opa test`.
const file = fileURLToPath(new URL('../../../../policy/rbac/vectors.json', import.meta.url));
const { rbac_vectors: vectors } = JSON.parse(readFileSync(file, 'utf8')) as {
  rbac_vectors: { name: string; input: DecisionInput; expected: Decision }[];
};

describe('shared policy vectors', () => {
  it('has vectors to run', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(evaluate(v.input)).toEqual(v.expected);
  });
});

describe('capability lists agree with single decisions', () => {
  const all = [...CAPABILITIES];
  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const listed = listCapabilities({ actor: v.input.actor, org: v.input.org, candidates: all });
    const allowed = all.filter((c) => evaluate({ ...v.input, capability: c }).allow).sort();
    expect(listed).toEqual(allowed);
  });

  it('drops duplicates and sorts', () => {
    const actor = vectors[0]!.input.actor;
    expect(
      listCapabilities({
        actor,
        candidates: ['profiles.view', 'profiles.onboard', 'profiles.view'],
        org: null,
      }),
    ).toEqual(['profiles.onboard', 'profiles.view']);
  });
});
