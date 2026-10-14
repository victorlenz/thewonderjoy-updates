// Run with: node --test worker/test/alerts.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideAlert, sendSlack } from '../src/alerts.mjs';

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-10-14T12:00:00.000Z');
const P = 'ampere: HTTP 404 for https://international.download.nvidia.com/x_ampere.exe';
const Q = 'blackwell: size 1 differs from listed 1347983656';

function hoursAgo(hours) {
  return new Date(NOW.getTime() - hours * HOUR_MS).toISOString();
}

function linesOf(message) {
  return message.split('\n');
}

// ---- A1: first run, nothing wrong --------------------------------------------------------------

test('A1: first run with no problems sends nothing and starts an empty state', () => {
  assert.deepEqual(decideAlert(undefined, [], NOW), {
    message: null,
    nextState: { problems: [], lastAlertAt: null },
  });
});

test('A1: no problems before and none now sends nothing and keeps lastAlertAt', () => {
  const previous = { problems: [], lastAlertAt: hoursAgo(30) };
  assert.deepEqual(decideAlert(previous, [], NOW), {
    message: null,
    nextState: { problems: [], lastAlertAt: previous.lastAlertAt },
  });
});

// ---- A2: first run, something wrong ------------------------------------------------------------

test('A2: first run with a problem sends it and records the time', () => {
  const { message, nextState } = decideAlert(undefined, [P], NOW);
  assert.equal(typeof message, 'string');
  assert.ok(message.includes(P), message);
  assert.deepEqual(nextState, { problems: [P], lastAlertAt: NOW.toISOString() });
});

// ---- A3: problems changed ----------------------------------------------------------------------

test('A3: a new problem added sends every current problem, each on its own line', () => {
  const previous = { problems: [P], lastAlertAt: hoursAgo(1) };
  const { message, nextState } = decideAlert(previous, [P, Q], NOW);
  assert.equal(typeof message, 'string');
  const lines = linesOf(message);
  assert.ok(lines.some((line) => line.includes(P) && !line.includes(Q)), message);
  assert.ok(lines.some((line) => line.includes(Q) && !line.includes(P)), message);
  assert.deepEqual(nextState, { problems: [P, Q], lastAlertAt: NOW.toISOString() });
});

test('A3: a problem replaced by another sends the current problem', () => {
  const previous = { problems: [P], lastAlertAt: hoursAgo(1) };
  const { message, nextState } = decideAlert(previous, [Q], NOW);
  assert.equal(typeof message, 'string');
  assert.ok(message.includes(Q), message);
  assert.deepEqual(nextState, { problems: [Q], lastAlertAt: NOW.toISOString() });
});

// ---- A4: fixed ---------------------------------------------------------------------------------

test('A4: problems gone sends an all-clear message and records the time', () => {
  const previous = { problems: [P], lastAlertAt: hoursAgo(1) };
  const { message, nextState } = decideAlert(previous, [], NOW);
  assert.equal(typeof message, 'string');
  assert.match(message, /\bOK\b|fixed/i);
  assert.deepEqual(nextState, { problems: [], lastAlertAt: NOW.toISOString() });
});

// ---- A5: daily reminder ------------------------------------------------------------------------

test('A5: same problems 23 hours after the last alert sends nothing and keeps lastAlertAt', () => {
  const previous = { problems: [P], lastAlertAt: hoursAgo(23) };
  assert.deepEqual(decideAlert(previous, [P], NOW), {
    message: null,
    nextState: { problems: [P], lastAlertAt: previous.lastAlertAt },
  });
});

test('A5: same problems exactly 24 hours after the last alert sends a "still" reminder listing them', () => {
  const previous = { problems: [P, Q], lastAlertAt: hoursAgo(24) };
  const { message, nextState } = decideAlert(previous, [P, Q], NOW);
  assert.equal(typeof message, 'string');
  assert.match(message, /still/i);
  assert.ok(message.includes(P), message);
  assert.ok(message.includes(Q), message);
  assert.deepEqual(nextState, { problems: [P, Q], lastAlertAt: NOW.toISOString() });
});

// ---- A6: order does not matter -----------------------------------------------------------------

test('A6: the same problems in a different order send nothing; the stored problems are sorted', () => {
  const previous = { problems: [Q, P], lastAlertAt: hoursAgo(1) };
  assert.deepEqual(decideAlert(previous, [Q, P].reverse(), NOW), {
    message: null,
    nextState: { problems: [P, Q], lastAlertAt: previous.lastAlertAt },
  });
});

test('A6: nextState.problems is sorted even when a message is sent', () => {
  const { nextState } = decideAlert(undefined, [Q, P], NOW);
  assert.deepEqual(nextState.problems, [P, Q]);
});

// ---- A7: sendSlack -----------------------------------------------------------------------------

const WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/XXXX';

function createSlackFetch(status, body = 'ok') {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  };
  return { fetch, calls };
}

test('A7: sendSlack POSTs {"text": …} as JSON to the webhook url', async () => {
  const slack = createSlackFetch(200);
  const text = 'GazeFix installer check:\nline "two"';
  await sendSlack(slack.fetch, WEBHOOK_URL, text);
  assert.equal(slack.calls.length, 1);
  const [{ url, init }] = slack.calls;
  assert.equal(url, WEBHOOK_URL);
  assert.equal(init.method, 'POST');
  assert.match(new Headers(init.headers).get('content-type') ?? '', /^application\/json\b/);
  assert.deepEqual(JSON.parse(init.body), { text });
});

for (const status of [400, 404, 500]) {
  test(`A7: sendSlack throws when Slack answers HTTP ${status}, naming the status`, async () => {
    const slack = createSlackFetch(status, 'no_service');
    await assert.rejects(sendSlack(slack.fetch, WEBHOOK_URL, 'hi'), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(String(status)), error.message);
      return true;
    });
  });
}

test('A7: sendSlack resolves on any 2xx answer', async () => {
  await sendSlack(createSlackFetch(204, null).fetch, WEBHOOK_URL, 'hi');
});
