# RunRunRun

A simple GPS running tracker for iPhone. It's an installable web app (a PWA), so you don't need a Mac, Xcode or the App Store. Open it in Safari, add it to your home screen, and it runs full-screen like a native app.

## Features

- Live distance, time, current pace and average pace
- Route drawn as you run
- Pause / resume (paused time and movement aren't counted)
- **Hold to finish**, so a stray tap in your pocket can't end the run
- Voice splits every km or mile
- Keeps the screen on during a run (iPhone stops GPS updates when the screen locks)
- History with per-km/mile splits and a route view
- Export GPX to upload to Strava, Garmin Connect, etc.
- Works offline; runs are stored only on your phone
- Recovers a run in progress if iOS kills the app

## Put it on your iPhone

1. **Turn on GitHub Pages (once):** in the repo go to **Settings › Pages** and set **Source** to **GitHub Actions**.
2. Merge to `main`. The `Deploy to GitHub Pages` workflow runs the tests and publishes the site to
   `https://<your-username>.github.io/RunRunRun/`.
3. On your iPhone, open that URL in **Safari**, tap **Share** → **Add to Home Screen**.
4. Open RunRunRun from the home screen and tap **Start**. Allow location access when asked.
   If you denied it by mistake: **Settings › Privacy & Security › Location Services › Safari Websites** → *While Using the App*, with *Precise Location* on.

### Tips for runs

- Keep **Keep screen on** enabled (Settings tab). iOS doesn't give web apps GPS while the screen is locked or another app is in front. If that happens briefly, the distance is filled in as a straight line when you come back.
- Wait for the GPS pill to turn green (±10 m or so) before starting for the most accurate distance.
- Voice splits play over your music.

## Develop

No build step. It's plain HTML, CSS and JavaScript modules.

```sh
npm start   # serves on http://localhost:8080
npm test    # unit tests for the GPS / pace math (Node 20+)
```

To try it on your phone from your computer you need HTTPS (geolocation requires a secure context). The easiest route is to push and use the GitHub Pages URL.

| Path | What it is |
| --- | --- |
| `index.html`, `css/styles.css` | UI |
| `js/app.js` | Run tracking, screens, voice, wake lock |
| `js/geo.js` | Pure math: distance, GPS filtering, splits, pace, GPX |
| `js/store.js` | IndexedDB storage for runs, settings |
| `sw.js`, `manifest.webmanifest` | Offline support and home-screen install |
| `scripts/make-icons.mjs` | Regenerates PNG icons from `icons/icon.svg` |

When you change app files, bump `CACHE` in `sw.js` so installed copies pick up the new version promptly.
