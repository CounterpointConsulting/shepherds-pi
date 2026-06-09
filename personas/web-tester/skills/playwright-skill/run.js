#!/usr/bin/env node
/**
 * Universal Playwright Executor for Claude Code
 *
 * Executes Playwright automation code from:
 * - File path: node run.js script.js
 * - Inline code: node run.js 'await page.goto("...")'
 * - Stdin: cat script.js | node run.js
 *
 * Ensures proper module resolution by running from skill directory.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Change to skill directory for proper module resolution
process.chdir(__dirname);

// In sandboxed/container runs the skill is mounted read-only and Playwright
// is installed globally (see docker/Dockerfile). Make the global modules dir
// resolvable from this skill dir so `require('playwright')` works even though
// there is no local node_modules.
try {
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  if (globalRoot && fs.existsSync(globalRoot) && !module.paths.includes(globalRoot)) {
    module.paths.push(globalRoot);
    // Propagate to child temp script (which is require()'d below) too.
    process.env.NODE_PATH = process.env.NODE_PATH
      ? `${process.env.NODE_PATH}${path.delimiter}${globalRoot}`
      : globalRoot;
    require('module').Module._initPaths();
  }
} catch (e) {
  // npm not available or no global root — fall back to default resolution.
}

// Writable directory for temp execution scripts. The skill dir itself may be
// mounted read-only, so prefer an explicit tmp dir.
const SKILL_TMP_DIR = process.env.PLAYWRIGHT_SKILL_TMP || os.tmpdir();

// ─── Default Chromium launch hardening ───────────────────────
// Shepherds Pi runs agents inside a locked-down container (CapDrop: ALL,
// no-new-privileges) where Chromium's own sandbox cannot initialize. The
// container is the security boundary, so we launch Chromium with --no-sandbox.
// We patch Playwright's launch entry points here so the flag is applied to
// EVERY launch path — helpers.launchBrowser(), raw chromium.launch(), and
// launchPersistentContext() — without each script having to remember it.
// Set PLAYWRIGHT_SKILL_SANDBOX=1 to opt out and use Chromium's sandbox.
if (process.env.PLAYWRIGHT_SKILL_SANDBOX !== '1') {
  try {
    const pw = require('playwright');
    const SANDBOX_ARGS = ['--no-sandbox', '--disable-setuid-sandbox'];

    const mergeArgs = (opts = {}) => {
      const existing = Array.isArray(opts.args) ? opts.args : [];
      const merged = [...existing];
      for (const a of SANDBOX_ARGS) {
        if (!merged.includes(a)) merged.push(a);
      }
      return { ...opts, args: merged };
    };

    // Only Chromium needs (and accepts) these flags.
    const bt = pw.chromium;
    if (bt) {
      for (const method of ['launch', 'launchPersistentContext']) {
        const original = bt[method];
        if (typeof original === 'function') {
          bt[method] = function (...args) {
            // launch(options) | launchPersistentContext(userDataDir, options)
            if (method === 'launchPersistentContext') {
              args[1] = mergeArgs(args[1] || {});
            } else {
              args[0] = mergeArgs(args[0] || {});
            }
            return original.apply(this, args);
          };
        }
      }
    }
  } catch (e) {
    // Playwright not resolvable yet — the launch will fail later with a clear
    // error from the install check; nothing useful to do here.
  }
}

/**
 * Check if Playwright is installed
 */
