/**
 * Request envelope shared by the api app's campaign channels (export, email, voice).
 *
 *   { "item_ids": string[], "metadata": [{ "key", "value" }], "content": {} }
 *
 * `item_ids` are the target Signals items. `metadata` pairs are stored as sent.
 * `content` is the per-channel payload (`{}` for export).
 *
 * The per-request item cap is checked in the route so it can return
 * `CAMPAIGN_TOO_MANY_ITEMS`.
 *
 * @module @aggregator-dpg/api
 */
import { z } from 'zod';

/** A single free-form metadata pair. */
export const campaignMetadataPairSchema = z
  .object({
    key: z.string().trim().min(1).max(200),
    value: z.string().max(2000),
  })
  .strict();

/**
 * The shared campaign request envelope. `item_ids` must be a non-empty uuid array;
 * `metadata` and `content` default to empty.
 */
export const campaignEnvelopeSchema = z
  .object({
    item_ids: z.array(z.string().uuid()).min(1),
    metadata: z.array(campaignMetadataPairSchema).max(50).default([]),
    content: z.record(z.unknown()).default({}),
  })
  .strict();

export type CampaignEnvelope = z.infer<typeof campaignEnvelopeSchema>;
export type CampaignMetadataPair = z.infer<typeof campaignMetadataPairSchema>;

/**
 * De-duplicates item ids while preserving first-seen order.
 *
 * @param ids - Raw item ids from the envelope.
 * @returns The ids with later duplicates removed, original order kept.
 */
export function dedupeItemIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Reads a metadata pair's value by key (first match), or undefined.
 *
 * @param metadata - The job's metadata pairs.
 * @param key - The key to look up.
 * @returns The matching value, or undefined.
 */
export function metadataValue(
  metadata: readonly CampaignMetadataPair[],
  key: string,
): string | undefined {
  return metadata.find((m) => m.key === key)?.value;
}
