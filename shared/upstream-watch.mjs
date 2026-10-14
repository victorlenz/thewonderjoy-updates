// Where the manifest is published, and the upstream pages watched for news (a new NVIDIA installer, a new FFmpeg
// release). One definition, used by the publish script, the GitHub checker and the Worker.

import knownOtherLinks from './known-other-links.json' with { type: 'json' };

export const PUBLISHED_SITE_URL = 'https://updates.thewonderjoy.com';
export const NVIDIA_PAGE_URL = 'https://www.nvidia.com/broadcast-sdk-resources';
export const FFMPEG_RELEASE_VERSION_URL = 'https://www.gyan.dev/ffmpeg/builds/release-version';

/** Installer links on NVIDIA's page that GazeFix deliberately does not use (reasons in known-other-links.json). */
export const KNOWN_OTHER_INSTALLER_URLS = Object.freeze(knownOtherLinks.map((entry) => entry.url));

const INSTALLER_LINK_PATTERN = /https?:\/\/[^"'\s<>]*nvidia_ar_sdk_installer[^"'\s<>]*\.exe/gi;

/** Every distinct AR SDK installer link in the HTML, in page order. */
export function extractInstallerLinks(html) {
  return [...new Set(html.match(INSTALLER_LINK_PATTERN) ?? [])];
}

/** Page links that are not in knownUrls. Comparison ignores http/https and letter case. */
export function findNewLinks(pageLinks, knownUrls) {
  const known = new Set(knownUrls.map(comparableUrl));
  return pageLinks.filter((link) => !known.has(comparableUrl(link)));
}

/** The installer urls of a manifest, as they appear on NVIDIA's page. */
export function nvidiaInstallerUrls(manifest) {
  return manifest.nvidiaArSdk.installers.flatMap((installer) => installer.urls);
}

export function newFfmpegReleaseNote(releasedVersion, manifestVersion) {
  return `FFmpeg ${releasedVersion} released (manifest has ${manifestVersion})`;
}

export function newInstallerNote(url) {
  return `NVIDIA lists a new installer: ${url}`;
}

function comparableUrl(url) {
  return url.trim().toLowerCase().replace(/^https?:\/\//, '');
}
