# Spec: hourly installer check (Cloudflare Worker cron → Slack)

Repo: `D:\Work\thewonderjoy-updates` (public; Node 20+, no npm runtime dependencies; wrangler is used via `npx wrangler`).
Stubs (their JSDoc is part of this spec): `worker/src/checks.mjs`, `worker/src/alerts.mjs`.

## Facts (verified)
- Live list: `https://updates.thewonderjoy.com/gazefix/sdk/v1/installers.json` (served by the owner's server behind Cloudflare).
  Repo copy: `site/gazefix/sdk/v1/installers.json`.
- NVIDIA answers HEAD on each installer with 200, `Content-Length`, and `ETag: "<md5>:<timestamp>"`, e.g.
  `"9ac74fe7c787ea98bd9a8b2b50608f0a:1738045409.233305"`. The md5 part equals the MD5 of the file, verified for all four:
  turing 5dbee8c09f09ef9b76ea292f3e3396fc, ampere 732b51ce049639631031312482b44479,
  ada d14abd6c8f4b9246e4082d84f8e1895e, blackwell 9ac74fe7c787ea98bd9a8b2b50608f0a.
- The GazeFix app ignores unknown fields in list entries, so adding `"md5"` is safe for sold apps.

## Changes

### S. Shared list rules (one definition)
S1. Move the list rules (`LIST_FORMAT`, `ARCHITECTURES`, `validateList` and its helpers) out of `scripts/check-links.mjs`
    into `shared/installer-list.mjs`. `scripts/check-links.mjs` imports from there (and re-exports `validateList` so
    existing tests keep importing it unchanged). The Worker imports the same module. No rule is written twice.
S2. New rule: every entry needs `"md5"`: 32 lowercase hex characters.
S3. Add the md5 values above to `site/gazefix/sdk/v1/installers.json`, as the last field of each entry
    (keep 2-space JSON formatting, trailing newline).
S4. `scripts/check-links.mjs` quick check also compares `md5FromEtag(ETag)` with `md5` (import md5FromEtag from
    `worker/src/checks.mjs` — or move it to shared and import it in both; one definition). Mismatch or missing ETag → failure.

### C. checks.mjs — findProblems / md5FromEtag
C1. md5FromEtag('"9ac74fe7c787ea98bd9a8b2b50608f0a:1738045409.233305"') → '9ac74fe7c787ea98bd9a8b2b50608f0a'.
    Also handles W/ prefix, no quotes, an ETag that is just the 32-hex md5, upper case (returned lower case).
    null, '', '"abc"', '"xyz…"' (not 32 hex at the start) → undefined.
C2. All fine (list 200 valid with 4 architectures; each HEAD 200 with matching size and ETag) → [].
C3. List HTTP 404 / 403 / network error → exactly one problem naming the list URL and the status/error; installers not checked.
C4. List not JSON, or failing validateList → one problem per validation error (prefixed so it names the list); installers not checked.
C5. List valid but an architecture missing → a problem naming the missing architecture (other installers still checked).
C6. One installer HEAD 404 → one problem naming its architecture, url and status; others still checked.
C7. Size differs → problem with both numbers. ETag md5 differs → problem with both md5s. ETag missing → problem.
C8. A step that fails once then succeeds (within `attempts`) is not a problem; `sleep` was called with retryDelayMs.
    A step failing every time → problem after exactly `attempts` fetch calls for that URL.
C9. Problems are returned sorted.

### A. alerts.mjs — decideAlert / sendSlack
A1. previous undefined, problems [] → message null; nextState {problems: [], lastAlertAt: null}.
A2. previous undefined, problems [p] → message contains p; nextState.lastAlertAt = now ISO.
A3. previous {problems: [p]} and problems [p, q] (or [q]) → message contains every current problem.
A4. previous {problems:[p]}, problems [] → a "fixed"/all-clear message (contains the word "OK" or "fixed"); lastAlertAt = now.
A5. Same non-empty problems, lastAlertAt 23 h ago → null, lastAlertAt unchanged. 24 h ago → reminder message
    (contains "still"), lastAlertAt = now.
A6. Same problems in a different order → treated as the same (no message).
A7. sendSlack POSTs JSON {"text": …} with Content-Type application/json to the URL; non-2xx → throws (message has the status).

### W. Worker wiring (`worker/src/index.mjs`, `worker/wrangler.toml`) — verified by running, not unit tests
W1. `export default { async scheduled(controller, env, ctx) }`: problems = findProblems({fetch, listUrl: env.LIST_URL,
    attempts: 3, retryDelayMs: 5000, sleep}); if findProblems throws, problems = ["the check itself crashed: <message>"].
    previous = parsed JSON of KV key "state" in binding STATE (undefined if absent/garbage). decideAlert; if message →
    sendSlack(fetch, env.SLACK_WEBHOOK_URL, message); then STATE.put("state", JSON(nextState)). Log a one-line summary.
    Messages start with "GazeFix installer check:" and include the list URL.
W2. No fetch handler that runs checks publicly (a plain fetch handler may answer 404).
W3. wrangler.toml: name "gazefix-installer-check", main "src/index.mjs", a fixed compatibility_date,
    `[triggers] crons = ["0 * * * *"]`, `[vars] LIST_URL = "<live list url>"`, `[[kv_namespaces]] binding = "STATE"`
    with id placeholder "REPLACE_WITH_KV_ID" (the architect fills it after `wrangler kv namespace create`).
    SLACK_WEBHOOK_URL is a secret (never in the repo). Add `worker/.dev.vars` to .gitignore.

### D. Docs / CI
D1. README: a section "Hourly check (Cloudflare Worker)" — what it checks, Slack alerts only on change + daily
    reminder, setup commands (`npx wrangler login`, `npx wrangler kv namespace create STATE`, put the id in
    wrangler.toml, `npx wrangler secret put SLACK_WEBHOOK_URL`, `npx wrangler deploy` from `worker/`), how to test locally
    (`npx wrangler dev --test-scheduled` then `curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"`), and that the
    GitHub workflow stays as the weekly full SHA-256 download check. Update "how to update a link" to include md5
    (PowerShell `Get-FileHash -Algorithm MD5`) and "copy the file to the server" (the list is hosted on the owner's
    server, not Cloudflare Pages: remove the Pages setup steps; keep `site/` as the folder that mirrors the server).
D2. The workflow's unit-test step runs all tests (scripts and worker).
