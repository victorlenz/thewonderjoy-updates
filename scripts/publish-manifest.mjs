#!/usr/bin/env node
// Signs and writes site/gazefix/manifest/v1/manifest.json from manifest-source/gazefix.json (see README).
// Usage: node scripts/publish-manifest.mjs [--key main-2026] [--full] [--offline] [--dry-run]
//   --key       which private key signs (default main-2026), read from <keys dir>/<key>.private.pem;
//               keys dir = THEWONDERJOY_KEYS_DIR, else %USERPROFILE%\.thewonderjoy\keys
//   --full      also download every url and compare its SHA-256 (about 5.5 GB)
//   --offline   skip the live serial and the link check
//   --dry-run   print the manifest that would be signed; sign and write nothing
// Exit code 1 (and nothing written) when the manifest breaks a rule, a link is wrong, or signing fails.

import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MANIFEST_FORMAT, readEnvelope, signManifest, validateManifest } from '../shared/manifest.mjs';
import { PUBLISHED_SITE_URL } from '../shared/upstream-watch.mjs';
import { checkDownloads, createNetwork } from './download-checks.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_FILE = path.join(REPO_ROOT, 'manifest-source', 'gazefix.json');
const PUBLIC_KEYS_FILE = path.join(REPO_ROOT, 'keys', 'public-keys.json');
const MANIFEST_SITE_PATH = 'gazefix/manifest/v1/manifest.json';
const SITE_FILE = path.join(REPO_ROOT, 'site', ...MANIFEST_SITE_PATH.split('/'));
const LIVE_URL = `${PUBLISHED_SITE_URL}/${MANIFEST_SITE_PATH}`;
const APP_BUILT_IN_MANIFEST = 'D:\\Work\\gaze\\app\\src\\GazeFix.Core\\Setup\\BuiltInManifest.json';
const DEFAULT_KEY_ID = 'main-2026';
const KEY_ID_PATTERN = /^[a-z0-9-]{3,40}$/;

class PublishRefused extends Error {}

// ---- Pure parts (unit-tested) -----------------------------------------------------------------

/** 1 + the highest of the given serials (null/undefined ignored); 1 when none. */
export function nextSerial(...serials) {
  const known = serials.filter((serial) => serial !== null && serial !== undefined);
  return known.length === 0 ? 1 : Math.max(...known) + 1;
}

/** { format: 1, serial, publishedAt: <now as ISO seconds with Z>, ...source } */
export function buildManifest(source, serial, now) {
  const header = { format: MANIFEST_FORMAT, serial, publishedAt: isoSeconds(now) };
  return { ...header, ...source, ...header }; // header first in key order, and the source cannot override it
}

function isoSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Command-line options; throws PublishRefused on anything unknown. */
export function parseOptions(args) {
  const options = { keyId: DEFAULT_KEY_ID, full: false, offline: false, dryRun: false };
  const flags = { '--full': 'full', '--offline': 'offline', '--dry-run': 'dryRun' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--key') options.keyId = args[++index];
    else if (Object.hasOwn(flags, arg)) options[flags[arg]] = true;
    else throw new PublishRefused(`Unknown option: ${arg}`);
  }
  if (!KEY_ID_PATTERN.test(options.keyId ?? '')) throw new PublishRefused(`--key must match ${KEY_ID_PATTERN}`);
  return options;
}

/** Where private keys live: THEWONDERJOY_KEYS_DIR, else <home>/.thewonderjoy/keys. */
export function keysDirectory(env = process.env, homeDirectory = os.homedir()) {
  return env.THEWONDERJOY_KEYS_DIR || path.join(homeDirectory, '.thewonderjoy', 'keys');
}

// ---- Main flow --------------------------------------------------------------------------------

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const publicKeys = await readJsonFile(PUBLIC_KEYS_FILE);
  const network = createNetwork();
  const serial = nextSerial(await siteSerial(publicKeys), options.offline ? null : await liveSerial(network, publicKeys));
  const manifest = buildManifest(await readJsonFile(SOURCE_FILE), serial, new Date());
  refuseBrokenRules(manifest);
  if (options.offline) log('Link check skipped (--offline).');
  else await refuseBrokenLinks(manifest, options.full);
  if (options.dryRun) {
    printDryRun(manifest);
    return;
  }
  const envelopeText = await signAndVerify(manifest, options.keyId, publicKeys);
  await writeFile(SITE_FILE, envelopeText);
  printNextSteps(serial, options.keyId);
}

/** The serial of the committed site file; null when there is none. A file that does not verify stops the publish. */
async function siteSerial(publicKeys) {
  let text;
  try {
    text = await readFile(SITE_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const result = await readEnvelope(text, publicKeys);
  if (result.errors) throw new PublishRefused(`${SITE_FILE} does not verify, so its serial is unknown: ${result.errors.join('; ')}`);
  log(`Site file serial: ${result.serial}`);
  return result.serial;
}

/** The serial of the live file; null (with a warning) when it cannot be read or does not verify. */
async function liveSerial(network, publicKeys) {
  try {
    const result = await readEnvelope(await network.fetchText(LIVE_URL), publicKeys);
    if (!result.errors) {
      log(`Live file serial: ${result.serial}`);
      return result.serial;
    }
    log(`WARNING: the live file ${LIVE_URL} does not verify (${result.errors.join('; ')}); its serial is ignored.`);
  } catch (error) {
    log(`WARNING: the live file ${LIVE_URL} could not be read (${error.message}); its serial is ignored.`);
  }
  return null;
}

function refuseBrokenRules(manifest) {
  const errors = validateManifest(manifest);
  if (errors.length > 0) throw new PublishRefused(`The manifest breaks the rules:\n- ${errors.join('\n- ')}`);
}

async function refuseBrokenLinks(manifest, full) {
  const { failures, notes } = await checkDownloads(manifest, { full, name: 'manifest-source' });
  for (const note of notes) log(`WARNING: ${note}`);
  if (failures.length > 0) throw new PublishRefused(`The link check failed:\n- ${failures.join('\n- ')}`);
}

async function signAndVerify(manifest, keyId, publicKeys) {
  if (!Object.hasOwn(publicKeys, keyId)) throw new PublishRefused(`Key "${keyId}" is not in keys/public-keys.json.`);
  const privateKeyFile = path.join(keysDirectory(), `${keyId}.private.pem`);
  const envelopeText = await signManifest(manifest, await readFile(privateKeyFile, 'utf8'), keyId);
  const result = await readEnvelope(envelopeText, publicKeys);
  if (result.errors) {
    throw new PublishRefused(`The signed file does not verify with keys/public-keys.json (wrong private key for "${keyId}"?): ${result.errors.join('; ')}`);
  }
  return envelopeText;
}

function printDryRun(manifest) {
  log(`\nDry run: serial ${manifest.serial}. Nothing was signed or written. The manifest that would be signed:\n`);
  log(JSON.stringify(manifest, null, 2));
}

function printNextSteps(serial, keyId) {
  log(`
Wrote ${path.relative(REPO_ROOT, SITE_FILE)} (serial ${serial}, signed with ${keyId}).
Next:
  1. Commit and push it (the workflow checks it).
  2. Upload it to the server so that it is served at ${LIVE_URL}
  3. Copy it to ${APP_BUILT_IN_MANIFEST} before the next GazeFix build.`);
}

async function readJsonFile(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function log(message) {
  console.log(message);
}

// ---------------------------------------------------------------------------------------------------------------

const isRunDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isRunDirectly) {
  main().catch((error) => {
    console.error(error instanceof PublishRefused ? `Not published: ${error.message}` : error);
    process.exitCode = 1;
  });
}
