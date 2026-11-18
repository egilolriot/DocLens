// src/history.js — local summary history for DocLens.
//
// Summaries are stored only in the user's own browser (localStorage),
// never sent anywhere. Every function is safe when localStorage is
// unavailable (private mode, disabled storage, SSR): it falls back to
// an in-memory store and never throws.

const STORAGE_KEY = 'doclens-history-v1';
export const MAX_HISTORY_ENTRIES = 20;

// In-memory fallback used when localStorage is unavailable or throws.
let memoryStore = [];

/**
 * @typedef {Object} HistoryEntry
 * @property {string} id
 * @property {string} title
 * @property {string} dateISO
 * @property {number} wordCount
 * @property {string} inferenceSource - e.g. 'on-device' | 'cloud' | 'demo'
 * @property {string} modelUsed
 * @property {string} summary
 * @property {string[]} keyPoints
 * @property {number} readingMinutes
 */

function storageAvailable() {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

function readStored() {
  if (!storageAvailable()) return [...memoryStore];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    // Corrupt data: return an empty history rather than crashing.
    return [];
  }
}

function writeStored(entries) {
  memoryStore = [...entries];
  if (!storageAvailable()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage full / blocked: the in-memory copy still holds the data
    // for this session; do not throw.
  }
}

function generateId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the Date.now-based id.
  }
  return `doclens-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Save a summary to history (newest first, capped at 20 entries).
 * Missing `id` / `dateISO` are filled in automatically. Any extra fields
 * the caller passes (e.g. `createdAt` from the UI) are preserved as-is.
 *
 * @param {Partial<HistoryEntry> & Record<string, unknown>} entry
 * @returns {HistoryEntry} the stored entry (with id and dateISO set)
 */
export function saveSummary(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('saveSummary requires a summary entry object.');
  }
  const stored = {
    ...entry,
    id: entry.id || generateId(),
    title: entry.title || 'Untitled document',
    dateISO: entry.dateISO || entry.createdAt || new Date().toISOString(),
    wordCount: typeof entry.wordCount === 'number' ? entry.wordCount : 0,
    inferenceSource: entry.inferenceSource || 'unknown',
    modelUsed: entry.modelUsed || 'unknown',
    summary: entry.summary || '',
    keyPoints: Array.isArray(entry.keyPoints) ? entry.keyPoints : [],
    readingMinutes: typeof entry.readingMinutes === 'number' ? entry.readingMinutes : 0,
  };
  const history = readStored();
  history.unshift(stored);
  writeStored(history.slice(0, MAX_HISTORY_ENTRIES));
  return stored;
}

/**
 * Load the saved history, newest first.
 * Returns [] when nothing is stored or the stored data is corrupt.
 *
 * @returns {HistoryEntry[]}
 */
export function loadHistory() {
  return readStored();
}

/** Remove all saved summaries. */
export function clearHistory() {
  memoryStore = [];
  if (!storageAvailable()) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore: nothing to clear, or storage is blocked.
  }
}

/**
 * Delete a single history item by id.
 *
 * @param {string} id
 * @returns {boolean} true if an item was removed, false otherwise
 */
export function deleteHistoryItem(id) {
  const history = readStored();
  const next = history.filter((item) => item && item.id !== id);
  const removed = next.length !== history.length;
  if (removed) writeStored(next);
  return removed;
}
