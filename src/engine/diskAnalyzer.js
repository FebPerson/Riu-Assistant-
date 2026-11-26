/**
 * diskAnalyzer.js
 * DeskPilot — Disk Analysis Engine
 *
 * Provides drive enumeration via WMI/CIM, recursive largest-file scanning,
 * Reveal-in-Explorer, and a human-readable byte formatter.
 */

'use strict';

const fs                       = require('fs');
const path                     = require('path');
const { execSync, spawn }      = require('child_process');

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------
/**
 * Convert a raw byte count into a human-readable string.
 *
 * @param {number} bytes - Number of bytes.
 * @returns {string} e.g. "3.14 GB", "512.00 KB"
 */
function formatBytes(bytes) {
  if (bytes === 0 || bytes == null) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp   = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / Math.pow(1024, exp);

  return `${value.toFixed(2)} ${units[exp]}`;
}

// ---------------------------------------------------------------------------
// getDrives
// ---------------------------------------------------------------------------
/**
 * Enumerate fixed (local) drives using the Win32_LogicalDisk WMI class.
 * DriveType 3 = Local Disk.
 *
 * PowerShell command used:
 *   Get-CimInstance Win32_LogicalDisk |
 *     Where-Object {$_.DriveType -eq 3} |
 *     Select-Object DeviceID, Size, FreeSpace, VolumeName |
 *     ConvertTo-Json
 *
 * @returns {Array<{drive:string, label:string, total:number, free:number, used:number, percentUsed:number}>}
 */
function getDrives() {
  const psCommand = [
    `Get-CimInstance Win32_LogicalDisk`,
    `Where-Object {$_.DriveType -eq 3}`,
    `Select-Object DeviceID, Size, FreeSpace, VolumeName`,
    `ConvertTo-Json`,
  ].join(' | ');

  let raw;
  try {
    raw = execSync(`powershell -NoProfile -NonInteractive -Command "${psCommand}"`, {
      windowsHide: true,
      encoding:    'utf8',
      stdio:       'pipe',
    });
  } catch (err) {
    console.error('[diskAnalyzer] getDrives PowerShell error:', err.message);
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (err) {
    console.error('[diskAnalyzer] JSON parse error:', err.message);
    return [];
  }

  // PowerShell returns an object (not array) when only 1 drive is present
  const drives = Array.isArray(parsed) ? parsed : [parsed];

  return drives
    .filter(d => d && d.Size != null)
    .map(d => {
      const total      = Number(d.Size)      || 0;
      const free       = Number(d.FreeSpace) || 0;
      const used       = total - free;
      const percentUsed = total > 0 ? Math.round((used / total) * 100) : 0;

      return {
        drive:       d.DeviceID  || '',
        label:       d.VolumeName || 'Local Disk',
        total,
        free,
        used,
        percentUsed,
        // Human-readable convenience fields
        totalHuman:  formatBytes(total),
        freeHuman:   formatBytes(free),
        usedHuman:   formatBytes(used),
      };
    });
}

// ---------------------------------------------------------------------------
// getLargestFiles
// ---------------------------------------------------------------------------
/**
 * Recursively walk `folderPath` and return the top `limit` largest files.
 * Inaccessible directories are silently skipped.
 *
 * @param {string} folderPath - Root folder to scan.
 * @param {number} [limit=25] - Maximum number of results to return.
 * @returns {Array<{path:string, name:string, size:number, sizeHuman:string, modified:Date}>}
 */
function getLargestFiles(folderPath, limit = 25) {
  const allFiles = [];

  /**
   * Inner recursive helper.
   * @param {string} dir
   */
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (_) {
      // No read permission — skip
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (_) {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        allFiles.push({
          path:     fullPath,
          name:     entry,
          size:     stat.size,
          modified: stat.mtime,
        });
      }
    }
  }

  walk(folderPath);

  // Sort descending by size and take top `limit`
  allFiles.sort((a, b) => b.size - a.size);

  return allFiles.slice(0, limit).map(f => ({
    ...f,
    sizeHuman: formatBytes(f.size),
  }));
}

// ---------------------------------------------------------------------------
// revealInExplorer
// ---------------------------------------------------------------------------
/**
 * Open Windows Explorer with the given file pre-selected.
 *
 * @param {string} filePath - Absolute path of the file to highlight.
 */
function revealInExplorer(filePath) {
  try {
    // /select,<path> highlights the item in its parent folder
    spawn('explorer.exe', [`/select,${filePath}`], {
      detached:   true,
      windowsHide: false,
      stdio:      'ignore',
    }).unref();
  } catch (err) {
    console.error('[diskAnalyzer] revealInExplorer error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  getDrives,
  getLargestFiles,
  revealInExplorer,
  formatBytes,
};
