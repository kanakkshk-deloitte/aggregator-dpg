/**
 * Unit tests for {@link getVoiceProvider} — the campaign voice channel's
 * provider factory (aggregator-dpg#577).
 *
 * @module @aggregator-dpg/voice-provider
 */
import { describe, it, expect, vi } from 'vitest';
import { getVoiceProvider } from '../index.js';
import { RayaVoiceProvider } from '../raya.js';

describe('getVoiceProvider', () => {
  it('constructs a RayaVoiceProvider for provider "raya"', () => {
    const provider = getVoiceProvider({
      provider: 'raya',
      baseUrl: 'https://raya.example.com/api',
      apiKey: 'key-abc',
      timeoutMs: 5000,
      acquireSlot: vi.fn().mockResolvedValue(undefined),
    });

    expect(provider).toBeInstanceOf(RayaVoiceProvider);
  });

  it('throws ConfigError for an unsupported provider', () => {
    expect(() =>
      getVoiceProvider({
        // Cast past the literal-union type to exercise the runtime guard.
        provider: 'bogus' as 'raya',
        baseUrl: 'https://raya.example.com/api',
        apiKey: 'key-abc',
        timeoutMs: 5000,
        acquireSlot: vi.fn().mockResolvedValue(undefined),
      }),
    ).toThrow(/unknown voice provider/);
  });
});
