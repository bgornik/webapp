# Izbirnik čaja

A one-page tea picker: keep a list of teas, spin the wheel, and get the tea of the day.

Live at **https://bgornik.github.io/webapp/**

- The whole app is [index.html](index.html): plain HTML, CSS and JavaScript, with no build step and no dependencies.
- The teas, the current pick and the history of picks are saved in the browser's `localStorage`. With sharing set up (below), they are also kept in one shared copy that every device reads and writes.
- The interface is in Slovenian.
- Pushing to `main` publishes the page through GitHub Pages about a minute later.

## Sharing the state between devices

By default each device keeps its own teas. To have every device that opens the page see and change the same teas, pick and history, the page talks to a small Google Apps Script that keeps the state in one file, `izbirnik-caja.json`, in a Google Drive.

Setting it up, once:

1. Open https://script.google.com and click **New project**. Rename it to **Izbirnik čaja**.
2. Replace everything in the editor with the contents of [apps-script/Code.gs](apps-script/Code.gs) and save.
3. Click **Deploy → New deployment**, choose the type **Web app**, set **Execute as: Me** and **Who has access: Anyone**, and click **Deploy**.
4. Authorize it. Google warns that it "hasn't verified this app", which is normal for a script you wrote yourself: **Advanced → Go to Izbirnik čaja (unsafe) → Allow**. It asks for Drive access because it keeps its file there.
5. Copy the **Web app URL** (it ends in `/exec`) into `SYNC_URL` near the top of the script in [index.html](index.html), and push.

How it behaves:

- Every change made on a device is uploaded whole. Each device downloads the shared copy when it is opened, every 30 seconds while it is on screen, and when it comes back into view.
- The last write wins. Two people editing at the same moment are not merged.
- The first time a device joins, the teas it already had are added to the shared list.
- Without a connection the app keeps working from its own copy and uploads its changes when the connection is back. The foot of the ⋮ menu says when it was last in step.
- Anyone who has the page can change the shared state: the script's address is in the page, and it accepts writes without a login.

If the script is edited later, publish it with **Deploy → Manage deployments → Edit → Version: New version**, which keeps the same URL.

The tests never use the real address: the test server always serves the page with its own.

## Installing it as an app

On an Android phone, open the page in Chrome, tap **⋮** and choose **Add to Home screen**, then **Install**. It then opens in its own window, without the browser bar, and keeps working without a connection.

- [manifest.webmanifest](manifest.webmanifest) holds the app's name, colours and icons.
- [sw.js](sw.js) is the service worker that saves a copy of the page for offline use. It asks the network first, so a newly published version shows up the next time the app is opened with a connection.
- The PNG icons are rendered from [icon.svg](icon.svg). `icon-maskable-512.png` is the same drawing with no rounded corners and a smaller teapot, so Android can crop it to any shape.

## Tests

```bash
node tests/test.mjs
```

This serves the site locally and drives it in headless Chrome: adding, editing and deleting teas, spinning the wheel, reloading, a phone-sized run with touch input, checks that the page can be installed and opens offline, and sharing against a local stand-in for the Apps Script. It takes a couple of minutes and exits non-zero if any check fails.

Requirements:

- Node 22 or newer
- Google Chrome. If the binary is not called `google-chrome`, point `CHROME` at it, for example `CHROME=/usr/bin/chromium node tests/test.mjs`.

Screenshots from the run are written to a temporary folder whose path is printed at the end.
