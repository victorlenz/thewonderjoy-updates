// Run with: node --test shared/manifest.test.mjs
// Criteria: SH1–SH5 of D:\Work\specs\updates-signed-manifest.md and docs/manifest-v1.md sections 1 and 3.
import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ARCHITECTURES,
  MAX_ENVELOPE_BYTES,
  githubReleaseAsset,
  md5FromEtag,
  readEnvelope,
  signManifest,
  validateManifest,
} from './manifest.mjs';
import {
  REAL_PUBLIC_KEYS,
  TEST_KEY_ID,
  TEST_PRIVATE_KEY_PEM,
  TEST_PUBLIC_KEY,
  TEST_PUBLIC_KEYS,
  VECTOR_ENVELOPE_TEXT,
  envelopeForBytes,
  envelopeWith,
  installerOf,
  manifestBytes,
  signedEnvelope,
  validManifest,
} from '../test-support/manifest-fixtures.mjs';

const REPO_ROOT = new URL('../', import.meta.url);

// ---- helpers ----------------------------------------------------------------------------------

async function assertAccepted(envelopeText, publicKeys = TEST_PUBLIC_KEYS) {
  const result = await readEnvelope(envelopeText, publicKeys);
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  return result;
}

async function assertRejected(envelopeText, publicKeys = TEST_PUBLIC_KEYS) {
  const result = await readEnvelope(envelopeText, publicKeys);
  assert.ok(Array.isArray(result.errors), `expected { errors }, got ${JSON.stringify(result)}`);
  assert.ok(result.errors.length > 0, 'errors must not be empty');
  assert.equal(result.manifest, undefined, 'a rejected envelope must not hand out a manifest');
  for (const error of result.errors) assert.equal(typeof error, 'string');
  return result.errors;
}

function assertSomeErrorNames(errors, word) {
  assert.ok(
    errors.some((error) => error.includes(word)),
    `expected an error naming ${JSON.stringify(word)}, got ${JSON.stringify(errors)}`,
  );
}

/** Signs a valid manifest after `breakIt` changed it, and checks both readEnvelope and validateManifest name `word`. */
async function assertRuleBroken(breakIt, word) {
  const manifest = validManifest();
  breakIt(manifest);
  assertSomeErrorNames(await assertRejected(signedEnvelope(manifest)), word);
  assertSomeErrorNames(validateManifest(manifest), word);
}

function changeOneManifestByte(envelopeText) {
  const bytes = Buffer.from(JSON.parse(envelopeText).manifest, 'base64');
  const offset = bytes.indexOf('"serial": 1');
  assert.ok(offset > 0, 'test vector layout changed');
  bytes[offset + '"serial": '.length] = '2'.charCodeAt(0); // "serial": 1 → "serial": 2, still valid JSON
  return envelopeWith(envelopeText, { manifest: bytes.toString('base64') });
}

function flipOneSignatureBit(envelopeText) {
  const signature = Buffer.from(JSON.parse(envelopeText).signature, 'base64');
  signature[10] ^= 0x01;
  return envelopeWith(envelopeText, { signature: signature.toString('base64') });
}

// ---- SH2: the test vector ---------------------------------------------------------------------

test('SH2: the test vector verifies with {"test-2026": test public key}', async () => {
  const result = await assertAccepted(VECTOR_ENVELOPE_TEXT);
  assert.deepEqual(result.manifest, validManifest());
  assert.equal(result.keyId, TEST_KEY_ID);
  assert.equal(result.serial, 1);
});

test('SH2: the test vector also verifies when the table holds other keys too', async () => {
  await assertAccepted(VECTOR_ENVELOPE_TEXT, { ...REAL_PUBLIC_KEYS, ...TEST_PUBLIC_KEYS });
});

test('SH2: one changed byte of the decoded manifest is rejected', async () => {
  await assertRejected(changeOneManifestByte(VECTOR_ENVELOPE_TEXT));
});

test('SH2: one flipped signature bit is rejected', async () => {
  await assertRejected(flipOneSignatureBit(VECTOR_ENVELOPE_TEXT));
});

