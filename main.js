/**
 * main.js — DeskPilot Electron Main Process
 *
 * Responsibilities:
 *  - Create and manage the BrowserWindow
 *  - Register ALL ipcMain.handle() handlers (organizer, duplicates, disk,
 *    system, ai, settings, dialog)
 *  - Manage the system tray icon
 *  - Handle app lifecycle events (ready, window-all-closed, activate)
 *
 * Architecture:
 *  Engine modules live under src/engine/ and are required lazily so that a
 *  missing native dependency never crashes the whole app at startup.
 */

'use strict';

const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, screen, globalShortcut } = require('electron');
const path  = require('path');
const fs    = require('fs');

// ─── Paths ────────────────────────────────────────────────────────────────────

const ROOT          = __dirname;
const ENGINE_DIR    = path.join(ROOT, 'src', 'engine');
const UI_INDEX      = path.join(ROOT, 'src', 'ui', 'index.html');
const FLOAT_INDEX   = path.join(ROOT, 'src', 'ui', 'floating-btn.html');
const POPUP_INDEX   = path.join(ROOT, 'src', 'ui', 'command-popup.html');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const TRAY_ICON     = path.join(ROOT, 'src', 'ui', 'assets', 'tray.png');

// ─── Lazy engine loader ───────────────────────────────────────────────────────

/**
 * Require an engine module. If the file doesn't exist yet (e.g. during early
 * development) return a Proxy that throws a descriptive error on first use.
 *
 * @param {string} name  Module filename without .js extension
 */
function loadEngine(name) {
  const modulePath = path.join(ENGINE_DIR, `${name}.js`);
  try {
    return require(modulePath);
  } catch (err) {
    console.warn(`[main] Engine "${name}" not loaded:`, err.message);
    return new Proxy({}, {
      get: (_, prop) => () => Promise.reject(
        new Error(`Engine "${name}" is unavailable (${err.message}). Method: ${prop}`)
      ),
    });
  }
}

// Engine singletons — loaded once at startup
let fileOrganizer, duplicateFinder, diskAnalyzer, systemOps, aiAssistant, geminiLive;

function requireEngines() {
  fileOrganizer   = loadEngine('fileOrganizer');
  duplicateFinder = loadEngine('duplicateFinder');
  diskAnalyzer    = loadEngine('diskAnalyzer');
  systemOps       = loadEngine('systemOps');
  aiAssistant     = loadEngine('aiAssistant');
  geminiLive      = loadEngine('geminiLive');
}

// ─── Settings store (plain JSON, no native deps) ──────────────────────────────

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[settings] Read error:', err.message);
  }
  return {};
}

function writeSettings(values) {
  try {
    const current = readSettings();
    const merged  = { ...current, ...values };
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch (err) {
    console.error('[settings] Write error:', err.message);
    throw err;
  }
}

// ─── Windows & Companion State ────────────────────────────────────────────────

/** @type {BrowserWindow|null} */
let mainWindow = null;

/** @type {BrowserWindow|null} */
let floatWindow = null;

/** @type {BrowserWindow|null} */
let commandPopupWindow = null;

let isQuitting = false;

/**
 * Calculate positions for the floating mascot companion (bottom-right of desktop)
 * and the command popup positioned right above it.
 */
function getFloatPositions() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;

  const btnWidth = 172;
  const btnHeight = 132;
  const btnX = Math.round(workArea.x + workArea.width - btnWidth - 16);
  const btnY = Math.round(workArea.y + workArea.height - btnHeight - 16);

  const popWidth = 440;
  const popHeight = 272;
  const popX = Math.round(workArea.x + workArea.width - popWidth - 20);
  const popY = Math.round(btnY - popHeight - 8);

  return { btnX, btnY, btnWidth, btnHeight, popX, popY, popWidth, popHeight };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1200,
    height:          750,
    minWidth:        900,
    minHeight:       600,
    frame:           false,          // Frameless — custom titlebar in HTML
    titleBarStyle:   'hidden',
    backgroundColor: '#08080a',      // Dark background prevents white flash
    show:            false,          // Reveal only after content loads
    icon:            fs.existsSync(TRAY_ICON) ? TRAY_ICON : undefined,
    webPreferences: {
      preload:          path.join(ROOT, 'preload.js'),
      contextIsolation: true,        // Renderer JS cannot reach Node globals
      nodeIntegration:  false,       // No require() in renderer
      sandbox:          true,        // Extra OS-level sandboxing
      devTools:         !app.isPackaged,
    },
  });

  // Show when ready to prevent flash of unstyled content
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!app.isPackaged) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.loadFile(UI_INDEX).catch(err => {
    console.error('[main] Failed to load UI:', err.message);
  });

  // Keep companion alive when main window is closed by hiding instead of destroying
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/**
 * Creates the persistent floating mascot button on the desktop at the right-bottom corner.
 */
