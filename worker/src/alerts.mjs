// When to tell Slack: only when the set of problems changes, plus a daily reminder while problems remain.

export const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MESSAGE_HEADING = 'GazeFix installer check:';

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
  const sortedProblems = [...problems].sort();
  const message = messageFor(previous, sortedProblems, now);
  const lastAlertAt = message === null ? (previous?.lastAlertAt ?? null) : now.toISOString();
  return { message, nextState: { problems: sortedProblems, lastAlertAt } };
}

function messageFor(previous, problems, now) {
  const hasProblems = problems.length > 0;
  if (previous === undefined) return hasProblems ? brokenMessage(problems) : null;
  if (!haveSameProblems(previous.problems, problems)) return hasProblems ? brokenMessage(problems) : fixedMessage();
  if (hasProblems && isReminderDue(previous.lastAlertAt, now)) return stillBrokenMessage(problems);
  return null;
}

function haveSameProblems(previousProblems, sortedProblems) {
  const previousSorted = [...previousProblems].sort();
  return (
    previousSorted.length === sortedProblems.length &&
    previousSorted.every((problem, index) => problem === sortedProblems[index])
  );
}

function isReminderDue(lastAlertAt, now) {
  if (lastAlertAt === null) return true;
  return now.getTime() - Date.parse(lastAlertAt) >= REMINDER_INTERVAL_MS;
}

function brokenMessage(problems) {
  return [`${MESSAGE_HEADING} ${problems.length} problem(s) found`, ...bulleted(problems)].join('\n');
}

function stillBrokenMessage(problems) {
  return [`${MESSAGE_HEADING} still broken, ${problems.length} problem(s)`, ...bulleted(problems)].join('\n');
}

function fixedMessage() {
  return `${MESSAGE_HEADING} fixed, everything is OK again`;
}

function bulleted(problems) {
  return problems.map((problem) => `• ${problem}`);
}

/**
 * Posts {"text": text} as JSON to the Slack incoming-webhook URL. Throws when Slack does not answer 2xx,
 * so the run fails and the state is not saved (the alert is retried next hour).
 * @param {typeof fetch} fetchFn
 * @param {string} webhookUrl
 * @param {string} text
 */
export async function sendSlack(fetchFn, webhookUrl, text) {
  const response = await fetchFn(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`Slack answered HTTP ${response.status}: ${await response.text()}`);
}
