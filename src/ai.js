// DocLens — Firebase AI Logic service (Worker B).
//
// Summarizes a document with Gemini, hybrid on-device / in-cloud:
//   - short docs (<= WORD_LIMIT_ON_DEVICE words) -> on-device Gemini Nano
//     via the Chrome Prompt API, through Firebase AI Logic hybrid mode
//     (InferenceMode.PREFER_ON_DEVICE). The device model is downloaded on
//     first use, so initializeDeviceModel() must run after a user gesture
//     (the Summarize click) and before generateContent().
//   - long docs -> cloud gemini-2.5-flash (InferenceMode.PREFER_IN_CLOUD,
//     Gemini Developer API backend — free tier, no billing).
//
// If no real Firebase config is present (src/firebase-config.js still has
// placeholders), the app runs in DEMO mode: summarize() returns an honest
// extractive fallback (first sentences of the text) clearly labelled
// `inferenceSource: 'demo'`, `modelUsed: 'demo (extractive, no AI)'` —
// demo output is never presented as AI-generated.
//
// VERIFIED against installed firebase 13.4.0
// (node_modules/@firebase/ai/dist/ai-public.d.ts + dist/esm/index.esm.js):
//   - `Schema` is an abstract class with static builders:
//     Schema.object({ properties, optionalProperties }),
//     Schema.string({ description }), Schema.array({ items, minItems,
//     maxItems }), Schema.integer({ description }), Schema.number(),
//     Schema.boolean(), Schema.enumString(), Schema.anyOf().
//   - GenerationConfig.responseSchema accepts a TypedSchema (e.g. the
//     result of Schema.object()) when responseMimeType is
//     "application/json".
//   - HybridParams = { mode, onDeviceParams?, inCloudParams?: ModelParams }.
//     IMPORTANT: in hybrid mode, top-level keys other than mode /
//     onDeviceParams / inCloudParams are IGNORED (SDK logs a warning) —
//     so generationConfig MUST live inside inCloudParams, not at top
//     level. Both models below therefore put generationConfig inside
//     inCloudParams: { model, generationConfig }.
//   - `result.response` is an EnhancedGenerateContentResponse with a
//     text() helper and an `inferenceSource` property:
//     `result.response.inferenceSource` is "on_device" | "in_cloud"
//     (InferenceSource.ON_DEVICE / IN_CLOUD). The SDK sets it in
//     createEnhancedContentResponse(response, inferenceSource); the
//     hybrid dispatcher (callCloudOrDevice) reports the backend that
//     actually answered, so PREFER_ON_DEVICE falling back to cloud is
//     reported as "in_cloud". Default when unset is "in_cloud".
//     This accessor was verified in the SDK source (see lines
//     createEnhancedContentResponse / callCloudOrDevice in
//     @firebase/ai/dist/esm/index.esm.js) but NOT yet observed from a
//     live generateContent() call — no real Firebase project / API key
//     exists in this repo, so no live call was possible. summarize()
//     therefore logs Object.keys(result.response) + the value at runtime
//     and falls back to the intended route (with a console.warn) if the
//     accessor is ever absent/unknown.
//   - getAI(app, { backend: new GoogleAIBackend() }) selects the Gemini
//     Developer API. getGenerativeModel(ai, hybridParams) with a
//     `mode` creates the Chrome adapter only when window.LanguageModel
//     exists; otherwise calls go straight to cloud.
//   - window.LanguageModel.availability() resolves to
//     'available' | 'downloadable' | 'downloading' | 'unavailable'.
//
// Progress callback contract (matches src/main.js setProgress): onProgress
// receives a NUMBER 0–100 (percent). It is called during the on-device
// model download and once while generation runs. For cloud calls there is
// no download, so onProgress is called once at generation start.

import { initializeApp, getApp, getApps } from "firebase/app";
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  Schema,
} from "firebase/ai";
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
} from "firebase/app-check";
import {
  firebaseConfig,
  isPlaceholderConfig,
  RECAPTCHA_V3_SITE_KEY,
} from "./firebase-config.js";

/** Word-count threshold: docs at or under this go to the on-device model. */
export const WORD_LIMIT_ON_DEVICE = 2000;

/** Cloud model used for long documents. */
const CLOUD_MODEL = "gemini-2.5-flash";

/** Words-per-minute used for the reading-time estimate. */
const WORDS_PER_MINUTE = 200;

