// The signed GazeFix manifest (docs/manifest-v1.md): reading, verifying and signing. One definition, used by the
// publish script, the GitHub checker and the Worker. Must run in Node and in the Workers runtime (WebCrypto).

export const MAX_ENVELOPE_BYTES = 1024 * 1024;
export const ARCHITECTURES = ['turing', 'ampere', 'ada', 'blackwell'];

/**
 * Verifies and validates an envelope (sections 1 and 3).
 * @param {string} text  @param {Record<string, string>} publicKeys keyId → base64 DER SPKI
 * @returns {Promise<{ manifest: object, keyId: string, serial: number } | { errors: string[] }>}
 */
export async function readEnvelope(text, publicKeys) {
  throw new Error('not implemented');
}

/** Section-3 rule violations of a decoded manifest object; [] when valid. @returns {string[]} */
export function validateManifest(manifest) {
  throw new Error('not implemented');
}

/**
 * Signs: manifest bytes = JSON.stringify(manifest, null, 2) + "\n"; returns the envelope text
 * JSON.stringify({ keyId, manifest: base64, signature: base64 P1363 }, null, 2) + "\n".
 * @returns {Promise<string>}
 */
export async function signManifest(manifest, privateKeyPem, keyId) {
  throw new Error('not implemented');
}

/** NVIDIA's ETag "<md5>:<timestamp>" → the 32 lowercase hex md5, else undefined. */
export function md5FromEtag(etag) {
  throw new Error('not implemented');
}

/** {owner, repo, tag, name} for https://github.com/<o>/<r>/releases/download/<tag>/<name>, else undefined. */
export function githubReleaseAsset(url) {
  throw new Error('not implemented');
}
