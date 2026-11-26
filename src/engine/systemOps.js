/**
 * systemOps.js
 * DeskPilot — System Operations Engine
 *
 * Provides real-time system metrics (RAM/CPU/Battery), temp-file cleaning,
 * Recycle Bin emptying, workstation locking, volume control, and app launching
 * — all implemented via Node.js built-ins and Windows PowerShell / Win32 APIs.
 */

'use strict';

const fs                            = require('fs');
const path                          = require('path');
const os                            = require('os');
const { execSync, exec, spawn }     = require('child_process');

// ---------------------------------------------------------------------------
// Internal CPU & Memory Tracker
// ---------------------------------------------------------------------------
function _getCpuTimes() {
  const cpus = os.cpus() || [];
  let idle = 0, total = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      total += cpu.times[type];
    }
    idle += cpu.times.idle;
  }
  return { idle, total };
}

let _prevCpuTimes = _getCpuTimes();

function _calculateCpuLoad() {
  const current = _getCpuTimes();
  const idleDiff = current.idle - _prevCpuTimes.idle;
  const totalDiff = current.total - _prevCpuTimes.total;
  _prevCpuTimes = current;

  if (totalDiff <= 0) return 10;
  const load = Math.round(100 - (100 * idleDiff / totalDiff));
  return Math.min(Math.max(load, 0), 100);
}

function _getRamMetrics() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);
  const percent = total > 0 ? Math.round((used / total) * 100) : 0;
  return { total, used, free, percent };
}

let _cachedBattery = { charge: null, status: null, hasBattery: false, isCharging: false };
let _lastBatteryCheck = 0;

// ---------------------------------------------------------------------------
// Internal PowerShell runner
// ---------------------------------------------------------------------------
/**
 * Run a PowerShell command synchronously and return its stdout as a string.
 * Returns null on error.
 *
 * @param {string} command - PowerShell command string.
 * @returns {string|null}
 */
function _ps(command) {
  try {
    return execSync(
      `powershell -NoProfile -NonInteractive -Command "${command}"`,
      { windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout: 5000 }
    ).trim();
  } catch (err) {
    console.error('[systemOps] PowerShell error:', err.message);
    return null;
  }
}

function _getBatteryMetrics() {
  const now = Date.now();
  // Check battery every 20 seconds to avoid unnecessary calls
  if (now - _lastBatteryCheck < 20000 && _lastBatteryCheck > 0) {
    return _cachedBattery;
  }
  _lastBatteryCheck = now;

  try {
    const batRaw = _ps(
      'Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json'
    );
    if (batRaw && batRaw.trim() !== '') {
      const b = JSON.parse(batRaw);
      const first = Array.isArray(b) ? b[0] : b;
      if (first && first.EstimatedChargeRemaining != null) {
        _cachedBattery = {
          charge:     Number(first.EstimatedChargeRemaining),
          status:     first.BatteryStatus ?? null,
          hasBattery: true,
          isCharging: first.BatteryStatus === 2 || first.BatteryStatus === 6 || first.BatteryStatus === 7 || first.BatteryStatus === 8
        };
        return _cachedBattery;
      }
    }
  } catch (_) { /* leave defaults */ }

  _cachedBattery = { charge: null, status: null, hasBattery: false, isCharging: false };
  return _cachedBattery;
}

// ---------------------------------------------------------------------------
// getMetrics
// ---------------------------------------------------------------------------
/**
 * Query RAM, CPU, and battery status and return a unified object with
 * both nested and flat schemas for maximum frontend compatibility.
 */
function getMetrics() {
  const ram = _getRamMetrics();
  const cpuLoad = _calculateCpuLoad();
  const battery = _getBatteryMetrics();

  return {
    // Nested structure
    ram,
    cpu: { load: cpuLoad },
    battery,

    // Flat structure (directly used by app.js)
    cpu: cpuLoad,
    cpuLoad,
    cpuPercent: cpuLoad,
    ramPercent: ram.percent,
    ramTotal: ram.total,
    ramUsed: ram.used,
    ramFree: ram.free,
    battery: battery.charge,
    batteryPercent: battery.charge,
    hasBattery: battery.hasBattery,
    batteryCharging: battery.isCharging
  };
}

