// The rules for an installers.json list (format 1), shared by scripts/check-links.mjs and the hourly Worker.
// They are the ones GazeFix applies when it reads a list. Never loosen them.

export const LIST_FORMAT = 1;
export const MAX_LIST_BYTES = 1024 * 1024;
export const ARCHITECTURES = ['turing', 'ampere', 'ada', 'blackwell'];
const TRUSTED_HOST = 'nvidia.com';
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]+\.exe$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MD5_HEX = /^[0-9a-f]{32}$/;
const ETAG_MD5_PREFIX = /^(?:W\/)?"?([0-9a-f]{32})(?=$|[":])/i;

/** Returns a list of human-readable problems; an empty array means the list is valid. */
export function validateList(data) {
  if (!isPlainObject(data)) return ['top level must be a JSON object'];
  const errors = [];
  if (data.format !== LIST_FORMAT) errors.push(`"format" must be ${LIST_FORMAT}, found ${JSON.stringify(data.format)}`);
  if (!Array.isArray(data.installers)) return [...errors, '"installers" must be an array'];
  if (data.installers.length === 0) errors.push('"installers" is empty');
  data.installers.forEach((installer, index) => {
    const label = `installers[${index}]`;
    errors.push(...validateInstaller(installer).map((error) => `${label}: ${error}`));
  });
  errors.push(...duplicateArchitectureErrors(data.installers));
  return errors;
}

/**
 * NVIDIA's download server sends ETag "<md5 of the file>:<timestamp>" (verified for all four 0.8.7 installers).
 * Returns the 32 lowercase hex characters at the start of the ETag (quotes and a W/ prefix removed), or undefined.
 * @param {string | null} etag
 */
export function md5FromEtag(etag) {
  return ETAG_MD5_PREFIX.exec(etag ?? '')?.[1].toLowerCase();
}

function validateInstaller(installer) {
  if (!isPlainObject(installer)) return ['must be a JSON object'];
  const errors = [];
  if (!ARCHITECTURES.includes(installer.architecture)) {
    errors.push(`"architecture" must be one of ${ARCHITECTURES.join('/')}, found ${JSON.stringify(installer.architecture)}`);
  }
  errors.push(...urlErrors(installer.url));
  if (!Number.isSafeInteger(installer.sizeBytes) || installer.sizeBytes <= 0) {
    errors.push(`"sizeBytes" must be a positive whole number, found ${JSON.stringify(installer.sizeBytes)}`);
  }
  errors.push(...hexErrors(installer, 'sha256', SHA256_HEX, 64));
  errors.push(...hexErrors(installer, 'md5', MD5_HEX, 32));
  return errors;
}

function hexErrors(installer, field, pattern, length) {
  const value = installer[field];
  if (typeof value === 'string' && pattern.test(value)) return [];
  return [`"${field}" must be ${length} lowercase hex characters, found ${JSON.stringify(value)}`];
}

function urlErrors(url) {
  const parsed = parseAbsoluteUrl(url);
  if (!parsed) return [`"url" must be an absolute URL, found ${JSON.stringify(url)}`];
  const errors = [];
  if (parsed.protocol !== 'https:') errors.push(`"url" must use https: ${url}`);
  if (!isTrustedHost(parsed.hostname)) errors.push(`"url" must be on ${TRUSTED_HOST} or a subdomain: ${url}`);
  if (!SAFE_FILE_NAME.test(fileNameOf(parsed))) {
    errors.push(`"url" file name must match ${SAFE_FILE_NAME}: ${url}`);
  }
  return errors;
}

function parseAbsoluteUrl(url) {
  if (typeof url !== 'string') return undefined;
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function isTrustedHost(hostname) {
  const host = hostname.toLowerCase();
  return host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
}

function fileNameOf(parsedUrl) {
  return parsedUrl.pathname.split('/').pop();
}

function duplicateArchitectureErrors(installers) {
  const seen = new Set();
  const errors = [];
  for (const installer of installers) {
    const architecture = installer?.architecture;
    if (typeof architecture !== 'string') continue;
    if (seen.has(architecture)) errors.push(`architecture "${architecture}" is listed more than once`);
    seen.add(architecture);
  }
  return errors;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
