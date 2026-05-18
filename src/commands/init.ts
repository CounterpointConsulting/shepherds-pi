import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getModuleDir } from '../utils.js';

export interface InitCommandOptions {
  force: boolean;
  copyPersonas: boolean;
  cwd?: string;
}

export async function runInitCommand(options: InitCommandOptions): Promise<number> {
  const cwd = path.resolve(options.cwd ?? process.cwd());

  if (!isGitRepo(cwd)) {
    console.error('❌ Current directory is not a git repository.');
    console.error('   Run this inside your project repo (or run `git init` first).');
    return 1;
  }

  const packageRoot = path.resolve(getModuleDir(import.meta.url), '../..');
  const templatesDir = path.join(packageRoot, 'templates');
  const bundledPersonasDir = path.join(packageRoot, 'personas');

  const templateConfigPath = path.join(templatesDir, 'shepherds-pi.yaml');
  const templateEnvPath = path.join(templatesDir, '.env.example');

  if (!fs.existsSync(templateConfigPath)) {
    console.error(`❌ Missing template file: ${templateConfigPath}`);
    return 1;
  }
  if (!fs.existsSync(templateEnvPath)) {
    console.error(`❌ Missing template file: ${templateEnvPath}`);
    return 1;
  }

  const targetConfigPath = path.join(cwd, 'shepherds-pi.yaml');
  const targetEnvExamplePath = path.join(cwd, '.env.example');
  const targetPersonasDir = path.join(cwd, '.shepherds-pi', 'personas');

  if (fs.existsSync(targetConfigPath) && !options.force) {
    console.error(`❌ ${targetConfigPath} already exists. Use --force to overwrite.`);
    return 1;
  }

  const projectName = path.basename(cwd);
  const defaultBranch = detectDefaultBranch(cwd);

  const rawConfig = fs.readFileSync(templateConfigPath, 'utf-8');
  const renderedConfig = rawConfig
    .replaceAll('__PROJECT_NAME__', projectName)
    .replaceAll('__DEV_BRANCH__', defaultBranch)
    .replaceAll('__MAIN_BRANCH__', defaultBranch);

  fs.writeFileSync(targetConfigPath, renderedConfig, 'utf-8');
  console.log(`✅ Wrote ${targetConfigPath}`);

  if (!fs.existsSync(targetEnvExamplePath) || options.force) {
    const envExample = fs.readFileSync(templateEnvPath, 'utf-8');
    fs.writeFileSync(targetEnvExamplePath, envExample, 'utf-8');
    console.log(`✅ Wrote ${targetEnvExamplePath}`);
  } else {
    console.log(`ℹ️  Kept existing ${targetEnvExamplePath}`);
  }

  if (options.copyPersonas) {
    if (!fs.existsSync(bundledPersonasDir)) {
      console.error(`❌ Bundled personas directory not found: ${bundledPersonasDir}`);
      return 1;
    }

    if (fs.existsSync(targetPersonasDir)) {
      if (options.force) {
        fs.rmSync(targetPersonasDir, { recursive: true, force: true });
        fs.cpSync(bundledPersonasDir, targetPersonasDir, { recursive: true });
        console.log(`✅ Replaced ${targetPersonasDir}`);
      } else {
        console.log(`ℹ️  Kept existing ${targetPersonasDir}`);
      }
    } else {
      fs.mkdirSync(path.dirname(targetPersonasDir), { recursive: true });
      fs.cpSync(bundledPersonasDir, targetPersonasDir, { recursive: true });
      console.log(`✅ Copied personas to ${targetPersonasDir}`);
    }
  } else {
    console.log('ℹ️  Skipped persona copy (--no-personas).');
  }

  ensureGitignoreEntries(path.join(cwd, '.gitignore'), [
    '.shepherds-pi/',
    '.env',
  ]);

  console.log('\nNext steps:');
  console.log('  1) Copy .env.example to .env and fill in credentials');
  console.log('  2) Run shepherds-pi doctor');
  console.log('  3) Run shepherds-pi setup');
  console.log('  4) Run shepherds-pi');

  return 0;
}

function isGitRepo(repoPath: string): boolean {
  try {
    const result = execSync('git rev-parse --is-inside-work-tree', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return result === 'true';
  } catch {
    return false;
  }
}

function detectDefaultBranch(repoPath: string): string {
  const candidates = ['main', 'master', 'dev'];

  for (const branch of candidates) {
    if (hasLocalBranch(repoPath, branch) || hasRemoteBranch(repoPath, branch)) {
      return branch;
    }
  }

  try {
    const current = execSync('git branch --show-current', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (current) return current;
  } catch {
    // ignore
  }

  return 'main';
}

function hasLocalBranch(repoPath: string, branch: string): boolean {
  try {
    execSync(`git show-ref --verify --quiet refs/heads/${branch}`, {
      cwd: repoPath,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function hasRemoteBranch(repoPath: string, branch: string): boolean {
  try {
    execSync(`git show-ref --verify --quiet refs/remotes/origin/${branch}`, {
      cwd: repoPath,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function ensureGitignoreEntries(gitignorePath: string, entries: string[]): void {
  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  }

  let changed = false;
  for (const entry of entries) {
    if (!content.includes(entry)) {
      if (content.length > 0 && !content.endsWith('\n')) content += '\n';
      content += `${entry}\n`;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(gitignorePath, content, 'utf-8');
    console.log(`✅ Updated ${gitignorePath}`);
  }
}
