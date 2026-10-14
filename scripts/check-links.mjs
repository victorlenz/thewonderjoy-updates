#!/usr/bin/env node
// Checks the installer lists in site/ and the NVIDIA links they point to.
//
//   node scripts/check-links.mjs              quick check (sizes and ETag md5 from HEAD requests)
//   node scripts/check-links.mjs --full       also download every installer and check its SHA-256
//   node scripts/check-links.mjs --skip-live  do not compare with the published copy on the website
//
// Exit codes: 0 = all fine, 1 = something is broken, 2 = nothing broken but NVIDIA's page has new installers.
// If REPORT_PATH is set, a Markdown report is also written there.

import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { MAX_LIST_BYTES, md5FromEtag, validateList } from '../shared/installer-list.mjs';

export { validateList };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');
const KNOWN_OTHER_LINKS_FILE = path.join(REPO_ROOT, 'scripts', 'known-other-links.txt');
const LIST_FILE_NAME = 'installers.json';

const PUBLISHED_SITE_URL = 'https://updates.thewonderjoy.com';
const NVIDIA_PAGE_URL = 'https://www.nvidia.com/broadcast-sdk-resources';
const INSTALLER_LINK_PATTERN = /https?:\/\/[^"'\s<>]*nvidia_ar_sdk_installer[^"'\s<>]*\.exe/gi;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const NETWORK_TIMEOUT_MS = 30_000;
const RETRIES_AFTER_FIRST_TRY = 2;
const RETRY_PAUSE_MS = 3_000;
const PROGRESS_STEP_PERCENT = 10;

const EXIT_ALL_FINE = 0;
const EXIT_BROKEN = 1;
const EXIT_ONLY_NEW_LINKS = 2;

// ---------------------------------------------------------------------------------------------------------------
// Main flow

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const findings = { failures: [], newLinks: [], notes: [] };

  const lists = await loadAllLists(findings);
  const allListsValid = findings.failures.length === 0;
  await checkInstallerHeaders(lists, findings);
  if (options.full) await checkInstallerHashes(lists, findings);
  if (options.skipLive) findings.notes.push('Live check skipped (--skip-live).');
  else await checkPublishedCopies(lists, findings);
  // With an invalid list left out, its links would wrongly show up as "new" on NVIDIA's page.
  if (allListsValid) await watchNvidiaPage(lists, findings);
  else findings.notes.push("NVIDIA page watch skipped because a list is invalid.");

  const report = buildReport(options, findings);
  console.log(`\n${report}`);
  if (process.env.REPORT_PATH) await writeFile(process.env.REPORT_PATH, report);
  process.exitCode = exitCodeFor(findings);
}

