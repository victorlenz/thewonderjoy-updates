// Run with: node --test worker/test/alerts.test.mjs
// Criteria: W4, W5 of D:\Work\specs\updates-signed-manifest.md (and the earlier A1–A7, adapted).
//
// decideAlert(previous, current, now) → { message: string | null, nextState }
//   previous: undefined (first run) or the stored state { problems, serial, lastAlertAt } — states saved before this
//             change have no `serial` field.
//   current:  exactly what findProblems returns: { problems: string[], serial: number | null }.
//   nextState: { problems (sorted, including a "serial went backwards" problem), serial, lastAlertAt }.
//     serial = the highest serial seen (a lower or null current serial keeps the stored one).
//     lastAlertAt = now when a message is sent, else unchanged.
// At most one message per run: an "updated" note and a problem/fixed message are combined into one string.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideAlert, sendSlack } from '../src/alerts.mjs';

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-10-14T12:00:00.000Z');
const P = 'ampere: HTTP 404 for https://international.download.nvidia.com/x_ampere.exe';
const Q = 'blackwell: size 1 differs from listed 1347983656';
const SERIAL = 1;

function hoursAgo(hours) {
  return new Date(NOW.getTime() - hours * HOUR_MS).toISOString();
}

function linesOf(message) {
  return message.split('\n');
}

function current(problems, serial = SERIAL) {
  return { problems, serial };
}

function stored(problems, lastAlertAt, serial = SERIAL) {
  return { problems, serial, lastAlertAt };
}

function updatedNote(from, to) {
  return `Manifest updated: serial ${from} → ${to}`;
}

function backwardsNote(from, to) {
  return `serial went backwards: ${from} → ${to}`;
}

// ---- A1 / W5: first run, nothing wrong ----------------------------------------------------------

test('W5/A1: first run with no problems sends nothing and stores the serial', () => {
  assert.deepEqual(decideAlert(undefined, current([]), NOW), {
    message: null,
    nextState: { problems: [], serial: SERIAL, lastAlertAt: null },
  });
});

test('W5/A1: no problems before and none now, same serial: nothing sent, lastAlertAt kept', () => {
  const previous = stored([], hoursAgo(30));
  assert.deepEqual(decideAlert(previous, current([]), NOW), {
    message: null,
    nextState: { problems: [], serial: SERIAL, lastAlertAt: previous.lastAlertAt },
  });
});

// ---- A2: first run, something wrong ------------------------------------------------------------

test('W5/A2: first run with a problem sends it and records the time', () => {
  const { message, nextState } = decideAlert(undefined, current([P]), NOW);
  assert.equal(typeof message, 'string');
  assert.ok(message.includes(P), message);
  assert.deepEqual(nextState, { problems: [P], serial: SERIAL, lastAlertAt: NOW.toISOString() });
});

// ---- A3: problems changed ----------------------------------------------------------------------

test('W5/A3: a new problem added sends every current problem, each on its own line', () => {
  const { message, nextState } = decideAlert(stored([P], hoursAgo(1)), current([P, Q]), NOW);
  assert.equal(typeof message, 'string');
  const lines = linesOf(message);
  assert.ok(lines.some((line) => line.includes(P) && !line.includes(Q)), message);
  assert.ok(lines.some((line) => line.includes(Q) && !line.includes(P)), message);
  assert.deepEqual(nextState, { problems: [P, Q], serial: SERIAL, lastAlertAt: NOW.toISOString() });
});

test('W5/A3: a problem replaced by another sends the current problem', () => {
  const { message, nextState } = decideAlert(stored([P], hoursAgo(1)), current([Q]), NOW);
  assert.equal(typeof message, 'string');
  assert.ok(message.includes(Q), message);
  assert.deepEqual(nextState, { problems: [Q], serial: SERIAL, lastAlertAt: NOW.toISOString() });
});

// ---- A4: fixed ---------------------------------------------------------------------------------

