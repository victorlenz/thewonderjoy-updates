# thewonderjoy-updates

Update metadata for apps by The Wonder Joy. The files are hosted on the owner's server (behind Cloudflare) at
**https://updates.thewonderjoy.com**. The `site/` folder in this repo mirrors what is on that server: a file at
`site/<path>` is served at `https://updates.thewonderjoy.com/<path>`.

The first app is **GazeFix**. At startup GazeFix reads one signed file, the **manifest**:

https://updates.thewonderjoy.com/gazefix/sdk/v1/manifest.json

(file in this repo: `site/gazefix/sdk/v1/manifest.json`)

It tells GazeFix where to download NVIDIA's AR SDK installer for the user's GPU and FFmpeg, with the size and SHA-256
of each file. If a download moves, publishing a new manifest fixes every copy of GazeFix already sold. No app update
is needed.

The contract between this repo and the app is **[docs/manifest-v1.md](docs/manifest-v1.md)**: the envelope, the
fields, and the rules. Version 1 never changes in a way that breaks sold apps.

## What is in this repo

| Path | What it is |
| --- | --- |
| `manifest-source/gazefix.json` | The manifest you edit: everything except `format`, `serial` and `publishedAt`. |
| `site/gazefix/sdk/v1/manifest.json` | The signed manifest (written by the publish script, never by hand). |
| `keys/public-keys.json` | The public keys apps trust (`main-2026`, `backup-2026`). |
| `shared/manifest.mjs` | Reading, verifying and signing the manifest, and the rules. One definition, used everywhere. |
| `shared/upstream-watch.mjs` | The website URL and the upstream pages that are watched (NVIDIA's page, gyan.dev's FFmpeg version). |
| `shared/known-other-links.json` | Installer links on NVIDIA's page that GazeFix leaves out on purpose, each with the reason. |
| `scripts/publish-manifest.mjs` | Checks, signs and writes the manifest. |
| `scripts/check-links.mjs` | The GitHub workflow check. |
| `scripts/create-signing-key.mjs` | Creates a new signing key. |
| `worker/` | The hourly Cloudflare Worker that alerts on Slack. |
| `test-vectors/manifest-v1/` | A manifest signed with a test key. This repo's tests and GazeFix's tests both verify it. |

## How to publish a new manifest

1. Edit `manifest-source/gazefix.json` (new URLs, `sizeBytes`, `sha256`, `md5`, FFmpeg version...).
2. Run:

   ```
   node scripts/publish-manifest.mjs
   ```

   It:
   - picks the serial: 1 + the highest serial of the repo file and the live file (the live file is skipped when it
     cannot be read or does not verify);
   - refuses (exit 1, nothing written) when the manifest breaks any rule of docs/manifest-v1.md;
   - checks every URL: the size (HEAD request), NVIDIA's md5 (from its `ETag`), and the SHA-256 that GitHub lists for
     the FFmpeg release asset (when GitHub's rate limit is hit, this is only a warning). Any wrong link → exit 1,
     nothing written;
   - signs with `%USERPROFILE%\.thewonderjoy\keys\main-2026.private.pem`, checks the result with
     `keys/public-keys.json`, and writes `site/gazefix/sdk/v1/manifest.json`.

   Options: `--full` also downloads every URL and compares its SHA-256 (about 5.5 GB, nothing saved).
   `--offline` skips the live serial and the link check. `--dry-run` prints the manifest and its serial and signs and
   writes nothing. `--key backup-2026` signs with another key. `THEWONDERJOY_KEYS_DIR` points to another keys folder.
3. Commit and push. The workflow checks the new file (with downloads).
4. Upload `site/gazefix/sdk/v1/manifest.json` to the server so it is served at
   https://updates.thewonderjoy.com/gazefix/sdk/v1/manifest.json. Within an hour the Worker posts
   "Manifest updated: serial A → B" on Slack.
5. Copy the same file to the app, `D:\Work\gaze\app\src\GazeFix.Core\Setup\BuiltInManifest.json`, before the next
   GazeFix build (the app uses it until it has read a newer one online).

Apps never accept a manifest with a lower serial than one they already accepted, so never publish an older file again.

### Getting the size and hashes yourself

Download the file, then in PowerShell:

```powershell
(Get-Item .\nvidia_ar_sdk_installer_v0.8.7_ada.exe).Length
(Get-FileHash .\nvidia_ar_sdk_installer_v0.8.7_ada.exe -Algorithm SHA256).Hash.ToLower()
(Get-FileHash .\nvidia_ar_sdk_installer_v0.8.7_ada.exe -Algorithm MD5).Hash.ToLower()
```

## Keys and backup

- `main-2026` signs every publish. Its private key is only on the owner's PC, in
  `%USERPROFILE%\.thewonderjoy\keys\main-2026.private.pem`. Keep a copy in a password manager.
- `backup-2026` is a second key. Its private key is kept offline (password manager). Apps trust it too, so if the main
  key is lost or leaked, publish with `--key backup-2026` (put the backup private key in the keys folder first) and
  retire the old key in a later app version.
- Private keys never go into this repo. Only public keys are in `keys/public-keys.json`.
- `node scripts/create-signing-key.mjs <keyId>` creates a new key pair: the private key goes to the keys folder, the
  public key into `keys/public-keys.json`. Apps trust a new key only after an app update that contains it.
- The test key in `test-vectors/` is public on purpose and is never trusted by apps.

## Hourly check (Cloudflare Worker)

`worker/` is a Cloudflare Worker that runs every hour on the free plan (Worker + Cron Trigger + KV; a run makes about
10 requests, the free limit is 50). It reads the live manifest from `MANIFEST_URL` (set in `worker/wrangler.toml`)
and alerts on Slack about:

- the manifest: not reachable, signature does not verify with `keys/public-keys.json`, or a rule is broken;
- every NVIDIA installer URL: not HTTP 200, `Content-Length` ≠ `sizeBytes`, or the md5 in NVIDIA's `ETag` ≠ `md5`;
- every FFmpeg URL: not HTTP 200 (redirects followed) or `Content-Length` ≠ `sizeBytes`;
- the GitHub FFmpeg release: the asset's digest ≠ `sha256`, or the asset is gone (GitHub's rate limit is ignored);
- news: gyan.dev released a newer FFmpeg ("FFmpeg 9.1.0 released (manifest has 9.0.2)"), or NVIDIA's page lists an
  installer that is neither in the manifest nor in `shared/known-other-links.json` ("NVIDIA lists a new installer");