function parseOptions(args) {
  const known = new Set(['--full', '--skip-live']);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(' ')}`);
  return { full: args.includes('--full'), skipLive: args.includes('--skip-live') };
}

export function exitCodeFor(findings) {
  if (findings.failures.length > 0) return EXIT_BROKEN;
  if (findings.newLinks.length > 0) return EXIT_ONLY_NEW_LINKS;
  return EXIT_ALL_FINE;
}

// ---------------------------------------------------------------------------------------------------------------
// (a) Load and validate the lists

async function loadAllLists(findings) {
  const files = await findListFiles(SITE_DIR);
  if (files.length === 0) findings.failures.push(`No ${LIST_FILE_NAME} found under site/.`);
  const lists = [];
  for (const file of files) {
    const list = await loadList(file, findings);
    if (list) lists.push(list);
  }
  return lists;
}

async function findListFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name === LIST_FILE_NAME)
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    .sort();
}

async function loadList(file, findings) {
  const sitePath = toSitePath(file);
  log(`Validating ${sitePath}`);
  const { data, errors } = await readAndValidateList(file);
  if (errors.length > 0) {
    findings.failures.push(...errors.map((error) => `${sitePath}: ${error}`));
    return undefined;
  }
  return { sitePath, data };
}

async function readAndValidateList(file) {
  const sizeError = await listSizeError(file);
  if (sizeError) return { errors: [sizeError] };
  const data = await parseJsonFile(file);
  if (data === undefined) return { errors: ['is not valid JSON'] };
  return { data, errors: validateList(data) };
}

async function listSizeError(file) {
  const { size } = await stat(file);
  return size > MAX_LIST_BYTES ? `is ${size} bytes; GazeFix rejects lists over ${MAX_LIST_BYTES} bytes` : undefined;
}

async function parseJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function toSitePath(file) {
  return path.relative(SITE_DIR, file).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------------------------------------------
// (b) Size and ETag md5 check with HEAD (or a one-byte ranged GET)

async function checkInstallerHeaders(lists, findings) {
  for (const { sitePath, installer } of allInstallers(lists)) {
    const label = `${sitePath} ${installer.architecture}`;
    try {
      const remote = await withRetries(() => fetchRemoteFileInfo(installer.url));
      const mismatches = headerMismatches(remote, installer);
      if (mismatches.length === 0) log(`OK    ${label}: ${remote.size} bytes, md5 ${remote.md5}`);
      else findings.failures.push(...mismatches.map((mismatch) => `${label}: ${mismatch} (${installer.url})`));
    } catch (error) {
      findings.failures.push(`${label}: ${error.message} (${installer.url})`);
    }
  }
}

function headerMismatches(remote, installer) {
  const mismatches = [];
  if (remote.size !== installer.sizeBytes) mismatches.push(`size is ${remote.size}, list says ${installer.sizeBytes}`);
  if (remote.md5 === undefined) mismatches.push(`server sent no md5 in its ETag (${JSON.stringify(remote.etag)})`);
  else if (remote.md5 !== installer.md5) mismatches.push(`ETag md5 is ${remote.md5}, list says ${installer.md5}`);
  return mismatches;
}

function allInstallers(lists) {
  return lists.flatMap(({ sitePath, data }) => data.installers.map((installer) => ({ sitePath, installer })));
}

async function fetchRemoteFileInfo(url) {
  const head = await fetchWithTimeout(url, { method: 'HEAD' });
  if (head.status === 200) return fileInfo(head, requireNumber(head.headers.get('content-length'), 'Content-Length', url));
  const ranged = await fetchWithTimeout(url, { headers: { Range: 'bytes=0-0' } });
  await ranged.body?.cancel();
  if (ranged.status === 206) {
    return fileInfo(ranged, requireNumber(totalFromContentRange(ranged.headers.get('content-range')), 'Content-Range', url));
  }
  if (ranged.status === 200) return fileInfo(ranged, requireNumber(ranged.headers.get('content-length'), 'Content-Length', url));
  throw new Error(`HTTP ${head.status} on HEAD and ${ranged.status} on ranged GET`);
}

function fileInfo(response, size) {
  const etag = response.headers.get('etag');
  return { size, etag, md5: md5FromEtag(etag) };
}

/** "bytes 0-0/1324834184" -> "1324834184" */
export function totalFromContentRange(contentRange) {
  return /\/(\d+)\s*$/.exec(contentRange ?? '')?.[1];
}

function requireNumber(text, headerName, url) {
  const value = Number(text);
  if (text === undefined || text === null || !Number.isSafeInteger(value)) {
    throw new Error(`server sent no usable ${headerName} header for ${url}`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// --full: download every installer and compare SHA-256 (nothing is saved to disk)

async function checkInstallerHashes(lists, findings) {
  for (const { sitePath, installer } of allInstallers(lists)) {
    const label = `${sitePath} ${installer.architecture}`;
    try {
      const { sha256, bytes } = await withRetries(() => hashDownload(installer, label));
      if (bytes !== installer.sizeBytes) findings.failures.push(`${label}: downloaded ${bytes} bytes, list says ${installer.sizeBytes}`);
      else if (sha256 !== installer.sha256) findings.failures.push(`${label}: SHA-256 is ${sha256}, list says ${installer.sha256}`);
      else log(`OK    ${label}: SHA-256 matches`);
    } catch (error) {
      findings.failures.push(`${label}: download failed: ${error.message} (${installer.url})`);
    }
  }
}

async function hashDownload(installer, label) {
  const idle = new IdleTimeout(NETWORK_TIMEOUT_MS);
  try {
    const response = await fetch(installer.url, { headers: browserHeaders(), signal: idle.signal });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    return await hashBody(response.body, installer.sizeBytes, label, idle);
  } finally {
    idle.stop();
  }
}

async function hashBody(body, expectedBytes, label, idle) {
  const hash = createHash('sha256');
  const progress = new ProgressLog(label, expectedBytes);
  let bytes = 0;
  for await (const chunk of body) {
    idle.reset();
    hash.update(chunk);
    bytes += chunk.length;
    progress.update(bytes);
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** Aborts a download only when no data has arrived for a while, so large files are not cut off. */
class IdleTimeout {
  #controller = new AbortController();
  #timer;

  constructor(milliseconds) {
    this.milliseconds = milliseconds;
    this.reset();
  }

  get signal() {
    return this.#controller.signal;
  }

  reset() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#controller.abort(new Error(`no data for ${this.milliseconds / 1000} s`)), this.milliseconds);
  }

  stop() {
    clearTimeout(this.#timer);
  }
}

class ProgressLog {
  #nextPercent = PROGRESS_STEP_PERCENT;

  constructor(label, totalBytes) {
    this.label = label;
    this.totalBytes = totalBytes;
  }

  update(bytes) {
    const percent = Math.floor((bytes / this.totalBytes) * 100);
    if (percent < this.#nextPercent) return;
    log(`      ${this.label}: ${percent}% (${bytes} of ${this.totalBytes} bytes)`);
    this.#nextPercent = percent - (percent % PROGRESS_STEP_PERCENT) + PROGRESS_STEP_PERCENT;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// (c) Live check: the published copy must equal the repo file

async function checkPublishedCopies(lists, findings) {
  for (const { sitePath, data } of lists) {
    const url = `${PUBLISHED_SITE_URL}/${sitePath}`;
    try {
      const published = await withRetries(() => fetchJson(url));
      if (isDeepStrictEqual(published, data)) log(`OK    live copy matches: ${url}`);
      else findings.failures.push(`Live copy at ${url} differs from site/${sitePath}`);
    } catch (error) {
      findings.failures.push(`Live copy at ${url} could not be read: ${error.message}`);
    }
  }
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url);
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('response is not valid JSON');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// (d) NVIDIA page watch: report installer links we have never seen

async function watchNvidiaPage(lists, findings) {
  let html;
  try {
    html = await withRetries(() => fetchText(NVIDIA_PAGE_URL));
  } catch (error) {
    findings.failures.push(`NVIDIA page ${NVIDIA_PAGE_URL} could not be read: ${error.message}`);
    return;
  }
  const pageLinks = extractInstallerLinks(html);
  if (pageLinks.length === 0) {
    findings.failures.push(`No installer links found on ${NVIDIA_PAGE_URL}; the page layout may have changed.`);
    return;
  }
  const listedUrls = allInstallers(lists).map(({ installer }) => installer.url);
  const knownOtherUrls = parseKnownLinks(await readFile(KNOWN_OTHER_LINKS_FILE, 'utf8'));
  findings.newLinks.push(...findNewLinks(pageLinks, [...listedUrls, ...knownOtherUrls]));
  log(`NVIDIA page: ${pageLinks.length} installer link(s), ${findings.newLinks.length} new`);
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url);
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** Every distinct AR SDK installer link in the HTML, in page order. */
export function extractInstallerLinks(html) {
  return [...new Set(html.match(INSTALLER_LINK_PATTERN) ?? [])];
}

/** Lines of the known-links file, without blank lines and # comments. */
export function parseKnownLinks(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0);
}

/** Page links that are not in knownUrls. Comparison ignores http/https and letter case. */
export function findNewLinks(pageLinks, knownUrls) {
  const known = new Set(knownUrls.map(comparableUrl));
  return pageLinks.filter((link) => !known.has(comparableUrl(link)));
}

function comparableUrl(url) {
  return url.trim().toLowerCase().replace(/^https?:\/\//, '');
}

// ---------------------------------------------------------------------------------------------------------------
// Networking helpers

function browserHeaders(extra = {}) {
  return { 'User-Agent': BROWSER_USER_AGENT, ...extra };
}

function fetchWithTimeout(url, { method = 'GET', headers = {} } = {}) {
  return fetch(url, {
    method,
    headers: browserHeaders(headers),
    redirect: 'follow',
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
}

async function withRetries(action) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= RETRIES_AFTER_FIRST_TRY) throw describeNetworkError(error);
      log(`      retrying after: ${describeNetworkError(error).message}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    }
  }
}

