/**
 * fileOrganizer.js
 * DeskPilot — File Organization Engine
 *
 * Provides folder scanning, file classification, conflict resolution,
 * move execution, and undo functionality for the DeskPilot file organizer.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// FILE_CATEGORIES — maps category names to their recognized extensions
// ---------------------------------------------------------------------------
const FILE_CATEGORIES = {
  Documents:  ['.pdf','.doc','.docx','.txt','.xlsx','.xls','.pptx','.ppt','.odt','.ods','.rtf','.csv'],
  Images:     ['.jpg','.jpeg','.png','.gif','.bmp','.svg','.webp','.tiff','.ico','.raw'],
  Videos:     ['.mp4','.mkv','.avi','.mov','.wmv','.flv','.webm','.m4v','.mpeg'],
  Audio:      ['.mp3','.wav','.flac','.aac','.ogg','.wma','.m4a'],
  Archives:   ['.zip','.rar','.7z','.tar','.gz','.bz2','.xz'],
  Code:       ['.js','.ts','.py','.java','.cpp','.c','.cs','.html','.css','.json','.xml','.sh','.ps1','.bat','.go','.rb','.php'],
  Installers: ['.exe','.msi','.dmg','.deb','.rpm'],
};

// Name of the history file written inside the organized folder
const HISTORY_FILE = '.riu_history.json';
const LEGACY_HISTORY_FILE = '.deskpilot_history.json';

// ---------------------------------------------------------------------------
// classifyFile
// ---------------------------------------------------------------------------
/**
 * Determine the category of a file based on its extension.
 *
 * @param {string} filename - The filename (with or without full path).
 * @returns {string} Category name, or 'Other' if no match is found.
 */
function classifyFile(filename) {
  const ext = path.extname(filename).toLowerCase();

  for (const [category, extensions] of Object.entries(FILE_CATEGORIES)) {
    if (extensions.includes(ext)) {
      return category;
    }
  }

  return 'Other';
}

// ---------------------------------------------------------------------------
// resolveConflict
// ---------------------------------------------------------------------------
/**
 * Generate a non-colliding destination filename.
 * If `filename` already exists in `destDir`, appends (1), (2), … until unique.
 *
 * @param {string} destDir  - Absolute path to the destination directory.
 * @param {string} filename - Original filename.
 * @returns {string} A filename guaranteed not to exist in destDir.
 */
function resolveConflict(destDir, filename) {
  let candidate = filename;
  let counter   = 1;
  const ext     = path.extname(filename);
  const base    = path.basename(filename, ext);

  while (fs.existsSync(path.join(destDir, candidate))) {
    candidate = `${base} (${counter})${ext}`;
    counter++;
  }

  return candidate;
}

// ---------------------------------------------------------------------------
// scanFolder
// ---------------------------------------------------------------------------
/**
 * Non-recursively scan a folder and produce move proposals.
 * Skips directories, the history file, and any file that cannot be stat'd.
 *
 * @param {string} folderPath - Absolute path to the folder to scan.
 * @returns {Array<{src:string, dest:string, filename:string, category:string, size:number}>}
 */
function scanFolder(folderPath) {
  const moves = [];

  let entries;
  try {
    entries = fs.readdirSync(folderPath);
  } catch (err) {
    console.error(`[fileOrganizer] Cannot read folder "${folderPath}":`, err.message);
    return moves;
  }

  for (const entry of entries) {
    // Skip the history file itself
    if (entry === HISTORY_FILE || entry === LEGACY_HISTORY_FILE) continue;

    const srcPath = path.join(folderPath, entry);

    let stat;
    try {
      stat = fs.statSync(srcPath);
    } catch (err) {
      // Locked or unreadable — skip silently
      console.warn(`[fileOrganizer] Skipping "${entry}":`, err.message);
      continue;
    }

    // Skip sub-directories; this is a non-recursive scan
    if (stat.isDirectory()) continue;

    const category    = classifyFile(entry);
    const destDir     = path.join(folderPath, category);
    const safeFile    = resolveConflict(destDir, entry);
    const destPath    = path.join(destDir, safeFile);

    moves.push({
      src:      srcPath,
      dest:     destPath,
      filename: safeFile,
      category,
      size:     stat.size,
    });
  }

  return moves;
}

