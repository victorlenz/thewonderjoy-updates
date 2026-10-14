// Test-only helpers: the manifest-v1 test vector and envelopes signed with its test key.
// Signing here uses node:crypto directly, so tests never depend on the code under test (signManifest).

import { sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const VECTOR_DIR = new URL('../test-vectors/manifest-v1/', import.meta.url);

function readVectorFile(name) {
  return readFileSync(new URL(name, VECTOR_DIR), 'utf8');
}

export const TEST_KEY_ID = 'test-2026';
export const TEST_PRIVATE_KEY_PEM = readVectorFile('test-key.private.pem');
export const TEST_PUBLIC_KEY = readVectorFile('test-key.public.txt').trim();
export const TEST_PUBLIC_KEYS = Object.freeze({ [TEST_KEY_ID]: TEST_PUBLIC_KEY });
export const VECTOR_ENVELOPE_TEXT = readVectorFile('signed-envelope.json');
export const REAL_PUBLIC_KEYS = Object.freeze(
  JSON.parse(readFileSync(new URL('../keys/public-keys.json', import.meta.url), 'utf8')),
);

const VECTOR_MANIFEST_TEXT = readVectorFile('manifest.json');

/** A fresh copy of the complete, valid test-vector manifest (safe to mutate). */
export function validManifest() {
  return JSON.parse(VECTOR_MANIFEST_TEXT);
}

/** The exact bytes that get signed: JSON.stringify(manifest, null, 2) + "\n" as UTF-8. */
export function manifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** Signature over `bytes` with the test private key, base64; P1363 (r ‖ s) unless dsaEncoding says otherwise. */
export function signatureFor(bytes, { privateKeyPem = TEST_PRIVATE_KEY_PEM, dsaEncoding = 'ieee-p1363' } = {}) {
  return sign('sha256', bytes, { key: privateKeyPem, dsaEncoding }).toString('base64');
}

/** Envelope text for arbitrary manifest bytes, laid out exactly like the contract's section 1. */
export function envelopeForBytes(bytes, { keyId = TEST_KEY_ID, ...signOptions } = {}) {
  const envelope = { keyId, manifest: bytes.toString('base64'), signature: signatureFor(bytes, signOptions) };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** Envelope text for a manifest object, signed with the test key. */
export function signedEnvelope(manifest, options = {}) {
  return envelopeForBytes(manifestBytes(manifest), options);
}

/** Replaces fields of a parsed envelope and returns it as text again (for tampering tests). */
export function envelopeWith(envelopeText, changes) {
  return JSON.stringify({ ...JSON.parse(envelopeText), ...changes }, null, 2);
}

export function installerOf(manifest, architecture) {
  return manifest.nvidiaArSdk.installers.find((installer) => installer.architecture === architecture);
}
