// DocLens — UI entry point (Worker A: UI shell).
//
// Wires the DOM to the shared interface contract:
//   src/ai.js      -> initAI(), summarize(text, onProgress), getAIStatus()
//   src/docs.js    -> extractTextFromFile(file), countWords(text), routeForDocument(text)
//   src/history.js -> saveSummary(entry), loadHistory(), clearHistory(), deleteHistoryItem(id)
//
// Flow: file select/drop (or paste) -> word count + routing indicator ->
// Summarize -> lazy initAI() -> summarize() with progress -> render result
// + badge -> save to history. Errors are always shown in #error-message.

import { initAI, summarize } from './ai.js';
import { extractTextFromFile, countWords, routeForDocument } from './docs.js';
import { saveSummary, loadHistory, clearHistory, deleteHistoryItem } from './history.js';

// ---------- DOM references ----------

const $ = (id) => document.getElementById(id);

const statusBanner = $('status-banner');
const errorBox = $('error-message');
const dropZone = $('drop-zone');
const fileInput = $('file-input');
const fileNameEl = $('file-name');
const pasteArea = $('paste-area');
const wordCountEl = $('word-count');
const routeIndicator = $('route-indicator');
const summarizeBtn = $('summarize-btn');
const progressArea = $('progress-area');
const progressBar = $('progress-bar');
const progressLabel = $('progress-label');
const resultPanel = $('result-panel');
const inferenceBadge = $('inference-badge');
const summaryText = $('summary-text');
const keyPointsEl = $('key-points');
const readingTimeEl = $('reading-time');
const modelUsedEl = $('model-used');
const historyList = $('history-list');
const historyEmpty = $('history-empty');
const clearHistoryBtn = $('clear-history');

// AI is initialized lazily on the first Summarize click, so the page
// loads fast and the on-device model download only starts when needed.
let aiInitialized = false;
let aiMode = 'demo';

// ---------- Helpers ----------

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.textContent = '';
  errorBox.hidden = true;
}

function setProgress(percent, label) {
  progressArea.hidden = false;
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  progressBar.style.width = `${clamped}%`;
  progressBar.setAttribute('aria-valuenow', String(clamped));
  if (label) progressLabel.textContent = label;
}

function hideProgress() {
  progressArea.hidden = true;
  progressBar.style.width = '0%';
  progressBar.setAttribute('aria-valuenow', '0');
}

// ---------- Document state ----------

/** Refresh word count, routing indicator, and Summarize button state. */
function refreshDocInfo() {
  const text = pasteArea.value;
  const words = countWords(text);
  wordCountEl.textContent = `${words.toLocaleString('en-US')} word${words === 1 ? '' : 's'}`;

  if (!text.trim()) {
    routeIndicator.textContent = 'No document loaded';
    routeIndicator.className = 'route-indicator';
    summarizeBtn.disabled = true;
    return;
  }

  const { route, reason } = routeForDocument(text);
  routeIndicator.textContent = route === 'on-device'
    ? `On-device summary — ${reason}`
    : `Cloud summary — ${reason}`;
  routeIndicator.className = `route-indicator ${route}`;
  summarizeBtn.disabled = false;
}

/** Load extracted text into the textarea and update the UI. */
function loadText(text, fileName) {
  pasteArea.value = text;
  if (fileName) {
    fileNameEl.textContent = `Loaded: ${fileName}`;
    fileNameEl.hidden = false;
  }
  refreshDocInfo();
}

/** Handle a file chosen via the picker or dropped onto the drop zone. */
async function handleFile(file) {
  if (!file) return;
  clearError();
  try {
    const { text, fileName } = await extractTextFromFile(file);
    if (!text || !text.trim()) {
      showError('Could not extract any text from that document. Try a different file or paste the text directly.');
      return;
    }
    loadText(text, fileName);
  } catch (err) {
    console.error('Failed to extract text:', err);
    showError(`Could not read "${file.name}": ${err?.message ?? 'unknown error'}. Try pasting the text instead.`);
  }
}

// ---------- Summarize flow ----------

