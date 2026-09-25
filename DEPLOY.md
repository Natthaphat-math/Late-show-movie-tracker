# Deploying to GitHub Pages

This repo is **public**. Your TMDB token, owner email and Firebase config never go into it:
they live in GitHub **Secrets**, and the workflow in `.github/workflows/deploy-pages.yml` writes
`js/config.js` only inside the deploy job.

> The token and config still end up in the live site's JavaScript, where anyone can read them in
> DevTools. That can't be avoided in a client-only app. What protects your data is the Firestore security
> rules, plus the API key restrictions below.

Site URL: **https://natthaphat-math.github.io/Late-show-movie-tracker/**

## 1. Add the app files (one time)

Copy the **contents** of `Claude-Code-projects/projects/movie-tracker/` into the root of this repo, so
you end up with `index.html`, `css/`, `js/`, `firestore.rules`, `firebase.json` and so on.
Keep this repo's `.gitignore`, `DEPLOY.md` and `.github/`.

Before committing:

```bash
git status
```

`js/config.js` must **not** be listed. `.gitignore` excludes it. Also check that `firestore.rules`
still contains the placeholder `YOUR_EMAIL_HERE` and not your real email (see step 5).

## 2. Add the secrets

GitHub → this repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `TMDB_READ_TOKEN` | the long v4 **API Read Access Token** (`eyJ...`) |
| `OWNER_EMAIL` | your email |
| `FIREBASE_CONFIG` | the whole `firebaseConfig = { ... }` block from Firebase. You can paste it as is. Leave this secret out for local-only mode. |

## 3. Turn on Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions**.

Then push to `main`, or go to **Actions → Deploy to GitHub Pages → Run workflow**. If a secret is
missing, the run fails with a message naming it.

## 4. Firebase settings for the github.io domain

- **Authentication → Settings → Authorized domains**: add `natthaphat-math.github.io`.
  Email-link sign-in fails without it.
- **Google Cloud Console → APIs & Services → Credentials →** your "Browser key (auto created by Firebase)":
  - Application restrictions: *Websites*, add
    `https://natthaphat-math.github.io/*` and `http://localhost:*/*`
  - API restrictions: Identity Toolkit API, Token Service API, Cloud Firestore API

### If sign-in says `...getoobcode-are-blocked`

This means the API key's **API restrictions** don't include Identity Toolkit. Open the key in Google Cloud Console
→ Credentials → **API restrictions** and tick **Identity Toolkit API** and **Token Service API**, plus
**Cloud Firestore API**, then Save. Changes can take up to 5 minutes to apply.

## 5. Security rules

`firestore.rules` in this repo is the current rule set, with the `YOUR_EMAIL_HERE` placeholder so your
email stays out of the public repo.

**Easiest (browser):** Firebase console → **Firestore Database → Rules** tab → select all → paste the
contents of `firestore.rules` → replace `YOUR_EMAIL_HERE` with your email → **Publish**. The editor
checks the syntax and refuses to publish if something's wrong; the previous version stays live.

**Or from a PC** with the Firebase CLI:

```bash
git update-index --skip-worktree firestore.rules   # one time: keep your local email edit out of git
# put your email in firestore.rules, then:
firebase deploy --only firestore:rules
```

Whenever an app update needs new rules, this file changes and the release notes say so.

## Local development

Keep your own `js/config.js` on your PC (it's gitignored) and serve the folder:

```bash
python3 -m http.server 8080   # http://localhost:8080
```

## If a secret ever gets committed

Deleting the file isn't enough, because it stays in the git history. Regenerate the TMDB token
(themoviedb.org → Settings → API), and if your Firebase API key was exposed without restrictions,
restrict it or rotate it in Google Cloud Console.

## Home-screen app (iPhone)

1. Open the site in **Safari** and tap **Share → Add to Home Screen → Add**.
2. Open **Late Show** from the home screen. It runs full-screen with the black Marquee theme.
3. **Signing in inside the home-screen app:** iOS gives the home-screen app its own storage, separate from
   Safari, so tapping the email link would sign in Safari, not the app. Instead:
   1. In the app, tap **LOCAL**, enter your email and tap **Send link**.
   2. In Mail, **long-press** the sign-in link and choose **Copy Link**. Don't tap it.
   3. Go back to the app. In the sign-in window, paste the link under **"Using the home-screen app?"** and
      tap **Sign in with pasted link**.
   The pill turns to **OWNER**, and the app stays signed in from then on.

The same paste option works if you open the email on a different device from the one you requested the link on.

On Android (Chrome), use the menu → **Add to Home screen / Install app**. Tapping the email link usually works
there directly.