test('W5/A4: problems gone sends an all-clear message and records the time', () => {
  const { message, nextState } = decideAlert(stored([P], hoursAgo(1)), current([]), NOW);
  assert.equal(typeof message, 'string');
  assert.match(message, /\bOK\b|fixed/i);
  assert.deepEqual(nextState, { problems: [], serial: SERIAL, lastAlertAt: NOW.toISOString() });
});

// ---- A5: daily reminder ------------------------------------------------------------------------

test('W5/A5: same problems 23 hours after the last alert sends nothing and keeps lastAlertAt', () => {
  const previous = stored([P], hoursAgo(23));
  assert.deepEqual(decideAlert(previous, current([P]), NOW), {
    message: null,
    nextState: { problems: [P], serial: SERIAL, lastAlertAt: previous.lastAlertAt },
  });
});

test('W5/A5: same problems exactly 24 hours after the last alert sends a "still" reminder listing them', () => {
  const { message, nextState } = decideAlert(stored([P, Q], hoursAgo(24)), current([P, Q]), NOW);
  assert.equal(typeof message, 'string');
  assert.match(message, /still/i);
  assert.ok(message.includes(P), message);
  assert.ok(message.includes(Q), message);
  assert.deepEqual(nextState, { problems: [P, Q], serial: SERIAL, lastAlertAt: NOW.toISOString() });
});

// ---- A6: order does not matter -----------------------------------------------------------------

test('W5/A6: the same problems in a different order send nothing; the stored problems are sorted', () => {
  const previous = stored([Q, P], hoursAgo(1));
  assert.deepEqual(decideAlert(previous, current([P, Q].reverse()), NOW), {
    message: null,
    nextState: { problems: [P, Q], serial: SERIAL, lastAlertAt: previous.lastAlertAt },
  });
});

test('W5/A6: nextState.problems is sorted even when a message is sent', () => {
  const { nextState } = decideAlert(undefined, current([Q, P]), NOW);
  assert.deepEqual(nextState.problems, [P, Q]);
});

test('W5: decideAlert does not change the arrays it was given', () => {
  const problems = [Q, P];
  const previous = stored([Q], hoursAgo(1));
  decideAlert(previous, current(problems), NOW);
  assert.deepEqual(problems, [Q, P]);
  assert.deepEqual(previous.problems, [Q]);
});

// ---- W4: serial changes ------------------------------------------------------------------------

test('W4: serial went up with no problems → "Manifest updated: serial A → B" is sent', () => {
  const { message, nextState } = decideAlert(stored([], hoursAgo(1), 1), current([], 2), NOW);
  assert.equal(typeof message, 'string');
  assert.ok(message.includes(updatedNote(1, 2)), message);
  assert.deepEqual(nextState, { problems: [], serial: 2, lastAlertAt: NOW.toISOString() });
});

test('W4: serial jump of more than one is reported with both numbers', () => {
  const { message } = decideAlert(stored([], null, 3), current([], 9), NOW);
  assert.ok(message?.includes(updatedNote(3, 9)), message);
});

test('W4: first run (no state) with a serial → no "updated" message', () => {
  const { message } = decideAlert(undefined, current([], 5), NOW);
  assert.equal(message, null);
});

test('W4: state saved before this change (no serial field) → no "updated" message; the serial is stored', () => {
  const oldState = { problems: [], lastAlertAt: hoursAgo(2) };
  assert.deepEqual(decideAlert(oldState, current([], 5), NOW), {
    message: null,
    nextState: { problems: [], serial: 5, lastAlertAt: oldState.lastAlertAt },
  });
});

test('W4: stored serial null (manifest unreadable last run) → no "updated" message', () => {
  const { message, nextState } = decideAlert(stored([], null, null), current([], 2), NOW);
  assert.equal(message, null);
  assert.equal(nextState.serial, 2);
});

