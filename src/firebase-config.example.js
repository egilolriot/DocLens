// DocLens — Firebase configuration (CONTRIBUTOR TEMPLATE).
//
// Copy this file to `firebase-config.js` and fill in the values from your
// own Firebase project (Project settings > Your apps), then enable
// Firebase AI Logic with the Gemini Developer API backend in the console:
// https://console.firebase.google.com/
//
// The apiKey below is a public client identifier, not a secret — but NEVER
// commit real service-account keys, Admin SDK credentials, or App Check
// debug tokens. See firebase-config.js for the full setup notes.

export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
  measurementId: "",
};

/**
 * reCAPTCHA v3 site key for Firebase App Check (optional).
 * Leave as "" to skip App Check init.
 */
export const RECAPTCHA_V3_SITE_KEY = "";

/** Link shown by the UI help text for Firebase setup. */
export const FIREBASE_SETUP_URL = "https://console.firebase.google.com/";

/**
 * True while firebaseConfig still holds placeholder/empty values.
 */
export function isPlaceholderConfig() {
  return (
    typeof firebaseConfig?.apiKey !== "string" ||
    firebaseConfig.apiKey === "" ||
    firebaseConfig.apiKey.startsWith("YOUR_")
  );
}
