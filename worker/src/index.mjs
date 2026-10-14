// Cloudflare Worker: every hour (Cron Trigger) checks the signed GazeFix manifest, every download it lists, and the
// upstream pages, and tells Slack when something changes. Free tier only.
// Bindings (worker/wrangler.toml): MANIFEST_URL (var), STATE (KV), SLACK_WEBHOOK_URL (secret).

import publicKeys from '../../keys/public-keys.json' with { type: 'json' };
import {
  FFMPEG_RELEASE_VERSION_URL,
  KNOWN_OTHER_INSTALLER_URLS,
  NVIDIA_PAGE_URL,
} from '../../shared/upstream-watch.mjs';
import { decideAlert, sendSlack } from './alerts.mjs';
import { findProblems } from './checks.mjs';

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;
const STATE_KEY = 'state';

export default {
  // Nothing is public: the check runs only from the Cron Trigger.
  async fetch() {
    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller, env) {
    await runHourlyCheck(env);
  },
};

async function runHourlyCheck(env) {
  const current = await findProblemsOrCrash(env.MANIFEST_URL);
  const previous = await loadState(env.STATE);
  const { message, nextState } = decideAlert(previous, current, new Date());
  console.log(summaryLine(env.MANIFEST_URL, current, message));
  if (message !== null) await sendSlack(workerFetch, requireWebhookUrl(env), withManifestUrl(message, env.MANIFEST_URL));
  await env.STATE.put(STATE_KEY, JSON.stringify(nextState));
}

async function findProblemsOrCrash(manifestUrl) {
  try {
    return await findProblems({
      fetch: workerFetch,
      manifestUrl,
      publicKeys,
      nvidiaPageUrl: NVIDIA_PAGE_URL,
      ffmpegVersionUrl: FFMPEG_RELEASE_VERSION_URL,
      knownOtherLinks: KNOWN_OTHER_INSTALLER_URLS,
      attempts: ATTEMPTS,
      retryDelayMs: RETRY_DELAY_MS,
      sleep,
    });
  } catch (error) {
    return { problems: [`the check itself crashed: ${error.message}`], serial: null };
  }
}

async function loadState(kv) {
  try {
    const state = JSON.parse(await kv.get(STATE_KEY));
    return Array.isArray(state?.problems) ? state : undefined;
  } catch {
    return undefined;
  }
}

function summaryLine(manifestUrl, { problems, serial }, message) {
  const slack = message === null ? 'no Slack message' : 'sending Slack message';
  return `GazeFix manifest check of ${manifestUrl}: serial ${serial}, ${problems.length} problem(s), ${slack} ${JSON.stringify(problems)}`;
}

function withManifestUrl(message, manifestUrl) {
  return `${message}\nManifest: ${manifestUrl}`;
}

function requireWebhookUrl(env) {
  if (!env.SLACK_WEBHOOK_URL) throw new Error('SLACK_WEBHOOK_URL secret is not set (npx wrangler secret put SLACK_WEBHOOK_URL)');
  return env.SLACK_WEBHOOK_URL;
}

// Called as a plain function so the Workers runtime never sees fetch with a foreign `this`.
function workerFetch(input, init) {
  return fetch(input, init);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
