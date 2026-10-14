// What the hourly check looks at: the live signed manifest GazeFix reads, every download it lists, and the upstream
// pages that announce news (a new NVIDIA installer, a new FFmpeg release).

import {
  downloadsOf,
  githubDigestProblem,
  githubReleaseApiUrl,
  githubReleaseAsset,
  md5FromEtag,
  readEnvelope,
} from '../../shared/manifest.mjs';
import {
  extractInstallerLinks,
  findNewLinks,
  newFfmpegReleaseNote,
  newInstallerNote,
  nvidiaInstallerUrls,
} from '../../shared/upstream-watch.mjs';

// Fetch has no time limit of its own; a hung request must fail this try, not the whole hourly run.
const REQUEST_TIMEOUT_MS = 30_000;
const GITHUB_RATE_LIMIT_STATUSES = [403, 429];
const GITHUB_API_HEADERS = { 'User-Agent': 'thewonderjoy-updates-check', Accept: 'application/vnd.github+json' };

/**
 * Checks the live manifest and everything it points to. A healthy run makes 10 requests (each retried at most
 * `attempts` times), well under the 50 subrequests a free Worker run may make.
 * @param {{ fetch: typeof fetch, manifestUrl: string, publicKeys: Record<string, string>, nvidiaPageUrl: string,
 *           ffmpegVersionUrl: string, knownOtherLinks: string[], attempts: number, retryDelayMs: number,
 *           sleep: (ms: number) => Promise<void> }} options
 * @returns {Promise<{ problems: string[], serial: number | null }>} problems sorted; serial null when unreadable
 */
export async function findProblems(options) {
  const network = createNetwork(options);
  const loaded = await loadManifest(network, options);
  if (loaded.problems) return { problems: loaded.problems.sort(), serial: null };
  const { manifest, serial } = loaded;
  const problemGroups = await Promise.all([
    ...downloadsOf(manifest).map((download) => checkDownload(network, download)),
    ...githubDigestChecks(network, manifest.ffmpeg),
    checkFfmpegRelease(network, manifest.ffmpeg, options.ffmpegVersionUrl),
    checkNvidiaPage(network, manifest, options),
  ]);
  return { problems: problemGroups.flat().sort(), serial };
}

// ---- The manifest -----------------------------------------------------------------------------

async function loadManifest(network, { manifestUrl, publicKeys }) {
  let text;
  try {
    text = await (await network.fetchExpecting(manifestUrl)).text();
  } catch (error) {
    return { problems: [`Manifest ${manifestUrl} could not be read: ${error.message}`] };
  }
  const result = await readEnvelope(text, publicKeys);
  if (result.errors) return { problems: result.errors.map((error) => `Manifest ${manifestUrl}: ${error}`) };
  return result;
}

// ---- One download url -------------------------------------------------------------------------

async function checkDownload(network, { label, url, download, isNvidia }) {
  try {
    const { headers } = await network.fetchExpecting(url, { method: 'HEAD' });
    const problems = sizeProblems(headers.get('content-length'), download);
    if (isNvidia) problems.push(...md5Problems(headers.get('etag'), download));
    return problems.map((problem) => `${label}: ${problem} (${url})`);
  } catch (error) {
    return [`${label}: ${error.message} (${url})`];
  }
}

function sizeProblems(contentLength, download) {
  if (contentLength === null) return ['server sent no Content-Length'];
  if (Number(contentLength) === download.sizeBytes) return [];
  return [`size is ${contentLength}, manifest says ${download.sizeBytes}`];
}

function md5Problems(etag, installer) {
  const servedMd5 = md5FromEtag(etag);
  if (servedMd5 === undefined) return [`server sent no md5 in its ETag (${JSON.stringify(etag)})`];
  if (servedMd5 === installer.md5) return [];
  return [`ETag md5 is ${servedMd5}, manifest says ${installer.md5}`];
}

// ---- GitHub release digest --------------------------------------------------------------------

function githubDigestChecks(network, ffmpeg) {
  return ffmpeg.urls
    .map(githubReleaseAsset)
    .filter((asset) => asset !== undefined)
    .map((asset) => checkGithubDigest(network, asset, ffmpeg));
}

async function checkGithubDigest(network, asset, ffmpeg) {
  const apiUrl = githubReleaseApiUrl(asset);
  const label = `FFmpeg ${ffmpeg.version}`;
  try {
    const okStatuses = [200, ...GITHUB_RATE_LIMIT_STATUSES];
    const response = await network.fetchExpecting(apiUrl, { headers: GITHUB_API_HEADERS }, okStatuses);
    if (response.status !== 200) return []; // rate-limited: try again next hour
    const problem = githubDigestProblem(await response.json(), asset.name, ffmpeg.sha256);
    return problem ? [`${label}: ${problem} (${apiUrl})`] : [];
  } catch (error) {
    return [`${label}: GitHub release could not be read: ${error.message} (${apiUrl})`];
  }
}

// ---- Upstream news ----------------------------------------------------------------------------

async function checkFfmpegRelease(network, ffmpeg, ffmpegVersionUrl) {
  try {
    const releasedVersion = (await (await network.fetchExpecting(ffmpegVersionUrl)).text()).trim();
    return releasedVersion === ffmpeg.version ? [] : [newFfmpegReleaseNote(releasedVersion, ffmpeg.version)];
  } catch (error) {
    return [`FFmpeg release version ${ffmpegVersionUrl} could not be read: ${error.message}`];
  }
}

async function checkNvidiaPage(network, manifest, { nvidiaPageUrl, knownOtherLinks }) {
  let html;
  try {
    html = await (await network.fetchExpecting(nvidiaPageUrl)).text();
  } catch (error) {
    return [`NVIDIA page ${nvidiaPageUrl} could not be read: ${error.message}`];
  }
  const pageLinks = extractInstallerLinks(html);
  if (pageLinks.length === 0) return [`No installer links found on ${nvidiaPageUrl}; the page layout may have changed`];
  return findNewLinks(pageLinks, [...nvidiaInstallerUrls(manifest), ...knownOtherLinks]).map(newInstallerNote);
}

// ---- Networking -------------------------------------------------------------------------------

/** fetchExpecting(url, init, okStatuses): the response once its status is in okStatuses, retried; else throws. */
function createNetwork({ fetch: fetchFn, attempts, retryDelayMs, sleep }) {
  const fetchOnce = async (url, init, okStatuses) => {
    const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (okStatuses.includes(response.status)) return response;
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  };
  const fetchExpecting = async (url, init = {}, okStatuses = [200]) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fetchOnce(url, init, okStatuses);
      } catch (error) {
        if (attempt >= attempts) throw error;
        await sleep(retryDelayMs);
      }
    }
  };
  return { fetchExpecting };
}
