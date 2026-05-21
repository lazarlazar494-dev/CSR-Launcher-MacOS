/**
 * crossover.js — CrossOver integration for CSR Launcher
 *
 * Launches csr.exe (a Windows binary) inside a named CrossOver bottle via
 * Wine, with DXVK enabled so that Direct3D 9/10/11 calls are translated to
 * Vulkan → Metal via MoltenVK (CrossOver's built-in Vulkan layer).
 *
 * Why wine directly instead of the CrossOver GUI binary?
 *   /Applications/CrossOver.app/Contents/MacOS/CrossOver is the GUI app —
 *   it ignores CLI flags and just opens a window.  The correct headless
 *   launchers are `cxrun` (high-level) or `wine` (low-level, gives full
 *   env-var control needed for DXVK).  We prefer wine so we can set
 *   WINEDLLOVERRIDES and MoltenVK variables precisely.
 *
 * DXVK on macOS (CrossOver) works like this:
 *   csr.exe calls D3D9/D3D11 → DXVK DLLs intercept → emit Vulkan calls →
 *   MoltenVK translates Vulkan → Metal API → GPU renders.
 *
 *   For this chain to work you need:
 *     1. WINEDLLOVERRIDES telling Wine to use DXVK's native d3d DLLs
 *     2. VK_ICD_FILENAMES pointing at CrossOver's MoltenVK ICD
 *     3. No -gl or -dxlevel flags (they bypass D3D → break DXVK)
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// CrossOver installation paths
// ---------------------------------------------------------------------------

const CROSSOVER_APP   = '/Applications/CrossOver.app';
const CROSSOVER_SHARE = path.join(CROSSOVER_APP, 'Contents/SharedSupport/CrossOver');

// Primary headless launcher.  Prefer wine for env-var control; fall back to
// cxrun if the wine binary isn't where we expect (future CrossOver layouts).
const WINE_BIN  = path.join(CROSSOVER_SHARE, 'bin/wine');
const CXRUN_BIN = path.join(CROSSOVER_APP,   'Contents/MacOS/cxrun');

// MoltenVK ICD — tells the Vulkan loader to use CrossOver's Metal driver.
// Without this, DXVK can't find Vulkan and falls back / crashes.
const MOLTENVK_ICD = path.join(
  CROSSOVER_SHARE,
  'lib/MoltenVK/MoltenVK_icd.json'
);

// ---------------------------------------------------------------------------
// Helper: derive WINEPREFIX from an exe path that lives inside a bottle
// ---------------------------------------------------------------------------

/**
 * Given a macOS path like:
 *   ~/Library/Application Support/CrossOver/Bottles/Steam/drive_c/game/csr.exe
 * returns the bottle root:
 *   ~/Library/Application Support/CrossOver/Bottles/Steam
 *
 * Returns null if the path doesn't contain drive_c (not inside a bottle).
 */
function bottlePrefixFromPath(exePath) {
  const parts = exePath.split(path.sep);
  const idx   = parts.lastIndexOf('drive_c');
  if (idx === -1) return null;
  return parts.slice(0, idx).join(path.sep) || path.sep;
}

/**
 * Returns the default bottle path for a named CrossOver bottle.
 */
function defaultBottlePath(bottleName) {
  return path.join(
    os.homedir(),
    'Library/Application Support/CrossOver/Bottles',
    bottleName
  );
}

// ---------------------------------------------------------------------------
// Helper: macOS path → Wine "C:\" Windows path
// ---------------------------------------------------------------------------

/**
 * Converts a macOS path inside a bottle's drive_c to a Wine Windows path.
 *
 *   .../Bottles/Steam/drive_c/game/csr.exe  →  C:\game\csr.exe
 *
 * Wine needs the Windows-style path as its first argument.
 */
function toWinPath(macPath) {
  const parts    = macPath.split(path.sep);
  const driveIdx = parts.lastIndexOf('drive_c');
  if (driveIdx === -1) {
    // Not inside a bottle drive — pass as-is and let Wine figure it out.
    return macPath;
  }
  const relative = parts.slice(driveIdx + 1).join('\\');
  return `C:\\${relative}`;
}