// ---------------------------------------------------------------------------
// Structured-output schema ({ summary, keyPoints[], readingMinutes }).
// Built with the verified firebase 13.4.0 Schema static builders.
// ---------------------------------------------------------------------------
const summarySchema = Schema.object({
  properties: {
    summary: Schema.string({
      description:
        "A concise summary of the document in the document's own language, 3-5 sentences.",
    }),
    keyPoints: Schema.array({
      items: Schema.string({
        description: "One key point from the document.",
      }),
      minItems: 3,
      maxItems: 6,
      description: "3-6 bullet key points from the document.",
    }),
    readingMinutes: Schema.integer({
      description:
        "Estimated reading time of the original document in whole minutes.",
    }),
  },
});

const generationConfig = {
  responseMimeType: "application/json",
  responseSchema: summarySchema,
};

// ---------------------------------------------------------------------------
// Cached instances (created once by initAI()).
// ---------------------------------------------------------------------------
let mode = null; // 'live' | 'demo' | null (not yet initialized)
let aiInstance = null;
let deviceModel = null; // PREFER_ON_DEVICE hybrid model
let cloudModel = null; // PREFER_IN_CLOUD hybrid model
let deviceModelReady = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function splitSentences(text) {
  const found = text.match(/[^.!?\n]+[.!?]+["')\]]*/g);
  if (found && found.length > 0) return found.map((s) => s.trim()).filter(Boolean);
  return [];
}

function isDevEnvironment() {
  try {
    // Vite sets import.meta.env.DEV; guard for non-Vite runtimes.
    if (typeof import.meta !== "undefined" && import.meta.env?.DEV) return true;
  } catch {
    // ignore — fall through to the hostname check
  }
  try {
    if (typeof location !== "undefined") {
      return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Best-effort App Check init. Skipped gracefully (warning only) when no
 * reCAPTCHA v3 site key is configured; enforcement happens in the Firebase
 * console, not in this code path. In dev, and only with a real config, the
 * Firebase App Check debug token is enabled via the boolean flag
 * `self.FIREBASE_APPCHECK_DEBUG_TOKEN = true` — no debug token *string*
 * is ever hardcoded anywhere in this repo.
 */
function tryInitAppCheck(app) {
  if (!RECAPTCHA_V3_SITE_KEY) {
    console.warn(
      "[DocLens] App Check skipped: no reCAPTCHA v3 site key configured " +
        "(RECAPTCHA_V3_SITE_KEY is empty in firebase-config.js). " +
        "Set one to enable App Check; enforcement is configured in the Firebase console.",
    );
    return;
  }
  try {
    if (isDevEnvironment()) {
      // Dev only, real config only (this function is never called in demo
      // mode). Boolean flag — Firebase generates/prints a debug token.
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(RECAPTCHA_V3_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
    console.log("[DocLens] App Check initialized (reCAPTCHA v3).");
  } catch (err) {
    // App Check must never break summarization; log and continue.
    console.warn("[DocLens] App Check init failed, continuing without it:", err);
  }
}

function buildPrompt(text, wordCount, readingMinutes) {
  return (
    "Summarize the document below. " +
    "Write the summary IN THE SAME LANGUAGE as the document. " +
    "Return ONLY a JSON object matching this shape, with no markdown fences, " +
    "no preamble, and no extra text: " +
    '{"summary": string, "keyPoints": string[], "readingMinutes": number}. ' +
    `The summary should be 3-5 sentences. keyPoints should be 3-6 short bullets. ` +
    `readingMinutes should be ${readingMinutes} (the document has about ${wordCount} words, ~200 words per minute). ` +
    "Document:\n\n" +
    text
  );
}

/** Strip ```json / ``` fences if the model wrapped its JSON in markdown. */
function stripMarkdownFences(raw) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseSummaryJson(rawText, wordCount, readingMinutes) {
  const cleaned = stripMarkdownFences(rawText);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.warn(
      "[DocLens] Model response was not valid JSON, falling back to raw text as summary.",
      err,
    );
    const sentences = splitSentences(cleaned);
    return {
      summary: sentences.slice(0, 3).join(" ") || cleaned.slice(0, 500),
      keyPoints: sentences.slice(0, 3),
      readingMinutes,
    };
  }
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : cleaned.slice(0, 500);
  const keyPoints = Array.isArray(parsed.keyPoints)
    ? parsed.keyPoints.filter((p) => typeof p === "string").map((p) => p.trim()).filter(Boolean).slice(0, 6)
    : [];
  const minutes =
    Number.isFinite(parsed.readingMinutes) && parsed.readingMinutes > 0
      ? Math.round(parsed.readingMinutes)
      : readingMinutes;
  return { summary, keyPoints, readingMinutes: minutes };
}

/** Honest extractive fallback used ONLY in demo mode (no Firebase config). */
function demoSummary(text, wordCount, readingMinutes) {
  const sentences = splitSentences(text);
  const summary =
    sentences.slice(0, 3).join(" ") || text.slice(0, 500).trim();
  const keyPoints =
    sentences.length > 0
      ? sentences.slice(0, 3)
      : [text.slice(0, 500).trim()].filter(Boolean);
  return {
    summary,
    keyPoints,
    readingMinutes,
    inferenceSource: "demo",
    modelUsed: "demo (extractive, no AI)",
    wordCount,
  };
}

function friendlyError(err) {
  const message = String(err?.message ?? err ?? "");
  const code = String(err?.code ?? "");
  const haystack = `${code} ${message}`;
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(haystack)) {
    return new Error(
      "AI quota exceeded (429). Please wait a bit and try again, or check the Firebase AI Logic quota in the Firebase console.",
    );
  }
  if (/API_NOT_ENABLED|api-not-enabled|not enabled|403/i.test(haystack)) {
    return new Error(
      "Firebase AI Logic / Gemini Developer API is not enabled for this project. Enable it in the Firebase console (Build > Firebase AI Logic).",
    );
  }
  if (/fetch|network|Failed to fetch|ERR_NETWORK|offline/i.test(haystack)) {
    return new Error(
      "Network error while contacting the AI service. Check your connection and try again.",
    );
  }
  if (/Local LanguageModel|ONLY_ON_DEVICE|on-device.*unavailable|download.*failed/i.test(haystack)) {
    return new Error(
      "The on-device model is unavailable in this browser (Gemini Nano needs Chrome with the Prompt API). Try a shorter document in Chrome, or use the cloud route.",
    );
  }
  if (/blocked|SAFETY|prompt.*blocked/i.test(haystack)) {
    return new Error(
      "The model declined this document (blocked by safety filters). Try a different document.",
    );
  }
  return new Error(`Summarization failed: ${message || "unknown error"}. Please try again.`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize Firebase + Firebase AI Logic (once; cached).
 * Demo mode (placeholder config): returns { mode: 'demo', ... } WITHOUT
 * initializing Firebase at all. Live mode initializes the app, attempts
 * App Check (best-effort), creates the AI service and both hybrid models.
 * Never throws in demo mode; throws only on real init failure, with a
 * clear message.
 */
export function initAI() {
  if (mode === "live" || mode === "demo") {
    return {
      mode,
      detail:
        mode === "demo"
          ? "Demo mode — no Firebase project configured. Summaries are extractive, not AI-generated."
          : "Live mode — Firebase AI Logic is configured.",
    };
  }

  if (isPlaceholderConfig()) {
    mode = "demo";
    return {
      mode: "demo",
      detail:
        "Demo mode — no Firebase project configured. Summaries are extractive, not AI-generated. " +
        "Add your Firebase config to src/firebase-config.js to enable AI summaries.",
    };
  }

  try {
    const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
    tryInitAppCheck(app);
    aiInstance = getAI(app, { backend: new GoogleAIBackend() });

    // NOTE: generationConfig MUST be inside inCloudParams for hybrid
    // models (verified: top-level keys are ignored by the SDK).
    deviceModel = getGenerativeModel(aiInstance, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      inCloudParams: { model: CLOUD_MODEL, generationConfig },
    });
    cloudModel = getGenerativeModel(aiInstance, {
      mode: InferenceMode.PREFER_IN_CLOUD,
      inCloudParams: { model: CLOUD_MODEL, generationConfig },
    });

    mode = "live";
    return {
      mode: "live",
      detail:
        "Live mode — Firebase AI Logic is configured. Short documents are summarized on-device; longer ones use the cloud.",
    };
  } catch (err) {
    console.error("[DocLens] Firebase AI init failed:", err);
    mode = null; // allow a later retry after the config is fixed
    throw new Error(
      `Could not initialize Firebase AI Logic: ${err?.message ?? err}. ` +
        "Check src/firebase-config.js (apiKey / projectId) and that Firebase AI Logic is enabled in the console.",
    );
  }
}

/**
 * Summarize `text`.
 * @param {string} text — document text to summarize.
 * @param {(percent: number) => void} [onProgress] — optional progress
 *   callback receiving a 0–100 percent (device-model download, then
 *   generation). Called with 90 while a cloud request is running.
 * @returns {Promise<{summary, keyPoints, readingMinutes, inferenceSource,
 *   modelUsed, wordCount}>}
 *   inferenceSource: 'on_device' | 'in_cloud' | 'demo'.
 *   modelUsed: 'gemini-nano (on-device)' | 'gemini-2.5-flash (cloud)' |
 *   'demo (extractive, no AI)'.
 */
export async function summarize(text, onProgress) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Nothing to summarize — please paste or upload a document first.");
  }
  const trimmed = text.trim();
  const wordCount = countWords(trimmed);
  const readingMinutes = Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE));

  // Ensure initialized (no-op if initAI() already ran; demo if placeholder).
  if (mode === null) initAI();

  if (mode === "demo") {
    return demoSummary(trimmed, wordCount, readingMinutes);
  }

  const useOnDevice = wordCount <= WORD_LIMIT_ON_DEVICE;
  const model = useOnDevice ? deviceModel : cloudModel;
  const intendedSource = useOnDevice ? "on_device" : "in_cloud";

  try {
    if (useOnDevice) {
      // MUST run after a user gesture (the Summarize click) and BEFORE
      // generateContent(). May download Gemini Nano on first use; the
      // SDK reports download progress as 0..1, forwarded as 0–80%.
      const reportDownload = (fraction) => {
        if (typeof onProgress === "function" && Number.isFinite(fraction)) {
          onProgress(Math.round(Math.min(1, Math.max(0, fraction)) * 80));
        }
      };
      await model.initializeDeviceModel(reportDownload);
      deviceModelReady = true;
    }

    if (typeof onProgress === "function") onProgress(90);

    const result = await model.generateContent(
      buildPrompt(trimmed, wordCount, readingMinutes),
    );

    // VERIFIED accessor (SDK source, firebase 13.4.0):
    // result.response.inferenceSource === 'on_device' | 'in_cloud'.
    // Log the keys + value at runtime so a future SDK change is visible.
    const responseKeys = Object.keys(result?.response ?? {});
    const rawSource = result?.response?.inferenceSource;
    console.log(
      "[DocLens] generateContent response keys:",
      responseKeys,
      "inferenceSource:",
      rawSource,
    );

    let inferenceSource;
    if (rawSource === "on_device" || rawSource === "in_cloud") {
      inferenceSource = rawSource;
      if (rawSource === "on_device") deviceModelReady = true;
    } else {
      // Accessor absent/unknown — fall back to the intended route and
      // say so loudly; do NOT silently claim the other backend ran.
      console.warn(
        "[DocLens] inferenceSource accessor unverified at runtime " +
          `(got ${JSON.stringify(rawSource)}); falling back to intended route '${intendedSource}'.`,
      );
      inferenceSource = intendedSource;
    }

    const parsed = parseSummaryJson(
      result.response.text(),
      wordCount,
      readingMinutes,
    );

    return {
      summary: parsed.summary,
      keyPoints: parsed.keyPoints,
      readingMinutes: parsed.readingMinutes,
      inferenceSource,
      modelUsed:
        inferenceSource === "on_device"
          ? "gemini-nano (on-device)"
          : "gemini-2.5-flash (cloud)",
      wordCount,
    };
  } catch (err) {
    console.error("[DocLens] summarize() failed:", err);
    throw friendlyError(err);
  }
}

/**
 * Current AI status. Async because the on-device availability probe
 * (window.LanguageModel.availability()) is async.
 * @returns {Promise<{mode, deviceModelReady, languageModelAvailable}>}
 *   mode: 'live' | 'demo'.
 *   deviceModelReady: true once initializeDeviceModel() has succeeded (or
 *   an on-device generation has succeeded) in this session.
 *   languageModelAvailable: 'available' | 'downloadable' | 'downloading' |
 *   'unavailable' (Chrome Prompt API), or 'unknown' when the API is
 *   absent (non-Chrome browsers) or the probe fails. Safe everywhere.
 */
export async function getAIStatus() {
  // Initialize if needed so `mode` reflects the real config; a failed
  // live init still means a real config exists (mode 'live', not ready).
  if (mode === null) {
    try {
      initAI();
    } catch (err) {
      console.warn("[DocLens] getAIStatus: init failed:", err);
      mode = "live";
    }
  }

  let languageModelAvailable = "unknown";
  try {
    const LanguageModel = globalThis.LanguageModel;
    if (LanguageModel?.availability) {
      const availability = await LanguageModel.availability();
      if (typeof availability === "string") languageModelAvailable = availability;
    }
  } catch (err) {
    console.warn("[DocLens] LanguageModel.availability() probe failed:", err);
    languageModelAvailable = "unknown";
  }

  return {
    mode: mode ?? (isPlaceholderConfig() ? "demo" : "live"),
    deviceModelReady,
    languageModelAvailable,
  };
}
