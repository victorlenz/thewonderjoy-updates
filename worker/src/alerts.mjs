// When to tell Slack: when the set of problems changes, when a new manifest was published, plus a daily reminder
// while problems remain. At most one message per run.

export const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MESSAGE_HEADING = 'GazeFix manifest check:';

/**
 * @typedef {{ problems: string[], serial: number | null, lastAlertAt: string | null }} CheckState
 *   stored between runs; lastAlertAt is an ISO time. States saved before serials existed have no `serial`.
 * @typedef {{ problems: string[], serial: number | null }} CheckResult  what findProblems returns
 *
 * Decides whether this run sends a Slack message.
 * - A current serial lower than the stored one adds the problem "serial went backwards: A → B".
 * - previous undefined (first run ever): send only if there are problems.
 * - problems differ from previous.problems (as sets): send. Problems → "broken" message; none → "fixed" message.
 * - same problems, not empty, and now - lastAlertAt ≥ REMINDER_INTERVAL_MS: send a "still broken" reminder.
 * - a stored serial that is a number and a higher current serial: "Manifest updated: serial A → B", combined with
 *   any of the messages above into one.
 * nextState: problems sorted; serial = the highest seen; lastAlertAt = now when sending, else unchanged.
 * @param {CheckState | undefined} previous
 * @param {CheckResult} current
 * @param {Date} now
 * @returns {{ message: string | null, nextState: CheckState }}
 */
export function decideAlert(previous, current, now) {
  const storedSerial = isSerial(previous?.serial) ? previous.serial : null;
  const problems = [...current.problems, ...serialProblems(storedSerial, current.serial)].sort();
  const problemMessage = messageFor(previous, problems, now);
  const message = withUpdateNote(problemMessage, updateNote(storedSerial, current.serial));
  const lastAlertAt = message === null ? (previous?.lastAlertAt ?? null) : now.toISOString();
  return { message, nextState: { problems, serial: highestSerial(storedSerial, current.serial), lastAlertAt } };
}

// ---- Serial -----------------------------------------------------------------------------------

function serialProblems(storedSerial, currentSerial) {
  if (!isSerial(storedSerial) || !isSerial(currentSerial) || currentSerial >= storedSerial) return [];
  return [`serial went backwards: ${storedSerial} → ${currentSerial}`];
}

function updateNote(storedSerial, currentSerial) {
  if (!isSerial(storedSerial) || !isSerial(currentSerial) || currentSerial <= storedSerial) return null;
  return `Manifest updated: serial ${storedSerial} → ${currentSerial}`;
}

function highestSerial(storedSerial, currentSerial) {
  const known = [storedSerial, currentSerial].filter(isSerial);
  return known.length > 0 ? Math.max(...known) : null;
}

function isSerial(value) {
  return typeof value === 'number';
}

function withUpdateNote(problemMessage, note) {
  if (note === null) return problemMessage;
  if (problemMessage === null) return `${MESSAGE_HEADING} ${note}`;
  return `${problemMessage}\n${note}`;
}

// ---- Problems ---------------------------------------------------------------------------------

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

// ---- Slack ------------------------------------------------------------------------------------

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
