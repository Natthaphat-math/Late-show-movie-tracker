// Firebase (Auth + Firestore), loaded lazily.
//
// Visitors never download or talk to Firebase: the SDK is only imported when
//   - the page was opened from a sign-in email link, or
//   - this browser has signed in as the owner before (flag below), or
//   - someone clicks the owner sign-in button.

const SDK = "https://www.gstatic.com/firebasejs/10.14.1";
const OWNER_FLAG = "movieTracker.ownerDevice";
const EMAIL_KEY = "movieTracker.emailForSignIn";

let fb = null;

export function shouldAutoLoadFirebase() {
  let flagged = false;
  try { flagged = localStorage.getItem(OWNER_FLAG) === "1"; } catch {}
  const url = new URL(location.href);
  return flagged || (url.searchParams.get("mode") === "signIn" && url.searchParams.has("oobCode"));
}

export async function loadFirebase(config) {
  if (fb) return fb;
  const [app, auth, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const appInst = app.initializeApp(config);
  fb = {
    auth: auth.getAuth(appInst),
    db: fs.getFirestore(appInst),
    authMod: auth,
    // Firestore functions handed to createFirestoreAdapter():
    collection: fs.collection,
    doc: fs.doc,
    getDocs: fs.getDocs,
    setDoc: fs.setDoc,
    deleteDoc: fs.deleteDoc,
  };
  return fb;
}

export function onOwnerAuth(callback) {
  return fb.authMod.onAuthStateChanged(fb.auth, callback);
}

export async function sendOwnerLink(email) {
  const settings = { url: location.origin + location.pathname, handleCodeInApp: true };
  await fb.authMod.sendSignInLinkToEmail(fb.auth, email, settings);
  try { localStorage.setItem(EMAIL_KEY, email); } catch {}
}

/**
 * If the current URL is a sign-in link, completes sign-in.
 * askEmail() is called when the link was opened on a different device.
 */
export async function completeLinkSignIn(askEmail) {
  if (!fb.authMod.isSignInWithEmailLink(fb.auth, location.href)) return false;
  let email = null;
  try { email = localStorage.getItem(EMAIL_KEY); } catch {}
  if (!email) email = await askEmail();
  if (!email) return false;
  try {
    await fb.authMod.signInWithEmailLink(fb.auth, email, location.href);
    try { localStorage.removeItem(EMAIL_KEY); } catch {}
  } finally {
    // Strip the one-time code from the address bar either way.
    history.replaceState(null, "", location.origin + location.pathname);
  }
  return true;
}

export function markOwnerDevice(on) {
  try {
    if (on) localStorage.setItem(OWNER_FLAG, "1");
    else localStorage.removeItem(OWNER_FLAG);
  } catch {}
}

export async function signOutOwner() {
  markOwnerDevice(false);
  if (fb) await fb.authMod.signOut(fb.auth);
}
