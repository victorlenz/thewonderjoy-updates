// The signed GazeFix manifest (docs/manifest-v1.md): reading, verifying and signing. One definition, used by the
// publish script, the GitHub checker and the Worker. Runs in Node and in the Workers runtime: only WebCrypto
// (globalThis.crypto.subtle), TextEncoder/TextDecoder, atob/btoa and URL are used.

export const MAX_ENVELOPE_BYTES = 1024 * 1024;
export const ARCHITECTURES = ['turing', 'ampere', 'ada', 'blackwell'];
export const MANIFEST_FORMAT = 1;

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' };
const ENVELOPE_STRING_FIELDS = ['keyId', 'manifest', 'signature'];

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MD5_HEX = /^[0-9a-f]{32}$/;
const FFMPEG_VERSION = /^[0-9A-Za-z.-]{1,40}$/;
const FORBIDDEN_IN_ZIP_PATH = ['..', '\\', ':'];
const ZIP_PATH_FIELDS = ['ffmpegExe', 'ffprobeExe', 'licenseFile'];
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ETAG_MD5_PREFIX = /^(?:W\/)?"?([0-9a-f]{32})(?=$|[":])/i;
const PEM_ARMOR = /-----(?:BEGIN|END) [A-Z ]+-----/g;
const BASE64_ENCODE_CHUNK = 0x8000;

// ---- Reading -------------------------------------------------------------------------------------

/**
 * Verifies and validates an envelope (sections 1 and 3).
 * @param {string} text  @param {Record<string, string>} publicKeys keyId → base64 DER SPKI
 * @returns {Promise<{ manifest: object, keyId: string, serial: number } | { errors: string[] }>}
 */
export async function readEnvelope(text, publicKeys) {
  const envelope = parseEnvelope(text);
  if (envelope.errors) return envelope;
  const manifestBytes = await verifiedManifestBytes(envelope, publicKeys);
  if (manifestBytes.errors) return manifestBytes;
  const manifest = parseManifest(manifestBytes);
  if (manifest.errors) return manifest;
  const ruleErrors = validateManifest(manifest);
  if (ruleErrors.length > 0) return { errors: ruleErrors };
  return { manifest, keyId: envelope.keyId, serial: manifest.serial };
}

function parseEnvelope(text) {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_ENVELOPE_BYTES) return failure(`envelope is ${bytes} bytes; the limit is ${MAX_ENVELOPE_BYTES}`);
  const envelope = parseJson(text);
  if (!isPlainObject(envelope)) return failure('envelope is not a JSON object');
  const errors = ENVELOPE_STRING_FIELDS.filter((field) => typeof envelope[field] !== 'string').map(
    (field) => `envelope "${field}" must be a string, found ${show(envelope[field])}`,
  );
  return errors.length > 0 ? { errors } : envelope;
}

async function verifiedManifestBytes({ keyId, manifest, signature }, publicKeys) {
  if (!Object.hasOwn(publicKeys, keyId)) return failure(`envelope keyId "${keyId}" is not a known key`);
  const manifestBytes = decodeBase64(manifest);
  if (!manifestBytes) return failure('envelope "manifest" is not standard base64');
  const signatureBytes = decodeBase64(signature);
  if (!signatureBytes) return failure('envelope "signature" is not standard base64');
  const publicKey = await importPublicKey(publicKeys[keyId]);
  if (!publicKey) return failure(`public key "${keyId}" is not a base64 DER SPKI P-256 key`);
  const valid = await crypto.subtle.verify(ECDSA_SHA256, publicKey, signatureBytes, manifestBytes);
  return valid ? manifestBytes : failure(`envelope "signature" does not verify with key "${keyId}"`);
}

async function importPublicKey(base64Spki) {
  const der = typeof base64Spki === 'string' ? decodeBase64(base64Spki) : undefined;
  if (!der) return undefined;
  try {
    return await crypto.subtle.importKey('spki', der, ECDSA_P256, false, ['verify']);
  } catch {
    return undefined;
  }
}

function parseManifest(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return failure('manifest is not UTF-8 text');
  }
  const manifest = parseJson(text);
  return isPlainObject(manifest) ? manifest : failure('manifest is not a JSON object');
}