// ---------------------------------------------------------------------------
// executeOrganize
// ---------------------------------------------------------------------------
/**
 * Perform file moves described by `moves`, create category sub-directories
 * as needed, and append the transaction to the history file.
 *
 * @param {string} folderPath - Root folder being organized.
 * @param {Array}  moves      - Move proposals returned by scanFolder().
 * @returns {{ moved: number, skipped: number }} Summary of the operation.
 */
function executeOrganize(folderPath, moves) {
  const executed = [];
  let skipped    = 0;

  for (const move of moves) {
    const destDir = path.dirname(move.dest);

    try {
      // Ensure the category sub-directory exists
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      fs.renameSync(move.src, move.dest);
      executed.push({ src: move.src, dest: move.dest });
    } catch (err) {
      // Skip locked / in-use files gracefully
      console.warn(`[fileOrganizer] Could not move "${move.src}" → "${move.dest}":`, err.message);
      skipped++;
    }
  }

  // Persist the transaction to history
  if (executed.length > 0) {
    _appendHistory(folderPath, executed);
  }

  return { moved: executed.length, skipped };
}

// ---------------------------------------------------------------------------
// undoLast
// ---------------------------------------------------------------------------
/**
 * Reverse the most recent organize transaction recorded in the history file.
 * Moves files back to their original locations and removes that entry.
 *
 * @param {string} folderPath - Root folder that was organized.
 * @returns {{ restored: number, skipped: number, message: string }}
 */
function undoLast(folderPath) {
  let historyPath = path.join(folderPath, HISTORY_FILE);
  if (!fs.existsSync(historyPath) && fs.existsSync(path.join(folderPath, LEGACY_HISTORY_FILE))) {
    historyPath = path.join(folderPath, LEGACY_HISTORY_FILE);
  }

  if (!fs.existsSync(historyPath)) {
    return { restored: 0, skipped: 0, message: 'No history found.' };
  }

  let history;
  try {
    history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  } catch (err) {
    return { restored: 0, skipped: 0, message: 'History file is corrupt.' };
  }

  if (!Array.isArray(history) || history.length === 0) {
    return { restored: 0, skipped: 0, message: 'Nothing to undo.' };
  }

  // Pop the last transaction
  const last    = history.pop();
  const entries = last.moves || [];
  let restored  = 0;
  let skipped   = 0;

  // Reverse each move: dest → src
  for (const entry of entries) {
    try {
      // Re-create the original directory if it was removed
      const srcDir = path.dirname(entry.src);
      if (!fs.existsSync(srcDir)) {
        fs.mkdirSync(srcDir, { recursive: true });
      }

      fs.renameSync(entry.dest, entry.src);
      restored++;
    } catch (err) {
      console.warn(`[fileOrganizer] Undo failed for "${entry.dest}":`, err.message);
      skipped++;
    }
  }

  // Write updated history (without the reversed transaction)
  try {
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
  } catch (err) {
    console.error('[fileOrganizer] Could not update history file:', err.message);
  }

  return { restored, skipped, message: `Restored ${restored} file(s).` };
}

// ---------------------------------------------------------------------------
// _appendHistory  (private helper)
// ---------------------------------------------------------------------------
/**
 * Append a transaction record to .deskpilot_history.json.
 *
 * @param {string} folderPath - Folder that owns the history file.
 * @param {Array}  moves      - Array of { src, dest } objects.
 */
function _appendHistory(folderPath, moves) {
  const historyPath = path.join(folderPath, HISTORY_FILE);
  let history       = [];

  if (fs.existsSync(historyPath)) {
    try {
      history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      if (!Array.isArray(history)) history = [];
    } catch (_) {
      history = [];
    }
  }

  history.push({
    timestamp: new Date().toISOString(),
    moves,
  });

  try {
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
  } catch (err) {
    console.error('[fileOrganizer] Could not write history:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  FILE_CATEGORIES,
  classifyFile,
  resolveConflict,
  scanFolder,
  executeOrganize,
  undoLast,
};
