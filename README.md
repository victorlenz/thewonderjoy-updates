# thewonderjoy-updates

Update metadata for apps by The Wonder Joy. The files are hosted on the owner's server (behind Cloudflare) at
**https://updates.thewonderjoy.com**. The `site/` folder in this repo mirrors what is on that server: a file at
`site/<path>` is served at `https://updates.thewonderjoy.com/<path>`.

The first app is **GazeFix**. GazeFix downloads NVIDIA's AR SDK installer for the user's GPU. It reads the list of
installers from:

https://updates.thewonderjoy.com/gazefix/sdk/v1/installers.json

(file in this repo: `site/gazefix/sdk/v1/installers.json`)

If an NVIDIA download moves (to another address on nvidia.com), fixing this file fixes every copy of GazeFix already
sold. No app update is needed.

## The list format (format 1)

```json
{
  "format": 1,
  "installers": [
    {
      "architecture": "blackwell",
      "sdkVersion": "0.8.7",
      "url": "https://international.download.nvidia.com/Windows/broadcast/sdk/AR/nvidia_ar_sdk_installer_v0.8.7_blackwell.exe",
      "sizeBytes": 1347983656,
      "sha256": "db73b7259efb57736651d26a643e7982132b734b63d9376cdbdd1ee3df7a847c",
      "md5": "9ac74fe7c787ea98bd9a8b2b50608f0a"
    }
  ]
}
```

Rules (GazeFix checks these when it reads the list; `scripts/check-links.mjs` and the hourly Worker check them on
every run; they are written once, in `shared/installer-list.mjs`):

