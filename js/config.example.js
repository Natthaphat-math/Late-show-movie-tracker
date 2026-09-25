// Copy this file to js/config.js and fill in your values.
// js/config.js is gitignored so your token and email never get committed.

// 1) TMDB v4 "API Read Access Token" (the long JWT-looking string, NOT the short v3 API key).
//    https://www.themoviedb.org/settings/api
export const TMDB_READ_TOKEN = "PASTE_YOUR_TMDB_V4_READ_ACCESS_TOKEN_HERE";

// 2) The only email allowed to use owner (Firestore) mode.
//    Must match the email in firestore.rules exactly.
export const OWNER_EMAIL = "YOUR_EMAIL_HERE";

// 3) Firebase web app config: Firebase console → Project settings → General →
//    "Your apps" → Web app → SDK setup and configuration → "Config".
//    Leave as null to run in local-only mode (no owner login button).
export const FIREBASE_CONFIG = null;
/* Example:
export const FIREBASE_CONFIG = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef123456"
};
*/
