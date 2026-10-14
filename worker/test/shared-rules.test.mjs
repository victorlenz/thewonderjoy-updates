// Run with: node --test worker/test/shared-rules.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateList } from '../../shared/installer-list.mjs';

const VALID_MD5 = 'd14abd6c8f4b9246e4082d84f8e1895e';

function adaInstaller(overrides = {}) {
  return {
    architecture: 'ada',
    sdkVersion: '0.8.7',
    url: 'https://international.download.nvidia.com/Windows/broadcast/sdk/AR/nvidia_ar_sdk_installer_v0.8.7_ada.exe',
    sizeBytes: 1330863768,
    sha256: '0e2e1110065ed58b9c4a844c674fe5f50ed5fe37a0d170bd229a4bbc48861ca5',
    md5: VALID_MD5,
    ...overrides,
  };
}

function errorsFor(installer) {
  return validateList({ format: 1, installers: [installer] });
}

test('S2: an entry with a valid md5 passes', () => {
  assert.deepEqual(errorsFor(adaInstaller()), []);
});

test('S2: an entry without md5 fails with one error naming md5', () => {
  const { md5, ...withoutMd5 } = adaInstaller();
  const errors = errorsFor(withoutMd5);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.ok(errors[0].includes('md5'), errors[0]);
});

test('S2: md5 must be exactly 32 lowercase hex characters', () => {
  const badValues = [VALID_MD5.slice(1), `${VALID_MD5}0`, VALID_MD5.toUpperCase(), 'g'.repeat(32), 42, null];
  for (const md5 of badValues) {
    assert.equal(errorsFor(adaInstaller({ md5 })).length, 1, `md5 ${JSON.stringify(md5)}`);
  }
});
