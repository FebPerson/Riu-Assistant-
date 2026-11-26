/**
 * DeskPilot — app.js
 * Vanilla JS frontend for the DeskPilot Electron application.
 * Communicates with the main process via window.deskpilot (exposed by preload.js).
 */

'use strict';

/* ============================================================
   STATE
   ============================================================ */
const state = {
  currentSection: 'dashboard',
  settings: { geminiKey: '', claudeKey: '' },
  organizer: {
    folderPath: '',
    currentMoves: [],
    scanned: false,
  },
  duplicates: {
    folderPath: '',
    groups: [],
  },
  disk: {
    folderPath: '',
  },
  system: {
    metricsInterval: null,
  },
  dashboard: {
    metricsInterval: null,
  },
  activityLog: [],
};

/* ============================================================
   UTILITY HELPERS
   ============================================================ */

/** Format bytes into a human-readable string */
function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024));
  const val = (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0);
  return `${val} ${units[i]}`;
}

/** Escape HTML to prevent XSS when inserting untrusted text */
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Clamp a value between min and max */
function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

/** Add an entry to the recent activity feed on the dashboard */
function addActivity(message, type = 'info') {
  state.activityLog.unshift({ message, type, time: new Date() });
  if (state.activityLog.length > 50) state.activityLog.pop();
  renderActivityFeed();
}

/* ============================================================
   MODULE: TOAST NOTIFICATIONS
   ============================================================ */
