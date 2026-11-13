/**
 * Public surface and factory for the campaign job store.
 *
 * Returns a process-wide singleton (Postgres impl). Tests override via
 * `_setCampaignJobStore` with the in-memory fake from `./memory`.
 *
 * @module @aggregator-dpg/api
 */
import type { CampaignJobStoreBase } from './interface.js';
import { PostgresCampaignJobStore } from './postgres.js';

let instance: CampaignJobStoreBase | null = null;

export function getCampaignJobStore(): CampaignJobStoreBase {
  if (instance) return instance;
  instance = new PostgresCampaignJobStore();
  return instance;
}

/** Test helper — replace the singleton (pass null to reset). */
export function _setCampaignJobStore(s: CampaignJobStoreBase | null): void {
  instance = s;
}

export { CampaignJobStoreBase, deriveJobStatus } from './interface.js';
export type {
  CampaignChannel,
  CampaignJobItemStatus,
  CampaignJobStatus,
  CampaignMetadataPair,
  CreateJobInput,
  CreateJobItemInput,
  JobItemView,
  JobRecord,
  JobStatusCounts,
  JobView,
  ListJobsOptions,
  ListJobsResult,
  ProcessingJobView,
  StoreError,
  StoreResult,
} from './interface.js';
export { PostgresCampaignJobStore } from './postgres.js';
export { InMemoryCampaignJobStore } from './memory.js';
