/**
 * Runtime configuration schema for this package.
 *
 * Validated at startup by @aggregator-dpg/config-loader. Add your service's
 * config keys here as Zod fields.
 *
 * @module @aggregator-dpg/_template/config
 */

import { z } from 'zod';

/**
 * Top-level key under which this package's config lives in the merged config tree.
 * Must be unique across all packages. Replace with your service name (camelCase).
 */
export const configKey = 'template';

// Replace with real config fields for your service.
export const configSchema = z.object({
  // exampleTimeoutMs: z.number().int().positive().default(5000),
  // exampleBaseUrl: z.string().url(),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Baseline config values merged into the tree before env YAML overrides.
 * Keys must match fields declared in configSchema above.
 */
export const configDefaults: Config = {
  // exampleTimeoutMs: 5000,
};
