/**
 * Unit tests for {@link InMemoryCampaignJobStore} — the store contract via the
 * shared conformance suite.
 *
 * @module @aggregator-dpg/api
 */
import { randomUUID } from 'node:crypto';
import { InMemoryCampaignJobStore } from '../memory.js';
import { runStoreConformance, runInMemoryNotFoundConformance } from './conformance.js';

runStoreConformance(() => new InMemoryCampaignJobStore(), { aggregatorId: randomUUID() });
runInMemoryNotFoundConformance(() => new InMemoryCampaignJobStore());