function describeNetworkError(error) {
  if (error?.name === 'TimeoutError') return new Error(`timed out after ${NETWORK_TIMEOUT_MS / 1000} s`);
  const cause = error?.cause?.code ?? error?.cause?.message;
  return cause ? new Error(`${error.message} (${cause})`) : error;
}

// ---------------------------------------------------------------------------------------------------------------
// Report

export function buildReport(options, findings) {
  const mode = options.full ? 'full (sizes, ETag md5 + SHA-256 downloads)' : 'quick (sizes and ETag md5)';
  const lines = [`# Installer link check`, '', `- Time: ${new Date().toISOString()}`, `- Mode: ${mode}`];
  lines.push(`- Result: ${resultSummary(findings)}`, '');
  lines.push(...section('Broken', findings.failures));
  lines.push(...section("New on NVIDIA's page (not in the list or known-other-links.txt)", findings.newLinks));
  lines.push(...section('Notes', findings.notes));
  return lines.join('\n');
}

function resultSummary(findings) {
  switch (exitCodeFor(findings)) {
    case EXIT_BROKEN: return `${findings.failures.length} problem(s) found`;
    case EXIT_ONLY_NEW_LINKS: return `links OK, ${findings.newLinks.length} new installer link(s) on NVIDIA's page`;
    default: return 'all fine';
  }
}

function section(title, items) {
  if (items.length === 0) return [];
  return [`## ${title}`, '', ...items.map((item) => `- ${item}`), ''];
}

function log(message) {
  console.log(message);
}

// ---------------------------------------------------------------------------------------------------------------

const isRunDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isRunDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = EXIT_BROKEN;
  });
}
