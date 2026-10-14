// Run with: node --test worker/test/checks.test.mjs
// Criteria: W2, W3 of D:\Work\specs\updates-signed-manifest.md (and the earlier C2–C9, adapted to the signed manifest).
//
// findProblems(options) → Promise<{ problems: string[] (sorted), serial: number | null }>
// options:
//   fetch            fetch-compatible function
//   manifestUrl      the live signed envelope
//   publicKeys       { keyId: base64 DER SPKI } handed to readEnvelope
//   nvidiaPageUrl    NVIDIA's page that lists installer links
//   ffmpegVersionUrl gyan.dev "release-version" (plain text, current version)
//   knownOtherLinks  string[] of installer urls on NVIDIA's page that are deliberately not used
//   attempts, retryDelayMs, sleep   retry policy (as before)
// Requests (each with a timeout signal):
//   GET  manifestUrl
//   HEAD every NVIDIA installer url            → 200, Content-Length == sizeBytes, ETag md5 == md5
//   HEAD every FFmpeg url (redirects followed) → 200, Content-Length == sizeBytes
//   GET  https://api.github.com/repos/<o>/<r>/releases/tags/<tag> for each GitHub FFmpeg url (User-Agent header set)
//        → the asset named <name> has digest "sha256:<ffmpeg.sha256>"; 403/429 → no problem
//   GET  ffmpegVersionUrl → trimmed text must equal ffmpeg.version
//   GET  nvidiaPageUrl    → every installer link must be a manifest url or in knownOtherLinks
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readEnvelope } from '../../shared/manifest.mjs';
import {
  REAL_PUBLIC_KEYS,
  TEST_PUBLIC_KEYS,
  installerOf,
  signedEnvelope,
  validManifest,
} from '../../test-support/manifest-fixtures.mjs';
import { findProblems } from '../src/checks.mjs';

const MANIFEST_URL = 'https://updates.thewonderjoy.com/gazefix/manifest/v1/manifest.json';
const NVIDIA_PAGE_URL = 'https://www.nvidia.com/broadcast-sdk-resources';
const FFMPEG_VERSION_URL = 'https://www.gyan.dev/ffmpeg/builds/release-version';
const AR_BASE = 'https://international.download.nvidia.com/Windows/broadcast/sdk/AR/';
const KNOWN_OTHER_LINK = `${AR_BASE}nvidia_ar_sdk_installer_v0.8.2_ada.exe`;
const BRAND_NEW_LINK = `${AR_BASE}nvidia_ar_sdk_installer_v0.9.0_ada.exe`;
const RETRY_DELAY_MS = 5000;
const ATTEMPTS = 3;

const MANIFEST = validManifest();
const FFMPEG = MANIFEST.ffmpeg;
const [GITHUB_FFMPEG_URL, GYAN_FFMPEG_URL] = FFMPEG.urls;
const FFMPEG_ASSET_NAME = 'ffmpeg-9.0.2-essentials_build.zip';
const GITHUB_RELEASE_API_URL = 'https://api.github.com/repos/GyanD/codexffmpeg/releases/tags/9.0.2';
const NVIDIA_URLS = MANIFEST.nvidiaArSdk.installers.flatMap((installer) => installer.urls);

function installerFor(architecture) {
  return installerOf(MANIFEST, architecture);
}

// ---- Fake network -------------------------------------------------------------------------------

/** A reply is a function that builds a fresh Response (or throws, like fetch does on a network error). */
const reply = {
  text: (body) => () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } }),
  json: (data) => () =>
    new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  status: (status) => () => new Response(`HTTP ${status}`, { status }),
  networkError: () => () => {
    throw new TypeError('fetch failed');
  },
  head: ({ contentLength, etag }) => () => {
    const headers = {};
    if (contentLength !== undefined) headers['Content-Length'] = String(contentLength);
    if (etag !== undefined) headers.ETag = etag;
    return new Response(null, { status: 200, headers });
  },
};

