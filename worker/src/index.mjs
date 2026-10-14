// Cloudflare Worker: every hour (Cron Trigger) checks the GazeFix installer list and tells Slack when something changes.
// Bindings (worker/wrangler.toml): LIST_URL (var), STATE (KV), SLACK_WEBHOOK_URL (secret).

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
  const problems = await findProblemsOrCrash(env.LIST_URL);
  const previous = await loadState(env.STATE);
  const { message, nextState } = decideAlert(previous, problems, new Date());
  console.log(summaryLine(env.LIST_URL, problems, message));
  if (message !== null) await sendSlack(workerFetch, requireWebhookUrl(env), withListUrl(message, env.LIST_URL));
  await env.STATE.put(STATE_KEY, JSON.stringify(nextState));
}

async function findProblemsOrCrash(listUrl) {
  try {
    return await findProblems({ fetch: workerFetch, listUrl, attempts: ATTEMPTS, retryDelayMs: RETRY_DELAY_MS, sleep });
  } catch (error) {
    return [`the check itself crashed: ${error.message}`];
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

function summaryLine(listUrl, problems, message) {
  const slack = message === null ? 'no Slack message' : 'sending Slack message';
  return `GazeFix installer check of ${listUrl}: ${problems.length} problem(s), ${slack} ${JSON.stringify(problems)}`;
}

function withListUrl(message, listUrl) {
  return `${message}\nList: ${listUrl}`;
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
