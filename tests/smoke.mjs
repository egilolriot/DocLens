// DocLens smoke test — `npm test` / `node tests/smoke.mjs`.
//
// Phase 0 (kept from Worker A's UI-shell checks): static checks that the
// required files exist, the required DOM ids are present in index.html,
// and main.js imports the exact contract modules.
// Phase 1 (Playwright): serves the production build with `vite preview`,
// loads it in real Chromium, pastes ~120 words, and runs a full
// summarize round-trip.
//
// NOTE: in this environment there is no real Firebase project, so the app
// runs in DEMO mode. The browser checks therefore accept the demo badge
// and the extractive demo summary as a valid pass: they assert the result
// panel becomes visible and the summary text is non-empty — they do NOT
// assert any AI provenance. The `window.LanguageModel` probe is logged
// only and never fails the run.

import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEW_PORT = 4173;
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}`;
const RESULT_TIMEOUT_MS = 60_000;

let failures = 0;

function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------------------
// Phase 0 — static checks
// ---------------------------------------------------------------------------

const requiredFiles = [
  'index.html',
  'vite.config.js',
  'src/main.js',
  'src/styles.css',
  'src/ai.js',
  'src/docs.js',
  'src/history.js',
  'src/firebase-config.js',
];
for (const f of requiredFiles) check(`file exists: ${f}`, existsSync(join(root, f)));

const html = readFileSync(join(root, 'index.html'), 'utf8');
const requiredIds = [
  'status-banner', 'error-message', 'drop-zone', 'file-input', 'paste-area',
  'word-count', 'route-indicator', 'summarize-btn', 'progress-area',
  'progress-bar', 'progress-label', 'result-panel', 'inference-badge',
  'summary-text', 'key-points', 'reading-time', 'model-used',
  'history-list', 'clear-history',
];
for (const id of requiredIds) check(`DOM id present: #${id}`, html.includes(`id="${id}"`));

const main = readFileSync(join(root, 'src/main.js'), 'utf8');
for (const mod of ['./ai.js', './docs.js', './history.js']) {
  check(`main.js imports ${mod}`, main.includes(`from '${mod}'`));
}
check('demo-mode banner text present',
  main.includes('Demo mode — no Firebase project configured.'));
check('no secrets in main.js', !/api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]/i.test(main));

if (failures > 0) {
  console.error(`\n${failures} static smoke check(s) failed — not starting the browser run.`);
  process.exit(1);
}
console.log('Static checks passed — starting the browser run.\n');

// ---------------------------------------------------------------------------
// Phase 1 — Playwright browser checks
// ---------------------------------------------------------------------------

// ~120-word sample document (10 words x 12 repeats = 120 words).
const SAMPLE_SENTENCE = 'Privacy matters because documents often contain sensitive personal information today.';
const SAMPLE_TEXT = Array(12).fill(SAMPLE_SENTENCE).join(' ');
const SAMPLE_WORDS = SAMPLE_TEXT.trim().split(/\s+/).filter(Boolean).length;

let server = null;
let browser = null;

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Preview server did not respond at ${url} within ${timeoutMs / 1000}s: ${lastError?.message ?? 'unknown error'}`);
}

async function launchChromium() {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    // Fall back to the pre-installed full Chromium build if Playwright's
    // bundled browser lookup fails in this environment.
    const cached = join(
      process.env.HOME ?? '',
      '.cache/ms-playwright/chromium-1255/chrome-linux64/chrome',
    );
    console.log(`Default chromium.launch failed (${err.message}); retrying with cached executable: ${cached}`);
    return await chromium.launch({ headless: true, executablePath: cached });
  }
}

try {
  // Start the Vite preview server (serves the production build in dist/).
  // NOTE: spawn the vite binary directly (not via `npx`) so SIGTERM/SIGKILL
  // in the cleanup below reaches the actual server process. Spawning via
  // npx leaves an orphaned vite process that keeps the test alive forever.
  const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  server = spawn(process.execPath, [viteBin, 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[vite preview] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[vite preview] ${d}`));

  try {
    await waitForServer(PREVIEW_URL);
    check('preview server responds', true, PREVIEW_URL);
  } catch (err) {
    check('preview server responds', false, err.message);
    throw new Error('Preview server failed to start — run `npm run build` first (dist/ must exist).');
  }

  browser = await launchChromium();
  check('chromium launched', true);

  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err?.message ?? err)));

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const title = await page.title();
  check('page title contains DocLens', title.includes('DocLens'), `title="${title}"`);

  // Summarize button exists and starts disabled (no document loaded yet).
  const summarizeBtn = page.locator('#summarize-btn');
  check('#summarize-btn exists', (await summarizeBtn.count()) === 1);
  check('#summarize-btn initially disabled', await summarizeBtn.isDisabled());

  // Report (do not fail on) on-device Prompt API availability.
  const languageModelExists = await page.evaluate(() => 'LanguageModel' in window);
  console.log(`INFO  window.LanguageModel exists: ${languageModelExists} (logged only — not a pass/fail check)`);

  // Paste the sample document and check the live word count + routing.
  await page.fill('#paste-area', SAMPLE_TEXT);
  await page.waitForTimeout(300); // let the input handler update the UI
  const wordCountText = (await page.locator('#word-count').textContent()) ?? '';
  check('word count updates after paste', wordCountText.includes(String(SAMPLE_WORDS)),
    `#word-count="${wordCountText.trim()}" (expected ${SAMPLE_WORDS})`);
  const routeText = (await page.locator('#route-indicator').textContent()) ?? '';
  check('route indicator updates after paste', /on-device/i.test(routeText),
    `#route-indicator="${routeText.trim()}" (expected on-device for ${SAMPLE_WORDS} words)`);
  check('#summarize-btn enabled after paste', await summarizeBtn.isEnabled());

  // Run the summarize round-trip (demo mode: extractive fallback).
  await summarizeBtn.click();
  let resultVisible = false;
  try {
    await page.locator('#result-panel').waitFor({ state: 'visible', timeout: RESULT_TIMEOUT_MS });
    resultVisible = true;
  } catch {
    resultVisible = false;
  }
  check('#result-panel becomes visible (≤60s)', resultVisible);

  const summaryText = ((await page.locator('#summary-text').textContent()) ?? '').trim();
  check('summary text non-empty', summaryText.length > 0, `${summaryText.length} chars`);
  const badgeText = ((await page.locator('#inference-badge').textContent()) ?? '').trim();
  check('inference badge text present', badgeText.length > 0, `badge="${badgeText}" (demo mode badge accepted)`);

  check('no fatal JS errors (pageerror)', pageErrors.length === 0,
    pageErrors.length ? pageErrors.join(' | ') : 'none');
  if (consoleErrors.length > 0) {
    console.log(`INFO  console errors seen (non-fatal, logged only): ${consoleErrors.join(' | ')}`);
  }
} catch (err) {
  failures += 1;
  console.error(`\nFAIL  browser run aborted: ${err?.message ?? err}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      server.on('exit', resolve);
      setTimeout(resolve, 5000);
    });
    if (server.exitCode === null) server.kill('SIGKILL');
  }
}

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed.`);
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
process.exit(0);