test('SH2: an unknown keyId is rejected, and the error names it', async () => {
  const errors = await assertRejected(VECTOR_ENVELOPE_TEXT, REAL_PUBLIC_KEYS);
  assertSomeErrorNames(errors, TEST_KEY_ID);
});

test('SH2: keyId swapped to another known key is rejected (signature does not verify with that key)', async () => {
  const swapped = envelopeWith(VECTOR_ENVELOPE_TEXT, { keyId: 'main-2026' });
  await assertRejected(swapped, { ...REAL_PUBLIC_KEYS, ...TEST_PUBLIC_KEYS });
});

test('SH2: the right keyId but the wrong public key is rejected', async () => {
  await assertRejected(VECTOR_ENVELOPE_TEXT, { [TEST_KEY_ID]: REAL_PUBLIC_KEYS['main-2026'] });
});

test('SH2: a public key that is not valid base64 DER SPKI is rejected (no throw)', async () => {
  await assertRejected(VECTOR_ENVELOPE_TEXT, { [TEST_KEY_ID]: 'not-a-key' });
});

test('SH1: a signature in DER form (not IEEE P1363) is rejected', async () => {
  const derSigned = envelopeForBytes(manifestBytes(validManifest()), { dsaEncoding: 'der' });
  await assertRejected(derSigned);
});

// ---- SH1: envelope rules (section 1) ----------------------------------------------------------

test('SH1: an envelope that is not JSON is rejected (no throw)', async () => {
  await assertRejected('<html>Bad gateway</html>');
});

for (const notAnObject of ['null', '[]', '"text"', '42']) {
  test(`SH1: an envelope that is JSON ${notAnObject} is rejected`, async () => {
    await assertRejected(notAnObject);
  });
}

for (const field of ['keyId', 'manifest', 'signature']) {
  test(`SH1: an envelope without "${field}" is rejected, naming ${field}`, async () => {
    const envelope = JSON.parse(VECTOR_ENVELOPE_TEXT);
    delete envelope[field];
    assertSomeErrorNames(await assertRejected(JSON.stringify(envelope)), field);
  });

  test(`SH1: an envelope whose "${field}" is not a string is rejected, naming ${field}`, async () => {
    assertSomeErrorNames(await assertRejected(envelopeWith(VECTOR_ENVELOPE_TEXT, { [field]: 42 })), field);
  });
}

test('SH1: unknown envelope fields are ignored', async () => {
  await assertAccepted(envelopeWith(VECTOR_ENVELOPE_TEXT, { comment: 'hello', extra: [1, 2] }));
});

test('SH1: an envelope over MAX_ENVELOPE_BYTES is rejected even though it is valid JSON', async () => {
  const padded = VECTOR_ENVELOPE_TEXT.replace('{', `{${' '.repeat(MAX_ENVELOPE_BYTES)}`);
  assert.doesNotThrow(() => JSON.parse(padded));
  await assertRejected(padded);
});

test('SH1: the size limit counts UTF-8 bytes, not characters', async () => {
  const filler = 'é'.repeat(Math.ceil(MAX_ENVELOPE_BYTES / 2)); // fewer characters than the limit, more bytes
  assert.ok(filler.length < MAX_ENVELOPE_BYTES);
  await assertRejected(envelopeWith(VECTOR_ENVELOPE_TEXT, { padding: filler }));
});

test('SH1: an envelope just under the limit is accepted', async () => {
  const room = MAX_ENVELOPE_BYTES - Buffer.byteLength(VECTOR_ENVELOPE_TEXT) - 100;
  await assertAccepted(envelopeWith(VECTOR_ENVELOPE_TEXT, { padding: 'x'.repeat(room) }));
});

test('SH1: a manifest field that is not base64 is rejected', async () => {
  await assertRejected(envelopeWith(VECTOR_ENVELOPE_TEXT, { manifest: '***not base64***' }));
});

test('SH1: correctly signed bytes that are not JSON are rejected', async () => {
  await assertRejected(envelopeForBytes(Buffer.from('this is not json\n')));
});

for (const json of ['[]', 'null', '42', '"text"']) {
  test(`SH1: correctly signed manifest bytes ${json} (not an object) are rejected`, async () => {
    await assertRejected(envelopeForBytes(Buffer.from(json)));
  });
}

