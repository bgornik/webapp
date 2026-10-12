# Izbirnik čaja

A one-page tea picker: keep a list of teas, spin the wheel, and get the tea of the day.

Live at **https://bgornik.github.io/webapp/**

- The whole app is [index.html](index.html): plain HTML, CSS and JavaScript, with no build step and no dependencies.
- The teas and the current pick are saved in the browser's `localStorage`, so they stay on the device they were entered on.
- The interface is in Slovenian.
- Pushing to `main` publishes the page through GitHub Pages about a minute later.

## Tests

```bash
node tests/test.mjs
```

This serves `index.html` locally and drives it in headless Chrome: adding, editing and deleting teas, spinning the wheel, reloading, and a phone-sized run with touch input. It takes about a minute and exits non-zero if any check fails.

Requirements:

- Node 22 or newer
- Google Chrome. If the binary is not called `google-chrome`, point `CHROME` at it, for example `CHROME=/usr/bin/chromium node tests/test.mjs`.

Screenshots from the run are written to a temporary folder whose path is printed at the end.
