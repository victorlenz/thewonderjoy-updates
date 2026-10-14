# thewonderjoy-updates

Update metadata for apps by The Wonder Joy. The `site/` folder is published as-is by Cloudflare Pages at
**https://updates.thewonderjoy.com**.

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
      "sha256": "db73b7259efb57736651d26a643e7982132b734b63d9376cdbdd1ee3df7a847c"
    }
  ]
}
```

Rules (GazeFix checks these when it reads the list, and `scripts/check-links.mjs` checks them on every run):

- `format` is `1`.
- `architecture` is one of `turing`, `ampere`, `ada`, `blackwell`. Each architecture appears only once.
- `url` is an absolute `https` URL on `nvidia.com` or a subdomain of it (installers run as administrator, so only
  NVIDIA's servers are trusted).
- The file name at the end of the URL matches `^[A-Za-z0-9._-]+\.exe$`.
- `sizeBytes` is a positive whole number.
- `sha256` is 64 hex characters (the checker asks for lowercase).
- `sdkVersion` is for people; the app does not use it.

**Never change format 1.** Apps that are already sold read it. If a new shape is ever needed, publish it at a new path
(`.../sdk/v2/installers.json`) and keep the v1 file working.

## How to update a link

1. Edit `site/gazefix/sdk/v1/installers.json` (new `url`, `sizeBytes`, `sha256`).
2. Open a pull request.
3. The workflow downloads every installer in the list and checks its size and SHA-256. Wait for it to pass.
4. Merge. Cloudflare Pages deploys the new file in about a minute.

### Getting the size and hash yourself

Download the installer, then in PowerShell:

```powershell
(Get-Item .\nvidia_ar_sdk_installer_v0.8.7_ada.exe).Length
(Get-FileHash .\nvidia_ar_sdk_installer_v0.8.7_ada.exe -Algorithm SHA256).Hash.ToLower()
```

To check the whole list against NVIDIA's servers (downloads about 5.3 GB, saves nothing to disk):

```
node scripts/check-links.mjs --full --skip-live
```

## The link check

`scripts/check-links.mjs` needs Node 20 or newer and has no npm dependencies.

| Command | What it does |
| --- | --- |
| `node scripts/check-links.mjs` | Validates every `site/**/installers.json`, checks each installer's size on NVIDIA's server, compares the live copy on updates.thewonderjoy.com with the repo, and looks for new installer links on [NVIDIA's download page](https://www.nvidia.com/broadcast-sdk-resources). |
| `--full` | Also downloads each installer and checks its SHA-256. |
| `--skip-live` | Skips the live-copy comparison. |
| `node --test scripts/check-links.test.mjs` | Unit tests for the checker. |

Exit codes: `0` all fine, `1` something is broken, `2` nothing is broken but NVIDIA's page has installer links that
are neither in the list nor in `scripts/known-other-links.txt`. Set `REPORT_PATH` to also save the Markdown report.

`scripts/known-other-links.txt` holds installers on NVIDIA's page that we leave out on purpose (one URL per line, with
a `#` comment saying why). When NVIDIA adds an installer, either put it in the list or add it there.

The GitHub workflow (`.github/workflows/check-links.yml`) runs:

- every day at 06:00 UTC (quick check),
- every Monday at 07:00 UTC (full check with downloads),
- on every push and pull request that changes `site/` or `scripts/` (full check),
- by hand from the Actions tab (tick "full" for a full check).

When links are broken it opens (or comments on) one issue, "Installer links are broken", and the run fails so GitHub
emails you. It closes that issue when the links work again. New links on NVIDIA's page go to a separate issue,
"NVIDIA published installers we don't list". Pull-request runs never create issues.

## One-time setup

1. Push this repo to GitHub (public).
2. In Cloudflare: Workers & Pages → Create → Pages → Connect to Git → pick this repo. Build command: none. Build output
   directory: `site`.
3. In the Pages project: Custom domains → add `updates.thewonderjoy.com`.
4. Check that https://updates.thewonderjoy.com/gazefix/sdk/v1/installers.json shows the list.
5. In GitHub: Settings → Secrets and variables → Actions → Variables → add `LIVE_CHECK` = `true`. Until then the
   workflow skips the live-copy check.

**Note:** GitHub turns off scheduled workflows in a repo with no activity for 60 days. GitHub emails a warning first.
To turn it back on, open the Actions tab and enable the workflow.

## Line endings

`.gitattributes` sets `* text=auto eol=lf`, so files are stored and checked out with LF line endings on every
machine. This keeps the published JSON byte-for-byte the same no matter who edits it, including on Windows.