const toastIcons = {
  info:    '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  success: '<svg class="icon" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  warning: '<svg class="icon" viewBox="0 0 24 24"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  error:   '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
};

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} type
 * @param {number} duration  ms before auto-dismiss (0 = never)
 */
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${toastIcons[type] || toastIcons.info}</span>
    <span class="toast-msg">${esc(message)}</span>
    <button class="toast-close" aria-label="Dismiss"><svg class="icon" style="width:14px;height:14px;" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
  `;

  const dismiss = () => {
    toast.classList.add('hiding');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  };

  toast.querySelector('.toast-close').addEventListener('click', dismiss);
  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(dismiss, duration);
  }
}

/* ============================================================
   MODULE: LOADING OVERLAY
   ============================================================ */

/**
 * Show or hide the full-screen loading overlay.
 * @param {boolean} visible
 * @param {string} message
 */
function setLoading(visible, message = 'Loading…') {
  const overlay = document.getElementById('loading-overlay');
  const msgEl   = document.getElementById('loading-message');
  if (visible) {
    msgEl.textContent = message;
    overlay.style.display = 'flex';
  } else {
    overlay.style.display = 'none';
  }
}

/* ============================================================
   MODULE: NAVIGATION
   ============================================================ */

/**
 * Switch the visible section and update sidebar active state.
 * @param {string} sectionId  e.g. 'dashboard'
 */
function switchSection(sectionId) {
  // Stop system metrics auto-refresh if leaving system section
  if (state.currentSection === 'system' && sectionId !== 'system') {
    clearInterval(state.system.metricsInterval);
    state.system.metricsInterval = null;
  }

  state.currentSection = sectionId;

  // Hide all sections
  document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));

  // Show target
  const target = document.getElementById(`section-${sectionId}`);
  if (target) target.classList.add('active');

  // Update sidebar
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.section === sectionId);
  });

  // Section-specific on-show hooks
  if (sectionId === 'disk') {
    onDiskSectionShow();
  }
  if (sectionId === 'system') {
    onSystemSectionShow();
  }
}

function initNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      switchSection(item.dataset.section);
    });
  });
}

/* ============================================================
   MODULE: TITLEBAR CONTROLS
   ============================================================ */
function initTitlebar() {
  document.getElementById('btn-minimize')?.addEventListener('click', () => {
    if (window.deskpilot?.window?.minimize) window.deskpilot.window.minimize();
  });
  document.getElementById('btn-maximize')?.addEventListener('click', () => {
    if (window.deskpilot?.window?.maximize) window.deskpilot.window.maximize();
  });
  document.getElementById('btn-close')?.addEventListener('click', () => {
    if (window.deskpilot?.window?.close) window.deskpilot.window.close();
  });
}

/* ============================================================
   MODULE: SETTINGS
   ============================================================ */
function renderEnvStatus(status) {
  const statusEl = document.getElementById('gemini-env-status');
  const maskedEl = document.getElementById('gemini-env-masked');
  const clearBtn = document.getElementById('gemini-env-clear-btn');
  if (!statusEl) return;

  state.settings.envLoaded = Boolean(status?.loaded);

  if (status && status.loaded) {
    const srcLabel = status.source === 'uploaded'
      ? 'Loaded from uploaded .env'
      : status.source === 'local'
        ? 'Loaded from local .env'
        : 'Loaded from environment';
    statusEl.textContent = srcLabel;
    statusEl.className = 'status-message success';
    if (maskedEl) maskedEl.textContent = status.maskedKey || '';
    if (clearBtn) clearBtn.style.display = status.source === 'uploaded' ? 'inline-flex' : 'none';
  } else {
    statusEl.textContent = 'No .env file loaded';
    statusEl.className = 'status-message warning';
    if (maskedEl) maskedEl.textContent = '';
    if (clearBtn) clearBtn.style.display = 'none';
  }
}

async function loadSettings() {
  try {
    if (window.deskpilot?.settings?.get) {
      const saved = await window.deskpilot.settings.get();
      if (saved) {
        state.settings.claudeKey = saved.claudeKey || '';
      }
    }
    if (window.deskpilot?.env?.status) {
      const envStatus = await window.deskpilot.env.status();
      renderEnvStatus(envStatus);
    }
  } catch (err) {
    console.warn('Could not load settings:', err);
  }

  const claudeInput = document.getElementById('claude-key-input');
  if (claudeInput && state.settings.claudeKey) claudeInput.value = state.settings.claudeKey;
}

async function saveApiKey(keyName, value) {
  try {
    state.settings[keyName] = value;
    if (window.deskpilot?.settings?.set) {
      await window.deskpilot.settings.set({ claudeKey: state.settings.claudeKey });
    }
    showToast('API key saved successfully.', 'success');
    addActivity('API key updated.', 'info');
  } catch (err) {
    showToast('Failed to save API key: ' + err.message, 'error');
  }
}

function initSettings() {
  // Show/hide password toggles
  document.querySelectorAll('.show-hide-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const inputId = btn.dataset.target;
      const input   = document.getElementById(inputId);
      if (!input) return;
      if (input.type === 'password') {
        input.type = 'text';
        btn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
      } else {
        input.type = 'password';
        btn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
      }
    });
  });

  // Upload .env file for Gemini API key
  document.getElementById('gemini-env-upload-btn')?.addEventListener('click', async () => {
    if (!window.deskpilot?.env?.upload) return;
    try {
      const res = await window.deskpilot.env.upload();
      renderEnvStatus(res);
      if (res && !res.canceled && res.loaded) {
        showToast('.env file imported successfully.', 'success');
        addActivity('Gemini .env credentials imported.', 'info');
      }
    } catch (err) {
      showToast('Import failed: ' + err.message, 'error');
    }
  });

  // Clear uploaded .env file
  document.getElementById('gemini-env-clear-btn')?.addEventListener('click', async () => {
    if (!window.deskpilot?.env?.clear) return;
    try {
      const res = await window.deskpilot.env.clear();
      renderEnvStatus(res);
      showToast('Uploaded .env removed.', 'info');
    } catch (err) {
      showToast('Failed to remove .env: ' + err.message, 'error');
    }
  });

  // Claude save
  document.getElementById('claude-save-btn')?.addEventListener('click', () => {
    const val = document.getElementById('claude-key-input')?.value?.trim();
    if (!val) { showToast('Please enter a Claude API key.', 'warning'); return; }
    saveApiKey('claudeKey', val);
  });
}

/* ============================================================
   MODULE: SYSTEM METRICS (shared by Dashboard + System Health)
   ============================================================ */
async function fetchMetrics() {
  const api = window.riu || window.deskpilot;
  if (!api?.system?.getMetrics) return null;
  try {
    return await api.system.getMetrics();
  } catch (err) {
    console.warn('Metrics fetch failed:', err);
    return null;
  }
}

/** Update the small dashboard metric cards */
function applyDashboardMetrics(m) {
  if (!m) return;

  const cpuPct = typeof m.cpu === 'number' ? clamp(Math.round(m.cpu), 0, 100)
    : (m.cpu?.load != null ? clamp(Math.round(m.cpu.load), 0, 100)
    : (m.cpuPercent != null ? clamp(Math.round(m.cpuPercent), 0, 100) : 0));

  const ramPct = typeof m.ramPercent === 'number' ? clamp(Math.round(m.ramPercent), 0, 100)
    : (m.ram?.percent != null ? clamp(Math.round(m.ram.percent), 0, 100)
    : (m.ramTotal && m.ramUsed ? clamp(Math.round((m.ramUsed / m.ramTotal) * 100), 0, 100)
    : (m.ram?.total && m.ram?.used ? clamp(Math.round((m.ram.used / m.ram.total) * 100), 0, 100) : 0)));

  const hasBattery = m.hasBattery || m.battery?.hasBattery;
  const batPct = typeof m.battery === 'number' ? clamp(Math.round(m.battery), 0, 100)
    : (m.battery?.charge != null ? clamp(Math.round(m.battery.charge), 0, 100)
    : (m.batteryPercent != null ? clamp(Math.round(m.batteryPercent), 0, 100) : null));

  const cpuEl = document.getElementById('metric-cpu-val');
  const progCpuEl = document.getElementById('progress-cpu');
  if (cpuEl) cpuEl.textContent = `${cpuPct}%`;
  if (progCpuEl) progCpuEl.style.width = `${cpuPct}%`;

  const ramEl = document.getElementById('metric-ram-val');
  const progRamEl = document.getElementById('progress-ram');
  if (ramEl) ramEl.textContent = `${ramPct}%`;
  if (progRamEl) progRamEl.style.width = `${ramPct}%`;

  const batEl = document.getElementById('metric-battery-val');
  const progBatEl = document.getElementById('progress-battery');
  if (hasBattery && batPct !== null) {
    if (batEl) batEl.textContent = `${batPct}%`;
    if (progBatEl) progBatEl.style.width = `${batPct}%`;
  } else {
    if (batEl) batEl.textContent = 'AC Power';
    if (progBatEl) progBatEl.style.width = '100%';
  }
}

/** Update the large System Health metric cards */
function applySystemMetrics(m) {
  if (!m) return;

  const cpuPct = typeof m.cpu === 'number' ? clamp(Math.round(m.cpu), 0, 100)
    : (m.cpu?.load != null ? clamp(Math.round(m.cpu.load), 0, 100)
    : (m.cpuPercent != null ? clamp(Math.round(m.cpuPercent), 0, 100) : 0));

  const ramPct = typeof m.ramPercent === 'number' ? clamp(Math.round(m.ramPercent), 0, 100)
    : (m.ram?.percent != null ? clamp(Math.round(m.ram.percent), 0, 100)
    : (m.ramTotal && m.ramUsed ? clamp(Math.round((m.ramUsed / m.ramTotal) * 100), 0, 100)
    : (m.ram?.total && m.ram?.used ? clamp(Math.round((m.ram.used / m.ram.total) * 100), 0, 100) : 0)));

  const ramUsed = m.ramUsed || m.ram?.used;
  const ramTotal = m.ramTotal || m.ram?.total;

  const hasBattery = m.hasBattery || m.battery?.hasBattery;
  const batPct = typeof m.battery === 'number' ? clamp(Math.round(m.battery), 0, 100)
    : (m.battery?.charge != null ? clamp(Math.round(m.battery.charge), 0, 100)
    : (m.batteryPercent != null ? clamp(Math.round(m.batteryPercent), 0, 100) : null));

  const sysCpuEl = document.getElementById('sys-cpu-val');
  const sysProgCpuEl = document.getElementById('sys-progress-cpu');
  if (sysCpuEl) sysCpuEl.textContent = `${cpuPct}%`;
  if (sysProgCpuEl) sysProgCpuEl.style.width = `${cpuPct}%`;

  const sysRamEl = document.getElementById('sys-ram-val');
  const sysProgRamEl = document.getElementById('sys-progress-ram');
  if (sysRamEl) sysRamEl.textContent = `${ramPct}%`;
  if (sysProgRamEl) sysProgRamEl.style.width = `${ramPct}%`;
  const ramSub = document.getElementById('sys-ram-sub');
  if (ramSub && ramUsed && ramTotal) {
    ramSub.textContent = `${formatBytes(ramUsed)} / ${formatBytes(ramTotal)}`;
  }

  const sysBatEl = document.getElementById('sys-battery-val');
  const sysProgBatEl = document.getElementById('sys-progress-battery');
  const batSub = document.getElementById('sys-battery-sub');

  if (hasBattery && batPct !== null) {
    if (sysBatEl) sysBatEl.textContent = `${batPct}%`;
    if (sysProgBatEl) sysProgBatEl.style.width = `${batPct}%`;
    if (batSub) {
      batSub.textContent = m.batteryCharging ? 'Charging' : 'On battery';
    }
  } else {
    if (sysBatEl) sysBatEl.textContent = '100%';
    if (sysProgBatEl) sysProgBatEl.style.width = '100%';
    if (batSub) {
      batSub.textContent = 'Desktop / AC power';
    }
  }
}

/* ============================================================
   MODULE: DASHBOARD
   ============================================================ */

/** Render the recent activity feed */
function renderActivityFeed() {
  const feed = document.getElementById('activity-feed');
  if (!feed) return;
  if (state.activityLog.length === 0) {
    feed.innerHTML = '<li class="activity-item activity-empty">No recent activity yet.</li>';
    return;
  }
  feed.innerHTML = state.activityLog.slice(0, 15).map(entry => {
    const timeStr = entry.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<li class="activity-item activity-${esc(entry.type)}">
      <span>${timeStr}</span>
      <span>${esc(entry.message)}</span>
    </li>`;
  }).join('');
}