- the serial: a higher serial than last hour → "Manifest updated: serial A → B"; a lower one → the problem
  "serial went backwards".

Each request is tried up to 3 times (5 s apart, 30 s timeout each). It posts to Slack only when the set of problems
changes (something broke, or it was fixed) or the serial went up, plus a "still broken" reminder once a day while
problems remain. At most one Slack message per run. The last result (problems, serial, time of the last alert) is kept
in the KV namespace `STATE`. The Worker has no public URL (any request gets 404).

Setup (from the `worker/` folder):

```
npx wrangler login
npx wrangler kv namespace create STATE        # put the printed id in wrangler.toml ([[kv_namespaces]] id)
npx wrangler secret put SLACK_WEBHOOK_URL     # paste the Slack incoming-webhook URL; never commit it
npx wrangler deploy
```

The Worker bundles `keys/public-keys.json` and `shared/known-other-links.json` when it is deployed, so deploy again
after changing either.

Test locally (no Slack URL is set locally, so a run that wants to alert stops with "SLACK_WEBHOOK_URL secret is not
set" instead of posting; the one-line summary in the log shows what it found):

```
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

To test with Slack, put `SLACK_WEBHOOK_URL=...` in `worker/.dev.vars` (ignored by git).

## The link check (GitHub workflow)

The Worker is the hourly watch. The GitHub workflow is the slower, deeper check: weekly it downloads every URL and
checks its SHA-256.

`scripts/check-links.mjs` needs Node 20 or newer and has no npm dependencies.

| Command | What it does |
| --- | --- |
| `node scripts/check-links.mjs` | Verifies every `site/**/manifest.json` with `keys/public-keys.json` and the rules; checks the size of every URL, NVIDIA's ETag md5 and the GitHub digest; compares the live file on updates.thewonderjoy.com with the repo (same serial and bytes); compares gyan.dev's current FFmpeg version with the manifest; looks for new installer links on [NVIDIA's page](https://www.nvidia.com/broadcast-sdk-resources). |
| `--full` | Also downloads every URL and checks its SHA-256. |
| `--skip-live` | Skips the live-file comparison. |
| `node --test shared/manifest.test.mjs scripts/publish-manifest.test.mjs worker/test/checks.test.mjs worker/test/alerts.test.mjs scripts/check-links.test.mjs` | All unit tests. |

Exit codes: `0` all fine, `1` something is broken, `2` nothing is broken but there is news (a new FFmpeg release, or
an installer link on NVIDIA's page that is neither in the manifest nor in `shared/known-other-links.json`). Set
`REPORT_PATH` to also save the Markdown report.

When NVIDIA adds an installer, either publish a manifest that uses it or add it to `shared/known-other-links.json`
with the reason (then deploy the Worker again).

The workflow (`.github/workflows/check-links.yml`) runs:

- every day at 06:00 UTC (quick check),
- every Monday at 07:00 UTC (full check with downloads),
- on every push and pull request that changes `site/`, `scripts/`, `shared/`, `keys/` or `manifest-source/` (full
  check),
- by hand from the Actions tab (tick "full" for a full check).

When something is broken it opens (or comments on) one issue, "Installer links are broken", and the run fails so
GitHub emails you. It closes that issue when everything works again. News goes to a separate issue, "News: a new
NVIDIA installer or FFmpeg release". Pull-request runs never create issues.

## One-time setup

1. Push this repo to GitHub (public).
2. Upload `site/gazefix/sdk/v1/manifest.json` to the server and check that
   https://updates.thewonderjoy.com/gazefix/sdk/v1/manifest.json shows it.
3. In GitHub: Settings → Secrets and variables → Actions → Variables → add `LIVE_CHECK` = `true`. Until then the
   workflow skips the live-file check.
4. Set up the hourly Worker (see "Hourly check" above).

**Note:** GitHub turns off scheduled workflows in a repo with no activity for 60 days. GitHub emails a warning first.
To turn it back on, open the Actions tab and enable the workflow.

## Free tier

Everything runs on free plans: GitHub Actions (public repo), Cloudflare Workers free plan (one Cron Trigger, KV,
under 50 subrequests per run), and unauthenticated GitHub API calls from the Worker (60 per hour per IP; a rate limit
is never reported as a problem).

## Line endings

`.gitattributes` sets `* text=auto eol=lf`, so files are stored and checked out with LF line endings on every
machine. (The signature covers the base64-decoded manifest bytes inside the envelope, so line endings of the
envelope file itself cannot break it.)