// ---------------------------------------------------------------------------
// cleanTemp
// ---------------------------------------------------------------------------
/**
 * Delete all items inside the user's TEMP directory.
 * Files that are locked or in use are silently skipped.
 *
 * @returns {{ cleaned: number, skipped: number, freedBytes: number }}
 */
function cleanTemp() {
  const tempDir = process.env.TEMP || process.env.TMP || path.join(require('os').tmpdir());
  let cleaned   = 0;
  let skipped   = 0;
  let freedBytes = 0;

  let entries;
  try {
    entries = fs.readdirSync(tempDir);
  } catch (err) {
    console.error('[systemOps] Cannot read TEMP directory:', err.message);
    return { cleaned, skipped, freedBytes };
  }

  for (const entry of entries) {
    const fullPath = path.join(tempDir, entry);

    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (_) {
      skipped++;
      continue;
    }

    try {
      if (stat.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(fullPath);
      }
      cleaned++;
      freedBytes += stat.size || 0;
    } catch (_) {
      // File locked / in use — skip
      skipped++;
    }
  }

  return { cleaned, skipped, freedBytes };
}

// ---------------------------------------------------------------------------
// emptyRecycleBin
// ---------------------------------------------------------------------------
/**
 * Empty the Windows Recycle Bin using PowerShell.
 * -ErrorAction SilentlyContinue ensures the call succeeds even if the bin
 * is already empty or the user lacks permissions for certain items.
 */
function emptyRecycleBin() {
  _ps('Clear-RecycleBin -Force -ErrorAction SilentlyContinue');
}

// ---------------------------------------------------------------------------
// lockWorkstation
// ---------------------------------------------------------------------------
/**
 * Lock the Windows workstation immediately.
 * Uses the standard LockWorkStation Win32 API via rundll32.
 */
function lockWorkstation() {
  exec('rundll32.exe user32.dll,LockWorkStation', (err) => {
    if (err) console.error('[systemOps] lockWorkstation error:', err.message);
  });
}

// ---------------------------------------------------------------------------
// volumeControl
// ---------------------------------------------------------------------------
/**
 * Adjust the system volume using Windows media key codes via WScript.Shell.
 *
 * Key codes:
 *   173 — Toggle Mute
 *   174 — Volume Down
 *   175 — Volume Up
 *
 * @param {'up'|'down'|'mute'} action
 */
function volumeControl(action) {
  const keyMap = { up: 175, down: 174, mute: 173 };
  const keyCode = keyMap[action];

  if (keyCode == null) {
    console.warn(`[systemOps] Unknown volume action "${action}"`);
    return;
  }

  const psCommand = [
    `$wsh = New-Object -ComObject WScript.Shell`,
    `$wsh.SendKeys([char]${keyCode})`,
  ].join('; ');

  _ps(psCommand);
}

// ---------------------------------------------------------------------------
// launchApp (Universal Windows App Launcher)
// ---------------------------------------------------------------------------

let _cachedShortcuts = null;
let _lastShortcutScan = 0;

/**
 * Scan Windows Start Menu folders to discover all installed application shortcuts (.lnk).
 * Results are cached for 60 seconds for near-instant lookup.
 *
 * @param {string} query
 * @returns {Array<{name: string, path: string}>}
 */
function _findShortcuts(query) {
  const now = Date.now();
  if (!_cachedShortcuts || (now - _lastShortcutScan > 60000)) {
    const list = [];
    const dirs = [
      'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
      path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    ];

    for (const d of dirs) {
      if (!fs.existsSync(d)) continue;
      function walk(dir) {
        try {
          const files = fs.readdirSync(dir, { withFileTypes: true });
          for (const f of files) {
            const full = path.join(dir, f.name);
            if (f.isDirectory()) {
              walk(full);
            } else if (f.name.toLowerCase().endsWith('.lnk')) {
              list.push({
                name: f.name.replace(/\.lnk$/i, ''),
                cleanName: f.name.replace(/\.lnk$/i, '').toLowerCase().replace(/[\s\-_]+/g, ''),
                path: full,
              });
            }
          }
        } catch (_) {}
      }
      walk(d);
    }
    _cachedShortcuts = list;
    _lastShortcutScan = now;
  }

  const cleanQuery = query.toLowerCase().replace(/[\s\-_]+/g, '');
  if (!cleanQuery) return [];

  // Match exact clean name or substring
  return _cachedShortcuts.filter(item =>
    item.cleanName === cleanQuery || item.cleanName.includes(cleanQuery)
  );
}

