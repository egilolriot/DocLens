// src/docs.js — document text extraction, word counting, and routing.
//
// Part of DocLens. This module has no Firebase / network dependency:
// it only reads the file the user supplied and turns it into plain text.

import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Verified against the installed pdfjs-dist (6.5.438):
// `node_modules/pdfjs-dist/build/pdf.worker.min.mjs` exists, so the
// `?url` import above resolves under Vite and yields the worker URL.
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/** Maximum document size accepted for extraction (10 MB). */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** Word-count threshold: at or below this, the document routes on-device. */
export const ON_DEVICE_MAX_WORDS = 2000;

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown']);
const PDF_EXTENSIONS = new Set(['pdf']);

function getExtension(fileName) {
  const name = (fileName || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1);
}

/**
 * Extract plain text from a user-supplied file.
 *
 * Supported: `.txt` / `.md` (read directly) and `.pdf` (pdf.js, page by page).
 *
 * @param {File|Blob} file - the uploaded file (must have `.name` for typing)
 * @returns {Promise<{ text: string, fileName: string, pageCount: number }>}
 * @throws {Error} on unsupported types, oversized files, encrypted PDFs,
 *   unreadable PDFs, or documents with no extractable text.
 */
export async function extractTextFromFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('No file was provided. Choose a .txt, .md, or .pdf file.');
  }

  const fileName = file.name || 'document';
  const ext = getExtension(fileName);

  if (typeof file.size === 'number' && file.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `File "${fileName}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum size is 10 MB.`,
    );
  }

  let text;
  let pageCount;

  if (TEXT_EXTENSIONS.has(ext)) {
    text = await file.text();
    pageCount = 1;
  } else if (PDF_EXTENSIONS.has(ext)) {
    const result = await extractTextFromPdf(file);
    text = result.text;
    pageCount = result.pageCount;
  } else {
    throw new Error(
      `Unsupported file type ".${ext || '?'}" for "${fileName}". DocLens reads .txt, .md, and .pdf files.`,
    );
  }

  if (!text || !text.trim()) {
    throw new Error(
      `No text could be extracted from "${fileName}". The document may be empty or contain only images (scanned pages need OCR, which DocLens does not do).`,
    );
  }

  return { text: text.trim(), fileName, pageCount };
}

async function extractTextFromPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());

  let pdf;
  try {
    const loadingTask = pdfjsLib.getDocument({ data });
    pdf = await loadingTask.promise;
  } catch (err) {
    // pdf.js signals a password-protected file with a PasswordException.
    if (err && (err.name === 'PasswordException' || /password/i.test(err.message || ''))) {
      throw new Error(
        `PDF "${file.name || 'document'}" is encrypted / password-protected. DocLens cannot read encrypted PDFs — remove the password and try again.`,
      );
    }
    throw new Error(
      `Could not read PDF "${file.name || 'document'}": ${err && err.message ? err.message : 'unknown error'}. The file may be corrupt or not a valid PDF.`,
    );
  }

  try {
    const pageCount = pdf.numPages;
    const pages = [];
    for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => (item && typeof item.str === 'string' ? item.str : ''))
        .join(' ');
      pages.push(pageText);
    }
    return { text: pages.join('\n'), pageCount };
  } finally {
    // Free the worker / parsed document even if a page failed.
    if (pdf && typeof pdf.destroy === 'function') {
      await pdf.destroy().catch(() => {});
    }
  }
}

/**
 * Count the words in a text: split on whitespace, drop empties.
 *
 * @param {string} text
 * @returns {number} word count (0 for empty / non-string input)
 */
export function countWords(text) {
  if (typeof text !== 'string' || !text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Decide where a document should be summarized.
 *
 * Short documents (<= 2000 words) stay on-device: faster and private.
 * Long documents go to the cloud model, which handles long context.
 *
 * @param {string} text
 * @returns {{ route: 'on-device' | 'cloud', reason: string }}
 */
export function routeForDocument(text) {
  const words = countWords(text);
  if (words <= ON_DEVICE_MAX_WORDS) {
    return {
      route: 'on-device',
      reason: `Short document (${words} words) — summarized on-device for speed and privacy.`,
    };
  }
  return {
    route: 'cloud',
    reason: `Long document (${words} words) — cloud model handles long context.`,
  };
}
