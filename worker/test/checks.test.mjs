// Run with: node --test worker/test/checks.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findProblems, md5FromEtag } from '../src/checks.mjs';

const LIST_URL = 'https://updates.thewonderjoy.com/gazefix/sdk/v1/installers.json';
const AR_BASE = 'https://international.download.nvidia.com/Windows/broadcast/sdk/AR/';
const RETRY_DELAY_MS = 5000;
const ATTEMPTS = 3;

// The four real 0.8.7 entries (site/gazefix/sdk/v1/installers.json plus the md5 values from the spec).
const REAL_INSTALLERS = [
  {
    architecture: 'turing',
    sizeBytes: 1324834184,
    sha256: 'ffa722db0f0d8191bdce928194487c41f8cd223bcd663262d8f3c54770b59a42',
    md5: '5dbee8c09f09ef9b76ea292f3e3396fc',
  },
  {
    architecture: 'ampere',
    sizeBytes: 1344314200,
    sha256: '2d237da124116a7f4d7b9ed95623a26eaafb6a99b692a6e4c2b41e143f2fd633',
    md5: '732b51ce049639631031312482b44479',
  },
  {
    architecture: 'ada',
    sizeBytes: 1330863768,
    sha256: '0e2e1110065ed58b9c4a844c674fe5f50ed5fe37a0d170bd229a4bbc48861ca5',
    md5: 'd14abd6c8f4b9246e4082d84f8e1895e',
  },
  {
    architecture: 'blackwell',
    sizeBytes: 1347983656,
    sha256: 'db73b7259efb57736651d26a643e7982132b734b63d9376cdbdd1ee3df7a847c',
    md5: '9ac74fe7c787ea98bd9a8b2b50608f0a',
  },
].map(({ architecture, sizeBytes, sha256, md5 }) => ({
  architecture,
  sdkVersion: '0.8.7',
  url: `${AR_BASE}nvidia_ar_sdk_installer_v0.8.7_${architecture}.exe`,
  sizeBytes,
  sha256,
  md5,
}));

function installerFor(architecture) {
  return REAL_INSTALLERS.find((installer) => installer.architecture === architecture);
}

// ---- Fake network -------------------------------------------------------------------------------

/** A reply is a function that builds a fresh Response (or throws, like fetch does on a network error). */
const reply = {
  json: (data) => () =>
    new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  text: (body) => () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
  status: (status) => () => new Response(`HTTP ${status}`, { status }),
  networkError: () => () => {
    throw new TypeError('fetch failed');
  },
  head: ({ contentLength, etag }) => () => {
    const headers = { 'Content-Length': String(contentLength) };
    if (etag !== undefined) headers.ETag = etag;
    return new Response(null, { status: 200, headers });
  },
};

function goodHead(installer) {
  return reply.head({ contentLength: installer.sizeBytes, etag: `"${installer.md5}:1738045409.233305"` });
}

/**
 * Routes are keyed "<METHOD> <url>". Each route is a list of replies used in turn; the last one repeats.
 * Every call is recorded as { method, url }. An unknown route is a test bug, so it fails loudly.
 */
function createFakeFetch(routes) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? (typeof input === 'string' ? 'GET' : input.method) ?? 'GET').toUpperCase();
    const callIndex = calls.filter((call) => call.method === method && call.url === url).length;
    calls.push({ method, url });
    const replies = routes[`${method} ${url}`];
    if (!replies) throw new Error(`fake fetch: unexpected ${method} ${url}`);
    return replies[Math.min(callIndex, replies.length - 1)]();
  };
  const callsTo = (method, url) => calls.filter((call) => call.method === method && call.url === url).length;
  return { fetch, calls, callsTo };
}

