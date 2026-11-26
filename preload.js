/**
 * preload.js — DeskPilot Secure Context Bridge
 *
 * Runs in a sandboxed renderer context with access to Node.js APIs disabled.
 * Exposes a typed, namespaced `window.deskpilot` API to the renderer via
 * Electron's contextBridge, so the UI can invoke IPC handlers in main.js
 * without ever touching ipcRenderer directly.
 *
 * Security model:
 *  - contextIsolation: true  (renderer JS cannot reach Node globals)
 *  - nodeIntegration: false  (no require() in renderer)
 *  - Only whitelisted IPC channels are callable from the renderer
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Helper — wraps ipcRenderer.invoke so we don't repeat the try/catch pattern
 * everywhere. All errors propagate to the caller as rejected Promises.
 *
 * @param {string} channel  - IPC channel name (e.g. 'organizer:scan')
 * @param {...any} args     - Arguments forwarded to ipcMain.handle
 * @returns {Promise<any>}
 */
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/**
 * window.deskpilot
 * ----------------
 * Namespaced API surface exposed to the renderer. Every method is an async
 * function that resolves with the return value of the corresponding
 * ipcMain.handle() in main.js.
 */
const api = {

  // ── File Organizer ────────────────────────────────────────────────────────
  organizer: {
    /**
     * Scan a folder and get proposed move operations grouped by category.
     * @param {string} folderPath  Absolute path of the folder to scan.
     * @returns {Promise<Array<{src:string, dest:string, filename:string, category:string, size:number}>>}
     */
    scan: (folderPath) => invoke('organizer:scan', folderPath),

    /**
     * Execute a list of previously proposed move operations.
     * @param {string} folderPath  Root folder (used for history file location).
     * @param {Array}  moves       Move proposals returned by scan().
     * @returns {Promise<{moved:number, errors:string[]}>}
     */
    execute: (folderPath, moves) => invoke('organizer:execute', folderPath, moves),

    /**
     * Undo the last organize operation recorded in .deskpilot_history.json.
     * @param {string} folderPath  Root folder where history is stored.
     * @returns {Promise<{undone:number, errors:string[]}>}
     */
    undo: (folderPath) => invoke('organizer:undo', folderPath),
  },

  // ── Duplicate Finder ──────────────────────────────────────────────────────
  duplicates: {
    /**
     * Scan a folder recursively for duplicate files (by SHA-256 hash).
     * @param {string} folderPath  Absolute path to scan.
     * @returns {Promise<Array<{hash:string, size:number, files:string[]}>>}
     */
    scan: (folderPath) => invoke('duplicates:scan', folderPath),

    /**
     * Move a list of files to the Windows Recycle Bin.
     * @param {string[]} filePaths  Absolute paths of files to recycle.
     * @returns {Promise<{recycled:number, errors:string[]}>}
     */
    delete: (filePaths) => invoke('duplicates:delete', filePaths),
  },

  // ── Disk Analyzer ─────────────────────────────────────────────────────────
  disk: {
    /**
     * List all logical drives with total / free / used space.
     * @returns {Promise<Array<{drive:string, total:number, free:number, used:number, pct:number}>>}
     */
    getDrives: () => invoke('disk:drives'),

    /**
     * Find the N largest files inside a folder (recursive).
     * @param {string} folderPath  Absolute path to scan.
     * @returns {Promise<Array<{path:string, size:number}>>}
     */
    getLargestFiles: (folderPath) => invoke('disk:largest', folderPath),

    /**
     * Open Windows Explorer and highlight a file.
     * @param {string} filePath  Absolute path to the file to reveal.
     * @returns {Promise<void>}
     */
    reveal: (filePath) => invoke('disk:reveal', filePath),
  },

  // ── System Operations ─────────────────────────────────────────────────────
  system: {
    /**
     * Get real-time CPU usage %, RAM used/total, and battery level.
     * @returns {Promise<{cpu:number, ramUsed:number, ramTotal:number, battery:number|null}>}
     */
    getMetrics: () => invoke('system:metrics'),

    /**
     * Delete temporary files from %TEMP% and Windows\Temp.
     * @returns {Promise<{deleted:number, freedBytes:number, errors:string[]}>}
     */
    cleanTemp: () => invoke('system:cleanTemp'),

    /**
     * Empty the Windows Recycle Bin (all drives).
     * @returns {Promise<{success:boolean}>}
     */
    emptyBin: () => invoke('system:emptyBin'),

    /**
     * Lock the Windows workstation (equivalent to Win+L).
     * @returns {Promise<void>}
     */
    lock: () => invoke('system:lock'),

    /**
     * Adjust system volume.
     * @param {'up'|'down'|'mute'} action  Direction or mute toggle.
     * @returns {Promise<void>}
     */
    volume: (action) => invoke('system:volume', action),

    /**
     * Launch a named application.
     * @param {string} appName  Friendly name: 'notepad', 'calc', 'explorer', etc.
     * @returns {Promise<void>}
     */
    launch: (appName) => invoke('system:launch', appName),
  },

  // ── AI Assistant ──────────────────────────────────────────────────────────
  ai: {
    /**
     * Send a natural-language command to the Gemini-based AI assistant.
     * @param {string} text    The user's input text.
     * @param {string} apiKey  Gemini API key (read from settings).
     * @returns {Promise<{type:'action'|'text', action?:string, params?:any, text?:string}>}
     */
    command: (text, apiKey) => invoke('ai:command', text, apiKey),
  },

  // ── Settings ──────────────────────────────────────────────────────────────
  settings: {
    /**
     * Load all persisted app settings.
     * @returns {Promise<{geminiKey?:string, claudeKey?:string, [key:string]:any}>}
     */
    get: () => invoke('settings:get'),

    /**
     * Persist one or more setting keys.
     * @param {object} values  Partial settings object to merge and save.
     * @returns {Promise<void>}
     */
    set: (values) => invoke('settings:set', values),
  },

  // ── .env Credentials Import ───────────────────────────────────────────────
  env: {
    status:        () => invoke('env:status'),
    upload:        () => invoke('env:upload'),
    importContent: (content) => invoke('env:importContent', content),
    clear:         () => invoke('env:clear'),
  },

  // ── Native Dialogs ────────────────────────────────────────────────────────
  dialog: {
    /**
     * Open the native OS folder-picker dialog.
     * @returns {Promise<string|null>}  Selected folder path, or null if cancelled.
     */
    openDirectory: () => invoke('dialog:openDirectory'),
  },

  // ── Standard System Paths ──────────────────────────────────────────────────
  paths: {
    get: () => invoke('app:getPaths'),
  },

  // ── Window Controls ────────────────────────────────────────────────────────
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close:    () => ipcRenderer.send('window:close'),
  },

  // ── Listen for Navigation from Companion / Floating widget ───────────────
  onNavigate: (callback) => {
    ipcRenderer.on('navigate-to-action', (_event, action) => callback(action));
  },
};

// Expose as `window.riu` and alias `window.deskpilot` for full compatibility
contextBridge.exposeInMainWorld('riu', api);
contextBridge.exposeInMainWorld('deskpilot', api);
