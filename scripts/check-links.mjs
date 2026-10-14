#!/usr/bin/env node
// Checks the signed manifests in site/ (site/**/manifest.json), every download they list, and the upstream pages.
//
//   node scripts/check-links.mjs              quick check (sizes, NVIDIA ETag md5, GitHub digest)
//   node scripts/check-links.mjs --full       also download every url and check its SHA-256
//   node scripts/check-links.mjs --skip-live  do not compare with the published copy on the website
//
// Exit codes: 0 = all fine, 1 = something is broken, 2 = nothing broken but there is news (NVIDIA lists a new
// installer, or gyan.dev released a new FFmpeg). If REPORT_PATH is set, a Markdown report is also written there.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readEnvelope } from '../shared/manifest.mjs';
import {
  FFMPEG_RELEASE_VERSION_URL,
  KNOWN_OTHER_INSTALLER_URLS,
  NVIDIA_PAGE_URL,
  PUBLISHED_SITE_URL,
  extractInstallerLinks,
  findNewLinks,
  newFfmpegReleaseNote,
  nvidiaInstallerUrls,
} from '../shared/upstream-watch.mjs';
import { checkDownloads, createNetwork, totalFromContentRange } from './download-checks.mjs';

export { extractInstallerLinks, findNewLinks, totalFromContentRange };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');
const PUBLIC_KEYS_FILE = path.join(REPO_ROOT, 'keys', 'public-keys.json');
const MANIFEST_FILE_NAME = 'manifest.json';

const EXIT_ALL_FINE = 0;
const EXIT_BROKEN = 1;
const EXIT_ONLY_NEWS = 2;

// ---------------------------------------------------------------------------------------------------------------
// Main flow

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const findings = { failures: [], newLinks: [], newReleases: [], notes: [] };
  const network = createNetwork();
  const publicKeys = JSON.parse(await readFile(PUBLIC_KEYS_FILE, 'utf8'));

  const manifests = await loadAllManifests(publicKeys, findings);
  const allManifestsValid = findings.failures.length === 0;
  await checkAllDownloads(manifests, options, findings);
  if (options.skipLive) findings.notes.push('Live check skipped (--skip-live).');
  else await checkPublishedCopies(network, manifests, publicKeys, findings);
  await checkFfmpegRelease(network, manifests, findings);
  // With an invalid manifest left out, its links would wrongly show up as "new" on NVIDIA's page.
  if (allManifestsValid) await watchNvidiaPage(network, manifests, findings);
  else findings.notes.push('NVIDIA page watch skipped because a manifest is invalid.');

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

async function checkAllDownloads(manifests, options, findings) {
  for (const { sitePath, manifest } of manifests) {
    const { failures, notes } = await checkDownloads(manifest, { full: options.full, name: sitePath });
    findings.failures.push(...failures);
    findings.notes.push(...notes);
  }
}

/** findings.newReleases is optional (older callers only know newLinks). */
export function exitCodeFor(findings) {
  if (findings.failures.length > 0) return EXIT_BROKEN;
  if (findings.newLinks.length + (findings.newReleases?.length ?? 0) > 0) return EXIT_ONLY_NEWS;
  return EXIT_ALL_FINE;
}

// ---------------------------------------------------------------------------------------------------------------
// C1: load and verify the signed manifests

async function loadAllManifests(publicKeys, findings) {
  const files = await findManifestFiles(SITE_DIR);
  if (files.length === 0) findings.failures.push(`No ${MANIFEST_FILE_NAME} found under site/.`);
  const manifests = [];
  for (const file of files) {
    const sitePath = toSitePath(file);
    log(`Verifying ${sitePath}`);
    const envelopeText = await readFile(file, 'utf8');
    const result = await readEnvelope(envelopeText, publicKeys);
    if (result.errors) findings.failures.push(...result.errors.map((error) => `${sitePath}: ${error}`));
    else manifests.push({ sitePath, envelopeText, ...result });
  }
  return manifests;
}

async function findManifestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name === MANIFEST_FILE_NAME)
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    .sort();
}

