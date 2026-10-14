// When to tell Slack: only when the set of problems changes, plus a daily reminder while problems remain.

export const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{ problems: string[], lastAlertAt: string | null }} CheckState  (stored between runs; ISO time)
 * Decides whether this run sends a Slack message.
 * - previous undefined (first run ever): send only if there are problems.
 * - problems differ from previous.problems (as sets): send. Problems → "broken" message; none → "fixed" message.
 * - same problems, not empty, and now - lastAlertAt ≥ REMINDER_INTERVAL_MS: send a "still broken" reminder.
 * - otherwise: no message.
 * nextState.problems = problems (sorted); nextState.lastAlertAt = now when sending, else previous.lastAlertAt (or null).
 * Messages list every problem on its own line.
 * @param {CheckState | undefined} previous
 * @param {string[]} problems
 * @param {Date} now
 * @returns {{ message: string | null, nextState: CheckState }}
 */
export function decideAlert(previous, problems, now) {
  throw new Error('not implemented');
}

/**
 * Posts {"text": text} as JSON to the Slack incoming-webhook URL. Throws when Slack does not answer 2xx,
 * so the run fails and the state is not saved (the alert is retried next hour).
 * @param {typeof fetch} fetchFn
 * @param {string} webhookUrl
 * @param {string} text
 */
export async function sendSlack(fetchFn, webhookUrl, text) {
  throw new Error('not implemented');
}