// ---- SH2: section-3 rules, each on a correctly signed manifest -------------------------------

test('SH2: the valid manifest has no rule violations', () => {
  assert.deepEqual(validateManifest(validManifest()), []);
});

test('SH2: unknown manifest fields are allowed (new optional fields may be added)', async () => {
  const manifest = validManifest();
  manifest.futureField = { anything: true };
  manifest.ffmpeg.mirrorNote = 'x';
  installerOf(manifest, 'ada').extra = 1;
  assert.deepEqual(validateManifest(manifest), []);
  await assertAccepted(signedEnvelope(manifest));
});

test('SH1: the serial returned is the manifest serial', async () => {
  const manifest = validManifest();
  manifest.serial = 42;
  const result = await assertAccepted(signedEnvelope(manifest));
  assert.equal(result.serial, 42);
  assert.equal(result.manifest.serial, 42);
});

const ADA = (manifest) => installerOf(manifest, 'ada');
const FFMPEG = (manifest) => manifest.ffmpeg;

/** [description, change that breaks the manifest, word the error must contain] */
const RULE_CASES = [
  ['format 2', (m) => { m.format = 2; }, 'format'],
  ['format "1" (a string)', (m) => { m.format = '1'; }, 'format'],
  ['format missing', (m) => { delete m.format; }, 'format'],
  ['serial 0', (m) => { m.serial = 0; }, 'serial'],
  ['serial -1', (m) => { m.serial = -1; }, 'serial'],
  ['serial 1.5', (m) => { m.serial = 1.5; }, 'serial'],
  ['serial "1" (a string)', (m) => { m.serial = '1'; }, 'serial'],
  ['serial missing', (m) => { delete m.serial; }, 'serial'],
  ['nvidiaArSdk missing', (m) => { delete m.nvidiaArSdk; }, 'nvidiaArSdk'],
  ['nvidiaArSdk not an object', (m) => { m.nvidiaArSdk = []; }, 'nvidiaArSdk'],
  ['ffmpeg missing', (m) => { delete m.ffmpeg; }, 'ffmpeg'],
  ['ffmpeg not an object', (m) => { m.ffmpeg = 'x'; }, 'ffmpeg'],
  ['installers not an array', (m) => { m.nvidiaArSdk.installers = {}; }, 'installers'],
  ['installers missing', (m) => { delete m.nvidiaArSdk.installers; }, 'installers'],
  ['an installer that is not an object', (m) => { m.nvidiaArSdk.installers.push('ada'); }, 'installers'],
  ['architecture "pascal"', (m) => { ADA(m).architecture = 'pascal'; }, 'architecture'],
  ['architecture "Ada" (upper case)', (m) => { ADA(m).architecture = 'Ada'; }, 'architecture'],
  ['blackwell missing', (m) => { m.nvidiaArSdk.installers = m.nvidiaArSdk.installers.slice(0, 3); }, 'blackwell'],
  ['ada listed twice', (m) => { m.nvidiaArSdk.installers.push({ ...ADA(m) }); }, 'ada'],
  ['sdkVersion empty', (m) => { ADA(m).sdkVersion = ''; }, 'sdkVersion'],
  ['sdkVersion missing', (m) => { delete ADA(m).sdkVersion; }, 'sdkVersion'],
  ['sdkVersion a number', (m) => { ADA(m).sdkVersion = 87; }, 'sdkVersion'],
  ['md5 missing', (m) => { delete ADA(m).md5; }, 'md5'],
  ['md5 31 characters', (m) => { ADA(m).md5 = ADA(m).md5.slice(1); }, 'md5'],
  ['md5 upper case', (m) => { ADA(m).md5 = ADA(m).md5.toUpperCase(); }, 'md5'],
  ['md5 not hex', (m) => { ADA(m).md5 = 'g'.repeat(32); }, 'md5'],
  ...downloadRuleCases('installer', ADA),
  ...downloadRuleCases('ffmpeg', FFMPEG),
  ['ffmpeg version missing', (m) => { delete m.ffmpeg.version; }, 'version'],
  ['ffmpeg version empty', (m) => { m.ffmpeg.version = ''; }, 'version'],
  ['ffmpeg version with a space', (m) => { m.ffmpeg.version = '9.0 2'; }, 'version'],
  ['ffmpeg version with a slash', (m) => { m.ffmpeg.version = '9.0/2'; }, 'version'],
  ['ffmpeg version 41 characters', (m) => { m.ffmpeg.version = '9'.repeat(41); }, 'version'],
  ['ffmpeg version a number', (m) => { m.ffmpeg.version = 9; }, 'version'],
  ['ffmpeg version ".."', (m) => { m.ffmpeg.version = '..'; }, 'version'],
  ['ffmpeg version "9..0" (contains ..)', (m) => { m.ffmpeg.version = '9..0'; }, 'version'],
  ...zipPathRuleCases('ffmpegExe'),
  ...zipPathRuleCases('ffprobeExe'),
  ...zipPathRuleCases('licenseFile'),
];