function toSitePath(file) {
  return path.relative(SITE_DIR, file).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------------------------------------------
// C3: live check, the published envelope must carry the same manifest bytes and serial as the repo file

async function checkPublishedCopies(network, manifests, publicKeys, findings) {
  for (const { sitePath, envelopeText, serial } of manifests) {
    const url = `${PUBLISHED_SITE_URL}/${sitePath}`;
    try {
      const liveText = await network.fetchText(url);
      const problem = await liveCopyProblem(liveText, envelopeText, serial, publicKeys);
      if (problem) findings.failures.push(`Live copy at ${url} ${problem}`);
      else log(`OK    live copy matches: ${url} (serial ${serial})`);
    } catch (error) {
      findings.failures.push(`Live copy at ${url} could not be read: ${error.message}`);
    }
  }
}

async function liveCopyProblem(liveText, repoText, repoSerial, publicKeys) {
  const live = await readEnvelope(liveText, publicKeys);
  if (live.errors) return `is not a valid signed manifest: ${live.errors.join('; ')}`;
  if (live.serial !== repoSerial) return `has serial ${live.serial}, the repo has ${repoSerial}`;
  if (JSON.parse(liveText).manifest !== JSON.parse(repoText).manifest) return 'has different manifest bytes than the repo';
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// C4: news, a new FFmpeg release on gyan.dev and new installer links on NVIDIA's page

async function checkFfmpegRelease(network, manifests, findings) {
  let releasedVersion;
  try {
    releasedVersion = (await network.fetchText(FFMPEG_RELEASE_VERSION_URL)).trim();
  } catch (error) {
    findings.failures.push(`FFmpeg release version ${FFMPEG_RELEASE_VERSION_URL} could not be read: ${error.message}`);
    return;
  }
  for (const { sitePath, manifest } of manifests) {
    if (manifest.ffmpeg.version === releasedVersion) log(`OK    ${sitePath}: FFmpeg ${releasedVersion} is the current gyan.dev release`);
    else findings.newReleases.push(`${sitePath}: ${newFfmpegReleaseNote(releasedVersion, manifest.ffmpeg.version)}`);
  }
}

async function watchNvidiaPage(network, manifests, findings) {
  let html;
  try {
    html = await network.fetchText(NVIDIA_PAGE_URL);
  } catch (error) {
    findings.failures.push(`NVIDIA page ${NVIDIA_PAGE_URL} could not be read: ${error.message}`);
    return;
  }
  const pageLinks = extractInstallerLinks(html);
  if (pageLinks.length === 0) {
    findings.failures.push(`No installer links found on ${NVIDIA_PAGE_URL}; the page layout may have changed.`);
    return;
  }
  const manifestUrls = manifests.flatMap(({ manifest }) => nvidiaInstallerUrls(manifest));
  findings.newLinks.push(...findNewLinks(pageLinks, [...manifestUrls, ...KNOWN_OTHER_INSTALLER_URLS]));
  log(`NVIDIA page: ${pageLinks.length} installer link(s), ${findings.newLinks.length} new`);
}

// ---------------------------------------------------------------------------------------------------------------
// Report

export function buildReport(options, findings) {
  const mode = options.full ? 'full (sizes, md5, GitHub digest + SHA-256 downloads)' : 'quick (sizes, md5, GitHub digest)';
  const lines = ['# GazeFix manifest check', '', `- Time: ${new Date().toISOString()}`, `- Mode: ${mode}`];
  lines.push(`- Result: ${resultSummary(findings)}`, '');
  lines.push(...section('Broken', findings.failures));
  lines.push(...section("New on NVIDIA's page (not in the manifest or shared/known-other-links.json)", findings.newLinks));
  lines.push(...section('New FFmpeg release', findings.newReleases ?? []));
  lines.push(...section('Notes', findings.notes));
  return lines.join('\n');
}

function resultSummary(findings) {
  switch (exitCodeFor(findings)) {
    case EXIT_BROKEN: return `${findings.failures.length} problem(s) found`;
    case EXIT_ONLY_NEWS: return 'links OK, but there is news (see below)';
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
