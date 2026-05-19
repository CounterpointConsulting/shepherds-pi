#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runInitCommand } from './commands/init.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runSetupCommand } from './commands/setup.js';
import { loadConfig } from './config/index.js';
import { resolveConfigPath } from './config/resolve-config.js';
import { getModuleDir } from './utils.js';

interface CommonArgs {
  configPath?: string;
  help: boolean;
  version: boolean;
  unknown: string[];
}

interface RuntimeArgs {
  configPath?: string;
  help: boolean;
  version: boolean;
  passthrough: string[];
  unknown: string[];
}

interface InitArgs extends CommonArgs {
  force: boolean;
  noPersonas: boolean;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (argv.length > 0 && (first === '--help' || first === '-h' || first === 'help')) {
    printUsage();
    return;
  }

  if (argv.length > 0 && (first === '--version' || first === '-v' || first === 'version')) {
    console.log(getVersion());
    return;
  }

  if (first === 'init') {
    const parsed = parseInitArgs(argv.slice(1));
    if (parsed.version) {
      console.log(getVersion());
      return;
    }
    if (parsed.help) {
      printInitUsage();
      return;
    }
    if (parsed.unknown.length > 0) {
      console.error(`Unknown init args: ${parsed.unknown.join(' ')}`);
      printInitUsage();
      process.exitCode = 1;
      return;
    }

    process.exitCode = await runInitCommand({
      force: parsed.force,
      copyPersonas: !parsed.noPersonas,
    });
    return;
  }

  if (first === 'doctor') {
    const parsed = parseCommonArgs(argv.slice(1));
    if (parsed.version) {
      console.log(getVersion());
      return;
    }
    if (parsed.help) {
      printDoctorUsage();
      return;
    }
    if (parsed.unknown.length > 0) {
      console.error(`Unknown doctor args: ${parsed.unknown.join(' ')}`);
      printDoctorUsage();
      process.exitCode = 1;
      return;
    }

    process.exitCode = await runDoctorCommand({
      configPath: parsed.configPath,
    });
    return;
  }

  if (first === 'setup') {
    const parsed = parseCommonArgs(argv.slice(1));
    if (parsed.version) {
      console.log(getVersion());
      return;
    }
    if (parsed.help) {
      printSetupUsage();
      return;
    }
    if (parsed.unknown.length > 0) {
      console.error(`Unknown setup args: ${parsed.unknown.join(' ')}`);
      printSetupUsage();
      process.exitCode = 1;
      return;
    }

    process.exitCode = await runSetupCommand({
      configPath: parsed.configPath,
    });
    return;
  }