function goodNvidiaHead(installer) {
  return reply.head({ contentLength: installer.sizeBytes, etag: `"${installer.md5}:1738045409.233305"` });
}

/** What fetch returns for an FFmpeg url after following GitHub's 302 to blob storage (or gyan.dev's 200). */
function goodFfmpegHead() {
  return reply.head({ contentLength: FFMPEG.sizeBytes });
}

function githubRelease({ digest = `sha256:${FFMPEG.sha256}`, assetName = FFMPEG_ASSET_NAME } = {}) {
  return {
    tag_name: '9.0.2',
    assets: [
      { name: 'ffmpeg-9.0.2-full_build.zip', digest: `sha256:${'0'.repeat(64)}` },
      { name: assetName, digest },
    ],
  };
}

function nvidiaPage(links = [...NVIDIA_URLS, KNOWN_OTHER_LINK]) {
  return `<html><body>${links.map((link) => `<a href="${link}">installer</a>`).join('\n')}</body></html>`;
}

/**
 * Routes are keyed "<METHOD> <url>". Each route is a list of replies used in turn; the last one repeats.
 * Every call is recorded as { method, url, init }. An unknown route is a test bug, so it fails loudly.
 */
function createFakeFetch(routes) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? (typeof input === 'string' ? 'GET' : input.method) ?? 'GET').toUpperCase();
    const callIndex = calls.filter((call) => call.method === method && call.url === url).length;
    calls.push({ method, url, init });
    const replies = routes[`${method} ${url}`];
    if (!replies) throw new Error(`fake fetch: unexpected ${method} ${url}`);
    return replies[Math.min(callIndex, replies.length - 1)]();
  };
  const callsTo = (method, url) => calls.filter((call) => call.method === method && call.url === url);
  return { fetch, calls, callsTo };
}