function createRecordingSleep() {
  const delays = [];
  const sleep = async (ms) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

/** Healthy routes for the given list and installers; `overrides` replaces individual routes. */
function routesFor({ list = { format: 1, installers: REAL_INSTALLERS }, overrides = {} } = {}) {
  const routes = { [`GET ${LIST_URL}`]: [reply.json(list)] };
  for (const installer of REAL_INSTALLERS) routes[`HEAD ${installer.url}`] = [goodHead(installer)];
  return { ...routes, ...overrides };
}

async function runCheck(routes, { attempts = ATTEMPTS } = {}) {
  const network = createFakeFetch(routes);
  const recorder = createRecordingSleep();
  const problems = await findProblems({
    fetch: network.fetch,
    listUrl: LIST_URL,
    attempts,
    retryDelayMs: RETRY_DELAY_MS,
    sleep: recorder.sleep,
  });
  return { problems, network, delays: recorder.delays };
}

function headCalls(network) {
  return network.calls.filter((call) => call.method === 'HEAD');
}

// ---- C1: md5FromEtag ---------------------------------------------------------------------------

const BLACKWELL_MD5 = '9ac74fe7c787ea98bd9a8b2b50608f0a';

test('C1: md5 is read from a quoted "<md5>:<timestamp>" ETag', () => {
  assert.equal(md5FromEtag(`"${BLACKWELL_MD5}:1738045409.233305"`), BLACKWELL_MD5);
});

test('C1: a W/ prefix is ignored', () => {
  assert.equal(md5FromEtag(`W/"${BLACKWELL_MD5}:1738045409.233305"`), BLACKWELL_MD5);
});

test('C1: an ETag without quotes works', () => {
  assert.equal(md5FromEtag(`${BLACKWELL_MD5}:1738045409.233305`), BLACKWELL_MD5);
});

test('C1: an ETag that is just the 32-hex md5 works, quoted or not', () => {
  assert.equal(md5FromEtag(`"${BLACKWELL_MD5}"`), BLACKWELL_MD5);
  assert.equal(md5FromEtag(BLACKWELL_MD5), BLACKWELL_MD5);
});

test('C1: upper case hex is returned in lower case', () => {
  assert.equal(md5FromEtag(`"${BLACKWELL_MD5.toUpperCase()}:1738045409.233305"`), BLACKWELL_MD5);
  assert.equal(md5FromEtag(`W/"${BLACKWELL_MD5.toUpperCase()}"`), BLACKWELL_MD5);
});

test('C1: null, empty and ETags not starting with 32 hex characters give undefined', () => {
  for (const etag of [null, '', '"abc"', '"xyz0123456789abcdef0123456789abcdef"', `"${BLACKWELL_MD5.slice(1)}:1"`]) {
    assert.equal(md5FromEtag(etag), undefined, `ETag ${JSON.stringify(etag)}`);
  }
});

// ---- C2: all fine ------------------------------------------------------------------------------

test('C2: a valid list and four healthy installers give no problems', async () => {
  const { problems } = await runCheck(routesFor());
  assert.deepEqual(problems, []);
});

test('C2: every installer is checked with one HEAD request to its url', async () => {
  const { network } = await runCheck(routesFor());
  for (const installer of REAL_INSTALLERS) {
    assert.equal(network.callsTo('HEAD', installer.url), 1, `HEAD ${installer.architecture}`);
  }
  assert.equal(network.callsTo('GET', LIST_URL), 1);
});

// ---- C3: list unreachable ----------------------------------------------------------------------

for (const status of [404, 403]) {
  test(`C3: list HTTP ${status} gives exactly one problem naming the list url and status; no installer checked`, async () => {
    const { problems, network } = await runCheck(
      routesFor({ overrides: { [`GET ${LIST_URL}`]: [reply.status(status)] } }),
    );
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.ok(problems[0].includes(LIST_URL), problems[0]);
    assert.ok(problems[0].includes(String(status)), problems[0]);
    assert.deepEqual(headCalls(network), []);
  });
}

test('C3: list network error gives exactly one problem naming the list url and the error; no installer checked', async () => {
  const { problems, network } = await runCheck(
    routesFor({ overrides: { [`GET ${LIST_URL}`]: [reply.networkError()] } }),
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.ok(problems[0].includes(LIST_URL), problems[0]);
  assert.ok(problems[0].includes('fetch failed'), problems[0]);
  assert.deepEqual(headCalls(network), []);
});

// ---- C4: list content bad ----------------------------------------------------------------------

test('C4: a list that is not JSON gives one problem naming the list; no installer checked', async () => {
  const { problems, network } = await runCheck(
    routesFor({ overrides: { [`GET ${LIST_URL}`]: [reply.text('<html>Bad gateway</html>')] } }),
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.ok(problems[0].includes(LIST_URL), problems[0]);
  assert.deepEqual(headCalls(network), []);
});

test('C4: each validation error becomes one problem naming the list; no installer checked', async () => {
  const badList = {
    format: 2, // error 1
    installers: REAL_INSTALLERS.map((installer) =>
      installer.architecture === 'ada' ? { ...installer, sha256: 'abc' } : installer, // error 2
    ),
  };
  const { problems, network } = await runCheck(
    routesFor({ overrides: { [`GET ${LIST_URL}`]: [reply.json(badList)] } }),
  );
  assert.equal(problems.length, 2, JSON.stringify(problems));
  for (const problem of problems) assert.ok(problem.includes(LIST_URL), problem);
  assert.ok(problems.some((problem) => problem.includes('format')), JSON.stringify(problems));
  assert.ok(problems.some((problem) => problem.includes('sha256')), JSON.stringify(problems));
  assert.deepEqual(headCalls(network), []);
});

test('C4: an entry without md5 fails validation, so it is reported and no installer is checked', async () => {
  const { md5, ...adaWithoutMd5 } = installerFor('ada');
  const badList = {
    format: 1,
    installers: REAL_INSTALLERS.map((installer) => (installer.architecture === 'ada' ? adaWithoutMd5 : installer)),
  };
  const { problems, network } = await runCheck(
    routesFor({ overrides: { [`GET ${LIST_URL}`]: [reply.json(badList)] } }),
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.ok(problems[0].includes(LIST_URL), problems[0]);
  assert.ok(problems[0].includes('md5'), problems[0]);
  assert.deepEqual(headCalls(network), []);
});

// ---- C5: architecture missing ------------------------------------------------------------------

test('C5: a missing architecture is a problem, and the listed installers are still checked', async () => {
  const listed = REAL_INSTALLERS.filter((installer) => installer.architecture !== 'blackwell');
  const { problems, network } = await runCheck(routesFor({ list: { format: 1, installers: listed } }));
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.ok(problems[0].includes('blackwell'), problems[0]);
  for (const installer of listed) {
    assert.equal(network.callsTo('HEAD', installer.url), 1, `HEAD ${installer.architecture}`);
  }
});

// ---- C6: one installer gone --------------------------------------------------------------------

test('C6: one installer 404 gives one problem naming its architecture, url and status; others still checked', async () => {
  const ampere = installerFor('ampere');
  const { problems, network } = await runCheck(
    routesFor({ overrides: { [`HEAD ${ampere.url}`]: [reply.status(404)] } }),
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.ok(problems[0].includes('ampere'), problems[0]);
  assert.ok(problems[0].includes(ampere.url), problems[0]);
  assert.ok(problems[0].includes('404'), problems[0]);
  for (const installer of REAL_INSTALLERS) {
    assert.ok(network.callsTo('HEAD', installer.url) >= 1, `HEAD ${installer.architecture}`);
  }
});

// ---- C7: installer changed ---------------------------------------------------------------------

test('C7: a different size is a problem that shows both numbers', async () => {
  const ada = installerFor('ada');
  const servedSize = ada.sizeBytes + 4096;
  const { problems } = await runCheck(
    routesFor({
      overrides: {
        [`HEAD ${ada.url}`]: [reply.head({ contentLength: servedSize, etag: `"${ada.md5}:1738045409.233305"` })],
      },
    }),
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.ok(problems[0].includes('ada'), problems[0]);
  assert.ok(problems[0].includes(String(ada.sizeBytes)), problems[0]);
  assert.ok(problems[0].includes(String(servedSize)), problems[0]);
});

test('C7: a different ETag md5 is a problem that shows both md5s', async () => {
  const turing = installerFor('turing');
  const servedMd5 = '0123456789abcdef0123456789abcdef';
  const { problems } = await runCheck(
    routesFor({
      overrides: {
        [`HEAD ${turing.url}`]: [reply.head({ contentLength: turing.sizeBytes, etag: `"${servedMd5}:1760000000.5"` })],
      },
    }),
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.ok(problems[0].includes('turing'), problems[0]);
  assert.ok(problems[0].includes(turing.md5), problems[0]);
  assert.ok(problems[0].includes(servedMd5), problems[0]);
});

test('C7: a missing ETag is a problem', async () => {
  const blackwell = installerFor('blackwell');
  const { problems } = await runCheck(
    routesFor({
      overrides: { [`HEAD ${blackwell.url}`]: [reply.head({ contentLength: blackwell.sizeBytes })] },
    }),
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.ok(problems[0].includes('blackwell'), problems[0]);
});

test('C7: an ETag without an md5 at the start is a problem', async () => {
  const blackwell = installerFor('blackwell');
  const { problems } = await runCheck(
    routesFor({
      overrides: { [`HEAD ${blackwell.url}`]: [reply.head({ contentLength: blackwell.sizeBytes, etag: '"abc"' })] },
    }),
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.ok(problems[0].includes('blackwell'), problems[0]);
});

// ---- C8: retries -------------------------------------------------------------------------------

test('C8: steps that fail once then succeed are not problems, and the wait is retryDelayMs', async () => {
  const ada = installerFor('ada');
  const { problems, delays, network } = await runCheck(
    routesFor({
      overrides: {
        [`GET ${LIST_URL}`]: [reply.status(503), reply.json({ format: 1, installers: REAL_INSTALLERS })],
        [`HEAD ${ada.url}`]: [reply.networkError(), goodHead(ada)],
      },
    }),
  );
  assert.deepEqual(problems, []);
  assert.equal(network.callsTo('GET', LIST_URL), 2);
  assert.equal(network.callsTo('HEAD', ada.url), 2);
  assert.deepEqual(delays, [RETRY_DELAY_MS, RETRY_DELAY_MS]);
});

test('C8: an installer that fails every time is a problem after exactly `attempts` requests', async () => {
  const turing = installerFor('turing');
  const { problems, network, delays } = await runCheck(
    routesFor({ overrides: { [`HEAD ${turing.url}`]: [reply.status(500)] } }),
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.ok(problems[0].includes('turing'), problems[0]);
  assert.equal(network.callsTo('HEAD', turing.url), ATTEMPTS);
  assert.deepEqual(delays, Array(ATTEMPTS - 1).fill(RETRY_DELAY_MS));
});

test('C8: a list that fails every time is one problem after exactly `attempts` requests', async () => {
  const attempts = 4;
  const { problems, network } = await runCheck(
    routesFor({ overrides: { [`GET ${LIST_URL}`]: [reply.networkError()] } }),
    { attempts },
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.equal(network.callsTo('GET', LIST_URL), attempts);
});

test('C8: a single attempt means no retry and no wait', async () => {
  const ada = installerFor('ada');
  const { problems, network, delays } = await runCheck(
    routesFor({ overrides: { [`HEAD ${ada.url}`]: [reply.status(404), goodHead(ada)] } }),
    { attempts: 1 },
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.equal(network.callsTo('HEAD', ada.url), 1);
  assert.deepEqual(delays, []);
});

test('C8: only the last failure counts', async () => {
  const ampere = installerFor('ampere');
  const { problems } = await runCheck(
    routesFor({
      overrides: { [`HEAD ${ampere.url}`]: [reply.networkError(), reply.networkError(), reply.status(410)] },
    }),
  );
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.ok(problems[0].includes('410'), problems[0]);
  assert.ok(!problems[0].includes('fetch failed'), problems[0]);
});

// ---- C9: sorted --------------------------------------------------------------------------------

test('C9: problems are returned sorted', async () => {
  const listed = REAL_INSTALLERS.filter((installer) => installer.architecture !== 'ada');
  const turing = installerFor('turing');
  const blackwell = installerFor('blackwell');
  const { problems } = await runCheck(
    routesFor({
      list: { format: 1, installers: listed },
      overrides: {
        [`HEAD ${turing.url}`]: [reply.status(404)],
        [`HEAD ${blackwell.url}`]: [reply.head({ contentLength: 1, etag: `"${blackwell.md5}:1"` })],
      },
    }),
  );
  assert.equal(problems.length, 3, JSON.stringify(problems));
  assert.deepEqual(problems, [...problems].sort());
});
