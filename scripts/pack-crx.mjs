#!/usr/bin/env node
/**
 * Pack the contents of `dist/` into a Chrome `.crx` file.
 *
 * Usage:
 *   pnpm build && pnpm pack:crx           # picks up key.pem if present, else generates ephemeral
 *   CLAWTAB_CRX_KEY="$(cat key.pem)" pnpm pack:crx   # CI: pipe key in via env
 *
 * Notes on the extension ID:
 *  - Chrome derives the extension ID from `manifest.json.key` (the public
 *    key field), not from the CRX signature. Our manifest pins this, so the
 *    install always shows up as `olfpncdbjlggonplhnlnbhkfianddhmp`
 *    regardless of whether we sign with a stable key or an ephemeral one.
 *  - The signing private key is only used for CRX integrity. Generating one
 *    on the fly is fine for CI; if you want signature continuity across
 *    builds (e.g. so update manifests verify), commit `key.pem` to a secret
 *    store and feed it via CLAWTAB_CRX_KEY.
 *
 * Requires `crx3` (CRX v3 packer) — see scripts entry in package.json.
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const distDir = join(repoRoot, 'dist');
const outCrx = join(repoRoot, 'clawtab.crx');

if (!existsSync(distDir)) {
  console.error(
    '[pack-crx] dist/ not found — run `pnpm build` first (or use `pnpm dev` and copy from there).',
  );
  process.exit(1);
}

// ── Resolve the signing key ────────────────────────────────────────────────
const keyFromEnv = process.env.CLAWTAB_CRX_KEY ?? '';
const repoKey = join(repoRoot, 'key.pem');
let keyPath;
let cleanupKey = null;

if (keyFromEnv.trim().length > 0) {
  // CI path — write the secret to a tmp file with restrictive perms
  const tmpDir = mkdtempSync(join(tmpdir(), 'clawtab-crx-'));
  keyPath = join(tmpDir, 'key.pem');
  writeFileSync(keyPath, keyFromEnv, { mode: 0o600 });
  cleanupKey = () => {
    rmSync(tmpDir, { recursive: true, force: true });
  };
  console.log('[pack-crx] using CLAWTAB_CRX_KEY from env');
} else if (existsSync(repoKey)) {
  keyPath = repoKey;
  console.log('[pack-crx] using local key.pem');
} else {
  // Local dev / first-CI-run path — let crx3 generate a fresh key. We DON'T
  // copy that ephemeral key back into the repo (it ends up at outCrx + '.pem'
  // which we delete after); the extension ID stays stable because it comes
  // from manifest.key, not from this signing key.
  keyPath = null;
  console.log('[pack-crx] no key found, crx3 will generate an ephemeral one');
}

// ── Run crx3 ───────────────────────────────────────────────────────────────
// CLI form: `crx3 [-p key.pem] -o out.crx -- dist`
// We invoke as `pnpm exec crx3` so it works even if crx3 isn't on PATH.
const args = ['exec', 'crx3'];
if (keyPath) {
  args.push('-p', keyPath);
}
args.push('-o', outCrx, '--', distDir);

console.log(`[pack-crx] $ pnpm ${args.join(' ')}`);

const child = spawn('pnpm', args, {
  stdio: 'inherit',
  cwd: repoRoot,
});

child.on('exit', (code) => {
  if (cleanupKey) cleanupKey();
  if (code !== 0) {
    console.error(`[pack-crx] crx3 exited with code ${code}`);
    process.exit(code ?? 1);
  }
  // Copy outCrx to a versioned name as well so the artifact is recognizable.
  const pkgVer = JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  ).version;
  const versioned = join(repoRoot, `clawtab-${pkgVer}.crx`);
  copyFileSync(outCrx, versioned);
  console.log(`[pack-crx] wrote:`);
  console.log(`           ${outCrx}`);
  console.log(`           ${versioned}`);
});

child.on('error', (err) => {
  if (cleanupKey) cleanupKey();
  console.error('[pack-crx] failed to spawn crx3:', err.message);
  process.exit(1);
});
