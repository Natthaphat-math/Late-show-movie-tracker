# Deploying to GitHub Pages

This repo is **public**. Your TMDB token, owner email and Firebase config never go into it:
they live in GitHub **Secrets**, and the workflow in `.github/workflows/deploy-pages.yml` writes
`js/config.js` only inside the deploy job.

> The token and config still end up in the live site's JavaScript, where anyone can read them in
> DevTools. That can't be avoided in a client-only app. What protects your data is the Firestore security
> rules, plus the API key restrictions below.

Site URL: **https://natthaphat-math.github.io/late-show-movie-tracker/**

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

## 5. Security rules (deploy from your PC)

The committed `firestore.rules` keeps the `YOUR_EMAIL_HERE` placeholder so your email stays out of
the public repo. To deploy the real rules:

```bash
# one time: tell git to ignore your local edits to this file
git update-index --skip-worktree firestore.rules

# put your email in firestore.rules locally, then:
firebase login
firebase use --add                      # pick your project
firebase deploy --only firestore:rules  # rules only; Pages does the hosting
```

Use `--only firestore:rules`. A plain `firebase deploy` would also publish a copy of the site to Firebase Hosting.

## Local development

Keep your own `js/config.js` on your PC (it's gitignored) and serve the folder:

```bash
python3 -m http.server 8080   # http://localhost:8080
```

## If a secret ever gets committed

Deleting the file isn't enough, because it stays in the git history. Regenerate the TMDB token
(themoviedb.org → Settings → API), and if your Firebase API key was exposed without restrictions,
restrict it or rotate it in Google Cloud Console.