async function executeCommand() {
  const input = document.getElementById('command-input');
  const responseEl = document.getElementById('command-response');
  const text = input?.value?.trim();
  if (!text) { showToast('Please enter a command.', 'warning'); return; }

  if (!window.deskpilot?.ai?.command) {
    showToast('AI command not available. Check your setup.', 'error');
    return;
  }

  setLoading(true, 'Processing your command…');
  try {
    const result = await window.deskpilot.ai.command(text);
    setLoading(false);

    if (result) {
      responseEl.style.display = 'block';
      if (typeof result === 'object' && result.action) {
        responseEl.innerHTML = `<strong>Action:</strong> ${esc(result.action)}<br>${result.message ? esc(result.message) : ''}`;
        handleAIAction(result);
      } else if (typeof result === 'object' && result.response) {
        responseEl.textContent = result.response;
      } else if (typeof result === 'object' && result.message) {
        responseEl.textContent = result.message;
      } else {
        responseEl.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      }
      addActivity(`Command: "${text}"`, 'info');
    }
  } catch (err) {
    setLoading(false);
    showToast('Command failed: ' + err.message, 'error');
  }
}

/** Route AI action responses to appropriate module actions */
function handleAIAction(result) {
  if (!result.action) return;
  const action = result.action.toLowerCase();

  // App launch handling (e.g. "launch:chrome", "launch:notepad")
  if (action.startsWith('launch:') || action.startsWith('open:')) {
    const appToLaunch = action.replace(/^(?:launch|open):/, '').trim();
    launchApp(appToLaunch);
    return;
  }

  if (action.includes('organize')) switchSection('organizer');
  else if (action.includes('duplicate')) switchSection('duplicates');
  else if (action.includes('disk') || action.includes('drive')) switchSection('disk');
  else if (action.includes('system') || action.includes('health')) switchSection('system');
  else if (action.includes('clean')) performCleanTemp();
  else if (action.includes('lock')) performLock();
  else if (action.includes('bin') || action.includes('recycle')) performEmptyBin();
}

