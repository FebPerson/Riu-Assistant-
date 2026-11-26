/**
 * duplicateFinder.js
 * DeskPilot — Duplicate File Finder Engine
 *
 * Uses a 3-phase algorithm (size → header hash → full hash) to efficiently
 * identify duplicate files and optionally recycle them via the Windows
 * Recycle Bin using PowerShell / VisualBasic FileSystem API.
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const crypto        = require('crypto');
const { execSync }  = require('child_process');

// Minimum file size to consider (1 KB). Files smaller than this are ignored.
const MIN_SIZE = 1024;

// Number of bytes read for the header (phase-2) hash.
const HEADER_BYTES = 4096;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively walk a directory tree and return all file paths.
 * Directories that cannot be read (permissions, etc.) are silently skipped.
 *
 * @param {string}   dirPath    - Root directory to walk.
 * @param {Function} [onError]  - Optional callback(err, filePath) for errors.
 * @returns {Array<{filePath:string, size:number, modified:Date}>}
 */
function _walkDir(dirPath, onError) {
  const results = [];

  let entries;
  try {
    entries = fs.readdirSync(dirPath);
  } catch (err) {
    if (typeof onError === 'function') onError(err, dirPath);
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);

    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (err) {
      if (typeof onError === 'function') onError(err, fullPath);
      continue;
    }

    if (stat.isDirectory()) {
      // Recurse into sub-directory
      const sub = _walkDir(fullPath, onError);
      results.push(...sub);
    } else if (stat.isFile() && stat.size >= MIN_SIZE) {
      results.push({ filePath: fullPath, size: stat.size, modified: stat.mtime });
    }
  }

  return results;
}

/**
 * Read up to `byteCount` bytes from `filePath` and return an MD5 hex digest.
 *
 * @param {string} filePath
 * @param {number} byteCount
 * @returns {string|null} MD5 hex string, or null on read error.
 */
function _hashPartial(filePath, byteCount) {
  try {
    const buffer = Buffer.alloc(byteCount);
    const fd     = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, byteCount, 0);
    fs.closeSync(fd);

    return crypto.createHash('md5').update(buffer.slice(0, bytesRead)).digest('hex');
  } catch (err) {
    console.warn(`[duplicateFinder] Cannot hash "${filePath}":`, err.message);
    return null;
  }
}

/**
 * Compute the full MD5 hash of a file by streaming its contents.
 *
 * @param {string} filePath
 * @returns {string|null} MD5 hex string, or null on error.
 */
function _hashFull(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(data).digest('hex');
  } catch (err) {
    console.warn(`[duplicateFinder] Full hash failed for "${filePath}":`, err.message);
    return null;
  }
}

/**
 * Group an array of items by a key-generating function.
 *
 * @param {Array}    arr
 * @param {Function} keyFn
 * @returns {Map<string, Array>}
 */
function _groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const key = keyFn(item);
    if (key == null) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// ---------------------------------------------------------------------------
// findDuplicates
// ---------------------------------------------------------------------------
/**
 * Run the 3-phase duplicate detection algorithm.
 *
 * Phase 1 — Size grouping:
 *   Walk the directory recursively. Group files by exact byte size.
 *   Discard any group with only one member (they cannot have duplicates).
 *
 * Phase 2 — Header hash:
 *   For each remaining size-group, read the first 4096 bytes of every file
 *   and compute an MD5. Re-group by header hash. Discard singletons.
 *
 * Phase 3 — Full hash:
 *   For each remaining header-hash group, compute the full-file MD5.
 *   Files sharing the same full MD5 are confirmed duplicates.
 *
 * @param {string}   folderPath               - Root directory to scan.
 * @param {Function} [progressCallback]       - Called with (phase, current, total).
 * @returns {Array<{hash:string, size:number, files:Array<{path,name,size,modified}>}>}
 */
function findDuplicates(folderPath, progressCallback) {
  const report = (phase, current, total) => {
    if (typeof progressCallback === 'function') {
      progressCallback({ phase, current, total });
    }
  };

  // ── Phase 1: Walk & group by size ────────────────────────────────────────
  report('walk', 0, 1);
  const allFiles = _walkDir(folderPath);
  report('walk', 1, 1);

  const bySize = _groupBy(allFiles, f => f.size);
  const sizeGroups = [...bySize.values()].filter(g => g.length > 1);

  if (sizeGroups.length === 0) return [];

  // ── Phase 2: Header hash ─────────────────────────────────────────────────
  const headerCandidates = [];
  let p2done = 0;
  const p2total = sizeGroups.reduce((s, g) => s + g.length, 0);

  for (const group of sizeGroups) {
    // Attach a header hash to each file descriptor
    const annotated = group.map(f => {
      const headerHash = _hashPartial(f.filePath, HEADER_BYTES);
      report('header', ++p2done, p2total);
      return { ...f, headerHash };
    });

    // Re-group by headerHash
    const byHeader = _groupBy(annotated, f => f.headerHash);
    for (const sub of byHeader.values()) {
      if (sub.length > 1) headerCandidates.push(...sub);
    }
  }

  if (headerCandidates.length === 0) return [];

  // Re-group the surviving candidates by (size + headerHash)
  const headerGroups = _groupBy(
    headerCandidates,
    f => `${f.size}::${f.headerHash}`
  );

  // ── Phase 3: Full hash ───────────────────────────────────────────────────
  const duplicateGroups = [];
  let p3done = 0;
  const p3total = [...headerGroups.values()].reduce((s, g) => s + g.length, 0);

  for (const group of headerGroups.values()) {
    const annotated = group.map(f => {
      const fullHash = _hashFull(f.filePath);
      report('full', ++p3done, p3total);
      return { ...f, fullHash };
    });

    const byFull = _groupBy(annotated, f => f.fullHash);

    for (const [hash, dupes] of byFull.entries()) {
      if (dupes.length > 1) {
        duplicateGroups.push({
          hash,
          size: dupes[0].size,
          files: dupes.map(f => ({
            path:     f.filePath,
            name:     path.basename(f.filePath),
            size:     f.size,
            modified: f.modified,
          })),
        });
      }
    }
  }

  return duplicateGroups;
}

// ---------------------------------------------------------------------------
// recycleFiles
// ---------------------------------------------------------------------------
/**
 * Move files to the Windows Recycle Bin using the VisualBasic FileSystem API
 * via PowerShell. Each file is processed individually so a failure on one
 * does not block the rest.
 *
 * @param {string[]} filePaths - Absolute paths of files to recycle.
 * @returns {{ recycled: string[], failed: string[] }}
 */
function recycleFiles(filePaths) {
  const recycled = [];
  const failed   = [];

  for (const filePath of filePaths) {
    // Escape single-quotes inside the path for PowerShell
    const safePath = filePath.replace(/'/g, "''");

    const psScript = [
      `Add-Type -AssemblyName Microsoft.VisualBasic`,
      `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${safePath}', 'OnlyErrorDialogs', 'SendToRecycleBin')`,
    ].join('; ');

    try {
      execSync(`powershell -NoProfile -NonInteractive -Command "${psScript}"`, {
        windowsHide: true,
        stdio: 'pipe',
      });
      recycled.push(filePath);
    } catch (err) {
      console.warn(`[duplicateFinder] Recycle failed for "${filePath}":`, err.message);
      failed.push(filePath);
    }
  }

  return { recycled, failed };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  findDuplicates,
  recycleFiles,
};
