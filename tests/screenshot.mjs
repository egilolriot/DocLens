// Visual QA: screenshot the DocLens app (empty state + after a demo summary).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4177;
const URL = `http://localhost:${PORT}/`;
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.screenshot({ path: '/tmp/doclens-empty.png' });
  const text = 'DocLens is a privacy-first document reader. It summarizes documents on the device when possible, using Gemini Nano through Firebase AI Logic, and falls back to the cloud for long documents. Your files never leave your device during on-device summarization. The app shows a badge telling you where each summary was produced, and keeps a local history of your summaries. '.repeat(4);
  await page.fill('#paste-area', text);
  await page.click('#summarize-btn');
  await page.waitForSelector('#result-panel:not([hidden])', { timeout: 60000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/doclens-result.png', fullPage: true });
  console.log('screenshots saved: /tmp/doclens-empty.png, /tmp/doclens-result.png');
} finally {
  await browser.close();
  server.kill('SIGKILL');
}