async function onSummarize() {
  const text = pasteArea.value;
  if (!text.trim()) return;

  clearError();
  summarizeBtn.disabled = true;
  resultPanel.hidden = true;
  setProgress(5, 'Preparing…');

  try {
    // Lazy AI init (once per session).
    if (!aiInitialized) {
      setProgress(10, 'Initializing AI…');
      const status = initAI();
      aiMode = status.mode;
      aiInitialized = true;
      updateStatusBanner();
    }

    // summarize() reports progress via the callback, e.g. while the
    // on-device model downloads or the cloud request runs.
    const result = await summarize(text, (progress) => {
      if (typeof progress === 'number') {
        setProgress(progress, 'Summarizing…');
      } else if (progress && typeof progress === 'object') {
        setProgress(progress.percent ?? 50, progress.label ?? 'Summarizing…');
      }
    });

    renderResult(result);

    // Persist to history and refresh the list.
    saveSummary({
      id: Date.now().toString(36),
      title: (result.summary || text).slice(0, 80).trim(),
      summary: result.summary,
      keyPoints: result.keyPoints ?? [],
      readingMinutes: result.readingMinutes,
      inferenceSource: result.inferenceSource,
      modelUsed: result.modelUsed,
      wordCount: result.wordCount ?? countWords(text),
      createdAt: new Date().toISOString(),
    });
    renderHistory();
  } catch (err) {
    console.error('Summarization failed:', err);
    showError(`Summarization failed: ${err?.message ?? 'unknown error'}. Please try again.`);
  } finally {
    hideProgress();
    summarizeBtn.disabled = !pasteArea.value.trim();
  }
}

// ---------- Result rendering ----------

const BADGE_LABELS = {
  on_device: 'On-device',
  in_cloud: 'Cloud',
  demo: 'Demo',
};

function renderResult(result) {
  const source = result.inferenceSource ?? 'demo';
  inferenceBadge.textContent = BADGE_LABELS[source] ?? 'Demo';
  inferenceBadge.className = `badge badge-${source === 'on_device' ? 'on-device' : source === 'in_cloud' ? 'cloud' : 'demo'}`;

  summaryText.textContent = result.summary ?? '';
  keyPointsEl.innerHTML = '';
  for (const point of result.keyPoints ?? []) {
    const li = document.createElement('li');
    li.textContent = point;
    keyPointsEl.appendChild(li);
  }

  readingTimeEl.textContent = result.readingMinutes != null
    ? `Reading time: ~${result.readingMinutes} min`
    : '';
  modelUsedEl.textContent = result.modelUsed ? `Model: ${result.modelUsed}` : '';

  resultPanel.hidden = false;
  resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- Status banner ----------

function updateStatusBanner() {
  if (aiMode === 'demo') {
    statusBanner.textContent =
      'Demo mode — no Firebase project configured. Summaries are extractive placeholders, not AI summaries.';
    statusBanner.classList.add('is-demo');
    statusBanner.classList.remove('is-live');
  } else {
    statusBanner.textContent =
      'Live mode — Firebase AI Logic is configured. Short documents are summarized on-device; longer ones use the cloud.';
    statusBanner.classList.add('is-live');
    statusBanner.classList.remove('is-demo');
  }
}

// ---------- History ----------

function renderHistory() {
  let entries;
  try {
    entries = loadHistory() ?? [];
  } catch (err) {
    console.error('Failed to load history:', err);
    entries = [];
  }

  historyList.innerHTML = '';
  historyEmpty.hidden = entries.length > 0;

  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'history-item';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'history-item-btn';
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = entry.title || entry.summary?.slice(0, 60) || 'Summary';
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    const date = entry.createdAt ? new Date(entry.createdAt).toLocaleString('en-US') : '';
    const sourceLabel = BADGE_LABELS[entry.inferenceSource] ?? '';
    meta.textContent = [date, sourceLabel].filter(Boolean).join(' · ');
    openBtn.append(title, meta);
    openBtn.addEventListener('click', () => {
      clearError();
      renderResult(entry);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'history-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.setAttribute('aria-label', `Delete summary "${title.textContent}"`);
    deleteBtn.addEventListener('click', () => {
      deleteHistoryItem(entry.id);
      renderHistory();
    });

    li.append(openBtn, deleteBtn);
    historyList.appendChild(li);
  }
}

// ---------- Event wiring ----------

fileInput.addEventListener('change', () => handleFile(fileInput.files?.[0]));

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});
dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFile(event.dataTransfer?.files?.[0]);
});

pasteArea.addEventListener('input', () => {
  clearError();
  refreshDocInfo();
});

summarizeBtn.addEventListener('click', onSummarize);

clearHistoryBtn.addEventListener('click', () => {
  clearHistory();
  renderHistory();
});

// ---------- Init ----------

renderHistory();
refreshDocInfo();
