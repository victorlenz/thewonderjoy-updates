// Checks that every download in a manifest is what the manifest says (Node only; used by check-links.mjs and
// publish-manifest.mjs):
//   quick: size of every url (HEAD, or a one-byte ranged GET), NVIDIA md5 from the ETag, GitHub asset digest
//   full:  also downloads every url (nothing is saved) and compares the SHA-256

import { createHash } from 'node:crypto';

import {
  downloadsOf,
  githubDigestProblem,
  githubReleaseApiUrl,
  githubReleaseAsset,
  md5FromEtag,
} from '../shared/manifest.mjs';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const NETWORK_TIMEOUT_MS = 30_000;
const RETRIES_AFTER_FIRST_TRY = 2;
const RETRY_PAUSE_MS = 3_000;
const PROGRESS_STEP_PERCENT = 10;
const GITHUB_RATE_LIMIT_STATUSES = [403, 429];

/**
 * @param {object} manifest  a manifest that passed validateManifest
 * @param {{ full?: boolean, name: string, fetch?: typeof fetch, log?: (line: string) => void }} options
 *   name prefixes every finding (e.g. the site path); fetch is injectable for tests.
 * @returns {Promise<{ failures: string[], notes: string[] }>}
 */
export async function checkDownloads(manifest, { full = false, name, fetch: fetchFn = fetch, log = console.log }) {
  const network = createNetwork(fetchFn, log);
  const findings = { failures: [], notes: [] };
  const downloads = downloadsOf(manifest).map((download) => ({ ...download, label: `${name} ${download.label}` }));
  for (const download of downloads) await checkHeaders(network, download, findings, log);
  await checkGithubDigests(network, manifest.ffmpeg, `${name} FFmpeg ${manifest.ffmpeg.version}`, findings, log);
  if (full) for (const download of downloads) await checkHash(network, download, findings, log);
  return findings;
}

// ---- Size and ETag md5 ------------------------------------------------------------------------

async function checkHeaders(network, { label, url, download, isNvidia }, findings, log) {
  try {
    const remote = await network.withRetries(() => remoteFileInfo(network, url));
    const mismatches = headerMismatches(remote, download, isNvidia);
    if (mismatches.length === 0) log(`OK    ${label}: ${remote.size} bytes${isNvidia ? `, md5 ${remote.md5}` : ''} (${url})`);
    else findings.failures.push(...mismatches.map((mismatch) => `${label}: ${mismatch} (${url})`));
  } catch (error) {
    findings.failures.push(`${label}: ${error.message} (${url})`);
  }
}

function headerMismatches(remote, download, isNvidia) {
  const mismatches = [];
  if (remote.size !== download.sizeBytes) mismatches.push(`size is ${remote.size}, manifest says ${download.sizeBytes}`);
  if (!isNvidia) return mismatches;
  if (remote.md5 === undefined) mismatches.push(`server sent no md5 in its ETag (${JSON.stringify(remote.etag)})`);
  else if (remote.md5 !== download.md5) mismatches.push(`ETag md5 is ${remote.md5}, manifest says ${download.md5}`);
  return mismatches;
}

async function remoteFileInfo(network, url) {
  const head = await network.fetchWithTimeout(url, { method: 'HEAD' });
  if (head.status === 200) return fileInfo(head, requireNumber(head.headers.get('content-length'), 'Content-Length', url));
  const ranged = await network.fetchWithTimeout(url, { headers: { Range: 'bytes=0-0' } });
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

// ---- GitHub release digest --------------------------------------------------------------------

async function checkGithubDigests(network, ffmpeg, label, findings, log) {
  const assets = ffmpeg.urls.map(githubReleaseAsset).filter((asset) => asset !== undefined);
  for (const asset of assets) {
    const apiUrl = githubReleaseApiUrl(asset);
    try {
      const response = await network.withRetries(() => fetchGithubRelease(network, apiUrl));
      if (GITHUB_RATE_LIMIT_STATUSES.includes(response.status)) {
        findings.notes.push(`${label}: GitHub digest not checked, API rate limit reached (HTTP ${response.status}, ${apiUrl})`);
        continue;
      }
      const problem = githubDigestProblem(await response.json(), asset.name, ffmpeg.sha256);
      if (problem) findings.failures.push(`${label}: ${problem} (${apiUrl})`);
      else log(`OK    ${label}: GitHub digest sha256:${ffmpeg.sha256} (${apiUrl})`);
    } catch (error) {
      findings.failures.push(`${label}: GitHub release could not be read: ${error.message} (${apiUrl})`);
    }
  }
}

async function fetchGithubRelease(network, apiUrl) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await network.fetchWithTimeout(apiUrl, { headers });
  if (response.status === 200 || GITHUB_RATE_LIMIT_STATUSES.includes(response.status)) return response;
  await response.body?.cancel();
  throw new Error(`HTTP ${response.status}`);
}

