// What the hourly check looks at: the live installers.json GazeFix reads, and every NVIDIA installer it lists.

import { ARCHITECTURES, MAX_LIST_BYTES, md5FromEtag, validateList } from '../../shared/installer-list.mjs';

export { md5FromEtag };

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
  const { listUrl } = options;
  const fetchOk = (url, init) => withRetries(() => fetchWithStatus200(options.fetch, url, init), options);
  const { list, problems: listProblems } = await loadList(fetchOk, listUrl);
  if (!list) return listProblems.sort();
  const installerProblems = await Promise.all(list.installers.map((installer) => checkInstaller(fetchOk, installer)));
  return [...missingArchitectureProblems(list, listUrl), ...installerProblems.flat()].sort();
}

// ---- The list ---------------------------------------------------------------------------------

async function loadList(fetchOk, listUrl) {
  const label = `List ${listUrl}`;
  let text;
  try {
    text = await (await fetchOk(listUrl)).text();
  } catch (error) {
    return listFailure(`${label} could not be read: ${error.message}`);
  }
  const { data, errors } = parseAndValidate(text);
  if (errors.length > 0) return listFailure(...errors.map((error) => `${label}: ${error}`));
  return { list: data, problems: [] };
}

function parseAndValidate(text) {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_LIST_BYTES) return { errors: [`is ${bytes} bytes; GazeFix rejects lists over ${MAX_LIST_BYTES} bytes`] };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { errors: ['is not valid JSON'] };
  }
  return { data, errors: validateList(data) };
}

function listFailure(...problems) {
  return { list: undefined, problems };
}

function missingArchitectureProblems(list, listUrl) {
  const listed = new Set(list.installers.map((installer) => installer.architecture));
  return ARCHITECTURES.filter((architecture) => !listed.has(architecture)).map(
    (architecture) => `List ${listUrl}: architecture "${architecture}" is missing`,
  );
}

// ---- One installer ----------------------------------------------------------------------------

async function checkInstaller(fetchOk, installer) {
  const { architecture, url } = installer;
  try {
    const head = await fetchOk(url, { method: 'HEAD' });
    return headerProblems(head.headers, installer).map((problem) => `${architecture}: ${problem} (${url})`);
  } catch (error) {
    return [`${architecture}: ${error.message} (${url})`];
  }
}

function headerProblems(headers, installer) {
  return [...sizeProblems(headers.get('content-length'), installer), ...md5Problems(headers.get('etag'), installer)];
}

function sizeProblems(contentLength, installer) {
  if (contentLength === null) return ['server sent no Content-Length'];
  if (Number(contentLength) === installer.sizeBytes) return [];
  return [`size is ${contentLength}, list says ${installer.sizeBytes}`];
}

function md5Problems(etag, installer) {
  const servedMd5 = md5FromEtag(etag);
  if (servedMd5 === undefined) return [`server sent no md5 in its ETag (${JSON.stringify(etag)})`];
  if (servedMd5 === installer.md5) return [];
  return [`ETag md5 is ${servedMd5}, list says ${installer.md5}`];
}

// ---- Networking -------------------------------------------------------------------------------

// Fetch has no time limit of its own; a hung request must fail this try, not the whole hourly run.
const REQUEST_TIMEOUT_MS = 30_000;

async function fetchWithStatus200(fetchFn, url, init) {
  const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.status === 200) return response;
  await response.body?.cancel();
  throw new Error(`HTTP ${response.status}`);
}

async function withRetries(action, { attempts, retryDelayMs, sleep }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(retryDelayMs);
    }
  }
}
