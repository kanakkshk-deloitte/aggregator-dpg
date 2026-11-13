import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** Headers sent with every response. */
const BASE_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];

/**
 * Signed-in pages may not be shown inside another site's frame, so their
 * buttons cannot be clicked through a disguised page. Public registration
 * pages are left frameable.
 */
const NO_FRAME_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];

/** Paths of the signed-in console, coordinator portal and API routes. */
const SIGNED_IN_PATHS = [
  '/console/:path*',
  '/console',
  '/dashboard/:path*',
  '/onboarding/:path*',
  '/profile/:path*',
  '/api/:path*',
];

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: false,
  async headers() {
    return [
      { source: '/:path*', headers: BASE_HEADERS },
      ...SIGNED_IN_PATHS.map((source) => ({ source, headers: NO_FRAME_HEADERS })),
    ];
  },
};

export default withNextIntl(nextConfig);