function downloadRuleCases(label, pick) {
  return [
    [`${label} sizeBytes 0`, (m) => { pick(m).sizeBytes = 0; }, 'sizeBytes'],
    [`${label} sizeBytes -1`, (m) => { pick(m).sizeBytes = -1; }, 'sizeBytes'],
    [`${label} sizeBytes 1.5`, (m) => { pick(m).sizeBytes = 1.5; }, 'sizeBytes'],
    [`${label} sizeBytes "100"`, (m) => { pick(m).sizeBytes = '100'; }, 'sizeBytes'],
    [`${label} sizeBytes missing`, (m) => { delete pick(m).sizeBytes; }, 'sizeBytes'],
    [`${label} sha256 too short`, (m) => { pick(m).sha256 = 'abc'; }, 'sha256'],
    [`${label} sha256 upper case`, (m) => { pick(m).sha256 = pick(m).sha256.toUpperCase(); }, 'sha256'],
    [`${label} sha256 not hex`, (m) => { pick(m).sha256 = 'g'.repeat(64); }, 'sha256'],
    [`${label} sha256 missing`, (m) => { delete pick(m).sha256; }, 'sha256'],
    [`${label} urls empty`, (m) => { pick(m).urls = []; }, 'urls'],
    [`${label} urls missing`, (m) => { delete pick(m).urls; }, 'urls'],
    [`${label} urls a string`, (m) => { pick(m).urls = pick(m).urls[0]; }, 'urls'],
    [`${label} urls with http`, (m) => { pick(m).urls = [pick(m).urls[0].replace('https:', 'http:')]; }, 'urls'],
    [`${label} urls with a relative url`, (m) => { pick(m).urls = ['ffmpeg.zip']; }, 'urls'],
    [`${label} urls with a non-string`, (m) => { pick(m).urls = [42]; }, 'urls'],
    [`${label} second url bad`, (m) => { pick(m).urls = [pick(m).urls[0], 'ftp://example.com/a.zip']; }, 'urls'],
  ];
}

function zipPathRuleCases(field) {
  return [
    [`${field} with ..`, (m) => { m.ffmpeg[field] = 'ffmpeg/../../evil.exe'; }, field],
    [`${field} starting with ..`, (m) => { m.ffmpeg[field] = '../evil.exe'; }, field],
    [`${field} with a leading /`, (m) => { m.ffmpeg[field] = '/bin/ffmpeg.exe'; }, field],
    [`${field} with a backslash`, (m) => { m.ffmpeg[field] = 'ffmpeg\\bin\\ffmpeg.exe'; }, field],
    [`${field} with a colon`, (m) => { m.ffmpeg[field] = 'C:/ffmpeg.exe'; }, field],
    [`${field} empty`, (m) => { m.ffmpeg[field] = ''; }, field],
    [`${field} missing`, (m) => { delete m.ffmpeg[field]; }, field],
    [`${field} a number`, (m) => { m.ffmpeg[field] = 7; }, field],
  ];
}

for (const [description, breakIt, word] of RULE_CASES) {
  test(`SH2: ${description} → rejected with an error naming "${word}"`, async () => {
    await assertRuleBroken(breakIt, word);
  });
}

