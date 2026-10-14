// Run with: node --test scripts/check-links.test.mjs
// Criteria: C1, C4, C5 of D:\Work\specs\updates-signed-manifest.md. The manifest rules themselves are tested once,
// in shared/manifest.test.mjs; here only what check-links adds.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { readEnvelope } from '../shared/manifest.mjs';
import { REAL_PUBLIC_KEYS } from '../test-support/manifest-fixtures.mjs';
import { exitCodeFor, extractInstallerLinks, findNewLinks, totalFromContentRange } from './check-links.mjs';

const AR_BASE = 'https://international.download.nvidia.com/Windows/broadcast/sdk/AR/';
const LISTED = `${AR_BASE}nvidia_ar_sdk_installer_v0.8.7_ada.exe`;
const KNOWN_OTHER = `${AR_BASE}nvidia_ar_sdk_installer_v0.8.2_ada.exe`;
const BRAND_NEW = `${AR_BASE}nvidia_ar_sdk_installer_v0.9.0_ada.exe`;

const SAMPLE_PAGE = `
  <a href="${LISTED}">Ada</a>
  <a href='${KNOWN_OTHER}'>Older Ada</a>
  <a href="${BRAND_NEW}">New Ada</a>
  <a href="${LISTED}">Ada again</a>
  <a href="https://example.com/other_tool.exe">Not an AR SDK installer</a>
  <a href="${AR_BASE}nvidia_ar_sdk_installer_v0.9.0_ada.zip">Not an exe</a>`;

// ---- C1: the committed signed manifest --------------------------------------------------------

test('C1: the committed site manifest verifies with keys/public-keys.json and passes every rule', async () => {
  const text = await readFile(new URL('../site/gazefix/manifest/v1/manifest.json', import.meta.url), 'utf8');
  const result = await readEnvelope(text, REAL_PUBLIC_KEYS);
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.ok(result.serial >= 1);
});

test('C4/C5: the installer urls of the committed manifest count as known on the NVIDIA page', async () => {
  const text = await readFile(new URL('../site/gazefix/manifest/v1/manifest.json', import.meta.url), 'utf8');
  const { manifest } = await readEnvelope(text, REAL_PUBLIC_KEYS);
  const manifestUrls = manifest.nvidiaArSdk.installers.flatMap((installer) => installer.urls);
  assert.deepEqual(findNewLinks(extractInstallerLinks(SAMPLE_PAGE), [...manifestUrls, KNOWN_OTHER]), [BRAND_NEW]);
});

// ---- C4: NVIDIA page watch (pure parts) -------------------------------------------------------

test('C4: extraction finds each AR SDK installer link once, in page order', () => {
  assert.deepEqual(extractInstallerLinks(SAMPLE_PAGE), [LISTED, KNOWN_OTHER, BRAND_NEW]);
});

test('C4: only links that are neither in the manifest nor known are new', () => {
  const pageLinks = extractInstallerLinks(SAMPLE_PAGE);
  assert.deepEqual(findNewLinks(pageLinks, [LISTED, KNOWN_OTHER]), [BRAND_NEW]);
});

test('C4: link comparison ignores http/https and letter case', () => {
  const pageLink = LISTED.replace('https://', 'http://').toUpperCase();
  assert.deepEqual(findNewLinks([pageLink], [LISTED]), []);
});

// ---- C2: size from a ranged GET ---------------------------------------------------------------

test('C2: total size is read from Content-Range', () => {
  assert.equal(totalFromContentRange('bytes 0-0/1324834184'), '1324834184');
  assert.equal(totalFromContentRange('bytes 0-0/*'), undefined);
  assert.equal(totalFromContentRange(null), undefined);
});

// ---- exit codes -------------------------------------------------------------------------------

test('C4: exit code: broken beats new links, new links alone give 2', () => {
  assert.equal(exitCodeFor({ failures: ['x'], newLinks: ['y'] }), 1);
  assert.equal(exitCodeFor({ failures: [], newLinks: ['y'] }), 2);
  assert.equal(exitCodeFor({ failures: [], newLinks: [] }), 0);
});