function initDashboard() {
  // Command bar
  const executeBtn = document.getElementById('btn-execute');
  const cmdInput   = document.getElementById('command-input');
  executeBtn?.addEventListener('click', executeCommand);
  cmdInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') executeCommand();
  });

  // Quick action buttons
  document.getElementById('qa-organize')?.addEventListener('click', () => {
    switchSection('organizer');
    // Pre-fill Downloads
    const input = document.getElementById('organizer-folder-input');
    if (input && !input.value) {
      resolvePresetFolder('downloads').then(p => { if (p) input.value = p; });
    }
  });
  document.getElementById('qa-duplicates')?.addEventListener('click', () => switchSection('duplicates'));
  document.getElementById('qa-cleantemp')?.addEventListener('click', performCleanTemp);
  document.getElementById('qa-emptybin')?.addEventListener('click', performEmptyBin);
  document.getElementById('qa-lock')?.addEventListener('click', performLock);

  // Start auto-refresh for dashboard metrics
  async function dashboardMetricsRefresh() {
    const m = await fetchMetrics();
    applyDashboardMetrics(m);
  }
  dashboardMetricsRefresh();
  state.dashboard.metricsInterval = setInterval(dashboardMetricsRefresh, 5000);
}

/* ============================================================
   MODULE: SMART ORGANIZER
   ============================================================ */

/** Returns a known folder path for preset names */
async function resolvePresetFolder(preset) {
  const api = window.riu || window.deskpilot;
  if (api?.paths?.get) {
    try {
      const paths = await api.paths.get();
      if (paths && paths[preset]) return paths[preset];
    } catch (_) {}
  }
  return '';
}

function renderOrganizerTable(moves) {
  const tbody = document.getElementById('organizer-table-body');
  const card  = document.getElementById('organizer-preview-card');
  if (!tbody || !card) return;

  if (!moves || moves.length === 0) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  tbody.innerHTML = moves.map(m => `
    <tr>
      <td>${esc(m.filename || m.file || '')}</td>
      <td><span class="path-truncated" title="${esc(m.src || '')}">${esc(m.src || '')}</span></td>
      <td><span class="path-truncated" title="${esc(m.dest || '')}">${esc(m.dest || '')}</span></td>
      <td><span class="badge">${esc(m.category || 'Other')}</span></td>
      <td>${formatBytes(m.size)}</td>
    </tr>
  `).join('');
}

function setOrganizerStatus(msg, type = '') {
  const el = document.getElementById('organizer-status');
  if (!el) return;
  el.textContent = msg;
  el.className   = `status-message ${type}`;
}

