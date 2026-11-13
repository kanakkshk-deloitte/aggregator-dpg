// Env must be set before any import that pulls in `config`.
process.env.SIGNALSTACK_BASE_URL = 'http://signals.local';
process.env.SIGNALSTACK_ADMIN_KEY = 'k';
process.env.SIGNALSTACK_ACTING_ORG_ID = 'svc';

import { afterEach, describe, expect, it, vi } from 'vitest';

const addMock = vi.fn();
const closeMock = vi.fn();
class FakeQueue {
  name: string;
  opts: unknown;
  constructor(name: string, opts: unknown) {
    this.name = name;
    this.opts = opts;
  }
  add = addMock;
  close = closeMock;
}
vi.mock('bullmq', () => ({ Queue: FakeQueue }));
vi.mock('@aggregator-dpg/queue', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    createRedisConnection: () => ({ on: vi.fn(), quit: vi.fn().mockResolvedValue(undefined) }),
  };
});

const { enqueueCampaignProcess, _resetCampaignProcessQueue } = await import('./index.js');

describe('enqueueCampaignProcess', () => {
  afterEach(async () => {
    await _resetCampaignProcessQueue();
    vi.clearAllMocks();
  });

  it('adds a campaign-process job keyed by the durable job id', async () => {
    addMock.mockResolvedValueOnce(undefined);
    await enqueueCampaignProcess({ jobId: 'job-123' });
    expect(addMock).toHaveBeenCalledTimes(1);
    const [queueName, payload, opts] = addMock.mock.calls[0]!;
    expect(queueName).toBe('campaign-process');
    expect(payload).toEqual({ jobId: 'job-123' });
    expect(opts).toEqual({ jobId: 'job-123' });
  });

  it('passes the caller channel attempts per enqueue, not per queue', async () => {
    // One queue serves export/email/voice, so attempts must not be baked into
    // defaultJobOptions — otherwise export's knob would govern every channel.
    addMock.mockResolvedValueOnce(undefined);
    await enqueueCampaignProcess({ jobId: 'job-a' }, { attempts: 7 });
    expect(addMock.mock.calls[0]![2]).toEqual({ jobId: 'job-a', attempts: 7 });
  });

  it('omits attempts when the caller does not set one', async () => {
    addMock.mockResolvedValueOnce(undefined);
    await enqueueCampaignProcess({ jobId: 'job-b' });
    expect(addMock.mock.calls[0]![2]).toEqual({ jobId: 'job-b' });
  });

  it('reuses the singleton queue across calls', async () => {
    addMock.mockResolvedValue(undefined);
    await enqueueCampaignProcess({ jobId: 'a' });
    await enqueueCampaignProcess({ jobId: 'b' });
    expect(addMock).toHaveBeenCalledTimes(2);
  });

  it('rethrows when the enqueue fails', async () => {
    addMock.mockRejectedValueOnce(new Error('redis down'));
    await expect(enqueueCampaignProcess({ jobId: 'x' })).rejects.toThrow('redis down');
  });
});
