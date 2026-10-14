// Run with: node --test scripts/check-links.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  exitCodeFor,
  extractInstallerLinks,
  findNewLinks,
  parseKnownLinks,
  totalFromContentRange,
  validateList,
} from './check-links.mjs';

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

function validInstaller(overrides = {}) {
  return {
    architecture: 'ada',
    sdkVersion: '0.8.7',
    url: LISTED,
    sizeBytes: 1330863768,
    sha256: '0e2e1110065ed58b9c4a844c674fe5f50ed5fe37a0d170bd229a4bbc48861ca5',
    md5: 'd14abd6c8f4b9246e4082d84f8e1895e',
    ...overrides,
  };
}

function errorsFor(installerOverrides) {
  return validateList({ format: 1, installers: [validInstaller(installerOverrides)] });
}

test('extraction finds each AR SDK installer link once, in page order', () => {
  assert.deepEqual(extractInstallerLinks(SAMPLE_PAGE), [LISTED, KNOWN_OTHER, BRAND_NEW]);
});

test('only links that are neither listed nor known are new', () => {
  const pageLinks = extractInstallerLinks(SAMPLE_PAGE);
  assert.deepEqual(findNewLinks(pageLinks, [LISTED, KNOWN_OTHER]), [BRAND_NEW]);
});

test('link comparison ignores http/https and letter case', () => {
  const pageLink = LISTED.replace('https://', 'http://').toUpperCase();
  assert.deepEqual(findNewLinks([pageLink], [LISTED]), []);
});

test('known-links file skips comments and blank lines', () => {
  const text = `# why this is here\n${KNOWN_OTHER}  # trailing note\n\n   \n${BRAND_NEW}\r\n`;
  assert.deepEqual(parseKnownLinks(text), [KNOWN_OTHER, BRAND_NEW]);
});

test('the committed list is valid', async () => {
  const text = await readFile(new URL('../site/gazefix/sdk/v1/installers.json', import.meta.url), 'utf8');
  assert.deepEqual(validateList(JSON.parse(text)), []);
});

test('a valid list has no errors', () => {
  assert.deepEqual(errorsFor({}), []);
});

test('format other than 1 is rejected', () => {
  assert.equal(validateList({ format: 2, installers: [validInstaller()] }).length, 1);
});

test('unknown architecture is rejected', () => {
  assert.equal(errorsFor({ architecture: 'pascal' }).length, 1);
});

test('non-https, non-nvidia and look-alike hosts are rejected', () => {
  assert.notDeepEqual(errorsFor({ url: LISTED.replace('https:', 'http:') }), []);
  assert.notDeepEqual(errorsFor({ url: 'https://example.com/nvidia_ar_sdk_installer_v0.8.7_ada.exe' }), []);
  assert.notDeepEqual(errorsFor({ url: 'https://evilnvidia.com/nvidia_ar_sdk_installer_v0.8.7_ada.exe' }), []);
  assert.notDeepEqual(errorsFor({ url: 'nvidia_ar_sdk_installer_v0.8.7_ada.exe' }), []);
});

test('nvidia.com itself and its subdomains are accepted', () => {
  assert.deepEqual(errorsFor({ url: 'https://nvidia.com/a/installer.exe' }), []);
  assert.deepEqual(errorsFor({ url: 'https://download.nvidia.com/a/installer.exe' }), []);
});

test('unsafe or non-exe file names are rejected', () => {
  assert.notDeepEqual(errorsFor({ url: `${AR_BASE}installer.zip` }), []);
  assert.notDeepEqual(errorsFor({ url: `${AR_BASE}my%20installer.exe` }), []);
});

test('sizeBytes must be a positive whole number', () => {
  for (const sizeBytes of [0, -1, 1.5, '100', null]) {
    assert.equal(errorsFor({ sizeBytes }).length, 1, `sizeBytes ${JSON.stringify(sizeBytes)}`);
  }
});

test('sha256 must be 64 lowercase hex characters', () => {
  assert.equal(errorsFor({ sha256: 'abc' }).length, 1);
  assert.equal(errorsFor({ sha256: 'g'.repeat(64) }).length, 1);
});

test('duplicate architectures are rejected', () => {
  const errors = validateList({ format: 1, installers: [validInstaller(), validInstaller()] });
  assert.equal(errors.length, 1);
});

test('total size is read from Content-Range', () => {
  assert.equal(totalFromContentRange('bytes 0-0/1324834184'), '1324834184');
  assert.equal(totalFromContentRange('bytes 0-0/*'), undefined);
  assert.equal(totalFromContentRange(null), undefined);
});

test('exit code: broken beats new links, new links alone give 2', () => {
  assert.equal(exitCodeFor({ failures: ['x'], newLinks: ['y'] }), 1);
  assert.equal(exitCodeFor({ failures: [], newLinks: ['y'] }), 2);
  assert.equal(exitCodeFor({ failures: [], newLinks: [] }), 0);
});