function checkPlaywrightInstalled() {
  try {
    require.resolve('playwright');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Install Playwright if missing
 */
function installPlaywright() {
  // In the container the skill dir is read-only and Playwright is preinstalled
  // globally; skip install attempts there.
  if (process.env.PLAYWRIGHT_SKILL_NO_INSTALL === '1') {
    console.error('❌ Playwright is not resolvable and auto-install is disabled.');
    console.error('   Ensure the container image installs playwright globally + browsers.');
    return false;
  }
  console.log('📦 Playwright not found. Installing...');
  try {
    execSync('npm install', { stdio: 'inherit', cwd: __dirname });
    execSync('npx playwright install chromium', { stdio: 'inherit', cwd: __dirname });
    console.log('✅ Playwright installed successfully');
    return true;
  } catch (e) {
    console.error('❌ Failed to install Playwright:', e.message);
    console.error('Please run manually: cd', __dirname, '&& npm run setup');
    return false;
  }
}

/**
 * Get code to execute from various sources
 */
function getCodeToExecute() {
  const args = process.argv.slice(2);

  // Case 1: File path provided
  if (args.length > 0 && fs.existsSync(args[0])) {
    const filePath = path.resolve(args[0]);
    console.log(`📄 Executing file: ${filePath}`);
    return fs.readFileSync(filePath, 'utf8');
  }

  // Case 2: Inline code provided as argument
  if (args.length > 0) {
    console.log('⚡ Executing inline code');
    return args.join(' ');
  }

  // Case 3: Code from stdin
  if (!process.stdin.isTTY) {
    console.log('📥 Reading from stdin');
    return fs.readFileSync(0, 'utf8');
  }

  // No input
  console.error('❌ No code to execute');
  console.error('Usage:');
  console.error('  node run.js script.js          # Execute file');
  console.error('  node run.js "code here"        # Execute inline');
  console.error('  cat script.js | node run.js    # Execute from stdin');
  process.exit(1);
}

/**
 * Clean up old temporary execution files from previous runs
 */
function cleanupOldTempFiles() {
  try {
    const files = fs.readdirSync(SKILL_TMP_DIR);
    const tempFiles = files.filter(f => f.startsWith('.playwright-skill-execution-') && f.endsWith('.js'));

    if (tempFiles.length > 0) {
      tempFiles.forEach(file => {
        const filePath = path.join(SKILL_TMP_DIR, file);
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          // Ignore errors - file might be in use or already deleted
        }
      });
    }
  } catch (e) {
    // Ignore directory read errors
  }
}

/**
 * Wrap code in async IIFE if not already wrapped
 */
function wrapCodeIfNeeded(code) {
  // Check if code already has require() and async structure
  const hasRequire = code.includes('require(');
  const hasAsyncIIFE = code.includes('(async () => {') || code.includes('(async()=>{');

  // If it's already a complete script, return as-is
  if (hasRequire && hasAsyncIIFE) {
    return code;
  }

  // If it's just Playwright commands, wrap in full template
  if (!hasRequire) {
    const helpersPath = JSON.stringify(path.join(__dirname, 'lib', 'helpers'));
    return `
const { chromium, firefox, webkit, devices } = require('playwright');
const helpers = require(${helpersPath});

// Extra headers from environment variables (if configured)
const __extraHeaders = helpers.getExtraHeadersFromEnv();

/**
 * Utility to merge environment headers into context options.
 * Use when creating contexts with raw Playwright API instead of helpers.createContext().
 * @param {Object} options - Context options
 * @returns {Object} Options with extraHTTPHeaders merged in
 */
function getContextOptionsWithHeaders(options = {}) {
  if (!__extraHeaders) return options;
  return {
    ...options,
    extraHTTPHeaders: {
      ...__extraHeaders,
      ...(options.extraHTTPHeaders || {})
    }
  };
}

(async () => {
  try {
    ${code}
  } catch (error) {
    console.error('❌ Automation error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
})();
`;
  }

  // If has require but no async wrapper
  if (!hasAsyncIIFE) {
    return `
(async () => {
  try {
    ${code}
  } catch (error) {
    console.error('❌ Automation error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
})();
`;
  }

  return code;
}

/**
 * Main execution
 */
async function main() {
  console.log('🎭 Playwright Skill - Universal Executor\n');

  // Clean up old temp files from previous runs
  cleanupOldTempFiles();

  // Check Playwright installation
  if (!checkPlaywrightInstalled()) {
    const installed = installPlaywright();
    if (!installed) {
      process.exit(1);
    }
  }

  // Get code to execute
  const rawCode = getCodeToExecute();
  const code = wrapCodeIfNeeded(rawCode);

  // Create temporary file for execution (in a writable dir)
  const tempFile = path.join(SKILL_TMP_DIR, `.playwright-skill-execution-${Date.now()}.js`);

  try {
    // Write code to temp file
    fs.writeFileSync(tempFile, code, 'utf8');

    // Execute the code
    console.log('🚀 Starting automation...\n');
    require(tempFile);

    // Note: Temp file will be cleaned up on next run
    // This allows long-running async operations to complete safely

  } catch (error) {
    console.error('❌ Execution failed:', error.message);
    if (error.stack) {
      console.error('\n📋 Stack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run main function
main().catch(error => {
  console.error('❌ Fatal error:', error.message);
  process.exit(1);
});
