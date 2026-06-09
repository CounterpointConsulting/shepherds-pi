#!/usr/bin/env node
/**
 * Sync the local shepherds-pi source into a target test project.
 *
 * Keeps the three artifacts that can drift in lock-step:
 *   1. CLI / coordinator code  -> `npm run build` (so the npm-linked binary
 *                                 runs the latest dist/ + coordinator.md)
 *   2. Agent Docker image      -> `npm run docker:build` (entrypoint, Playwright,
 *                                 browsers) tagged shepherds-pi-agent:latest
 *   3. Personas                -> copied into <project>/.shepherds-pi/personas
 *
 * It also points the target project's shepherds-pi.yaml at the locally-built
 * image tag so you never accidentally run the stale published GHCR image.
 *
 * Usage:
 *   node scripts/sync-to-project.mjs <path-to-project> [--no-build] [--no-docker] [--image <tag>]
 *
 * Example:
 *   npm run sync -- C:/Users/BillMarkmann/git/shepherd-test-3
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));

let imageTag = 'shepherds-pi-agent:latest';
const imageIdx = args.indexOf('--image');
if (imageIdx !== -1 && args[imageIdx + 1]) imageTag = args[imageIdx + 1];

const target = positional[0];
if (!target) {
  console.error('Usage: node scripts/sync-to-project.mjs <path-to-project> [--no-build] [--no-docker] [--image <tag>]');
  process.exit(1);
}

const projectRoot = path.resolve(target);
if (!fs.existsSync(projectRoot)) {
  console.error(`❌ Target project not found: ${projectRoot}`);
  process.exit(1);
}

const configPath = path.join(projectRoot, 'shepherds-pi.yaml');
if (!fs.existsSync(configPath)) {
  console.error(`❌ No shepherds-pi.yaml in ${projectRoot}. Run "shepherds-pi init" there first.`);
  process.exit(1);
}

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: repoRoot, stdio: 'inherit' });
}

// ─── 1. Build CLI / coordinator code ──────────────────────────────
if (!flags.has('--no-build')) {
  console.log('▶ Building CLI + coordinator assets (dist/) ...');
  run('npm run build');
} else {
  console.log('⏭  Skipping CLI build (--no-build)');
}

// ─── 2. Build the agent Docker image ──────────────────────────────
if (!flags.has('--no-docker')) {
  console.log('▶ Building agent Docker image ...');
  run(`docker build -t ${imageTag} -f docker/Dockerfile docker`);
} else {
  console.log('⏭  Skipping Docker build (--no-docker)');
}

// ─── 3. Sync personas ─────────────────────────────────────────────
const srcPersonas = path.join(repoRoot, 'personas');
const dstPersonas = path.join(projectRoot, '.shepherds-pi', 'personas');
console.log(`\n▶ Syncing personas -> ${dstPersonas}`);
fs.rmSync(dstPersonas, { recursive: true, force: true });
fs.mkdirSync(path.dirname(dstPersonas), { recursive: true });
fs.cpSync(srcPersonas, dstPersonas, { recursive: true });
console.log('✅ Personas synced');

// ─── 4. Pin the project's image to the locally-built tag ──────────
let yaml = fs.readFileSync(configPath, 'utf-8');
const imageLineRe = /^(\s*image:\s*).*$/m;
if (imageLineRe.test(yaml)) {
  const newYaml = yaml.replace(imageLineRe, `$1${imageTag}`);
  if (newYaml !== yaml) {
    fs.writeFileSync(configPath, newYaml, 'utf-8');
    console.log(`✅ Pinned image in shepherds-pi.yaml -> ${imageTag}`);
  } else {
    console.log(`ℹ️  Image already set to ${imageTag}`);
  }
} else {
  console.warn('⚠️  Could not find an "image:" line in shepherds-pi.yaml to pin.');
}

console.log('\n✅ Sync complete. Your test project is in sync with source.');
