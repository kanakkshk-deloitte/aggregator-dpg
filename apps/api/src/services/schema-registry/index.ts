/**
 * Schema registry: the persona and service ids an aggregator may declare on
 * its profile (`@aggregator-dpg/api`).
 *
 * Loaded once from `config/schema-registry.yaml`. Tests can replace the
 * singleton with {@link _setSchemaRegistry}.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RegistryEntry {
  id: string;
  name: string;
}

export abstract class SchemaRegistryBase {
  abstract hasPersona(id: string): boolean;
  abstract hasService(id: string): boolean;
  abstract listPersonas(): RegistryEntry[];
  abstract listServices(): RegistryEntry[];
  abstract resolvePersona(id: string): RegistryEntry | null;
  abstract resolveService(id: string): RegistryEntry | null;
}

/**
 * YAML-backed registry. Loads the file on construction; `pathOverride` sets another path.
 */
export class YamlSchemaRegistry extends SchemaRegistryBase {
  private readonly personas: Map<string, RegistryEntry>;
  private readonly services: Map<string, RegistryEntry>;

  constructor(pathOverride?: string) {
    super();
    const raw = readFileSync(pathOverride ?? resolveRegistryPath(), 'utf8');
    const parsed = parseSimpleYaml(raw);
    this.personas = new Map(parsed.personas.map((e) => [e.id, e]));
    this.services = new Map(parsed.services.map((e) => [e.id, e]));
  }

  hasPersona(id: string): boolean {
    return this.personas.has(id);
  }
  hasService(id: string): boolean {
    return this.services.has(id);
  }
  listPersonas(): RegistryEntry[] {
    return [...this.personas.values()];
  }
  listServices(): RegistryEntry[] {
    return [...this.services.values()];
  }
  resolvePersona(id: string): RegistryEntry | null {
    return this.personas.get(id) ?? null;
  }
  resolveService(id: string): RegistryEntry | null {
    return this.services.get(id) ?? null;
  }
}

/**
 * In-memory registry for tests, seeded with fixture ids. No file I/O.
 */
export class InMemorySchemaRegistry extends SchemaRegistryBase {
  private readonly personas = new Map<string, RegistryEntry>();
  private readonly services = new Map<string, RegistryEntry>();

  seed(input: { personas?: RegistryEntry[]; services?: RegistryEntry[] }): this {
    for (const e of input.personas ?? []) this.personas.set(e.id, e);
    for (const e of input.services ?? []) this.services.set(e.id, e);
    return this;
  }

  hasPersona(id: string): boolean {
    return this.personas.has(id);
  }
  hasService(id: string): boolean {
    return this.services.has(id);
  }
  listPersonas(): RegistryEntry[] {
    return [...this.personas.values()];
  }
  listServices(): RegistryEntry[] {
    return [...this.services.values()];
  }
  resolvePersona(id: string): RegistryEntry | null {
    return this.personas.get(id) ?? null;
  }
  resolveService(id: string): RegistryEntry | null {
    return this.services.get(id) ?? null;
  }
}

let instance: SchemaRegistryBase | null = null;

export function getSchemaRegistry(): SchemaRegistryBase {
  if (instance) return instance;
  instance = new YamlSchemaRegistry();
  return instance;
}

/** Test helper; replaces the singleton with a fake. */
export function _setSchemaRegistry(r: SchemaRegistryBase | null): void {
  instance = r;
}

// ─── Minimal YAML parser ─────────────────────────────────────────────────────

/**
 * Minimal parser for the shape of `schema-registry.yaml`:
 *
 *   personas:
 *     - id: ...
 *       name: ...
 *
 * Handles flat lists only; use `js-yaml` if the file grows more complex.
 */
function parseSimpleYaml(raw: string): {
  personas: RegistryEntry[];
  services: RegistryEntry[];
} {
  const lines = raw
    .split('\n')
    .map((l) => l.replace(/#.*/, ''))
    .map((l) => l.trimEnd());

  const personas: RegistryEntry[] = [];
  const services: RegistryEntry[] = [];
  let bucket: RegistryEntry[] | null = null;
  let cur: Partial<RegistryEntry> | null = null;

  const flush = (): void => {
    if (cur && cur.id && cur.name && bucket) {
      bucket.push({ id: cur.id, name: cur.name });
    }
    cur = null;
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('personas:')) {
      flush();
      bucket = personas;
      continue;
    }
    if (line.startsWith('services:')) {
      flush();
      bucket = services;
      continue;
    }
    if (!bucket) continue;
    const dash = line.match(/^\s*-\s+(.*)/);
    if (dash && dash[1]) {
      flush();
      cur = {};
      const rest = dash[1];
      const m = rest.match(/^(id|name)\s*:\s*(.+)/);
      if (m && m[1] && m[2]) cur[m[1] as 'id' | 'name'] = unquote(m[2]);
      continue;
    }
    const kv = line.match(/^\s+(id|name)\s*:\s*(.+)/);
    if (kv && kv[1] && kv[2] && cur) {
      cur[kv[1] as 'id' | 'name'] = unquote(kv[2]);
    }
  }
  flush();
  return { personas, services };
}

function unquote(v: string): string {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveRegistryPath(): string {
  const candidates = [
    path.resolve(__dirname, '../../../../config/schema-registry.yaml'),
    path.resolve(__dirname, '../../../../../config/schema-registry.yaml'),
    path.resolve(process.cwd(), 'config/schema-registry.yaml'),
    path.resolve(process.cwd(), '../../config/schema-registry.yaml'),
  ];
  for (const c of candidates) {
    try {
      readFileSync(c, 'utf8');
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error(`schema-registry.yaml not found; tried: ${candidates.join(', ')}`);
}
