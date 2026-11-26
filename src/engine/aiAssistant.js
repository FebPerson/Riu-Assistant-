/**
 * aiAssistant.js
 * DeskPilot — AI Assistant & Intent Engine
 *
 * Provides natural-language command processing with two layers:
 *   1. Fast offline regex-based intent matching (no network required).
 *   2. Cloud AI fallback: Google Gemini or Anthropic Claude when an API key
 *      is configured and no local intent is recognised.
 */

'use strict';

// ---------------------------------------------------------------------------
// INTENT_PATTERNS
// ---------------------------------------------------------------------------
/**
 * Ordered list of intent patterns.
 * Each entry maps a regex against user text to a DeskPilot action string.
 * Patterns are tested in order; the first match wins.
 *
 * @type {Array<{pattern: RegExp, action: string, description: string}>}
 */
const INTENT_PATTERNS = [
  // ── File Organizer ────────────────────────────────────────────────────────
  {
    pattern:     /organize.*(download)/i,
    action:      'organize:downloads',
    description: 'Organize the Downloads folder',
  },
  {
    pattern:     /organize.*(desktop)/i,
    action:      'organize:desktop',
    description: 'Organize the Desktop folder',
  },
  {
    pattern:     /sort.*(download)/i,
    action:      'organize:downloads',
    description: 'Sort files in the Downloads folder',
  },

  // ── Duplicate Finder ──────────────────────────────────────────────────────
  {
    pattern:     /find.*(duplic)/i,
    action:      'duplicates:scan',
    description: 'Scan for duplicate files',
  },

  // ── System Ops ───────────────────────────────────────────────────────────
  {
    pattern:     /clean.*(temp|cache)/i,
    action:      'system:cleanTemp',
    description: 'Clean temporary and cache files',
  },
  {
    pattern:     /empty.*(bin|recycle)/i,
    action:      'system:emptyBin',
    description: 'Empty the Recycle Bin',
  },
  {
    pattern:     /lock.*(screen|work)/i,
    action:      'system:lock',
    description: 'Lock the workstation',
  },
  {
    pattern:     /mute/i,
    action:      'system:mute',
    description: 'Toggle mute',
  },
  {
    pattern:     /volume.*(up)/i,
    action:      'system:volumeUp',
    description: 'Increase system volume',
  },
  {
    pattern:     /volume.*(down)/i,
    action:      'system:volumeDown',
    description: 'Decrease system volume',
  },

  // ── App Launcher (Universal) ─────────────────────────────────────────────
  {
    pattern:     /^(?:launch|open|start|run)\s+(?:the\s+)?([a-zA-Z0-9_\-\.\s]+)$/i,
    action:      (match) => `launch:${match[1].trim()}`,
    description: 'Launch an application by name',
  },

  // ── Disk Analyzer ─────────────────────────────────────────────────────────
  {
    pattern:     /disk|storage|drive/i,
    action:      'disk:analyze',
    description: 'Analyze disk usage',
  },
  {
    pattern:     /large.*(file)|big.*(file)/i,
    action:      'disk:largest',
    description: 'Find the largest files',
  },
];

// ---------------------------------------------------------------------------
// parseIntent
// ---------------------------------------------------------------------------
/**
 * Match user text against INTENT_PATTERNS and return the action string.
 *
 * @param {string} text - Raw user input.
 * @returns {string|null} The matched action string, or null if nothing matched.
 */
