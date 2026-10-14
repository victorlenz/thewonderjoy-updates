// Run with: node --test scripts/publish-manifest.test.mjs
// Criteria: P1, P2, P5 (pure parts) of D:\Work\specs\updates-signed-manifest.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { readEnvelope, validateManifest } from '../shared/manifest.mjs';
import { REAL_PUBLIC_KEYS } from '../test-support/manifest-fixtures.mjs';
import { buildManifest, nextSerial } from './publish-manifest.mjs';

const REPO_ROOT = new URL('../', import.meta.url);

function readRepoFile(relativePath) {
  return readFileSync(new URL(relativePath, REPO_ROOT), 'utf8');
}

function realSource() {
  return JSON.parse(readRepoFile('manifest-source/gazefix.json'));
}

// ---- P1: nextSerial ---------------------------------------------------------------------------

test('P1: nextSerial with no serials at all is 1', () => {
  assert.equal(nextSerial(), 1);
});

test('P1: nextSerial ignores null and undefined (unreachable or invalid live file); only those → 1', () => {
  assert.equal(nextSerial(null), 1);
  assert.equal(nextSerial(undefined, null), 1);
});

test('P1: nextSerial is 1 + the highest given serial, in any order', () => {
  assert.equal(nextSerial(1), 2);
  assert.equal(nextSerial(3, 7), 8);
  assert.equal(nextSerial(7, 3), 8);
  assert.equal(nextSerial(5, 5), 6);
});

test('P1: nextSerial mixes numbers with null/undefined', () => {
  assert.equal(nextSerial(null, 4), 5);
  assert.equal(nextSerial(4, undefined), 5);
});

// ---- P1: buildManifest ------------------------------------------------------------------------

const SAMPLE_SOURCE = Object.freeze({ nvidiaArSdk: { installers: [] }, ffmpeg: { version: '9.0.2' } });
const NOW_WITH_MILLIS = new Date('2026-10-14T09:00:00.123Z');

test('P1: buildManifest has format, serial, publishedAt first, then the source keys in source order', () => {
  const manifest = buildManifest(SAMPLE_SOURCE, 5, NOW_WITH_MILLIS);
  assert.deepEqual(Object.keys(manifest), ['format', 'serial', 'publishedAt', 'nvidiaArSdk', 'ffmpeg']);
});

test('P1: buildManifest values: format 1, the given serial, publishedAt as ISO seconds with Z (millis dropped)', () => {
  const manifest = buildManifest(SAMPLE_SOURCE, 5, NOW_WITH_MILLIS);
  assert.equal(
    JSON.stringify(manifest),
    JSON.stringify({ format: 1, serial: 5, publishedAt: '2026-10-14T09:00:00Z', ...SAMPLE_SOURCE }),
  );
});

test('P1: publishedAt for a time with zero millis has no fraction either', () => {
  assert.equal(buildManifest(SAMPLE_SOURCE, 1, new Date('2026-01-02T03:04:05.000Z')).publishedAt, '2026-01-02T03:04:05Z');
});

test('P1: publishedAt is UTC and millis are cut, not rounded (…59.999 stays …59)', () => {
  const now = new Date(Date.UTC(2026, 11, 31, 23, 59, 59, 999));
  assert.equal(buildManifest(SAMPLE_SOURCE, 1, now).publishedAt, '2026-12-31T23:59:59Z');
});

test('P1: buildManifest does not change the source object', () => {
  const source = realSource();
  const before = JSON.stringify(source);
  buildManifest(source, 2, NOW_WITH_MILLIS);
  assert.equal(JSON.stringify(source), before);
});

// ---- P2: the built manifest passes section 3 (the script refuses when it does not) -----------

test('P2: the real source built with any serial ≥ 1 passes every section-3 rule', () => {
  assert.deepEqual(validateManifest(buildManifest(realSource(), 2, NOW_WITH_MILLIS)), []);
});

test('P2: a source missing ffmpeg builds a manifest that section 3 rejects (what the script must refuse)', () => {
  const { ffmpeg, ...withoutFfmpeg } = realSource();
  const errors = validateManifest(buildManifest(withoutFfmpeg, 2, NOW_WITH_MILLIS));
  assert.ok(errors.some((error) => error.includes('ffmpeg')), JSON.stringify(errors));
});

// ---- P1: the committed signed manifest matches its source -------------------------------------

test('P1: site manifest verifies with keys/public-keys.json and equals {format, serial, publishedAt, ...source}', async () => {
  const result = await readEnvelope(readRepoFile('site/gazefix/manifest/v1/manifest.json'), REAL_PUBLIC_KEYS);
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  const { format, serial, publishedAt, ...rest } = result.manifest;
  assert.equal(format, 1);
  assert.ok(Number.isSafeInteger(serial) && serial >= 1);
  assert.match(publishedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(rest, realSource());
});
