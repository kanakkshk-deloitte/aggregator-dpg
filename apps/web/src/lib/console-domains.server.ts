/**
 * The network's domains for the console (`apps/web`, user & org Phase 5):
 * ids and labels from the public aggregator config, so a coordinator's
 * served domains read as "Seekers" rather than `seeker`.
 *
 * @module apps/web/src/lib/console-domains.server
 */

/** One network domain. */
export interface ConsoleDomain {
  id: string;
  label: string;
}

interface ConfigPayload {
  domains?: ConsoleDomain[];
}

/**
 * Reads the network's domains (server-side; empty on any failure, so a
 * page still renders with domain ids).
 *
 * @returns The domains, in configuration order.
 */
export async function networkDomains(): Promise<ConsoleDomain[]> {
  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${base}/v1/aggregator-config`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const cfg = (await res.json()) as ConfigPayload;
    return (cfg.domains ?? []).map((d) => ({ id: d.id, label: d.label }));
  } catch {
    return [];
  }
}

/**
 * The domains a coordinator serves, with their labels.
 *
 * @param serves - Domain ids served; empty means every domain.
 * @param domains - From {@link networkDomains}.
 * @returns The served domains (an unknown id keeps its id as the label); every domain when `serves` is empty.
 */
export function servedDomains(
  serves: readonly string[],
  domains: readonly ConsoleDomain[],
): ConsoleDomain[] {
  if (serves.length === 0) return [...domains];
  return serves.map((id) => ({ id, label: domains.find((d) => d.id === id)?.label ?? id }));
}