function createRecordingSleep() {
  const delays = [];
  const sleep = async (ms) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

/** Healthy routes for `manifest` (signed with the test key); `overrides` replaces individual routes. */
function routesFor({ manifest = MANIFEST, envelopeText = signedEnvelope(manifest), overrides = {} } = {}) {
  const routes = {
    [`GET ${MANIFEST_URL}`]: [reply.text(envelopeText)],
    [`GET ${GITHUB_RELEASE_API_URL}`]: [reply.json(githubRelease())],
    [`GET ${FFMPEG_VERSION_URL}`]: [reply.text(`${FFMPEG.version}\n`)],
    [`GET ${NVIDIA_PAGE_URL}`]: [reply.text(nvidiaPage())],
  };
  for (const installer of manifest.nvidiaArSdk?.installers ?? []) {
    for (const url of installer.urls) routes[`HEAD ${url}`] = [goodNvidiaHead(installer)];
  }
  for (const url of manifest.ffmpeg?.urls ?? []) routes[`HEAD ${url}`] = [goodFfmpegHead()];
  return { ...routes, ...overrides };
}

async function runCheck(
  routes,
  { attempts = ATTEMPTS, publicKeys = TEST_PUBLIC_KEYS, knownOtherLinks = [KNOWN_OTHER_LINK] } = {},
) {
  const network = createFakeFetch(routes);
  const recorder = createRecordingSleep();
  const result = await findProblems({
    fetch: network.fetch,
    manifestUrl: MANIFEST_URL,
    publicKeys,
    nvidiaPageUrl: NVIDIA_PAGE_URL,
    ffmpegVersionUrl: FFMPEG_VERSION_URL,
    knownOtherLinks,
    attempts,
    retryDelayMs: RETRY_DELAY_MS,
    sleep: recorder.sleep,
  });
  return { ...result, result, network, delays: recorder.delays };
}

function assertOneProblemIncluding(problems, ...parts) {
  assert.equal(problems.length, 1, JSON.stringify(problems));
  for (const part of parts) assert.ok(problems[0].includes(part), `${JSON.stringify(part)} not in ${problems[0]}`);
}

function assertOnlyManifestFetched(network) {
  const fetched = network.calls.map(({ method, url }) => `${method} ${url}`);
  assert.ok(fetched.length > 0, 'the manifest must be fetched');
  assert.deepEqual(new Set(fetched), new Set([`GET ${MANIFEST_URL}`]), 'nothing else may be fetched');
}

function manifestWith(change) {
  const manifest = validManifest();
  change(manifest);
  return manifest;
}

// ---- W2/W3: all fine ------------------------------------------------------------------------------

test('W2/W3: a valid manifest and healthy downloads give { problems: [], serial }', async () => {
  const { result } = await runCheck(routesFor());
  assert.deepEqual(result, { problems: [], serial: 1 });
});

test('W3: serial is the serial of the live manifest', async () => {
  const manifest = manifestWith((m) => { m.serial = 7; });
  const { problems, serial } = await runCheck(routesFor({ manifest }));
  assert.deepEqual(problems, []);
  assert.equal(serial, 7);
});

test('W2: a healthy run makes exactly one request to each url (10 in all, well under 50 subrequests)', async () => {
  const { network } = await runCheck(routesFor());
  const expected = [
    `GET ${MANIFEST_URL}`,
    ...NVIDIA_URLS.map((url) => `HEAD ${url}`),
    `HEAD ${GITHUB_FFMPEG_URL}`,
    `HEAD ${GYAN_FFMPEG_URL}`,
    `GET ${GITHUB_RELEASE_API_URL}`,
    `GET ${FFMPEG_VERSION_URL}`,
    `GET ${NVIDIA_PAGE_URL}`,
  ];
  assert.deepEqual(network.calls.map(({ method, url }) => `${method} ${url}`).sort(), expected.sort());
});

test('W2: every request carries an abort signal (the 30 s timeout)', async () => {
  const { network } = await runCheck(routesFor());
  assert.ok(network.calls.length > 0);
  for (const { method, url, init } of network.calls) {
    assert.ok(init.signal instanceof AbortSignal, `${method} ${url} has no signal`);
  }
});

test('W2: FFmpeg HEAD requests follow redirects (GitHub answers 302 to blob storage)', async () => {
  const { network } = await runCheck(routesFor());
  for (const url of FFMPEG.urls) {
    const [{ init }] = network.callsTo('HEAD', url);
    assert.ok(init.redirect === undefined || init.redirect === 'follow', `redirect: ${init.redirect}`);
  }
});

test('W2: the GitHub API request sends a User-Agent header', async () => {
  const { network } = await runCheck(routesFor());
  const [{ init }] = network.callsTo('GET', GITHUB_RELEASE_API_URL);
  assert.ok((new Headers(init.headers).get('user-agent') ?? '').length > 0);
});

test('W2: every url of an installer is checked, not only the first', async () => {
  const mirror = 'https://download.nvidia.com/mirror/nvidia_ar_sdk_installer_v0.8.7_ada.exe';
  const manifest = manifestWith((m) => { installerOf(m, 'ada').urls.push(mirror); });
  const { problems, network } = await runCheck(routesFor({ manifest }));
  assert.deepEqual(problems, []);
  assert.equal(network.callsTo('HEAD', mirror).length, 1);
});

// ---- W2: envelope unreachable (was C3) ----------------------------------------------------------

for (const status of [404, 403]) {
  test(`W2: manifest HTTP ${status} → one problem naming the url and status; serial null; nothing else fetched`, async () => {
    const { problems, serial, network } = await runCheck(
      routesFor({ overrides: { [`GET ${MANIFEST_URL}`]: [reply.status(status)] } }),
    );
    assertOneProblemIncluding(problems, MANIFEST_URL, String(status));
    assert.equal(serial, null);
    assertOnlyManifestFetched(network);
  });
}

test('W2: manifest network error → one problem naming the url and the error; serial null; nothing else fetched', async () => {
  const { problems, serial, network } = await runCheck(
    routesFor({ overrides: { [`GET ${MANIFEST_URL}`]: [reply.networkError()] } }),
  );
  assertOneProblemIncluding(problems, MANIFEST_URL, 'fetch failed');
  assert.equal(serial, null);
  assertOnlyManifestFetched(network);
});

// ---- W2: envelope content bad (was C4/C5) -------------------------------------------------------

/** Each readEnvelope error is one problem naming the manifest url; serial null; nothing else fetched. */
async function assertEnvelopeRejected(envelopeText, { publicKeys = TEST_PUBLIC_KEYS } = {}) {
  const { errors } = await readEnvelope(envelopeText, publicKeys);
  assert.ok(errors?.length > 0, 'test setup: this envelope must be invalid');
  const { problems, serial, network } = await runCheck(routesFor({ envelopeText }), { publicKeys });
  assert.equal(problems.length, errors.length, JSON.stringify(problems));
  for (const problem of problems) assert.ok(problem.includes(MANIFEST_URL), problem);
  assert.equal(serial, null);
  assertOnlyManifestFetched(network);
  return problems;
}

test('W2: an envelope that is not JSON → problem(s) naming the manifest url; nothing else fetched', async () => {
  await assertEnvelopeRejected('<html>Bad gateway</html>');
});

test('W2: a bad signature (key table has another key for test-2026) → problems; nothing else fetched', async () => {
  await assertEnvelopeRejected(signedEnvelope(MANIFEST), { publicKeys: { 'test-2026': REAL_PUBLIC_KEYS['main-2026'] } });
});

test('W2: an unknown keyId → problems; nothing else fetched', async () => {
  await assertEnvelopeRejected(signedEnvelope(MANIFEST), { publicKeys: REAL_PUBLIC_KEYS });
});

test('W2: each section-3 error of a signed manifest is one problem; nothing else fetched', async () => {
  const manifest = manifestWith((m) => {
    m.format = 2;
    installerOf(m, 'ada').sha256 = 'abc';
  });
  const problems = await assertEnvelopeRejected(signedEnvelope(manifest));
  assert.ok(problems.some((problem) => problem.includes('format')), JSON.stringify(problems));
  assert.ok(problems.some((problem) => problem.includes('sha256')), JSON.stringify(problems));
});

test('W2: a signed manifest missing an architecture is rejected as a whole (problem names it; nothing checked)', async () => {
  const manifest = manifestWith((m) => {
    m.nvidiaArSdk.installers = m.nvidiaArSdk.installers.filter((installer) => installer.architecture !== 'blackwell');
  });
  const problems = await assertEnvelopeRejected(signedEnvelope(manifest));
  assert.ok(problems.some((problem) => problem.includes('blackwell')), JSON.stringify(problems));
});

// ---- W2: NVIDIA installers (was C6/C7) ----------------------------------------------------------

test('W2: one NVIDIA installer 404 → one problem naming architecture, url and status; others still checked', async () => {
  const ampere = installerFor('ampere');
  const { problems, serial, network } = await runCheck(
    routesFor({ overrides: { [`HEAD ${ampere.urls[0]}`]: [reply.status(404)] } }),
  );
  assertOneProblemIncluding(problems, 'ampere', ampere.urls[0], '404');
  assert.equal(serial, 1, 'the serial is known even when downloads have problems');
  for (const url of NVIDIA_URLS) assert.ok(network.callsTo('HEAD', url).length >= 1, `HEAD ${url}`);
});

test('W2: a different NVIDIA size is a problem that shows both numbers', async () => {
  const ada = installerFor('ada');
  const servedSize = ada.sizeBytes + 4096;
  const { problems } = await runCheck(
    routesFor({
      overrides: {
        [`HEAD ${ada.urls[0]}`]: [reply.head({ contentLength: servedSize, etag: `"${ada.md5}:1738045409.233305"` })],
      },
    }),
  );
  assertOneProblemIncluding(problems, 'ada', String(ada.sizeBytes), String(servedSize));
});

test('W2: a different ETag md5 is a problem that shows both md5s', async () => {
  const turing = installerFor('turing');
  const servedMd5 = '0123456789abcdef0123456789abcdef';
  const { problems } = await runCheck(
    routesFor({
      overrides: {
        [`HEAD ${turing.urls[0]}`]: [reply.head({ contentLength: turing.sizeBytes, etag: `"${servedMd5}:1760000000.5"` })],
      },
    }),
  );
  assertOneProblemIncluding(problems, 'turing', turing.md5, servedMd5);
});

test('W2: a missing ETag is a problem', async () => {
  const blackwell = installerFor('blackwell');
  const { problems } = await runCheck(
    routesFor({ overrides: { [`HEAD ${blackwell.urls[0]}`]: [reply.head({ contentLength: blackwell.sizeBytes })] } }),
  );
  assertOneProblemIncluding(problems, 'blackwell');
});

test('W2: an ETag without an md5 at the start is a problem', async () => {
  const blackwell = installerFor('blackwell');
  const { problems } = await runCheck(
    routesFor({
      overrides: { [`HEAD ${blackwell.urls[0]}`]: [reply.head({ contentLength: blackwell.sizeBytes, etag: '"abc"' })] },
    }),
  );
  assertOneProblemIncluding(problems, 'blackwell');
});

// ---- W2: FFmpeg urls ------------------------------------------------------------------------------

test('W2: an FFmpeg url answering 404 → one problem naming the url and status', async () => {
  const { problems } = await runCheck(routesFor({ overrides: { [`HEAD ${GYAN_FFMPEG_URL}`]: [reply.status(404)] } }));
  assertOneProblemIncluding(problems, GYAN_FFMPEG_URL, '404');
});

test('W2: an FFmpeg url with a different Content-Length → one problem with both numbers', async () => {
  const servedSize = FFMPEG.sizeBytes - 1;
  const { problems } = await runCheck(
    routesFor({ overrides: { [`HEAD ${GITHUB_FFMPEG_URL}`]: [reply.head({ contentLength: servedSize })] } }),
  );
  assertOneProblemIncluding(problems, GITHUB_FFMPEG_URL, String(FFMPEG.sizeBytes), String(servedSize));
});

test('W2: an FFmpeg url without Content-Length → one problem naming the url', async () => {
  const { problems } = await runCheck(routesFor({ overrides: { [`HEAD ${GYAN_FFMPEG_URL}`]: [reply.head({})] } }));
  assertOneProblemIncluding(problems, GYAN_FFMPEG_URL);
});

// ---- W2: GitHub API digest ----------------------------------------------------------------------

test('W2: a GitHub asset digest different from ffmpeg.sha256 → one problem with both hashes', async () => {
  const otherSha = 'f'.repeat(64);
  const release = githubRelease({ digest: `sha256:${otherSha}` });
  const { problems } = await runCheck(routesFor({ overrides: { [`GET ${GITHUB_RELEASE_API_URL}`]: [reply.json(release)] } }));
  assertOneProblemIncluding(problems, FFMPEG.sha256, otherSha);
});

test('W2: the asset missing from the GitHub release → one problem naming the asset', async () => {
  const release = githubRelease({ assetName: 'something-else.zip' });
  const { problems } = await runCheck(routesFor({ overrides: { [`GET ${GITHUB_RELEASE_API_URL}`]: [reply.json(release)] } }));
  assertOneProblemIncluding(problems, FFMPEG_ASSET_NAME);
});

for (const status of [403, 429]) {
  test(`W2: GitHub API HTTP ${status} (rate limit) → no problem`, async () => {
    const { problems } = await runCheck(
      routesFor({ overrides: { [`GET ${GITHUB_RELEASE_API_URL}`]: [reply.status(status)] } }),
    );
    assert.deepEqual(problems, []);
  });
}

test('W2: GitHub API HTTP 404 (release gone) → one problem naming the API url', async () => {
  const { problems } = await runCheck(
    routesFor({ overrides: { [`GET ${GITHUB_RELEASE_API_URL}`]: [reply.status(404)] } }),
  );
  assertOneProblemIncluding(problems, GITHUB_RELEASE_API_URL, '404');
});

test('W2: no GitHub url in ffmpeg.urls → no GitHub API request', async () => {
  const manifest = manifestWith((m) => { m.ffmpeg.urls = [GYAN_FFMPEG_URL]; });
  const { problems, network } = await runCheck(routesFor({ manifest }));
  assert.deepEqual(problems, []);
  assert.equal(network.callsTo('GET', GITHUB_RELEASE_API_URL).length, 0);
});

// ---- W2: gyan.dev release-version ---------------------------------------------------------------

test('W2: gyan.dev release-version equal to ffmpeg.version (surrounding whitespace ignored) → no problem', async () => {
  const { problems } = await runCheck(
    routesFor({ overrides: { [`GET ${FFMPEG_VERSION_URL}`]: [reply.text('  9.0.2\r\n')] } }),
  );
  assert.deepEqual(problems, []);
});

test('W2: a newer gyan.dev release → exactly "FFmpeg <v> released (manifest has <m>)"', async () => {
  const { problems } = await runCheck(
    routesFor({ overrides: { [`GET ${FFMPEG_VERSION_URL}`]: [reply.text('9.1.0\n')] } }),
  );
  assert.deepEqual(problems, ['FFmpeg 9.1.0 released (manifest has 9.0.2)']);
});

test('W2: release-version unreadable after all attempts → one problem naming its url and status', async () => {
  const { problems } = await runCheck(
    routesFor({ overrides: { [`GET ${FFMPEG_VERSION_URL}`]: [reply.status(500)] } }),
  );
  assertOneProblemIncluding(problems, FFMPEG_VERSION_URL, '500');
});

// ---- W2: NVIDIA page new installer links --------------------------------------------------------

test('W2: a page link in neither the manifest nor knownOtherLinks → exactly "NVIDIA lists a new installer: <url>"', async () => {
  const page = nvidiaPage([...NVIDIA_URLS, KNOWN_OTHER_LINK, BRAND_NEW_LINK]);
  const { problems } = await runCheck(routesFor({ overrides: { [`GET ${NVIDIA_PAGE_URL}`]: [reply.text(page)] } }));
  assert.deepEqual(problems, [`NVIDIA lists a new installer: ${BRAND_NEW_LINK}`]);
});

test('W2: a new link that appears several times on the page is reported once', async () => {
  const page = nvidiaPage([...NVIDIA_URLS, BRAND_NEW_LINK, BRAND_NEW_LINK]);
  const { problems } = await runCheck(routesFor({ overrides: { [`GET ${NVIDIA_PAGE_URL}`]: [reply.text(page)] } }));
  assert.deepEqual(problems, [`NVIDIA lists a new installer: ${BRAND_NEW_LINK}`]);
});

test('W2: a known other link is a new installer when knownOtherLinks does not list it', async () => {
  const { problems } = await runCheck(routesFor(), { knownOtherLinks: [] });
  assert.deepEqual(problems, [`NVIDIA lists a new installer: ${KNOWN_OTHER_LINK}`]);
});

test('W2: NVIDIA page unreadable after all attempts → one problem naming the page url and status', async () => {
  const { problems } = await runCheck(routesFor({ overrides: { [`GET ${NVIDIA_PAGE_URL}`]: [reply.status(503)] } }));
  assertOneProblemIncluding(problems, NVIDIA_PAGE_URL, '503');
});

test('W2: an NVIDIA page with no installer links at all → one problem naming the page url (layout changed?)', async () => {
  const { problems } = await runCheck(
    routesFor({ overrides: { [`GET ${NVIDIA_PAGE_URL}`]: [reply.text('<html>Maintenance</html>')] } }),
  );
  assertOneProblemIncluding(problems, NVIDIA_PAGE_URL);
});

// ---- W2: retries (was C8) -----------------------------------------------------------------------

test('W2: steps that fail once then succeed are not problems, and the wait is retryDelayMs', async () => {
  const ada = installerFor('ada');
  const { problems, delays, network } = await runCheck(
    routesFor({
      overrides: {
        [`GET ${MANIFEST_URL}`]: [reply.status(503), reply.text(signedEnvelope(MANIFEST))],
        [`HEAD ${ada.urls[0]}`]: [reply.networkError(), goodNvidiaHead(ada)],
      },
    }),
  );
  assert.deepEqual(problems, []);
  assert.equal(network.callsTo('GET', MANIFEST_URL).length, 2);
  assert.equal(network.callsTo('HEAD', ada.urls[0]).length, 2);
  assert.deepEqual(delays, [RETRY_DELAY_MS, RETRY_DELAY_MS]);
});

test('W2: an FFmpeg url that fails once then succeeds is not a problem', async () => {
  const { problems, network } = await runCheck(
    routesFor({ overrides: { [`HEAD ${GYAN_FFMPEG_URL}`]: [reply.status(502), goodFfmpegHead()] } }),
  );
  assert.deepEqual(problems, []);
  assert.equal(network.callsTo('HEAD', GYAN_FFMPEG_URL).length, 2);
});

test('W2: an installer that fails every time is a problem after exactly `attempts` requests', async () => {
  const turing = installerFor('turing');
  const { problems, network, delays } = await runCheck(
    routesFor({ overrides: { [`HEAD ${turing.urls[0]}`]: [reply.status(500)] } }),
  );
  assertOneProblemIncluding(problems, 'turing');
  assert.equal(network.callsTo('HEAD', turing.urls[0]).length, ATTEMPTS);
  assert.deepEqual(delays, Array(ATTEMPTS - 1).fill(RETRY_DELAY_MS));
});

test('W2: a manifest that fails every time is one problem after exactly `attempts` requests', async () => {
  const attempts = 4;
  const { problems, network } = await runCheck(
    routesFor({ overrides: { [`GET ${MANIFEST_URL}`]: [reply.networkError()] } }),
    { attempts },
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.equal(network.callsTo('GET', MANIFEST_URL).length, attempts);
});

test('W2: a single attempt means no retry and no wait', async () => {
  const ada = installerFor('ada');
  const { problems, network, delays } = await runCheck(
    routesFor({ overrides: { [`HEAD ${ada.urls[0]}`]: [reply.status(404), goodNvidiaHead(ada)] } }),
    { attempts: 1 },
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.equal(network.callsTo('HEAD', ada.urls[0]).length, 1);
  assert.deepEqual(delays, []);
});

test('W2: only the last failure counts', async () => {
  const ampere = installerFor('ampere');
  const { problems } = await runCheck(
    routesFor({
      overrides: { [`HEAD ${ampere.urls[0]}`]: [reply.networkError(), reply.networkError(), reply.status(410)] },
    }),
  );
  assertOneProblemIncluding(problems, '410');
  assert.ok(!problems[0].includes('fetch failed'), problems[0]);
});

// ---- W2: sorted (was C9) ------------------------------------------------------------------------

test('W2: problems from every kind of check are returned together, sorted', async () => {
  const turing = installerFor('turing');
  const page = nvidiaPage([...NVIDIA_URLS, BRAND_NEW_LINK]);
  const { problems } = await runCheck(
    routesFor({
      overrides: {
        [`HEAD ${turing.urls[0]}`]: [reply.status(404)],
        [`HEAD ${GYAN_FFMPEG_URL}`]: [reply.head({ contentLength: 1 })],
        [`GET ${FFMPEG_VERSION_URL}`]: [reply.text('9.1.0')],
        [`GET ${NVIDIA_PAGE_URL}`]: [reply.text(page)],
      },
    }),
  );
  assert.equal(problems.length, 4, JSON.stringify(problems));
  assert.deepEqual(problems, [...problems].sort());
});