// ---- Section 3 rules -----------------------------------------------------------------------------

/** Section-3 rule violations of a decoded manifest object; [] when valid. @returns {string[]} */
export function validateManifest(manifest) {
  if (!isPlainObject(manifest)) return ['manifest must be a JSON object'];
  const errors = [];
  if (manifest.format !== MANIFEST_FORMAT) errors.push(`"format" must be ${MANIFEST_FORMAT}, found ${show(manifest.format)}`);
  if (!isWholeNumberFrom(manifest.serial, 1)) errors.push(`"serial" must be a whole number ≥ 1, found ${show(manifest.serial)}`);
  errors.push(...nvidiaArSdkErrors(manifest.nvidiaArSdk), ...ffmpegErrors(manifest.ffmpeg));
  return errors;
}

function nvidiaArSdkErrors(nvidiaArSdk) {
  if (!isPlainObject(nvidiaArSdk)) return [`"nvidiaArSdk" must be an object, found ${show(nvidiaArSdk)}`];
  const { installers } = nvidiaArSdk;
  if (!Array.isArray(installers)) return [`"nvidiaArSdk.installers" must be an array, found ${show(installers)}`];
  return [
    ...installers.flatMap((installer, index) => prefixed(`nvidiaArSdk.installers[${index}]`, installerErrors(installer))),
    ...architectureCoverageErrors(installers),
  ];
}

function installerErrors(installer) {
  if (!isPlainObject(installer)) return ['must be an object'];
  const errors = [];
  if (!ARCHITECTURES.includes(installer.architecture)) {
    errors.push(`"architecture" must be one of ${ARCHITECTURES.join(', ')}, found ${show(installer.architecture)}`);
  }
  if (!isNonEmptyString(installer.sdkVersion)) errors.push(`"sdkVersion" must be a non-empty string, found ${show(installer.sdkVersion)}`);
  if (!matches(installer.md5, MD5_HEX)) errors.push(`"md5" must be 32 lowercase hex characters, found ${show(installer.md5)}`);
  return [...errors, ...downloadErrors(installer)];
}

function architectureCoverageErrors(installers) {
  const listed = installers.map((installer) => installer?.architecture);
  return ARCHITECTURES.flatMap((architecture) => {
    const count = listed.filter((listedArchitecture) => listedArchitecture === architecture).length;
    if (count === 0) return [`"nvidiaArSdk.installers": architecture "${architecture}" is missing`];
    if (count > 1) return [`"nvidiaArSdk.installers": architecture "${architecture}" is listed ${count} times`];
    return [];
  });
}

function ffmpegErrors(ffmpeg) {
  if (!isPlainObject(ffmpeg)) return [`"ffmpeg" must be an object, found ${show(ffmpeg)}`];
  const errors = [];
  if (!matches(ffmpeg.version, FFMPEG_VERSION) || ffmpeg.version.includes('..')) {
    errors.push(`"version" must match ${FFMPEG_VERSION} and not contain "..", found ${show(ffmpeg.version)}`);
  }
  for (const field of ZIP_PATH_FIELDS) {
    if (!isSafeZipPath(ffmpeg[field])) errors.push(`"${field}" must be a relative /-separated path, found ${show(ffmpeg[field])}`);
  }
  return prefixed('ffmpeg', [...errors, ...downloadErrors(ffmpeg)]);
}

/** The fields every download has: sizeBytes, sha256, urls. */
function downloadErrors(download) {
  const errors = [];
  if (!isWholeNumberFrom(download.sizeBytes, 1)) errors.push(`"sizeBytes" must be a whole number > 0, found ${show(download.sizeBytes)}`);
  if (!matches(download.sha256, SHA256_HEX)) errors.push(`"sha256" must be 64 lowercase hex characters, found ${show(download.sha256)}`);
  if (!Array.isArray(download.urls) || download.urls.length === 0) {
    errors.push(`"urls" must be a non-empty array, found ${show(download.urls)}`);
  } else {
    errors.push(...download.urls.filter((url) => !isHttpsUrl(url)).map((url) => `"urls" must hold absolute https urls, found ${show(url)}`));
  }
  return errors;
}