function parseIntent(text) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();
  for (const { pattern, action } of INTENT_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match) {
      if (typeof action === 'function') {
        return action(match);
      }
      return action;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// callGeminiAPI
// ---------------------------------------------------------------------------
/**
 * Send a prompt to the Google Gemini API (gemini-pro model) and return the
 * generated text response.
 *
 * API endpoint:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=<apiKey>
 *
 * @param {string} prompt  - The user's message / instruction.
 * @param {string} apiKey  - Google Gemini API key.
 * @returns {Promise<string>} The model's text reply.
 * @throws {Error} On network failure or non-2xx HTTP status.
 */
async function callGeminiAPI(prompt, apiKey) {
  // Use modern Gemini models with automatic fallback
  const candidateModels = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite'];
  let lastErr = null;

  for (const model of candidateModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature:     0.7,
        maxOutputTokens: 1024,
      },
    };

    try {
      const response = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        lastErr = new Error(`Gemini API error (${model}) ${response.status}: ${errorText}`);
        continue;
      }

      const data = await response.json();
      const text =
        data?.candidates?.[0]?.content?.parts?.[0]?.text ??
        data?.candidates?.[0]?.output ??
        '';

      if (text) return text.trim();
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('Could not connect to Gemini API');
}

// ---------------------------------------------------------------------------
// callClaudeAPI
// ---------------------------------------------------------------------------
/**
 * Send a prompt to the Anthropic Claude API and return the generated text.
 *
 * API endpoint:
 *   POST https://api.anthropic.com/v1/messages
 *
 * @param {string} prompt  - The user's message / instruction.
 * @param {string} apiKey  - Anthropic API key.
 * @returns {Promise<string>} The model's text reply.
 * @throws {Error} On network failure or non-2xx HTTP status.
 */
async function callClaudeAPI(prompt, apiKey) {
  const url  = 'https://api.anthropic.com/v1/messages';
  const body = {
    model:      'claude-3-haiku-20240307',   // fast & cost-effective default
    max_tokens: 1024,
    messages: [
      { role: 'user', content: prompt },
    ],
  };

  const response = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Claude API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();

  // content is an array of content blocks
  const text = data?.content?.[0]?.text ?? '';
  return text.trim();
}

// ---------------------------------------------------------------------------
// processCommand
// ---------------------------------------------------------------------------
/**
 * Process a natural-language command using a two-stage pipeline:
 *
 *   Stage 1 — Intent matching (offline, instant):
 *     If `text` matches a known INTENT_PATTERN, return an action descriptor
 *     immediately without touching the network.
 *
 *   Stage 2 — AI fallback (online, requires API key in settings):
 *     If no intent matched and an API key is available, forward the prompt to
 *     the configured AI provider (Gemini preferred, Claude as secondary).
 *     Returns the AI's free-text response.
 *
 *   Fallback:
 *     If neither stage produces a result, return a helpful unknown-command
 *     message.
 *
 * @param {string} text     - Raw user input.
 * @param {object} settings - Application settings object.
 * @param {string} [settings.geminiKey] - Google Gemini API key.
 * @param {string} [settings.claudeKey] - Anthropic Claude API key.
 * @returns {Promise<
 *   | { type: 'action',  action: string }
 *   | { type: 'ai',      response: string }
 *   | { type: 'unknown', message: string }
 * >}
 */
async function processCommand(text, settings = {}) {
  // ── Stage 1: Offline intent matching ──────────────────────────────────────
  const action = parseIntent(text);
  if (action) {
    return { type: 'action', action };
  }

  // ── Stage 2: AI fallback ──────────────────────────────────────────────────
  const { geminiKey, claudeKey } = settings;

  if (geminiKey) {
    try {
      const response = await callGeminiAPI(text, geminiKey);
      return { type: 'ai', response };
    } catch (err) {
      console.error('[aiAssistant] Gemini API call failed:', err.message);
      // Fall through to Claude if available
    }
  }

  if (claudeKey) {
    try {
      const response = await callClaudeAPI(text, claudeKey);
      return { type: 'ai', response };
    } catch (err) {
      console.error('[aiAssistant] Claude API call failed:', err.message);
    }
  }

  // ── Fallback: nothing matched ─────────────────────────────────────────────
  return {
    type:    'unknown',
    message: 'Sorry, I didn\'t understand that command. Try phrases like "organize downloads", "find duplicates", or "clean temp files".',
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  INTENT_PATTERNS,
  parseIntent,
  callGeminiAPI,
  callClaudeAPI,
  processCommand,
};
