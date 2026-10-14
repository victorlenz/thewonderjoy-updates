# GazeFix manifest, version 1

GazeFix reads one signed file at startup and does what it says:

    https://updates.thewonderjoy.com/gazefix/sdk/v1/manifest.json

This document is the contract between this repo (which writes and checks the file) and the GazeFix app
(which reads it). **Version 1 never changes in a way that breaks apps already sold.** New optional fields may be
added (apps ignore fields they do not know). Anything incompatible gets a new path (`.../sdk/v2/...`), and the
v1 file keeps being published for old apps.

## 1. The envelope (what is served)

```json
{
  "keyId": "main-2026",
  "manifest": "<base64 of the manifest JSON bytes>",
  "signature": "<base64 of the signature>"
}
```

- `manifest`: standard base64 (RFC 4648, with padding) of the exact UTF-8 bytes of the manifest JSON (section 2).
- `signature`: standard base64 of an **ECDSA P-256 / SHA-256** signature over exactly those decoded bytes, in
  **IEEE P1363** form (r ‖ s, 64 bytes). (.NET: `ECDsa.VerifyData(bytes, sig, HashAlgorithmName.SHA256)`;
  Node: `crypto.sign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' })`.)
- `keyId`: which public key signed it. Apps contain a fixed table `keyId → public key`
  (public key = standard base64 of the DER **SubjectPublicKeyInfo**). An unknown `keyId` is rejected.
- The envelope is at most 1 MiB. Unknown envelope fields are ignored.

An app accepts a manifest only when: the envelope parses, `keyId` is known, the signature verifies, and the manifest
passes section 3. Otherwise the whole file is ignored (the app keeps using the last good manifest).

## 2. The manifest (what is signed)

```jsonc
{
  "format": 1,
  "serial": 1,
  "publishedAt": "2026-10-14T09:00:00Z",
  "nvidiaArSdk": {
    "installers": [   // shortened here: a real manifest lists turing, ampere, ada and blackwell
      {
        "architecture": "blackwell",
        "sdkVersion": "0.8.7",
        "sizeBytes": 1347983656,
        "sha256": "db73b7259efb57736651d26a643e7982132b734b63d9376cdbdd1ee3df7a847c",
        "md5": "9ac74fe7c787ea98bd9a8b2b50608f0a",
        "urls": ["https://international.download.nvidia.com/Windows/broadcast/sdk/AR/nvidia_ar_sdk_installer_v0.8.7_blackwell.exe"]
      }
    ]
  },
  "ffmpeg": {
    "version": "9.0.2",
    "sizeBytes": 114768076,
    "sha256": "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba",
    "urls": [
      "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip",
      "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip"
    ],
    "ffmpegExe": "ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe",
    "ffprobeExe": "ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe",
    "licenseFile": "ffmpeg-9.0.2-essentials_build/LICENSE"
  }
}
```

## 3. Rules (checked by the app, the publish script and the hourly check)

Manifest:
- `format` is the number `1`.
- `serial` is a whole number ≥ 1. Every publish increases it. **An app never accepts a manifest whose serial is lower
  than the highest serial it has already accepted** (protects against an old signed file being served again).
- `publishedAt` is informational (people read it; apps do not act on it).
- `nvidiaArSdk` and `ffmpeg` are both required.

Shared "download" fields (each NVIDIA installer, and `ffmpeg`):
- `sizeBytes`: whole number > 0.
- `sha256`: 64 lowercase hex characters. A downloaded file is used only if its size and SHA-256 match, whichever URL
  it came from.
- `urls`: non-empty array of absolute `https` URLs, tried in order (the first that delivers the right file wins).

NVIDIA installers (`nvidiaArSdk.installers`):
- `architecture`: one of `turing`, `ampere`, `ada`, `blackwell` (lowercase); each at most once; all four required.
- `sdkVersion`: non-empty string (informational).
- `md5`: 32 lowercase hex characters (NVIDIA's download server sends it in its ETag; used by the hourly check only).

FFmpeg (`ffmpeg`):
- `version`: matches `^[0-9A-Za-z.-]{1,40}$` and does not contain `..` (used in the install folder name).
- `ffmpegExe`, `ffprobeExe`, `licenseFile`: relative paths inside the zip, `/`-separated, no `..`, no leading `/`,
  no `\`, no `:`.

The whole manifest is rejected when any rule fails (no partial use: a signed manifest that fails a rule is a
publishing bug, and the app keeps its last good manifest instead).

## 4. Keys

- `main-2026`: the key used to sign. Private key only on the owner's PC (`%USERPROFILE%\.thewonderjoy\keys\`), backed
  up in a password manager.
- `backup-2026`: a second key whose private half is kept offline. Its public key is built into apps too, so if the
  main key is lost or leaked, publishing continues with the backup key (and a new app version can retire the old key).
- Test keys (in `test-vectors/`) are never built into apps.

## 5. Test vector

`test-vectors/manifest-v1/` holds a signed envelope made with a test key, its public key, and the expected decoded
values. Both this repo's tests and the GazeFix app's tests verify it, so the two implementations provably agree.
