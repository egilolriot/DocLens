// Probe: can Gemini Nano actually download + answer in this Chromium?
// Uses the raw Prompt API (window.LanguageModel) — the same API Firebase AI
// Logic wraps for on-device inference. No Firebase project needed.
// Prints progress events; times out after DOWNLOAD_TIMEOUT_MS.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4175;
const URL = `http://localhost:${PORT}/`;
const DOWNLOAD_TIMEOUT_MS = 300_000; // 5 min

const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const server = spawn(process.execPath, [viteBin, 'preview', '--port', String(PORT)], { cwd: root, stdio: 'ignore' });
async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(URL); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('preview server did not start');
}

const browser = await chromium.launch({ headless: true });
try {
  await waitForServer();
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[page]', m.type(), m.text().slice(0, 200)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const avail = await page.evaluate(() => window.LanguageModel?.availability?.());
  console.log('availability:', avail);
  if (avail === 'unavailable') {
    console.log('RESULT: on-device model unavailable in this Chromium — cannot test download.');
    process.exit(0);
  }
  console.log('Attempting LanguageModel.create() with progress monitor (timeout 5 min)...');
  const result = await page.evaluate(async (timeoutMs) => {
    const events = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const session = await window.LanguageModel.create({
        signal: controller.signal,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            events.push({ loaded: e.loaded, total: e.total });
          });
        },
      });
      clearTimeout(timer);
      const t0 = Date.now();
      const reply = await session.prompt('Say the word "DocLens" and nothing else.');
      return { ok: true, events: events.slice(-5), reply, ms: Date.now() - t0 };
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: String(e && e.name ? e.name + ': ' + e.message : e), events: events.slice(-5) };
    }
  }, DOWNLOAD_TIMEOUT_MS);
  console.log('RESULT:', JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  server.kill('SIGKILL');
}
