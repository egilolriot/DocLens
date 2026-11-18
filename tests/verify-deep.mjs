// Deep verification for DocLens (parent integration check).
// Checks beyond tests/smoke.mjs:
//  1. window.LanguageModel presence + availability() value in this Chromium.
//  2. PDF upload end-to-end (generates a tiny valid PDF in-memory, uploads it).
//  3. Long-document routing (>2000 words -> cloud route indicator).
//  4. History persistence across reload.
//  5. No pageerror / failed requests.
// Usage: node tests/verify-deep.mjs  (run from repo root; starts vite preview itself)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const PORT = 4174;
const URL = `http://localhost:${PORT}/`;
let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
}

function waitForServer(proc, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      fetch(URL).then((r) => (r.ok ? resolve() : setTimeout(tick, 500))).catch(() => {
        if (Date.now() - start > timeoutMs) reject(new Error('preview server did not start'));
        else setTimeout(tick, 500);
      });
    };
    tick();
  });
}

// Minimal valid 1-page PDF containing "Hello DocLens PDF world."
function makePdf() {
  const text = 'Hello DocLens PDF world. This is a test document for DocLens.';
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const server = spawn(process.execPath, [viteBin, 'preview', '--port', String(PORT)], { cwd: root, stdio: 'ignore' });
let browser;
try {
  await waitForServer(server);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle' });
  check('page loads, title contains DocLens', (await page.title()).includes('DocLens'), await page.title());

  // 1. LanguageModel / Prompt API availability
  const lm = await page.evaluate(async () => {
    const out = { hasLanguageModel: typeof window.LanguageModel !== 'undefined' };
    if (out.hasLanguageModel) {
      try { out.availability = await window.LanguageModel.availability(); } catch (e) { out.availabilityError = String(e); }
      try {
        out.params = await window.LanguageModel.params().catch(() => null);
      } catch (e) { /* ignore */ }
    }
    out.userAgent = navigator.userAgent;
    return out;
  });
  console.log('  LanguageModel probe:', JSON.stringify(lm));
  check('window.LanguageModel exists', lm.hasLanguageModel === true);
  // Log availability value without failing (environment-dependent).
  console.log(`  INFO  LanguageModel.availability() = ${lm.availability ?? 'n/a'}`);

  // 2. PDF upload
  const pdfPath = '/tmp/doclens-test.pdf';
  fs.writeFileSync(pdfPath, makePdf());
  await page.setInputFiles('#file-input', pdfPath);
  await page.waitForTimeout(3000);
  const pasted = await page.inputValue('#paste-area');
  check('PDF text extracted into textarea', pasted.includes('Hello DocLens PDF world'), JSON.stringify(pasted.slice(0, 80)));
  const wc = await page.textContent('#word-count');
  check('word count shown after PDF upload', /[1-9]\d* words/.test(wc || ''), wc);

  // 3. Long-document routing
  const longText = ('The quick brown fox jumps over the lazy dog. '.repeat(260)).trim(); // ~2340 words
  await page.fill('#paste-area', longText);
  await page.waitForTimeout(500);
  const route = await page.textContent('#route-indicator');
  check('long doc routes to cloud', (route || '').toLowerCase().includes('cloud'), route);
  const wcLong = await page.textContent('#word-count');
  console.log(`  INFO  long doc word count: ${wcLong}`);

  // 4. Summarize (demo mode) + history persistence
  await page.click('#summarize-btn');
  await page.waitForSelector('#result-panel:not([hidden])', { timeout: 60000 }).catch(() => null);
  const resultVisible = await page.isVisible('#result-panel');
  check('result panel visible after summarize', resultVisible);
  const summary = await page.textContent('#summary-text');
  check('summary non-empty', (summary || '').trim().length > 20, `${(summary || '').length} chars`);
  const badge = await page.textContent('#inference-badge');
  console.log(`  INFO  inference badge: ${badge}`);
  check('badge present', (badge || '').trim().length > 0);
  const histCount = await page.locator('#history-list > *').count();
  check('history entry saved', histCount >= 1, `${histCount} items`);
  await page.reload({ waitUntil: 'networkidle' });
  const histAfter = await page.locator('#history-list > *').count();
  check('history persists across reload', histAfter >= 1, `${histAfter} items`);

  check('no page errors during deep verification', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  deep verification threw: ' + e.message);
  failures++;
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}
console.log(failures === 0 ? '\nDEEP VERIFY: ALL PASS' : `\nDEEP VERIFY: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
