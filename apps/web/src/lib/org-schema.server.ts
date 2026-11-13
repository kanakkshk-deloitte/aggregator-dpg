/**
 * Server-side loading of the organisation schema (`apps/web`): the
 * deployment's `org-registration.v1.json` + `.ui.json`, with the network's
 * domains filled into every `x-network-domains` field. Used by the org
 * registration page and the console's organisation page.
 *
 * @module apps/web/src/lib/org-schema.server
 */

import { readFile } from 'node:fs/promises';
import type { RJSFSchema } from '@rjsf/utils';
import { resolveAggregatorSchemaPath } from './aggregator-schema.server';
import { networkDomains } from './console-domains.server';
import { applyNetworkDomains } from './org-schema';

/** The org schema pair, ready to render. */
export interface LoadedOrgSchema {
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
}

/**
 * Loads the org-registration schema and UI schema and applies the network's
 * domains. Without network config the schema's own values stand.
 *
 * @returns The schema pair, or `null` when the files are absent or unreadable.
 */
export async function loadOrgSchema(): Promise<LoadedOrgSchema | null> {
  let raw: LoadedOrgSchema;
  try {
    const [rawSchema, rawUi] = await Promise.all([
      readFile(resolveAggregatorSchemaPath('org-registration.v1.json'), 'utf8'),
      readFile(resolveAggregatorSchemaPath('org-registration.v1.ui.json'), 'utf8'),
    ]);
    raw = {
      schema: JSON.parse(rawSchema) as RJSFSchema,
      uiSchema: JSON.parse(rawUi) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
  return applyNetworkDomains(raw.schema, raw.uiSchema, await networkDomains());
}
