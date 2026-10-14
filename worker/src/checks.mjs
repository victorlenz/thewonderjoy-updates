// What the hourly check looks at: the live installers.json GazeFix reads, and every NVIDIA installer it lists.

/**
 * Checks the live list and every installer in it. Returns human-readable problems, sorted; [] means all fine.
 * - The list must answer HTTP 200 and pass validateList (shared rules), and list every architecture in ARCHITECTURES.
 * - Each installer: HEAD its url → HTTP 200, Content-Length == sizeBytes, and md5FromEtag(ETag) == md5.
 * Every network step gets `attempts` tries, waiting `sleep(retryDelayMs)` between them; only the last failure counts.
 * @param {{ fetch: typeof fetch, listUrl: string, attempts: number, retryDelayMs: number,
 *           sleep: (ms: number) => Promise<void> }} options
 * @returns {Promise<string[]>}
 */
export async function findProblems(options) {
  throw new Error('not implemented');
}

/**
 * NVIDIA's download server sends ETag "<md5 of the file>:<timestamp>" (verified for all four 0.8.7 installers).
 * Returns the 32 lowercase hex characters at the start of the ETag (quotes and a W/ prefix removed), or undefined.
 * @param {string | null} etag
 */
export function md5FromEtag(etag) {
  throw new Error('not implemented');
}