function createFloatWindow() {
  if (floatWindow && !floatWindow.isDestroyed()) return;

  const pos = getFloatPositions();

  floatWindow = new BrowserWindow({
    x: pos.btnX,
    y: pos.btnY,
    width: pos.btnWidth,
    height: pos.btnHeight,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  floatWindow.loadFile(FLOAT_INDEX).catch(err => {
    console.error('[float] Failed to load floating button UI:', err.message);
  });

  floatWindow.on('closed', () => { floatWindow = null; });
}

/**
 * Creates the quick command prompt popup that appears right above the mascot button.
 */
function createCommandPopupWindow() {
  if (commandPopupWindow && !commandPopupWindow.isDestroyed()) return;

  const pos = getFloatPositions();

  commandPopupWindow = new BrowserWindow({
    x: pos.popX,
    y: pos.popY,
    width: pos.popWidth,
    height: pos.popHeight,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  commandPopupWindow.loadFile(POPUP_INDEX).catch(err => {
    console.error('[popup] Failed to load command popup UI:', err.message);
  });

  commandPopupWindow.on('closed', () => { commandPopupWindow = null; });
}

// ─── Tray icon ────────────────────────────────────────────────────────────────

/** @type {Tray|null} */
let tray = null;

function createTray() {
  try {
    let icon;
    if (fs.existsSync(TRAY_ICON)) {
      icon = nativeImage.createFromPath(TRAY_ICON).resize({ width: 16, height: 16 });
    } else {
      // Fallback: 1×1 transparent PNG so Tray construction never throws
      icon = nativeImage.createEmpty();
      console.warn('[tray] Icon file not found, using empty placeholder:', TRAY_ICON);
    }

    tray = new Tray(icon);
    tray.setToolTip('Riu');

    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show Riu Dashboard', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow(); } },
      { label: 'Toggle Desktop Companion', click: () => {
        if (floatWindow && !floatWindow.isDestroyed()) {
          if (floatWindow.isVisible()) floatWindow.hide();
          else floatWindow.show();
        } else {
          createFloatWindow();
        }
      }},
      { type:  'separator' },
      { label: 'Quit Riu', click: () => { isQuitting = true; app.quit(); } },
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
  } catch (err) {
    // Tray is optional — a failure must never crash the app
    console.error('[tray] Could not create tray icon:', err.message);
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

function registerIpcHandlers() {

  // Helper: wraps an async engine call and surfaces errors back to renderer
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        console.error(`[ipc] ${channel} error:`, err.message);
        // Serialise the error so the renderer can display it
        throw new Error(err.message || String(err));
      }
    });
  };

  // ── File Organizer ─────────────────────────────────────────────────────────

  /**
   * Scan a folder and return proposed file moves grouped by category.
   * Input:  folderPath {string}
   * Output: Array<{src, dest, filename, category, size}>
   */
  handle('organizer:scan', (folderPath) => {
    if (!folderPath) throw new Error('folderPath is required');
    return fileOrganizer.scanFolder(folderPath);
  });

  /**
   * Execute the proposed moves and log to history.
   * Input:  folderPath {string}, moves {Array}
   * Output: {moved:number, errors:string[]}
   */
  handle('organizer:execute', (folderPath, moves) => {
    if (!folderPath) throw new Error('folderPath is required');
    if (!Array.isArray(moves)) throw new Error('moves must be an array');
    return fileOrganizer.executeOrganize(folderPath, moves);
  });

  /**
   * Undo the last organize run.
   * Input:  folderPath {string}
   * Output: {undone:number, errors:string[]}
   */
  handle('organizer:undo', (folderPath) => {
    if (!folderPath) throw new Error('folderPath is required');
    return fileOrganizer.undoLast(folderPath);
  });

  // ── Duplicate Finder ───────────────────────────────────────────────────────

  /**
   * Recursively scan a folder for duplicate files (by content hash).
   * Input:  folderPath {string}
   * Output: Array<{hash, size, files:string[]}>
   */
  handle('duplicates:scan', (folderPath) => {
    if (!folderPath) throw new Error('folderPath is required');
    return duplicateFinder.findDuplicates(folderPath);
  });

  /**
   * Move selected files to the Recycle Bin.
   * Input:  filePaths {string[]}
   * Output: {recycled:number, errors:string[]}
   */
  handle('duplicates:delete', (filePaths) => {
    if (!Array.isArray(filePaths) || filePaths.length === 0)
      throw new Error('filePaths must be a non-empty array');
    return duplicateFinder.recycleFiles(filePaths);
  });

  // ── Disk Analyzer ──────────────────────────────────────────────────────────

  /**
   * List all logical drives with space statistics.
   * Output: Array<{drive, total, free, used, pct}>
   */
  handle('disk:drives', () => diskAnalyzer.getDrives());

  /**
   * Find the N largest files inside a folder.
   * Input:  folderPath {string}
   * Output: Array<{path, size}>
   */
  handle('disk:largest', (folderPath) => {
    if (!folderPath) throw new Error('folderPath is required');
    return diskAnalyzer.getLargestFiles(folderPath);
  });

  /**
   * Open Windows Explorer highlighting the given file.
   * Input:  filePath {string}
   */
  handle('disk:reveal', (filePath) => {
    if (!filePath) throw new Error('filePath is required');
    return diskAnalyzer.revealInExplorer(filePath);
  });

  // ── System Operations ──────────────────────────────────────────────────────

  /**
   * Return real-time CPU %, RAM, and battery metrics.
   * Output: {cpu, ramUsed, ramTotal, battery}
   */
  handle('system:metrics', () => systemOps.getMetrics());

  /**
   * Delete temporary files from %TEMP% and Windows\Temp.
   * Output: {deleted, freedBytes, errors}
   */
  handle('system:cleanTemp', () => systemOps.cleanTemp());

  /**
   * Empty the Windows Recycle Bin on all drives.
   * Output: {success}
   */
  handle('system:emptyBin', () => systemOps.emptyRecycleBin());

  /**
   * Lock the Windows workstation (Win+L equivalent).
   */
  handle('system:lock', () => systemOps.lockWorkstation());

  /**
   * Adjust system volume.
   * Input: action {'up'|'down'|'mute'}
   */
  handle('system:volume', (action) => {
    if (!['up', 'down', 'mute'].includes(action))
      throw new Error(`Invalid volume action: "${action}". Expected up|down|mute.`);
    return systemOps.volumeControl(action);
  });

  /**
   * Launch a named application.
   * Input: appName {string}
   */
  handle('system:launch', (appName) => {
    if (!appName) throw new Error('appName is required');
    return systemOps.launchApp(appName);
  });

  // ── AI Assistant ───────────────────────────────────────────────────────────

  /**
   * Process a natural-language command via the AI assistant engine.
   * Input:  text {string}, apiKey {string}
   * Output: {type:'action'|'text', action?, params?, text?}
   */
  handle('ai:command', (text, apiKey) => {
    if (!text) throw new Error('text is required');
    return aiAssistant.processCommand(text, apiKey);
  });

  // ── Settings ───────────────────────────────────────────────────────────────

  /**
   * Return all persisted settings.
   * Output: {geminiKey?, claudeKey?, ...}
   */
  handle('settings:get', () => readSettings());

  /**
   * Merge and persist settings.
   * Input: values {object}
   */
  handle('settings:set', (values) => {
    if (!values || typeof values !== 'object')
      throw new Error('values must be an object');
    return writeSettings(values);
  });

  // ── Native Dialogs ─────────────────────────────────────────────────────────

  /**
   * Open a native folder-picker dialog.
   * Output: selected folder path string, or null if cancelled
   */
  handle('dialog:openDirectory', async () => {
    const win = mainWindow; // may be null during tests
    const result = await dialog.showOpenDialog(win, {
      title:      'Select Folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle('app:getPaths', () => ({
    downloads: app.getPath('downloads'),
    desktop:   app.getPath('desktop'),
    documents: app.getPath('documents'),
    home:      app.getPath('home'),
  }));

  // ── Window Controls ────────────────────────────────────────────────────────
  ipcMain.on('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.on('window:maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });
  ipcMain.on('window:close', () => {
    if (mainWindow) mainWindow.hide();
  });

  // ── Floating Companion & Command Popup ─────────────────────────────────────

  // Toggle command popup on float button click
  ipcMain.on('float-btn:clicked', () => {
    if (!commandPopupWindow || commandPopupWindow.isDestroyed()) {
      createCommandPopupWindow();
    }
    if (commandPopupWindow.isVisible()) {
      commandPopupWindow.hide();
    } else {
      const pos = getFloatPositions();
      commandPopupWindow.setPosition(pos.popX, pos.popY);
      commandPopupWindow.show();
      commandPopupWindow.focus();
    }
  });

  // Open / Restore main dashboard on double click or right click
  ipcMain.on('float-btn:open-main', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    } else {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Close command popup
  ipcMain.on('command-popup:close', () => {
    if (commandPopupWindow && !commandPopupWindow.isDestroyed() && commandPopupWindow.isVisible()) {
      commandPopupWindow.hide();
    }
  });

  // Navigate main window to specific section from command popup
  ipcMain.on('command-popup:navigate', (_event, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    } else {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('navigate-to-action', action);
    }
  });

  // Execute quick commands from the desktop popup
  ipcMain.handle('float:execute-command', async (_event, text) => {
    if (!text || typeof text !== 'string') {
      return { message: 'Please provide a command.' };
    }

    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    // Direct local fast actions
    if (lower.includes('clean') && (lower.includes('temp') || lower.includes('cache'))) {
      const res = systemOps.cleanTemp();
      return {
        action: 'clean temp',
        message: `Cleaned ${res.cleaned} items (${(res.freedBytes / (1024*1024)).toFixed(1)} MB freed).`
      };
    }
    if (lower.includes('empty') && (lower.includes('bin') || lower.includes('recycle'))) {
      const res = systemOps.emptyRecycleBin();
      return {
        action: 'empty bin',
        message: res.success ? 'Recycle Bin emptied successfully.' : 'Could not empty bin.'
      };
    }
    if (lower.includes('lock') && (lower.includes('screen') || lower.includes('workstation'))) {
      systemOps.lockWorkstation();
      return { action: 'lock screen', message: 'Workstation locked.' };
    }
    if (lower.includes('mute')) {
      systemOps.volumeControl('mute');
      return { action: 'mute', message: 'Audio mute toggled.' };
    }

    // Universal "open <app>" or "launch <app>" command
    const launchMatch = lower.match(/^(?:open|launch|start|run)\s+(?:the\s+)?([a-zA-Z0-9_\-\.\s]+)$/i);
    if (launchMatch) {
      const targetApp = launchMatch[1].trim();

      // Intercept module shortcuts
      if (targetApp.includes('download') || targetApp.includes('organizer')) {
        if (!mainWindow || mainWindow.isDestroyed()) createWindow();
        else {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('navigate-to-action', 'organize:downloads');
        }
        return { action: 'organize downloads', message: 'Opened Smart Organizer.' };
      }
      if (targetApp.includes('duplic')) {
        if (!mainWindow || mainWindow.isDestroyed()) createWindow();
        else {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('navigate-to-action', 'duplicates:scan');
        }
        return { action: 'find duplicates', message: 'Opened Duplicate Finder.' };
      }
      if (targetApp.includes('disk') || targetApp.includes('drive') || targetApp.includes('storage')) {
        if (!mainWindow || mainWindow.isDestroyed()) createWindow();
        else {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('navigate-to-action', 'disk:analyze');
        }
        return { action: 'disk analyzer', message: 'Opened Disk Analyzer.' };
      }

      // Launch application through universal Windows app launcher
      const launchRes = systemOps.launchApp(targetApp);
      const appName = launchRes.app || targetApp;
      return {
        action: `launch: ${appName}`,
        message: `🚀 Launching ${appName}…`,
      };
    }

    if (lower.includes('organize') || lower.includes('sort')) {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      else {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('navigate-to-action', 'organize:downloads');
      }
      return { action: 'organize downloads', message: 'Opened Smart Organizer.' };
    }
    if (lower.includes('duplic')) {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      else {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('navigate-to-action', 'duplicates:scan');
      }
      return { action: 'find duplicates', message: 'Opened Duplicate Finder.' };
    }
    if (lower.includes('disk') || lower.includes('drive') || lower.includes('storage')) {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      else {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('navigate-to-action', 'disk:analyze');
      }
      return { action: 'disk analyzer', message: 'Opened Disk Analyzer.' };
    }

    // Fallback: AI assistant command handler (with Gemini Live support)
    const settings = readSettings();
    const apiKey = settings.geminiKey || '';
    if (apiKey && geminiLive && geminiLive.streamLiveResponse) {
      try {
        const res = await geminiLive.streamLiveResponse({ apiKey, text: trimmed });
        if (res.action) _dispatchLiveAction(res.action);
        return {
          action: res.action || null,
          response: res.text,
          message: res.text,
          model: res.model,
        };
      } catch (err) {
        return { message: 'AI error: ' + err.message };
      }
    }

    if (aiAssistant && aiAssistant.processCommand) {
      try {
        const res = await aiAssistant.processCommand(trimmed, apiKey);
        if (res && res.action) {
          if (res.action.startsWith('launch:')) {
            const appToLaunch = res.action.replace('launch:', '').trim();
            const launchRes = systemOps.launchApp(appToLaunch);
            const appName = launchRes.app || appToLaunch;
            return { action: `launch: ${appName}`, message: `Launching ${appName}` };
          }
          return { action: res.action, message: res.message || 'Action executed.' };
        }
        if (res && res.response) {
          return { response: res.response };
        }
      } catch (err) {
        return { message: 'AI error: ' + err.message };
      }
    }

    return { message: `Command "${trimmed}" processed.` };
  });

  // ── Gemini Live Streaming (Text + Multimodal Voice Audio) ──────────────────
  ipcMain.handle('ai:live-stream', async (event, payload) => {
    const settings = readSettings();
    const apiKey = settings.geminiKey || '';
    if (!apiKey) {
      throw new Error('Gemini API key not configured. Add it in Settings.');
    }

    const { text, audioBase64, audioMimeType } = payload || {};
    const result = await geminiLive.streamLiveResponse({
      apiKey,
      text,
      audioBase64,
      audioMimeType,
      onChunk: (_delta, cleanText) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('ai:live-chunk', { text: cleanText });
        }
      },
    });

    if (result.action) {
      _dispatchLiveAction(result.action);
    }

    return result;
  });

  // ── Gemini Natural Human TTS ───────────────────────────────────────────────
  ipcMain.handle('ai:tts', async (_event, text) => {
    const settings = readSettings();
    const apiKey = settings.geminiKey || '';
    if (!apiKey) throw new Error('Gemini API key not configured.');
    return geminiLive.synthesizeSpeech(text, apiKey, 'Aoede');
  });
}