// ---- --full: download and compare SHA-256 -----------------------------------------------------

async function checkHash(network, { label, url, download }, findings, log) {
  try {
    const { sha256, bytes } = await network.withRetries(() => hashDownload(network, url, download.sizeBytes, label));
    if (bytes !== download.sizeBytes) findings.failures.push(`${label}: downloaded ${bytes} bytes, manifest says ${download.sizeBytes} (${url})`);
    else if (sha256 !== download.sha256) findings.failures.push(`${label}: SHA-256 is ${sha256}, manifest says ${download.sha256} (${url})`);
    else log(`OK    ${label}: SHA-256 matches (${url})`);
  } catch (error) {
    findings.failures.push(`${label}: download failed: ${error.message} (${url})`);
  }
}

async function hashDownload(network, url, expectedBytes, label) {
  const idle = new IdleTimeout(NETWORK_TIMEOUT_MS);
  try {
    const response = await network.fetchRaw(url, { headers: browserHeaders(), signal: idle.signal });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    return await hashBody(response.body, new ProgressLog(label, expectedBytes, network.log), idle);
  } finally {
    idle.stop();
  }
}

async function hashBody(body, progress, idle) {
  const hash = createHash('sha256');
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

  constructor(label, totalBytes, log) {
    this.label = label;
    this.totalBytes = totalBytes;
    this.log = log;
  }

  update(bytes) {
    const percent = Math.floor((bytes / this.totalBytes) * 100);
    if (percent < this.#nextPercent) return;
    this.log(`      ${this.label}: ${percent}% (${bytes} of ${this.totalBytes} bytes)`);
    this.#nextPercent = percent - (percent % PROGRESS_STEP_PERCENT) + PROGRESS_STEP_PERCENT;
  }
}

// ---- Networking -------------------------------------------------------------------------------

/** Fetch with a browser User-Agent, a timeout and retries; shared by the checks and the scripts. */
export function createNetwork(fetchFn = fetch, log = console.log) {
  const fetchWithTimeout = (url, { method = 'GET', headers = {} } = {}) =>
    fetchFn(url, {
      method,
      headers: browserHeaders(headers),
      redirect: 'follow',
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });

  const withRetries = async (action) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await action();
      } catch (error) {
        if (attempt >= RETRIES_AFTER_FIRST_TRY) throw describeNetworkError(error);
        log(`      retrying after: ${describeNetworkError(error).message}`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
      }
    }
  };

  /** The body as text when the url answers 200; throws otherwise. Retried. */
  const fetchText = (url) =>
    withRetries(async () => {
      const response = await fetchWithTimeout(url);
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      return response.text();
    });

  return { fetchWithTimeout, fetchRaw: fetchFn, withRetries, fetchText, log };
}

function browserHeaders(extra = {}) {
  return { 'User-Agent': BROWSER_USER_AGENT, ...extra };
}

function describeNetworkError(error) {
  if (error?.name === 'TimeoutError') return new Error(`timed out after ${NETWORK_TIMEOUT_MS / 1000} s`);
  const cause = error?.cause?.code ?? error?.cause?.message;
  return cause ? new Error(`${error.message} (${cause})`) : error;
}
