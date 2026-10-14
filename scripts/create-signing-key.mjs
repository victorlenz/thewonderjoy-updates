// Creates an ECDSA P-256 signing key for the manifest (docs/manifest-v1.md, section 4).
// The private key is written outside the repo; its public key is added to keys/public-keys.json.
// Usage: node scripts/create-signing-key.mjs <keyId>        e.g. main-2026
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_ID_PATTERN = /^[a-z0-9-]{3,40}$/;
const PRIVATE_KEY_DIR = path.join(os.homedir(), '.thewonderjoy', 'keys');
const PUBLIC_KEYS_FILE = new URL('../keys/public-keys.json', import.meta.url);

const keyId = process.argv[2];
if (!KEY_ID_PATTERN.test(keyId ?? '')) throw new Error('Usage: node scripts/create-signing-key.mjs <keyId> (a-z, 0-9, -)');

const publicKeys = existsSync(PUBLIC_KEYS_FILE) ? JSON.parse(readFileSync(PUBLIC_KEYS_FILE, 'utf8')) : {};
const privateKeyPath = path.join(PRIVATE_KEY_DIR, `${keyId}.private.pem`);
if (publicKeys[keyId] || existsSync(privateKeyPath)) throw new Error(`Key "${keyId}" already exists; pick a new keyId.`);

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
mkdirSync(PRIVATE_KEY_DIR, { recursive: true });
writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx' });
publicKeys[keyId] = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
writeFileSync(PUBLIC_KEYS_FILE, JSON.stringify(publicKeys, null, 2) + '\n');

console.log(`Private key: ${privateKeyPath}  (back it up in a password manager; never commit it)`);
console.log(`Public key ${keyId}: ${publicKeys[keyId]}  (added to keys/public-keys.json)`);