function initOrganizer() {
  const folderInput  = document.getElementById('organizer-folder-input');
  const browseBtn    = document.getElementById('organizer-browse-btn');
  const presetSelect = document.getElementById('organizer-preset-select');
  const scanBtn      = document.getElementById('organizer-scan-btn');
  const executeBtn   = document.getElementById('organizer-execute-btn');
  const undoBtn      = document.getElementById('organizer-undo-btn');

  browseBtn?.addEventListener('click', async () => {
    if (!window.deskpilot?.dialog?.openDirectory) {
      showToast('Dialog not available.', 'error'); return;
    }
    const path = await window.deskpilot.dialog.openDirectory();
    if (path && folderInput) folderInput.value = path;
  });

  presetSelect?.addEventListener('change', async () => {
    const val = presetSelect.value;
    if (!val) return;
    const path = await resolvePresetFolder(val);
    if (path && folderInput) folderInput.value = path;
    presetSelect.value = '';
  });

  scanBtn?.addEventListener('click', async () => {
    const folderPath = folderInput?.value?.trim();
    if (!folderPath) { showToast('Please select a folder to scan.', 'warning'); return; }
    if (!window.deskpilot?.organizer?.scan) {
      showToast('Organizer engine not available.', 'error'); return;
    }
    setLoading(true, 'Scanning folder…');
    setOrganizerStatus('Scanning…');
    try {
      const moves = await window.deskpilot.organizer.scan(folderPath);
      setLoading(false);
      state.organizer.currentMoves = moves || [];
      state.organizer.folderPath   = folderPath;
      state.organizer.scanned      = true;
      renderOrganizerTable(moves);
      if (executeBtn) executeBtn.disabled = !moves || moves.length === 0;
      setOrganizerStatus(
        moves && moves.length > 0
          ? `Found ${moves.length} file(s) to organize.`
          : 'No files to organize in this folder.',
        moves && moves.length > 0 ? 'success' : ''
      );
      addActivity(`Scanned "${folderPath}" — ${(moves||[]).length} files found.`, 'info');
    } catch (err) {
      setLoading(false);
      setOrganizerStatus('Scan failed: ' + err.message, 'error');
      showToast('Scan failed: ' + err.message, 'error');
    }
  });

  executeBtn?.addEventListener('click', async () => {
    if (!state.organizer.scanned || !state.organizer.currentMoves.length) return;
    if (!window.deskpilot?.organizer?.execute) {
      showToast('Organizer engine not available.', 'error'); return;
    }
    setLoading(true, 'Organizing files…');
    try {
      const result = await window.deskpilot.organizer.execute(
        state.organizer.folderPath,
        state.organizer.currentMoves
      );
      setLoading(false);
      showToast(result?.message || 'Files organized successfully!', 'success');
      addActivity(`Organized "${state.organizer.folderPath}"`, 'success');
      state.organizer.scanned = false;
      state.organizer.currentMoves = [];
      executeBtn.disabled = true;
      document.getElementById('organizer-preview-card').style.display = 'none';
      setOrganizerStatus('Organization complete.', 'success');
    } catch (err) {
      setLoading(false);
      showToast('Organize failed: ' + err.message, 'error');
      setOrganizerStatus('Error: ' + err.message, 'error');
    }
  });

  undoBtn?.addEventListener('click', async () => {
    if (!window.deskpilot?.organizer?.undo) {
      showToast('Undo not available.', 'error'); return;
    }
    const folderPath = folderInput?.value?.trim() || state.organizer.folderPath;
    if (!folderPath) { showToast('Select a folder first.', 'warning'); return; }
    setLoading(true, 'Undoing last organization…');
    try {
      const result = await window.deskpilot.organizer.undo(folderPath);
      setLoading(false);
      showToast(result?.message || 'Undo successful!', 'success');
      addActivity(`Undo last organize in "${folderPath}"`, 'info');
      setOrganizerStatus('Undo complete.', 'success');
    } catch (err) {
      setLoading(false);
      showToast('Undo failed: ' + err.message, 'error');
    }
  });
}

/* ============================================================
   MODULE: DUPLICATE FINDER
   ============================================================ */

function renderDuplicateGroups(groups) {
  const container = document.getElementById('duplicates-results');
  const selectBtn = document.getElementById('duplicates-selectall-btn');
  const deleteBtn = document.getElementById('duplicates-delete-btn');
  if (!container) return;

  state.duplicates.groups = groups || [];

  if (!groups || groups.length === 0) {
    container.innerHTML = '<div class="card"><p style="color:var(--text-secondary);text-align:center;padding:20px;">No duplicates found.</p></div>';
    if (selectBtn) selectBtn.disabled = true;
    if (deleteBtn) deleteBtn.disabled = true;
    return;
  }

  if (selectBtn) selectBtn.disabled = false;
  if (deleteBtn) deleteBtn.disabled = false;

  container.innerHTML = groups.map((group, gi) => {
    // Sort files by modified date descending (newest first)
    const sorted = [...(group.files || [])].sort((a, b) =>
      (b.modified || b.mtime || 0) - (a.modified || a.mtime || 0)
    );
    const rows = sorted.map((file, fi) => {
      const isNewest = fi === 0;
      return `
        <div class="duplicate-file-row">
          <input type="checkbox" class="dup-checkbox" data-group="${gi}" data-file="${fi}"
            data-path="${esc(file.path || file.src || '')}"
            ${isNewest ? '' : 'checked'}
            id="dup-${gi}-${fi}" />
          <label class="duplicate-filename" for="dup-${gi}-${fi}" title="${esc(file.path || '')}">
            ${esc(file.name || file.filename || '')}
          </label>
          <div class="duplicate-meta">
            <span>${formatBytes(file.size)}</span>
            ${isNewest ? '<span class="newest-badge">Newest</span>' : ''}
          </div>
        </div>`;
    }).join('');

    const totalSize = (group.files || []).reduce((s, f) => s + (f.size || 0), 0);
    return `
      <div class="duplicate-group-card">
        <div class="duplicate-group-header">
          Group ${gi + 1} &mdash; ${(group.files || []).length} files &mdash; ${formatBytes(totalSize)} each
        </div>
        ${rows}
      </div>`;
  }).join('');

  updateSpaceSavings();
}

