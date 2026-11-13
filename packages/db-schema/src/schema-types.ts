/**
 * String-literal types matching DB enums, for callers that do not import the Drizzle schema.
 */

export type AggregatorActorType = 'aggregator' | 'seeker' | 'provider';

export type AggregatorStatus = 'pending' | 'active' | 'inactive' | 'retired';