  const parsed = parseRuntimeArgs(argv);
  if (parsed.version) {
    console.log(getVersion());
    return;
  }
  if (parsed.help) {
    printUsage();
    return;
  }
  if (parsed.unknown.length > 0) {
    console.error(`Unknown args: ${parsed.unknown.join(' ')}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  process.exitCode = await runCoordinatorPi(parsed.configPath, parsed.passthrough);
}

async function runCoordinatorPi(configPathArg: string | undefined, passthrough: string[]): Promise<number> {
  const resolvedConfigPath = resolveConfigPath({ configPath: configPathArg });
  const config = loadConfig(resolvedConfigPath);

  const moduleDir = getModuleDir(import.meta.url);
  const packageRoot = path.resolve(moduleDir, '..');
  const preferDistAssets = path.basename(moduleDir) === 'dist';
  const piCliPath = path.join(packageRoot, 'node_modules', '@mariozechner', 'pi-coding-agent', 'dist', 'cli.js');

  if (!fs.existsSync(piCliPath)) {
    throw new Error(`Could not find pi CLI at ${piCliPath}`);
  }

  const coordinatorPromptPath = resolveCoordinatorPromptPath(packageRoot, preferDistAssets);
  const coordinatorPrompt = fs.readFileSync(coordinatorPromptPath, 'utf-8');

  const extensionPath = resolveExtensionPath(packageRoot, preferDistAssets);

  const piArgs = [
    piCliPath,
    '--system-prompt', coordinatorPrompt,
    '--no-builtin-tools',
    '--no-extensions',
    '--extension', extensionPath,
    '--model', config.coordinator.model,
    '--thinking', config.coordinator.thinkingLevel,
    ...passthrough,
  ];

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, piArgs, {
      stdio: 'inherit',
      env: {
        ...process.env,
        SHEPHERDS_PI_CONFIG: resolvedConfigPath,
      },
    });

    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function resolveCoordinatorPromptPath(packageRoot: string, preferDistAssets: boolean): string {
  const candidates = preferDistAssets
    ? [
      path.join(packageRoot, 'dist', 'orchestrator', 'coordinator.md'),
      path.join(packageRoot, 'src', 'orchestrator', 'coordinator.md'),
    ]
    : [
      path.join(packageRoot, 'src', 'orchestrator', 'coordinator.md'),
      path.join(packageRoot, 'dist', 'orchestrator', 'coordinator.md'),
    ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`Could not locate coordinator prompt. Checked:\n- ${candidates.join('\n- ')}`);
}

function resolveExtensionPath(packageRoot: string, preferDistAssets: boolean): string {
  const candidates = preferDistAssets
    ? [
      path.join(packageRoot, 'dist', 'extensions', 'shepherds', 'index.js'),
      path.join(packageRoot, 'src', 'extensions', 'shepherds', 'index.ts'),
    ]
    : [
      path.join(packageRoot, 'src', 'extensions', 'shepherds', 'index.ts'),
      path.join(packageRoot, 'dist', 'extensions', 'shepherds', 'index.js'),
    ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`Could not locate Shepherds Pi extension entrypoint. Checked:\n- ${candidates.join('\n- ')}`);
}

function parseCommonArgs(args: string[]): CommonArgs {
  let configPath: string | undefined;
  let help = false;
  let version = false;
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--config' || arg === '-c') {
      const value = args[i + 1];
      if (!value) {
        unknown.push(arg);
      } else {
        configPath = value;
        i += 1;
      }
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--version' || arg === '-v') {
      version = true;
      continue;
    }

    unknown.push(arg);
  }

  return { configPath, help, version, unknown };
}

function parseRuntimeArgs(args: string[]): RuntimeArgs {
  let configPath: string | undefined;
  let help = false;
  let version = false;
  const passthrough: string[] = [];
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--config' || arg === '-c') {
      const value = args[i + 1];
      if (!value) {
        unknown.push(arg);
      } else {
        configPath = value;
        i += 1;
      }
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--version' || arg === '-v') {
      version = true;
      continue;
    }

    passthrough.push(arg);
  }

  return { configPath, help, version, passthrough, unknown };
}

function parseInitArgs(args: string[]): InitArgs {
  const base = parseCommonArgs(args);
  let force = false;
  let noPersonas = false;
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--force') {
      force = true;
      continue;
    }

    if (arg === '--no-personas') {
      noPersonas = true;
      continue;
    }

    if (arg === '--config' || arg === '-c') {
      i += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v') {
      continue;
    }

    unknown.push(arg);
  }

  return {
    ...base,
    force,
    noPersonas,
    unknown: [...new Set([
      ...base.unknown.filter(x => x !== '--force' && x !== '--no-personas'),
      ...unknown,
    ])],
  };
}

function getVersion(): string {
  try {
    const packageJsonPath = path.resolve(getModuleDir(import.meta.url), '../package.json');
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function printUsage(): void {
  console.log(`Shepherds Pi\n\nUsage:\n  shepherds-pi [--config <path>] [pi args...]\n  shepherds-pi init [--force] [--no-personas]\n  shepherds-pi doctor [--config <path>]\n  shepherds-pi setup [--config <path>]\n  shepherds-pi --help\n  shepherds-pi --version\n\nDefault mode:\n  Launches pi with the Shepherds coordinator system prompt and the\n  Shepherds orchestration extension tools enabled. Any extra args are\n  passed through to pi.\n\nCommands:\n  init      Scaffold shepherds-pi.yaml, .env.example, and default personas\n  doctor    Validate prerequisites and configuration\n  setup     Pull/build the configured Docker agent image\n\nConfig resolution order:\n  1) --config <path>\n  2) SHEPHERDS_PI_CONFIG env var\n  3) nearest shepherds-pi.yaml by walking up from CWD\n`);
}

function printInitUsage(): void {
  console.log(`Usage: shepherds-pi init [--force] [--no-personas]\n\nOptions:\n  --force         Overwrite existing scaffold files\n  --no-personas   Skip copying bundled personas into ./.shepherds-pi/personas\n`);
}

function printDoctorUsage(): void {
  console.log(`Usage: shepherds-pi doctor [--config <path>]`);
}

function printSetupUsage(): void {
  console.log(`Usage: shepherds-pi setup [--config <path>]`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`❌ ${msg}`);
  process.exitCode = 1;
});