/**
 * Execute an ACTION:<name> directive emitted by Gemini Live.
 * @param {string} actionStr
 */
function _dispatchLiveAction(actionStr) {
  if (!actionStr) return;
  const a = actionStr.toLowerCase().trim();

  if (a === 'clean_temp') {
    systemOps.cleanTemp();
  } else if (a === 'empty_bin') {
    systemOps.emptyRecycleBin();
  } else if (a === 'lock_screen') {
    systemOps.lockWorkstation();
  } else if (a === 'mute') {
    systemOps.volumeControl('mute');
  } else if (a.startsWith('open:')) {
    const appName = a.slice(5).trim();
    if (appName) systemOps.launchApp(appName);
  } else if (a === 'organize_downloads' || a === 'find_duplicates' || a === 'disk_analyzer') {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    const map = {
      organize_downloads: 'organize:downloads',
      find_duplicates: 'duplicates:scan',
      disk_analyzer: 'disk:analyze',
    };
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('navigate-to-action', map[a]);
    }
  }
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Load engine modules before registering handlers
  requireEngines();

  // Register all IPC handlers
  registerIpcHandlers();

  // Create the main window
  createWindow();

  // Create the persistent desktop floating companion button
  createFloatWindow();

  // Pre-create the command popup window (hidden initially)
  createCommandPopupWindow();

  // Create the system tray icon
  createTray();

  // Global hotkey Ctrl+L to toggle Riu microphone listening
  const shortcutOk = globalShortcut.register('CommandOrControl+L', () => {
    if (!floatWindow || floatWindow.isDestroyed()) {
      createFloatWindow();
    }
    if (floatWindow && !floatWindow.isDestroyed()) {
      if (!floatWindow.isVisible()) floatWindow.show();
      floatWindow.webContents.send('float-btn:toggle-mic');
    }
  });
  if (!shortcutOk) {
    console.warn('[hotkey] Failed to register CommandOrControl+L');
  }

  // Auto-reposition floating button if screen resolution/workArea changes
  screen.on('display-metrics-changed', () => {
    if (floatWindow && !floatWindow.isDestroyed()) {
      const p = getFloatPositions();
      floatWindow.setBounds({ x: p.btnX, y: p.btnY, width: p.btnWidth, height: p.btnHeight });
    }
    if (commandPopupWindow && !commandPopupWindow.isDestroyed()) {
      const p = getFloatPositions();
      commandPopupWindow.setBounds({ x: p.popX, y: p.popY, width: p.popWidth, height: p.popHeight });
    }
  });

  // macOS: re-create window when dock icon is clicked and no windows are open
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Clean up on quit
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (floatWindow && !floatWindow.isDestroyed()) {
    floatWindow.destroy();
    floatWindow = null;
  }
  if (commandPopupWindow && !commandPopupWindow.isDestroyed()) {
    commandPopupWindow.destroy();
    commandPopupWindow = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

// ─── Unhandled rejection guard ────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled rejection:', reason);
});