function getCheckedDuplicatePaths() {
  return Array.from(document.querySelectorAll('.dup-checkbox:checked'))
    .map(cb => cb.dataset.path)
    .filter(Boolean);
}

function updateSpaceSavings() {
  const checked  = Array.from(document.querySelectorAll('.dup-checkbox:checked'));
  const totalSize = checked.reduce((s, cb) => {
    // Look up file size from groups
    const gi = parseInt(cb.dataset.group, 10);
    const fi = parseInt(cb.dataset.file, 10);
    const group = state.duplicates.groups[gi];
    if (!group) return s;
    const sorted = [...(group.files || [])].sort((a, b) =>
      (b.modified || b.mtime || 0) - (a.modified || a.mtime || 0)
    );
    return s + (sorted[fi]?.size || 0);
  }, 0);

  const savingsEl = document.getElementById('duplicates-savings');
  const valEl     = document.getElementById('duplicates-savings-val');
  if (savingsEl && valEl) {
    savingsEl.style.display = totalSize > 0 ? 'flex' : 'none';
    valEl.textContent = formatBytes(totalSize);
  }
}

function initDuplicateFinder() {
  const folderInput = document.getElementById('duplicates-folder-input');
  const browseBtn   = document.getElementById('duplicates-browse-btn');
  const scanBtn     = document.getElementById('duplicates-scan-btn');
  const selectBtn   = document.getElementById('duplicates-selectall-btn');
  const deleteBtn   = document.getElementById('duplicates-delete-btn');

  browseBtn?.addEventListener('click', async () => {
    if (!window.deskpilot?.dialog?.openDirectory) return;
    const path = await window.deskpilot.dialog.openDirectory();
    if (path && folderInput) folderInput.value = path;
  });

  scanBtn?.addEventListener('click', async () => {
    const folderPath = folderInput?.value?.trim();
    if (!folderPath) { showToast('Please select a folder to scan.', 'warning'); return; }
    if (!window.deskpilot?.duplicates?.scan) {
      showToast('Duplicate finder engine not available.', 'error'); return;
    }
    setLoading(true, 'Scanning for duplicates…');
    try {
      const groups = await window.deskpilot.duplicates.scan(folderPath);
      setLoading(false);
      state.duplicates.folderPath = folderPath;
      renderDuplicateGroups(groups);
      const count = (groups || []).reduce((n, g) => n + (g.files || []).length, 0);
      showToast(
        groups && groups.length > 0
          ? `Found ${groups.length} duplicate group(s) (${count} files).`
          : 'No duplicates found.',
        groups && groups.length > 0 ? 'warning' : 'success'
      );
      addActivity(`Duplicate scan: "${folderPath}" — ${(groups||[]).length} groups.`, 'info');
    } catch (err) {
      setLoading(false);
      showToast('Scan failed: ' + err.message, 'error');
    }
  });

  selectBtn?.addEventListener('click', () => {
    // Auto-check all except newest in each group
    document.querySelectorAll('.dup-checkbox').forEach(cb => {
      const fi = parseInt(cb.dataset.file, 10);
      cb.checked = fi !== 0; // 0 = newest (sorted newest first)
    });
    updateSpaceSavings();
  });

  // Live update savings when checkboxes change
  document.getElementById('duplicates-results')?.addEventListener('change', e => {
    if (e.target.classList.contains('dup-checkbox')) updateSpaceSavings();
  });

  deleteBtn?.addEventListener('click', async () => {
    const paths = getCheckedDuplicatePaths();
    if (!paths.length) { showToast('No files selected.', 'warning'); return; }
    if (!window.deskpilot?.duplicates?.delete) {
      showToast('Delete engine not available.', 'error'); return;
    }
    setLoading(true, `Moving ${paths.length} file(s) to Recycle Bin…`);
    try {
      const result = await window.deskpilot.duplicates.delete(paths);
      setLoading(false);
      showToast(result?.message || `${paths.length} file(s) moved to Recycle Bin.`, 'success');
      addActivity(`Deleted ${paths.length} duplicate(s).`, 'success');
      // Re-scan to refresh results
      const folderPath = state.duplicates.folderPath;
      if (folderPath && window.deskpilot?.duplicates?.scan) {
        const groups = await window.deskpilot.duplicates.scan(folderPath);
        renderDuplicateGroups(groups);
      } else {
        document.getElementById('duplicates-results').innerHTML = '';
      }
    } catch (err) {
      setLoading(false);
      showToast('Delete failed: ' + err.message, 'error');
    }
  });
}

