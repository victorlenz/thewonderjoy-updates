// Signs and writes site/gazefix/manifest/v1/manifest.json from manifest-source/gazefix.json (see README).
// Usage: node scripts/publish-manifest.mjs [--key main-2026] [--full] [--offline]

/** 1 + the highest of the given serials (null/undefined ignored); 1 when none. */
export function nextSerial(...serials) {
  throw new Error('not implemented');
}

/** { format: 1, serial, publishedAt: <now as ISO seconds with Z>, ...source } */
export function buildManifest(source, serial, now) {
  throw new Error('not implemented');
}
