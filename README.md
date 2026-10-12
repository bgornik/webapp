# Izbirnik čaja

A one-page tea picker: keep a list of teas, spin the wheel, and get the tea of the day.

Live at **https://bgornik.github.io/webapp/**

- The whole app is [index.html](index.html): plain HTML, CSS and JavaScript, with no build step and no dependencies.
- The teas and the current pick are saved in the browser's `localStorage`, so they stay on the device they were entered on.
- The interface is in Slovenian.
- Pushing to `main` publishes the page through GitHub Pages about a minute later.

## Installing it as an app

On an Android phone, open the page in Chrome, tap **⋮** and choose **Add to Home screen**, then **Install**. It then opens in its own window, without the browser bar, and keeps working without a connection.

- [manifest.webmanifest](manifest.webmanifest) holds the app's name, colours and icons.
- [sw.js](sw.js) is the service worker that saves a copy of the page for offline use. It asks the network first, so a newly published version shows up the next time the app is opened with a connection.
- The PNG icons are rendered from [icon.svg](icon.svg). `icon-maskable-512.png` is the same drawing with no rounded corners and a smaller teapot, so Android can crop it to any shape.

## Tests

```bash
node tests/test.mjs
```

This serves the site locally and drives it in headless Chrome: adding, editing and deleting teas, spinning the wheel, reloading, a phone-sized run with touch input, and checks that the page can be installed and opens offline. It takes about a minute and exits non-zero if any check fails.

Requirements:

- Node 22 or newer
- Google Chrome. If the binary is not called `google-chrome`, point `CHROME` at it, for example `CHROME=/usr/bin/chromium node tests/test.mjs`.

Screenshots from the run are written to a temporary folder whose path is printed at the end.
