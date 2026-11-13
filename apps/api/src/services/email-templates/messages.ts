/**
 * Externalised email copy: loading, layering, and lookup.
 *
 * Belongs to `@aggregator-dpg/api`. Uses the same layering model as Signals-DPG.
 *
 * Per-key precedence, lowest first:
 *
 *   1. `config/emails/messages.properties` — aggregator-level default, complete
 *   2. `config/<network>/emails/messages.properties`
 *   3. `config/<network>/<brand>/emails/messages.properties`
 *   4. `EMAIL_MESSAGES_PATH` — per-instance escape hatch, wins over all
 *
 * Every layer lives in `config/`, so changing copy is a config edit, not a release.
 *
 * Layers 2-4 are partial: a file lists only the keys it changes. Layer 1 must
 * be complete; {@link assertMessagesComplete} checks this at boot.
 *
 * Lookup is synchronous. The default layer is read once, lazily, with
 * `readFileSync`; {@link loadEmailMessageOverrides} merges the override layers
 * at boot.
 *
 * @module @aggregator-dpg/api
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveConfigRoot, resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { logger } from '../../logger.js';
import { parseProperties } from './parse-properties.js';
import { EMAIL_CASE_IDS, caseKeys, caseTokenTypes, requiredMessageKeys } from './email-cases.js';
import { tokensUsed } from './substitute.js';

/** Relative location of a copy layer inside its config directory. */
const MESSAGES_FILE = path.join('emails', 'messages.properties');

/**
 * Absolute path to the aggregator-level default layer.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns `<config root>/emails/messages.properties`.
 */
function defaultsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveConfigRoot(env), MESSAGES_FILE);
}

let messages: Map<string, string> | null = null;

/**
 * Reads and parses the bundled defaults.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Parsed default entries.
 * @throws {Error} If the file is missing (broken image or wrong `CONFIG_ROOT`).
 */
function loadDefaults(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const file = defaultsPath(env);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new Error(
      `email copy defaults not found at ${file} — check CONFIG_ROOT and that config/ is present`,
      { cause },
    );
  }
  const parsed = parseProperties(text);
  if (parsed.malformedLines.length > 0) {
    // The default layer must be valid, so this is an error, not a warning.
    logger.error({
      operation: 'emailMessages.loadDefaults',
      status: 'failure',
      file,
      malformed_lines: parsed.malformedLines,
    });
  }
  return parsed.entries;
}

/**
 * Returns the active copy index, loading the bundled defaults on first use.
 *
 * @returns Key → copy fragment.
 */
function index(): Map<string, string> {
  messages ??= loadDefaults();
  return messages;
}

/**
 * Looks up one copy fragment.
 *
 * @param key - Fully-qualified key, e.g. `applicant_approved.subject`.
 * @returns The fragment, or the key itself when absent.
 */
export function getMessage(key: string): string {
  return index().get(key) ?? key;
}

/**
 * Candidate override files, lowest precedence first.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Absolute paths, in the order they must be merged.
 */
export function emailMessageOverridePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = resolveConfigRoot(env);
  const { network, brand } = resolveActiveNetwork(env);
  // Use the config root, not `resolveConfigDir`, which already includes the network segment.
  const paths = [path.join(root, network, MESSAGES_FILE)];
  if (brand) paths.push(path.join(root, network, brand, MESSAGES_FILE));
  const instance = env.EMAIL_MESSAGES_PATH?.trim();
  if (instance) paths.push(instance);
  return paths;
}

/**
 * Reads one override layer, distinguishing "absent" from "broken".
 *
 * A missing layer is silent. Any other read error (EACCES, EISDIR, …) is
 * reported as a misconfiguration.
 *
 * @param file - Absolute path to the layer.
 * @param isInstanceOverride - Whether this is `EMAIL_MESSAGES_PATH`.
 * @returns File contents, or `null` when the layer is absent or skippable.
 * @throws {Error} If `EMAIL_MESSAGES_PATH` exists but cannot be read.
 */
async function readOverrideLayer(
  file: string,
  isInstanceOverride: boolean,
): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null; // absent layer — the common case
    if (isInstanceOverride) {
      throw new Error(`EMAIL_MESSAGES_PATH is set but unreadable: ${file} (${code})`, { cause });
    }
    logger.warn({
      operation: 'emailMessages.loadOverrides',
      status: 'failure',
      file,
      error: code ?? 'UNKNOWN',
      reason: 'unreadable',
    });
    return null;
  }
}

/**
 * Merges the override layers over the bundled defaults.
 *
 * Called once at server boot. A missing override file is skipped silently. A
 * file that cannot be read or parsed is logged and skipped; copy overrides
 * never stop the API from starting.
 *
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Number of keys overridden, for the boot log.
 */
export async function loadEmailMessageOverrides(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const merged = new Map(loadDefaults(env));
  let overridden = 0;

  const instanceOverride = env.EMAIL_MESSAGES_PATH?.trim();

  for (const file of emailMessageOverridePaths(env)) {
    const text = await readOverrideLayer(file, file === instanceOverride);
    if (text === null) continue;
    const parsed = parseProperties(text);
    if (parsed.malformedLines.length > 0) {
      logger.warn({
        operation: 'emailMessages.loadOverrides',
        status: 'failure',
        file,
        malformed_lines: parsed.malformedLines,
      });
    }
    for (const [key, value] of parsed.entries) {
      // An override key no case declares is likely a typo; warn about it.
      if (!merged.has(key)) {
        logger.warn({
          operation: 'emailMessages.loadOverrides',
          status: 'skipped',
          file,
          key,
          reason: 'unknown_key',
        });
        continue;
      }
      merged.set(key, value);
      overridden += 1;
    }
    logger.info({ operation: 'emailMessages.loadOverrides', status: 'success', file });
  }

  messages = merged;
  return overridden;
}

/**
 * Verifies every key the case registry declares is present.
 *
 * @throws {Error} If any declared key is missing from the active index.
 */
export function assertMessagesComplete(): void {
  const active = index();
  const missing = requiredMessageKeys().filter((k) => !active.has(k));
  if (missing.length > 0) {
    throw new Error(`email copy is missing ${missing.length} key(s): ${missing.join(', ')}`);
  }

  // Also check that override copy keeps every `{{token}}` the default uses.
  const undeclared: string[] = [];
  for (const caseId of EMAIL_CASE_IDS) {
    const declared = new Set(Object.keys(caseTokenTypes(caseId)));
    for (const key of caseKeys(caseId)) {
      for (const token of tokensUsed(active.get(`${caseId}.${key}`) ?? '')) {
        if (!declared.has(token)) undeclared.push(`${caseId}.${key}: {{${token}}}`);
      }
    }
  }
  if (undeclared.length > 0) {
    throw new Error(
      `email copy uses ${undeclared.length} undeclared token(s): ${undeclared.join(', ')}`,
    );
  }
}

/**
 * Test seam — replaces the active index.
 *
 * @param entries - Copy entries, or `null` to fall back to bundled defaults.
 */
export function _setEmailMessages(entries: Map<string, string> | null): void {
  messages = entries;
}