test('W4: current serial null (manifest unreadable now) → no "updated" message; the stored serial is kept', () => {
  const { message, nextState } = decideAlert(stored([P], hoursAgo(1), 4), current([P], null), NOW);
  assert.equal(message, null);
  assert.equal(nextState.serial, 4);
});

test('W4: serial update and a new problem in the same run → ONE message with both', () => {
  const { message, nextState } = decideAlert(stored([], hoursAgo(1), 1), current([P], 2), NOW);
  assert.equal(typeof message, 'string');
  assert.ok(message.includes(updatedNote(1, 2)), message);
  assert.ok(message.includes(P), message);
  assert.deepEqual(nextState, { problems: [P], serial: 2, lastAlertAt: NOW.toISOString() });
});

test('W4: serial update and a fix in the same run → ONE message with both', () => {
  const { message } = decideAlert(stored([P], hoursAgo(1), 1), current([], 2), NOW);
  assert.equal(typeof message, 'string');
  assert.ok(message.includes(updatedNote(1, 2)), message);
  assert.match(message, /\bOK\b|fixed/i);
});

test('W4: serial update while the same problems remain (reminder not due) → the "updated" message is still sent', () => {
  const { message } = decideAlert(stored([P], hoursAgo(1), 1), current([P], 2), NOW);
  assert.equal(typeof message, 'string');
  assert.ok(message.includes(updatedNote(1, 2)), message);
});

test('W4: serial lower than stored → a PROBLEM "serial went backwards: A → B" (no "updated" note)', () => {
  const { message, nextState } = decideAlert(stored([], hoursAgo(1), 3), current([], 2), NOW);
  assert.equal(typeof message, 'string');
  assert.ok(message.includes(backwardsNote(3, 2)), message);
  assert.ok(!message.includes('Manifest updated'), message);
  assert.ok(nextState.problems.some((problem) => problem.includes(backwardsNote(3, 2))), JSON.stringify(nextState));
  assert.equal(nextState.lastAlertAt, NOW.toISOString());
});

test('W4: after going backwards the highest serial stays stored, so the problem persists without repeat alerts', () => {
  const first = decideAlert(stored([], hoursAgo(1), 3), current([], 2), NOW);
  assert.equal(first.nextState.serial, 3);
  const anHourLater = new Date(NOW.getTime() + HOUR_MS);
  const second = decideAlert(first.nextState, current([], 2), anHourLater);
  assert.equal(second.message, null, 'same problem within 24 h → no new message');
  assert.deepEqual(second.nextState.problems, first.nextState.problems);
});

test('W4: back to the stored serial after going backwards → the problem is fixed, no "updated" note', () => {
  const wentBack = decideAlert(stored([], hoursAgo(1), 3), current([], 2), NOW).nextState;
  const { message, nextState } = decideAlert(wentBack, current([], 3), new Date(NOW.getTime() + HOUR_MS));
  assert.equal(typeof message, 'string');
  assert.match(message, /\bOK\b|fixed/i);
  assert.ok(!message.includes('Manifest updated'), message);
  assert.deepEqual(nextState.problems, []);
  assert.equal(nextState.serial, 3);
});

test('W4: same serial → no "updated" message', () => {
  const { message } = decideAlert(stored([], hoursAgo(1), 2), current([], 2), NOW);
  assert.equal(message, null);
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

test('W5/A7: sendSlack POSTs {"text": …} as JSON to the webhook url', async () => {
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
  test(`W5/A7: sendSlack throws when Slack answers HTTP ${status}, naming the status`, async () => {
    const slack = createSlackFetch(status, 'no_service');
    await assert.rejects(sendSlack(slack.fetch, WEBHOOK_URL, 'hi'), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(String(status)), error.message);
      return true;
    });
  });
}

test('W5/A7: sendSlack resolves on any 2xx answer', async () => {
  await sendSlack(createSlackFetch(204, null).fetch, WEBHOOK_URL, 'hi');
});
