// Probe Gemini Nano in REAL Google Chrome (system install).
// Uses Playwright with executablePath=/usr/bin/google-chrome-stable.
// If the model truly downloads, progress events will show large totals and
// the prompt reply will be a real generation (not an echo).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4176;
const URL = `http://localhost:${PORT}/`;
const DOWNLOAD_TIMEOUT_MS = 600_000; // 10 min

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

const browser = await chromium.launchPersistentContext('/tmp/chrome-headed-profile', {
  headless: false,
  executablePath: '/usr/bin/google-chrome-stable',
  args: [
    '--no-sandbox',
    '--enable-features=PromptAPIForGeminiNanoMultimodalInput,OptimizationGuideModelExecution',
    '--enable-unsafe-swiftshader',
  ],
});
try {
  await waitForServer();
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const ua = await page.evaluate(() => navigator.userAgent);
  console.log('UA:', ua);
  const avail = await page.evaluate(() => window.LanguageModel?.availability?.());
  console.log('availability:', avail);
  if (avail === 'unavailable' || avail === undefined) {
    console.log('RESULT: model unavailable in this Chrome — on-device cannot be tested here.');
    process.exitCode = 0;
  } else {
    console.log('Attempting LanguageModel.create() (timeout 10 min, progress logged)...');
    const result = await page.evaluate(async (timeoutMs) => {
      const events = [];
      let lastLog = 0;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const session = await window.LanguageModel.create({
          signal: controller.signal,
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => {
              const now = Date.now();
              if (now - lastLog > 5000 || e.loaded === e.total) {
                events.push({ loaded: e.loaded, total: e.total, at: new Date().toISOString() });
                lastLog = now;
              }
            });
          },
        });
        clearTimeout(timer);
        const t0 = Date.now();
        const reply = await session.prompt('In one short sentence, what is photosynthesis?');
        return { ok: true, events, reply, ms: Date.now() - t0 };
      } catch (e) {
        clearTimeout(timer);
        return { ok: false, error: String(e && e.name ? e.name + ': ' + e.message : e), events };
      }
    }, DOWNLOAD_TIMEOUT_MS);
    console.log('RESULT:', JSON.stringify(result, null, 2));
  }
} finally {
  await browser.close();
  server.kill('SIGKILL');
}
