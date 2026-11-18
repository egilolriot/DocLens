// DocLens — Firebase configuration.
//
// HOW TO CONNECT YOUR OWN FIREBASE PROJECT (AI Logic setup):
//   1. Go to https://console.firebase.google.com/ and create (or open) a
//      project, then register a Web App (Project settings > Your apps).
//   2. Copy the firebaseConfig object Firebase shows you and paste its
//      values over the placeholders below.
//   3. In the console, open Build > Firebase AI Logic, click "Get started",
//      and enable the Gemini Developer API backend (free tier, no billing
//      required). AI Logic is the Firebase service this app uses; the
//      Gemini Developer API key it uses is the apiKey below.
//   4. (Optional, recommended for production) Enable App Check
//      (Build > App Check) with a reCAPTCHA v3 site key and paste that key
//      into RECAPTCHA_V3_SITE_KEY below. Enforcement is configured in the
//      Firebase console, not in this file — see src/ai.js.
//
// SECURITY NOTE: the apiKey in a Firebase web config is a *public client
// identifier*, not a secret — it identifies your project to Google's APIs
// and is safe to ship in client code (Firebase's own docs say so). It is
// NOT a service-account key and cannot by itself administer your project.
// Even so: NEVER commit real service-account keys, Admin SDK credentials,
// or App Check debug tokens to this repo. Keep this file on placeholders
// until you configure your own project locally.
//
// Until real values are pasted in, the app runs in honest "demo" mode
// (extractive summaries, clearly labelled — see src/ai.js).

export const firebaseConfig = {
  apiKey: "AIzaSyC_ZLhxh3lf85fA151dB9uM2jBYiRbyd2A",
  authDomain: "doclens-f2998.firebaseapp.com",
  projectId: "doclens-f2998",
  storageBucket: "doclens-f2998.firebasestorage.app",
  messagingSenderId: "932045050708",
  appId: "1:932045050708:web:2cc6990497a84093776ec1",
  measurementId: "G-8M8VMFZW77",
};

/**
 * reCAPTCHA v3 site key for Firebase App Check (optional).
 * Leave as "" to skip App Check init (the app logs a warning and works
 * without it; enforcement, if any, is set in the Firebase console).
 * This is a public site key, not a secret — but never put a *secret* key
 * or any debug token string here.
 */
export const RECAPTCHA_V3_SITE_KEY = "6LckoyYuAAAAABwAL0z2LeBaZ6tDTkV9p2kenG4D";

/** Link shown by the UI help text for Firebase setup. */
export const FIREBASE_SETUP_URL = "https://console.firebase.google.com/";

/**
 * True while firebaseConfig still holds the placeholder values above.
 * The app uses this to decide between live Firebase AI Logic and the
 * honest extractive demo fallback (src/ai.js).
 */
export function isPlaceholderConfig() {
  return (
    typeof firebaseConfig?.apiKey !== "string" ||
    firebaseConfig.apiKey.startsWith("YOUR_")
  );
}