test('SH2: an ffmpeg version of exactly 40 allowed characters is accepted', async () => {
  const manifest = validManifest();
  manifest.ffmpeg.version = `9.0.2-${'a'.repeat(34)}`;
  assert.equal(manifest.ffmpeg.version.length, 40);
  assert.deepEqual(validateManifest(manifest), []);
});

test('SH2: an installer with several https urls is accepted', () => {
  const manifest = validManifest();
  ADA(manifest).urls.push('https://download.nvidia.com/mirror/nvidia_ar_sdk_installer_v0.8.7_ada.exe');
  assert.deepEqual(validateManifest(manifest), []);
});

test('SH2: every violation is reported, not only the first', () => {
  const manifest = validManifest();
  manifest.format = 2;
  ADA(manifest).sha256 = 'abc';
  manifest.ffmpeg.licenseFile = '../LICENSE';
  const errors = validateManifest(manifest);
  assert.ok(errors.length >= 3, JSON.stringify(errors));
  for (const word of ['format', 'sha256', 'licenseFile']) assertSomeErrorNames(errors, word);
});

test('SH2: validateManifest of a non-object returns errors (no throw)', () => {
  for (const value of [null, undefined, [], 'x', 1]) {
    assert.ok(validateManifest(value).length > 0, JSON.stringify(value));
  }
});

// ---- SH3: signManifest ------------------------------------------------------------------------

test('SH3: signManifest output reads back with readEnvelope (round trip)', async () => {
  const manifest = validManifest();
  manifest.serial = 9;
  const envelopeText = await signManifest(manifest, TEST_PRIVATE_KEY_PEM, TEST_KEY_ID);
  const result = await assertAccepted(envelopeText);
  assert.deepEqual(result.manifest, manifest);
  assert.equal(result.keyId, TEST_KEY_ID);
  assert.equal(result.serial, 9);
});

test('SH3: envelope text is exactly JSON.stringify({keyId, manifest, signature}, null, 2) + "\\n"', async () => {
  const manifest = validManifest();
  const envelopeText = await signManifest(manifest, TEST_PRIVATE_KEY_PEM, TEST_KEY_ID);
  const parsed = JSON.parse(envelopeText);
  assert.deepEqual(Object.keys(parsed), ['keyId', 'manifest', 'signature']);
  const expected = { keyId: TEST_KEY_ID, manifest: manifestBytes(manifest).toString('base64'), signature: parsed.signature };
  assert.equal(envelopeText, `${JSON.stringify(expected, null, 2)}\n`);
});

test('SH3: the signed bytes of the vector manifest are exactly the vector envelope manifest field', async () => {
  const envelopeText = await signManifest(validManifest(), TEST_PRIVATE_KEY_PEM, TEST_KEY_ID);
  assert.equal(JSON.parse(envelopeText).manifest, JSON.parse(VECTOR_ENVELOPE_TEXT).manifest);
});