/**
 * Launch ANY named application on Windows by direct executable, alias,
 * protocol, or Start Menu shortcut.
 *
 * Supports commands like:
 *   "notepad", "calc", "chrome", "vscode", "spotify", "whatsapp",
 *   "word", "excel", "edge", "settings", "paint", "discord", etc.
 *
 * @param {string} rawName - Name of the application to open.
 * @returns {{ success: boolean, app: string, target?: string, error?: string }}
 */
function launchApp(rawName) {
  if (!rawName || typeof rawName !== 'string') {
    return { success: false, app: '', error: 'App name is required.' };
  }

  // Clean the input (e.g. "open Google Chrome" -> "google chrome")
  let name = rawName.trim().toLowerCase();
  name = name.replace(/^(?:open|launch|start|run)\s+(?:the\s+)?/i, '').trim();

  // 1. Direct App Aliases Map
  const APP_MAP = {
    notepad:              'notepad.exe',
    calc:                 'calc.exe',
    calculator:           'calc.exe',
    explorer:             'explorer.exe',
    files:                'explorer.exe',
    'file explorer':      'explorer.exe',
    cmd:                  'cmd.exe',
    terminal:             'cmd.exe',
    'windows terminal':   'wt.exe',
    powershell:           'powershell.exe',
    chrome:               'chrome',
    'google chrome':      'chrome',
    edge:                 'msedge',
    'microsoft edge':     'msedge',
    vscode:               'code',
    'vs code':            'code',
    code:                 'code',
    'visual studio code': 'code',
    paint:                'mspaint.exe',
    mspaint:              'mspaint.exe',
    taskmgr:              'taskmgr.exe',
    'task manager':       'taskmgr.exe',
    settings:             'ms-settings:',
    'windows settings':   'ms-settings:',
    control:              'control.exe',
    'control panel':      'control.exe',
    spotify:              'spotify:',
    discord:              'discord:',
    steam:                'steam:',
    word:                 'winword',
    'ms word':            'winword',
    excel:                'excel',
    'ms excel':           'excel',
    powerpoint:           'powerpnt',
    'snipping tool':      'snippingtool.exe',
    snippingtool:         'snippingtool.exe',
    snip:                 'snippingtool.exe',
    regedit:              'regedit.exe',
    registry:             'regedit.exe',
    vlc:                  'vlc',
    brave:                'brave',
    firefox:              'firefox',
    whatsapp:             'whatsapp:',
    telegram:             'telegram:',
  };

  const target = APP_MAP[name];
  if (target) {
    try {
      spawn('cmd.exe', ['/c', 'start', '', target], {
        detached:    true,
        stdio:       'ignore',
        windowsHide: true,
      }).unref();
      return { success: true, app: name, target };
    } catch (err) {
      console.warn(`[systemOps] Failed to launch direct alias "${name}":`, err.message);
    }
  }

  // 2. Check Windows Start Menu shortcuts
  const shortcuts = _findShortcuts(name);
  if (shortcuts.length > 0) {
    const bestMatch = shortcuts[0];
    try {
      spawn('cmd.exe', ['/c', 'start', '', bestMatch.path], {
        detached:    true,
        stdio:       'ignore',
        windowsHide: true,
      }).unref();
      return { success: true, app: bestMatch.name, target: bestMatch.path };
    } catch (err) {
      console.warn(`[systemOps] Failed to launch shortcut "${bestMatch.path}":`, err.message);
    }
  }

  // 3. Fallback: Try generic Windows start command
  try {
    spawn('cmd.exe', ['/c', 'start', '', name], {
      detached:    true,
      stdio:       'ignore',
      windowsHide: true,
    }).unref();
    return { success: true, app: name, target: name };
  } catch (err) {
    console.error(`[systemOps] launchApp error for "${name}":`, err.message);
    return { success: false, app: name, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  getMetrics,
  cleanTemp,
  emptyRecycleBin,
  lockWorkstation,
  volumeControl,
  launchApp,
};