/* ============================================================
   MODULE: DISK ANALYZER
   ============================================================ */

function getDriveBarClass(pct) {
  if (pct < 70) return 'drive-low';
  if (pct < 85) return 'drive-mid';
  return 'drive-high';
}

function renderDriveCards(drives) {
  const row = document.getElementById('drives-row');
  if (!row) return;
  if (!drives || drives.length === 0) {
    row.innerHTML = '<div class="drives-empty">No drives found.</div>';
    return;
  }
  row.innerHTML = drives.map(d => {
    const pct         = d.total > 0 ? Math.round(((d.total - d.free) / d.total) * 100) : 0;
    const barCls      = getDriveBarClass(pct);
    const used        = d.total - d.free;
    const rawLetter   = d.drive || d.letter || d.mount || '?';
    const driveTitle  = rawLetter.replace(/:+$/, '') + ':';
    return `
      <div class="drive-card">
        <div class="drive-letter">${esc(driveTitle)}</div>
        <div class="drive-label" title="${esc(d.label || '')}">${esc(d.label || 'Local Disk')}</div>
        <div class="drive-usage-bar">
          <div class="progress-bar ${barCls}" style="width:${pct}%;"></div>
        </div>
        <div class="drive-info">
          <span>${formatBytes(used)} used</span>
          <span>${formatBytes(d.total)} total</span>
        </div>
        <div class="drive-info" style="margin-top:4px;">
          <span style="color:var(--text-secondary);">${pct}% full</span>
          <span style="color:var(--text-secondary);">${formatBytes(d.free)} free</span>
        </div>
      </div>`;
  }).join('');
}

function renderLargestFilesTable(files) {
  const wrap  = document.getElementById('disk-results-wrap');
  const tbody = document.getElementById('disk-table-body');
  if (!wrap || !tbody) return;

  if (!files || files.length === 0) {
    wrap.style.display = 'none';
    showToast('No files found in that folder.', 'info');
    return;
  }

  wrap.style.display = 'block';
  tbody.innerHTML = files.map((f, i) => `
    <tr>
      <td style="color:var(--text-secondary);font-weight:600;">${i + 1}</td>
      <td>${esc(f.name || f.filename || '')}</td>
      <td><span class="path-truncated" title="${esc(f.path || '')}">${esc(f.path || '')}</span></td>
      <td style="font-weight:600;color:var(--accent-red);">${formatBytes(f.size)}</td>
      <td>
        <button class="btn-ghost btn-sm reveal-btn" data-path="${esc(f.path || '')}">Reveal</button>
      </td>
    </tr>
  `).join('');

  // Wire up reveal buttons
  tbody.querySelectorAll('.reveal-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const p = btn.dataset.path;
      if (!p) return;
      if (window.deskpilot?.disk?.reveal) {
        try { await window.deskpilot.disk.reveal(p); }
        catch (err) { showToast('Could not reveal file: ' + err.message, 'error'); }
      }
    });
  });
}

async function onDiskSectionShow() {
  // Auto-load drives on section show
  await refreshDrives();
}

async function refreshDrives() {
  if (!window.deskpilot?.disk?.getDrives) {
    document.getElementById('drives-row').innerHTML =
      '<div class="drives-empty">Drive info not available in this environment.</div>';
    return;
  }
  try {
    const drives = await window.deskpilot.disk.getDrives();
    renderDriveCards(drives);
  } catch (err) {
    showToast('Could not load drives: ' + err.message, 'error');
  }
}

function initDiskAnalyzer() {
  const folderInput = document.getElementById('disk-folder-input');
  const browseBtn   = document.getElementById('disk-browse-btn');
  const scanBtn     = document.getElementById('disk-scan-btn');
  const refreshBtn  = document.getElementById('disk-refresh-btn');

  refreshBtn?.addEventListener('click', refreshDrives);

  browseBtn?.addEventListener('click', async () => {
    if (!window.deskpilot?.dialog?.openDirectory) return;
    const path = await window.deskpilot.dialog.openDirectory();
    if (path && folderInput) folderInput.value = path;
  });

  scanBtn?.addEventListener('click', async () => {
    const folder = folderInput?.value?.trim();
    if (!folder) { showToast('Please select a folder to scan.', 'warning'); return; }
    if (!window.deskpilot?.disk?.getLargestFiles) {
      showToast('Disk analyzer not available.', 'error'); return;
    }
    setLoading(true, 'Scanning for largest files…');
    try {
      const files = await window.deskpilot.disk.getLargestFiles(folder);
      setLoading(false);
      renderLargestFilesTable(files);
      addActivity(`Disk scan: "${folder}" — ${(files||[]).length} files found.`, 'info');
    } catch (err) {
      setLoading(false);
      showToast('Scan failed: ' + err.message, 'error');
    }
  });
}

