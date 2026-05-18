#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { runTui } from './index.js';
import { runInitCommand } from './commands/init.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runSetupCommand } from './commands/setup.js';
import { getModuleDir } from './utils.js';

interface CommonArgs {
  configPath?: string;
  help: boolean;
  version: boolean;
  unknown: string[];
}

interface InitArgs extends CommonArgs {
  force: boolean;
  noPersonas: boolean;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    runTui();
    return;
  }

  const first = argv[0];

  if (first === '--help' || first === '-h' || first === 'help') {
    printUsage();
    return;
  }

  if (first === '--version' || first === '-v' || first === 'version') {
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

  // Default mode: run TUI and allow global flags without an explicit command.
  const parsed = parseCommonArgs(argv);
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

  runTui({ configPath: parsed.configPath });
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
  console.log(`Shepherds Pi\n\nUsage:\n  shepherds-pi [--config <path>]\n  shepherds-pi init [--force] [--no-personas]\n  shepherds-pi doctor [--config <path>]\n  shepherds-pi setup [--config <path>]\n  shepherds-pi --help\n  shepherds-pi --version\n\nCommands:\n  init      Scaffold shepherds-pi.yaml, .env.example, and default personas\n  doctor    Validate prerequisites and configuration\n  setup     Pull/build the configured Docker agent image\n\nConfig resolution order:\n  1) --config <path>\n  2) SHEPHERDS_PI_CONFIG env var\n  3) nearest shepherds-pi.yaml by walking up from CWD\n`);
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