function isSafeZipPath(value) {
  return isNonEmptyString(value) && !value.startsWith('/') && FORBIDDEN_IN_ZIP_PATH.every((part) => !value.includes(part));
}

function isHttpsUrl(value) {
  return parseUrl(value)?.protocol === 'https:';
}

// ---- Signing -------------------------------------------------------------------------------------

/**
 * Signs: manifest bytes = JSON.stringify(manifest, null, 2) + "\n"; returns the envelope text
 * JSON.stringify({ keyId, manifest: base64, signature: base64 P1363 }, null, 2) + "\n".
 * @returns {Promise<string>}
 */
export async function signManifest(manifest, privateKeyPem, keyId) {
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const privateKey = await importPrivateKey(privateKeyPem);
  const signature = new Uint8Array(await crypto.subtle.sign(ECDSA_SHA256, privateKey, manifestBytes));
  const envelope = { keyId, manifest: encodeBase64(manifestBytes), signature: encodeBase64(signature) };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function importPrivateKey(pkcs8Pem) {
  const der = decodeBase64(pkcs8Pem.replace(PEM_ARMOR, '').replace(/\s+/g, ''));
  if (!der) throw new Error('private key is not a PEM-encoded PKCS#8 key');
  return crypto.subtle.importKey('pkcs8', der, ECDSA_P256, false, ['sign']);
}

// ---- Download helpers used by the checks ---------------------------------------------------------

/** NVIDIA's ETag "<md5>:<timestamp>" → the 32 lowercase hex md5, else undefined. */
export function md5FromEtag(etag) {
  return ETAG_MD5_PREFIX.exec(etag ?? '')?.[1].toLowerCase();
}

/** {owner, repo, tag, name} for https://github.com/<o>/<r>/releases/download/<tag>/<name>, else undefined. */
export function githubReleaseAsset(url) {
  const parsed = parseUrl(url);
  if (parsed?.protocol !== 'https:' || parsed.hostname !== 'github.com') return undefined;
  const [root, owner, repo, releases, download, tag, name, ...deeper] = parsed.pathname.split('/');
  const isReleaseDownload = root === '' && releases === 'releases' && download === 'download' && deeper.length === 0;
  if (!isReleaseDownload || ![owner, repo, tag, name].every(isNonEmptyString)) return undefined;
  return { owner, repo, tag, name };
}

/** The GitHub API url listing the assets of an asset's release, each with digest "sha256:<hex>". */
export function githubReleaseApiUrl({ owner, repo, tag }) {
  return `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`;
}

/**
 * Compares the digest GitHub lists for asset `name` in a release (the API's JSON) with the expected sha256.
 * @returns {string | undefined} what is wrong, or undefined when the digest matches
 */
export function githubDigestProblem(release, name, sha256) {
  const asset = Array.isArray(release?.assets) ? release.assets.find((candidate) => candidate?.name === name) : undefined;
  if (!asset) return `GitHub release has no asset named ${name}`;
  const expected = `sha256:${sha256}`;
  return asset.digest === expected ? undefined : `GitHub digest is ${asset.digest}, manifest says ${expected}`;
}

/** Every url of the manifest that GazeFix downloads, with a label naming what it is. */
export function downloadsOf(manifest) {
  const installers = manifest.nvidiaArSdk.installers.flatMap((installer) =>
    installer.urls.map((url) => ({ label: installer.architecture, url, download: installer, isNvidia: true })),
  );
  const ffmpeg = manifest.ffmpeg.urls.map((url) => ({ label: `FFmpeg ${manifest.ffmpeg.version}`, url, download: manifest.ffmpeg, isNvidia: false }));
  return [...installers, ...ffmpeg];
}

// ---- Small helpers -------------------------------------------------------------------------------

function decodeBase64(text) {
  if (!STANDARD_BASE64.test(text)) return undefined;
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_ENCODE_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_ENCODE_CHUNK));
  }
  return btoa(binary);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseUrl(value) {
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function failure(error) {
  return { errors: [error] };
}

function prefixed(label, errors) {
  return errors.map((error) => `${label}: ${error}`);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isWholeNumberFrom(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function matches(value, pattern) {
  return typeof value === 'string' && pattern.test(value);
}

function show(value) {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}