// ---------------------------------------------------------------------------
// Helper: strip launch flags that conflict with DXVK
// ---------------------------------------------------------------------------

/**
 * Removes flags that bypass or conflict with DXVK:
 *
 *   -gl          Forces OpenGL mode — D3D is never called, DXVK never runs.
 *   -d3d9ex      Enables D3D9Ex extensions in Wine's own D3D, not DXVK's.
 *   -dxlevel N   Overrides the D3D feature level — interferes with DXVK's
 *                own negotiation and can trigger "unsupported DX level" crashes.
 *   -autoconfig  Resets video settings on next launch (wipes our DX config).
 */
const CONFLICTING_FLAGS = new Set(['-gl', '-d3d9ex', '-autoconfig']);

function stripConflictingArgs(args) {
  const out = [];
  let skip = false;
  for (const arg of args) {
    if (skip) { skip = false; continue; }
    if (CONFLICTING_FLAGS.has(arg)) continue;
    if (arg === '-dxlevel') { skip = true; continue; } // drop value too
    out.push(arg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Launches a Windows executable inside a CrossOver bottle with DXVK active.
 *
 * @param {string}   exePath    - macOS filesystem path to the .exe file.
 * @param {string[]} args       - Extra launch arguments (passed after the exe).
 * @param {string}   bottleName - CrossOver bottle name (default: "Steam").
 * @returns {import('child_process').ChildProcess}
 */
function launchInCrossOver(exePath, args = [], bottleName = 'Steam') {
  // ------------------------------------------------------------------
  // 1. Resolve WINEPREFIX (the bottle directory Wine uses as C:\)
  // ------------------------------------------------------------------
  let winePrefix = bottlePrefixFromPath(exePath);

  if (!winePrefix || !fs.existsSync(winePrefix)) {
    // exe isn't inside a drive_c path (user set a custom path outside the
    // bottle) — fall back to the named bottle's default location.
    winePrefix = defaultBottlePath(bottleName);
    console.warn(
      `[CrossOver] Could not derive bottle from exe path; ` +
      `using default bottle at: ${winePrefix}`
    );
  }

  if (!fs.existsSync(winePrefix)) {
    const msg = `[CrossOver] Bottle not found: ${winePrefix}. ` +
                `Ensure CrossOver is installed and the "${bottleName}" bottle exists.`;
    console.error(msg);
    throw new Error(msg);
  }

  // ------------------------------------------------------------------
  // 2. Build the Wine Windows path for the exe
  // ------------------------------------------------------------------
  const winExePath = toWinPath(exePath);
  const gameCwd    = path.dirname(exePath); // macOS dir — valid for spawn cwd

  // ------------------------------------------------------------------
  // 3. Strip flags that break DXVK
  // ------------------------------------------------------------------
  const cleanArgs = stripConflictingArgs(args);

  // ------------------------------------------------------------------
  // 4. Build environment
  // ------------------------------------------------------------------

  // MoltenVK ICD path — use CrossOver's bundled one if present, otherwise
  // leave VK_ICD_FILENAMES unset and trust the system loader.
  const moltenvkIcd = fs.existsSync(MOLTENVK_ICD) ? MOLTENVK_ICD : undefined;

  const env = {
    ...process.env,
    cwd: path.dirname(exePath),

    // Wine / bottle config
    WINEPREFIX: winePrefix,
    WINEARCH:   'win64',
    WINEDEBUG:  '-all',             // silence most Wine debug noise

    // DXVK — override Wine's own D3D stubs with DXVK's native DLLs.
    // 'n' = native (i.e. DXVK's DLL), 'b' = built-in Wine fallback.
    // CS:GO / CSR primarily uses D3D9; d3d11+dxgi cover any D3D10/11 paths.
    WINEDLLOVERRIDES: [
      'd3d9=n,b',
      'd3d10=n,b',
      'd3d10core=n,b',
      'd3d10_1=n,b',
      'd3d11=n,b',
      'dxgi=n,b',
    ].join(';'),

    // DXVK runtime options
    DXVK_LOG_LEVEL:    'warn',      // 'none' | 'warn' | 'info' | 'debug'
    DXVK_STATE_CACHE:  '1',         // persistent shader cache → less stutter
    DXVK_ENABLE_NVAPI: '0',         // disable NVAPI (not relevant on Mac)
    DXVK_ASYNC:        '1',         // async shader compilation — reduces hitching
                                    // (CrossOver's DXVK fork supports this)

    // MoltenVK — Vulkan-on-Metal driver bundled with CrossOver.
    // Without VK_ICD_FILENAMES the Vulkan loader can't find the Metal driver
    // and DXVK fails with "VK_ERROR_INCOMPATIBLE_DRIVER".
    ...(moltenvkIcd ? { VK_ICD_FILENAMES: moltenvkIcd } : {}),

    // MoltenVK performance / compatibility tweaks
    MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS: '2', // required for Tier-2 argument buffers
    MVK_ALLOW_METAL_FENCES:                '1',
    MVK_CONFIG_RESUME_LOST_DEVICE:         '1', // auto-recover from GPU device loss
    MVK_CONFIG_PREFILL_METAL_COMMAND_ENCODERS: '1',
  };

  // ------------------------------------------------------------------
  // 5. Choose launcher binary
  //    wine  → full env-var control, needed for DXVK (preferred)
  //    cxrun → CrossOver high-level wrapper, good fallback
  // ------------------------------------------------------------------
  let bin, spawnArgs;

  if (fs.existsSync(WINE_BIN)) {
    bin       = WINE_BIN;
    spawnArgs = [winExePath, ...cleanArgs];
    console.log('[CrossOver] Using wine binary:', WINE_BIN);
  } else if (fs.existsSync(CXRUN_BIN)) {
    // cxrun doesn't honour WINEDLLOVERRIDES as reliably, but it's better
    // than nothing if the wine binary isn't where we expect.
    bin       = CXRUN_BIN;
    spawnArgs = ['--bottle', bottleName, '--cx-app', winExePath, ...cleanArgs];
    console.warn('[CrossOver] wine binary not found; falling back to cxrun. ' +
                 'DXVK env overrides may not take effect.');
  } else {
    const msg = `[CrossOver] Neither wine nor cxrun found. ` +
                `Is CrossOver installed at ${CROSSOVER_APP}?`;
    console.error(msg);
    throw new Error(msg);
  }

  console.log('[CrossOver] WINEPREFIX :', winePrefix);
  console.log('[CrossOver] exe (win)  :', winExePath);
  console.log('[CrossOver] args       :', cleanArgs.join(' '));
  console.log('[CrossOver] DXVK dlls :', env.WINEDLLOVERRIDES);
  if (moltenvkIcd) {
    console.log('[CrossOver] MoltenVK  :', moltenvkIcd);
  } else {
    console.warn('[CrossOver] MoltenVK ICD not found at expected path; ' +
                 'relying on system Vulkan loader.');
  }

  // ------------------------------------------------------------------
  // 6. Spawn
  // ------------------------------------------------------------------
  console.log('Launching EXE:', exePath);
const child = spawn(bin, spawnArgs, {
    cwd:      gameCwd,
    env,
    stdio:    ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Log stdout (usually empty for a game, but useful for DXVK init messages)
  child.stdout?.on('data', (d) => {
    const line = d.toString().trim();
    if (line) console.log('[CrossOver] stdout:', line);
  });

  // Filter Wine/DXVK stderr: drop 'fixme:' spam, log everything else
  child.stderr?.on('data', (d) => {
    const lines = d.toString().split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Suppress noisy-but-harmless Wine fixme messages
      if (/^fixme:/i.test(trimmed)) continue;
      // Suppress generic Wine loader noise
      if (/^wine:/i.test(trimmed) && !/error/i.test(trimmed)) continue;
      console.error('[CrossOver] stderr:', trimmed);
    }
  });

  child.on('error', (err) => {
    console.error('[CrossOver] Spawn error:', err.message);
  });

  child.on('exit', (code, signal) => {
    console.log(`[CrossOver] Process exited — code: ${code ?? 'null'}, signal: ${signal ?? 'none'}`);
  });

  return child;
}

module.exports = { launchInCrossOver };