/* ============================================================
   MODULE: SYSTEM HEALTH
   ============================================================ */

async function onSystemSectionShow() {
  const m = await fetchMetrics();
  applySystemMetrics(m);

  // Start auto-refresh every 10s while section is active
  if (!state.system.metricsInterval) {
    state.system.metricsInterval = setInterval(async () => {
      if (state.currentSection !== 'system') {
        clearInterval(state.system.metricsInterval);
        state.system.metricsInterval = null;
        return;
      }
      const metrics = await fetchMetrics();
      applySystemMetrics(metrics);
    }, 10000);
  }
}

async function performCleanTemp() {
  if (!window.deskpilot?.system?.cleanTemp) {
    showToast('Clean Temp not available.', 'error'); return;
  }
  setLoading(true, 'Cleaning temporary files…');
  try {
    const result = await window.deskpilot.system.cleanTemp();
    setLoading(false);
    const msg = result?.message || result?.freed
      ? `Cleaned! Freed ${formatBytes(result.freed)}.`
      : 'Temp files cleaned.';
    showToast(msg, 'success');
    addActivity(msg, 'success');
    const el = document.getElementById('sys-temp-results');
    if (el) { el.textContent = msg; el.className = 'status-message success'; }
  } catch (err) {
    setLoading(false);
    showToast('Clean failed: ' + err.message, 'error');
  }
}

async function performEmptyBin() {
  if (!window.deskpilot?.system?.emptyBin) {
    showToast('Empty Bin not available.', 'error'); return;
  }
  setLoading(true, 'Emptying Recycle Bin…');
  try {
    const result = await window.deskpilot.system.emptyBin();
    setLoading(false);
    showToast(result?.message || 'Recycle Bin emptied.', 'success');
    addActivity('Recycle Bin emptied.', 'success');
  } catch (err) {
    setLoading(false);
    showToast('Empty Bin failed: ' + err.message, 'error');
  }
}

async function performLock() {
  if (!window.deskpilot?.system?.lock) {
    showToast('Lock not available.', 'error'); return;
  }
  try {
    await window.deskpilot.system.lock();
    addActivity('Workstation locked.', 'info');
  } catch (err) {
    showToast('Lock failed: ' + err.message, 'error');
  }
}

async function performVolume(action) {
  if (!window.deskpilot?.system?.volume) {
    showToast('Volume control not available.', 'error'); return;
  }
  try {
    await window.deskpilot.system.volume(action);
  } catch (err) {
    showToast('Volume control failed: ' + err.message, 'error');
  }
}

async function launchApp(appName) {
  if (!window.deskpilot?.system?.launch) {
    showToast('App launcher not available.', 'error'); return;
  }
  try {
    await window.deskpilot.system.launch(appName);
    addActivity(`Launched: ${appName}`, 'info');
  } catch (err) {
    showToast(`Could not launch ${appName}: ` + err.message, 'error');
  }
}

function initSystemHealth() {
  // Quick tool buttons
  document.getElementById('sys-cleantemp-btn')?.addEventListener('click', performCleanTemp);
  document.getElementById('sys-emptybin-btn')?.addEventListener('click', performEmptyBin);
  document.getElementById('sys-lock-btn')?.addEventListener('click', performLock);
  document.getElementById('sys-volup-btn')?.addEventListener('click', () => performVolume('up'));
  document.getElementById('sys-voldown-btn')?.addEventListener('click', () => performVolume('down'));
  document.getElementById('sys-volmute-btn')?.addEventListener('click', () => performVolume('mute'));

  // App launcher cards
  document.querySelectorAll('.app-launcher-card').forEach(card => {
    card.addEventListener('click', () => {
      const app = card.dataset.app;
      if (app) launchApp(app);
    });
  });
}

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  // Load persisted settings first
  await loadSettings();

  // Boot all modules
  initNavigation();
  initTitlebar();
  initSettings();
  initDashboard();
  initOrganizer();
  initDuplicateFinder();
  initDiskAnalyzer();
  initSystemHealth();

  // Show dashboard by default
  switchSection('dashboard');

  // Listen for navigation requests from Desktop Companion / Float Widget
  const api = window.riu || window.deskpilot;
  if (api?.onNavigate) {
    api.onNavigate((action) => {
      handleAIAction({ action });
    });
  }

  console.log('[Riu] UI initialised.');
});