test('SH3: the signature is 64-byte IEEE P1363 that node:crypto verifies over the decoded bytes', async () => {
  const envelopeText = await signManifest(validManifest(), TEST_PRIVATE_KEY_PEM, TEST_KEY_ID);
  const { manifest, signature } = JSON.parse(envelopeText);
  const signatureBytes = Buffer.from(signature, 'base64');
  assert.equal(signatureBytes.length, 64);
  const publicKey = { key: Buffer.from(TEST_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki', dsaEncoding: 'ieee-p1363' };
  assert.ok(verify('sha256', Buffer.from(manifest, 'base64'), publicKey, signatureBytes));
});

test('SH3: non-ASCII text is signed as UTF-8', async () => {
  const manifest = validManifest();
  ADA(manifest).sdkVersion = '0.8.7–β';
  const envelopeText = await signManifest(manifest, TEST_PRIVATE_KEY_PEM, TEST_KEY_ID);
  assert.equal(JSON.parse(envelopeText).manifest, manifestBytes(manifest).toString('base64'));
  const result = await assertAccepted(envelopeText);
  assert.equal(installerOf(result.manifest, 'ada').sdkVersion, '0.8.7–β');
});

// ---- SH4: constants, md5FromEtag, known-other-links -------------------------------------------

test('SH4: MAX_ENVELOPE_BYTES is 1 MiB and ARCHITECTURES are the four, in order', () => {
  assert.equal(MAX_ENVELOPE_BYTES, 1024 * 1024);
  assert.deepEqual(ARCHITECTURES, ['turing', 'ampere', 'ada', 'blackwell']);
});

const BLACKWELL_MD5 = '9ac74fe7c787ea98bd9a8b2b50608f0a';

test('SH4: md5 is read from a quoted "<md5>:<timestamp>" ETag', () => {
  assert.equal(md5FromEtag(`"${BLACKWELL_MD5}:1738045409.233305"`), BLACKWELL_MD5);
});

test('SH4: md5FromEtag ignores a W/ prefix and works without quotes', () => {
  assert.equal(md5FromEtag(`W/"${BLACKWELL_MD5}:1738045409.233305"`), BLACKWELL_MD5);
  assert.equal(md5FromEtag(`${BLACKWELL_MD5}:1738045409.233305`), BLACKWELL_MD5);
});

test('SH4: md5FromEtag accepts an ETag that is just the md5, quoted or not', () => {
  assert.equal(md5FromEtag(`"${BLACKWELL_MD5}"`), BLACKWELL_MD5);
  assert.equal(md5FromEtag(BLACKWELL_MD5), BLACKWELL_MD5);
});

test('SH4: md5FromEtag returns upper case hex in lower case', () => {
  assert.equal(md5FromEtag(`"${BLACKWELL_MD5.toUpperCase()}:1738045409.233305"`), BLACKWELL_MD5);
  assert.equal(md5FromEtag(`W/"${BLACKWELL_MD5.toUpperCase()}"`), BLACKWELL_MD5);
});

test('SH4: md5FromEtag gives undefined for null, empty and ETags not starting with 32 hex characters', () => {
  for (const etag of [null, undefined, '', '"abc"', '"xyz0123456789abcdef0123456789abcdef"', `"${BLACKWELL_MD5.slice(1)}:1"`]) {
    assert.equal(md5FromEtag(etag), undefined, `ETag ${JSON.stringify(etag)}`);
  }
});

test('SH4: shared/known-other-links.json is an array of {url, why} with https urls and a reason each', () => {
  const entries = JSON.parse(readFileSync(new URL('shared/known-other-links.json', REPO_ROOT), 'utf8'));
  assert.ok(Array.isArray(entries) && entries.length > 0);
  for (const entry of entries) {
    assert.match(entry.url, /^https:\/\/\S+$/, JSON.stringify(entry));
    assert.equal(typeof entry.why, 'string');
    assert.ok(entry.why.trim().length > 0, JSON.stringify(entry));
  }
  const urls = entries.map((entry) => entry.url);
  assert.ok(urls.includes('https://international.download.nvidia.com/Windows/broadcast/sdk/AR/nvidia_ar_sdk_installer_v0.8.2_ada.exe'));
  assert.equal(new Set(urls).size, urls.length, 'no url twice');
});

test('SH4: the retired files are gone (installers.json list, its rules, known-other-links.txt)', () => {
  for (const retired of ['site/gazefix/sdk/v1/installers.json', 'shared/installer-list.mjs', 'scripts/known-other-links.txt']) {
    assert.equal(existsSync(new URL(retired, REPO_ROOT)), false, `${retired} should be deleted`);
  }
});

// ---- SH5: githubReleaseAsset ------------------------------------------------------------------

test('SH5: a GitHub release download url gives owner, repo, tag and name', () => {
  assert.deepEqual(
    githubReleaseAsset('https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip'),
    { owner: 'GyanD', repo: 'codexffmpeg', tag: '9.0.2', name: 'ffmpeg-9.0.2-essentials_build.zip' },
  );
});

test('SH5: urls that are not GitHub release downloads give undefined', () => {
  const notReleaseAssets = [
    'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip',
    'http://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg.zip',
    'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/',
    'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/sub/ffmpeg.zip',
    'https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2',
    'https://github.com/GyanD/codexffmpeg',
    'https://example.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg.zip',
    'not a url',
    '',
    undefined,
    null,
  ];
  for (const url of notReleaseAssets) assert.equal(githubReleaseAsset(url), undefined, JSON.stringify(url));
});