- `format` is `1`.
- `architecture` is one of `turing`, `ampere`, `ada`, `blackwell`. Each architecture appears only once.
- `url` is an absolute `https` URL on `nvidia.com` or a subdomain of it (installers run as administrator, so only
  NVIDIA's servers are trusted).
- The file name at the end of the URL matches `^[A-Za-z0-9._-]+\.exe$`.
- `sizeBytes` is a positive whole number.
- `sha256` is 64 hex characters (the checker asks for lowercase).
- `md5` is 32 lowercase hex characters. GazeFix ignores it; the checks use it, because NVIDIA's server sends the
  file's MD5 in its `ETag` header (`"<md5>:<timestamp>"`), so a changed file shows up without downloading it.
- `sdkVersion` is for people; the app does not use it.

**Never change format 1.** Apps that are already sold read it. If a new shape is ever needed, publish it at a new path
(`.../sdk/v2/installers.json`) and keep the v1 file working. (Adding a field the app ignores, like `md5`, is safe.)

## How to update a link

1. Edit `site/gazefix/sdk/v1/installers.json` (new `url`, `sizeBytes`, `sha256`, `md5`).
2. Open a pull request.
3. The workflow downloads every installer in the list and checks its size and SHA-256, and compares each `md5` with
   NVIDIA's `ETag`. Wait for it to pass.
4. Merge.
5. Copy the file to the server, to the same path (`gazefix/sdk/v1/installers.json`). Check that
   https://updates.thewonderjoy.com/gazefix/sdk/v1/installers.json shows the new file. Within an hour the Worker
   checks the new list (Slack says "fixed" if it had reported a problem).

### Getting the size and hashes yourself

Download the installer, then in PowerShell:

```powershell
(Get-Item .\nvidia_ar_sdk_installer_v0.8.7_ada.exe).Length
(Get-FileHash .\nvidia_ar_sdk_installer_v0.8.7_ada.exe -Algorithm SHA256).Hash.ToLower()
(Get-FileHash .\nvidia_ar_sdk_installer_v0.8.7_ada.exe -Algorithm MD5).Hash.ToLower()
```

To check the whole list against NVIDIA's servers (downloads about 5.3 GB, saves nothing to disk):

```
node scripts/check-links.mjs --full --skip-live
```

## Hourly check (Cloudflare Worker)

`worker/` is a Cloudflare Worker (free plan: Worker + Cron Trigger + KV) that runs every hour. It:

- reads the live list at https://updates.thewonderjoy.com/gazefix/sdk/v1/installers.json and checks it with the
  same rules as above, and that every architecture is listed;
- sends a `HEAD` request to every installer and checks HTTP 200, `Content-Length` = `sizeBytes`, and the md5 in
  NVIDIA's `ETag` = `md5`;
- tries each request up to 3 times (5 s apart) before calling it a problem.

It posts to Slack only when the set of problems changes (something broke, or it was fixed), plus a "still broken"
reminder once a day while problems remain. The last result is kept in the KV namespace `STATE`.

Setup (from the `worker/` folder):

```
npx wrangler login
npx wrangler kv namespace create STATE        # put the printed id in wrangler.toml ([[kv_namespaces]] id)
npx wrangler secret put SLACK_WEBHOOK_URL     # paste the Slack incoming-webhook URL; never commit it
npx wrangler deploy
```

Test locally (no Slack URL is set locally, so a run that wants to alert stops with "SLACK_WEBHOOK_URL secret is not
set" instead of posting; the one-line summary in the log shows what it found):

```
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

To test with Slack, put `SLACK_WEBHOOK_URL=...` in `worker/.dev.vars` (ignored by git).

## The link check (GitHub workflow)

The Worker is the hourly watch. The GitHub workflow stays as the slower, deeper check: it downloads every installer
weekly and checks its SHA-256.

`scripts/check-links.mjs` needs Node 20 or newer and has no npm dependencies.

| Command | What it does |
| --- | --- |
| `node scripts/check-links.mjs` | Validates every `site/**/installers.json`, checks each installer's size and ETag md5 on NVIDIA's server, compares the live copy on updates.thewonderjoy.com with the repo, and looks for new installer links on [NVIDIA's download page](https://www.nvidia.com/broadcast-sdk-resources). |
| `--full` | Also downloads each installer and checks its SHA-256. |
| `--skip-live` | Skips the live-copy comparison. |
| `node --test scripts/check-links.test.mjs worker/test/checks.test.mjs worker/test/alerts.test.mjs worker/test/shared-rules.test.mjs` | Unit tests for the checker and the Worker. |

Exit codes: `0` all fine, `1` something is broken, `2` nothing is broken but NVIDIA's page has installer links that
are neither in the list nor in `scripts/known-other-links.txt`. Set `REPORT_PATH` to also save the Markdown report.

`scripts/known-other-links.txt` holds installers on NVIDIA's page that we leave out on purpose (one URL per line, with
a `#` comment saying why). When NVIDIA adds an installer, either put it in the list or add it there.

The GitHub workflow (`.github/workflows/check-links.yml`) runs:

- every day at 06:00 UTC (quick check),
- every Monday at 07:00 UTC (full check with downloads),
- on every push and pull request that changes `site/`, `scripts/` or `shared/` (full check),
- by hand from the Actions tab (tick "full" for a full check).

When links are broken it opens (or comments on) one issue, "Installer links are broken", and the run fails so GitHub
emails you. It closes that issue when the links work again. New links on NVIDIA's page go to a separate issue,
"NVIDIA published installers we don't list". Pull-request runs never create issues.

## One-time setup

1. Push this repo to GitHub (public).
2. Copy `site/gazefix/sdk/v1/installers.json` to the server and check that
   https://updates.thewonderjoy.com/gazefix/sdk/v1/installers.json shows it.
3. In GitHub: Settings → Secrets and variables → Actions → Variables → add `LIVE_CHECK` = `true`. Until then the
   workflow skips the live-copy check.
4. Set up the hourly Worker (see "Hourly check" above).

**Note:** GitHub turns off scheduled workflows in a repo with no activity for 60 days. GitHub emails a warning first.
To turn it back on, open the Actions tab and enable the workflow.

## Line endings

`.gitattributes` sets `* text=auto eol=lf`, so files are stored and checked out with LF line endings on every
machine. This keeps the published JSON byte-for-byte the same no matter who edits it, including on Windows.
