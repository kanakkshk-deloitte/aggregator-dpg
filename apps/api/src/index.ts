/**
 * Public exports of the api app for packages that need its types. The HTTP entry point is `server.ts`.
 */

export type { Config } from './config.js';
export type { Coordinator } from './services/user-store/index.js';
export { buildApp } from './app.js';
