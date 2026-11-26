/**
 * geminiLive.js
 * Riu — Gemini Live & Streaming Multimodal Engine
 *
 * Supports:
 *  1. Real-time SSE streaming via `gemini-2.5-flash:streamGenerateContent?alt=sse`
 *     for both text and multimodal microphone audio (`audio/webm`).
 *  2. Optional WebSocket `BidiGenerateContent` Live API session when a
 *     Live-enabled model/key is used.
 *  3. Action extraction so spoken or natural-language requests can trigger
 *     local Riu desktop actions (open apps, clean temp, empty bin, lock, etc.).
 */

'use strict';

const SYSTEM_PROMPT = [
  'You are Riu, a concise Windows desktop assistant.',
  'If the user asks to perform a Windows desktop action, include one line at the very start in the exact format:',
  'ACTION:<action_name>',
  'Supported actions:',
  '- ACTION:clean_temp (clean temporary files)',
  '- ACTION:empty_bin (empty recycle bin)',
  '- ACTION:lock_screen (lock workstation)',
  '- ACTION:mute (mute/unmute audio)',
  '- ACTION:organize_downloads (open smart file organizer)',
  '- ACTION:find_duplicates (open duplicate finder)',
  '- ACTION:disk_analyzer (open disk analyzer)',
  '- ACTION:open:<app_name> (launch any Windows app by name, e.g. ACTION:open:chrome)',
  'Then give a brief 1-2 sentence confirmation or answer. Keep replies short and direct.',
].join('\n');

/**
 * Parse an optional ACTION:<name> directive from the model's response.
 * @param {string} fullText
 * @returns {{ action: string|null, cleanText: string }}
 */
function parseActionDirective(fullText) {
  if (!fullText) return { action: null, cleanText: '' };
  const match = fullText.match(/^ACTION:([^\r\n]+)/i);
  if (!match) return { action: null, cleanText: fullText.trim() };

  const action = match[1].trim();
  const cleanText = fullText.slice(match[0].length).trim();
  return { action, cleanText: cleanText || `Executed ${action}` };
}

/**
 * Stream a text or multimodal audio prompt through Gemini 2.5 Flash SSE streaming.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.text]
 * @param {string} [opts.audioBase64]
 * @param {string} [opts.audioMimeType='audio/webm']
 * @param {(chunk: string, accumulated: string) => void} [opts.onChunk]
 * @returns {Promise<{ text: string, action: string|null, model: string }>}
 */
async function streamLiveResponse({ apiKey, text, audioBase64, audioMimeType = 'audio/webm', onChunk }) {
  if (!apiKey) {
    throw new Error('Gemini API key is not configured in Settings');
  }

  const parts = [];
  if (audioBase64) {
    parts.push({
      inlineData: {
        mimeType: audioMimeType,
        data: audioBase64,
      },
    });
    parts.push({
      text: text || 'Listen to the user audio and respond or emit an ACTION directive if requested.',
    });
  } else if (text) {
    parts.push({ text });
  } else {
    throw new Error('No text or audio input provided');
  }

  const candidateModels = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite'];
  let lastErr = null;

  for (const model of candidateModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const body = {
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.5,
        maxOutputTokens: 512,
      },
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        lastErr = new Error(`Gemini Live error (${model}) ${response.status}: ${errText}`);
        continue;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (delta) {
              accumulated += delta;
              if (typeof onChunk === 'function') {
                const { cleanText } = parseActionDirective(accumulated);
                onChunk(delta, cleanText);
              }
            }
          } catch (_) {
            // Ignore partial JSON frames
          }
        }
      }

      const { action, cleanText } = parseActionDirective(accumulated);
      return { text: cleanText, action, model };
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('Failed to reach Gemini Live streaming endpoint');
}

/**
 * Wrap raw 16-bit signed little-endian mono PCM bytes in a standard 44-byte WAV header.
 * @param {Buffer} pcmBuffer
 * @param {number} [sampleRate=24000]
 * @returns {Buffer}
 */
function _pcmToWav(pcmBuffer, sampleRate = 24000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);            // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20);             // AudioFormat (1 = PCM)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Synthesize natural human-sounding speech using Gemini 2.5 Flash Preview TTS.
 * Returns a base64 WAV audio payload ready to play in an HTML5 <audio> element.
 *
 * @param {string} text
 * @param {string} apiKey
 * @param {string} [voiceName='Aoede']
 * @returns {Promise<{ audioBase64: string, mimeType: string }>}
 */
async function synthesizeSpeech(text, apiKey, voiceName = 'Aoede') {
  if (!apiKey) throw new Error('Gemini API key is required for TTS');
  if (!text || !text.trim()) throw new Error('Text is required for TTS');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: `Speak naturally and warmly: ${text.trim()}` }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`Gemini TTS error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const inline = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inline || !inline.data) {
    throw new Error('No audio returned by Gemini TTS');
  }

  const pcmBuf = Buffer.from(inline.data, 'base64');
  // Parse sample rate if present in mimeType (e.g. audio/L16;codec=pcm;rate=24000)
  const rateMatch = String(inline.mimeType || '').match(/rate=(\d+)/i);
  const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
  const wavBuf = _pcmToWav(pcmBuf, sampleRate);

  return {
    audioBase64: wavBuf.toString('base64'),
    mimeType: 'audio/wav',
  };
}

/**
 * Build the official BidiGenerateContent WebSocket URL for Gemini Live API.
 * Available for keys with Live WebSocket model access.
 *
 * @param {string} apiKey
 * @returns {string}
 */
function getLiveWebSocketUrl(apiKey) {
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
}

module.exports = {
  streamLiveResponse,
  parseActionDirective,
  synthesizeSpeech,
  getLiveWebSocketUrl,
};
