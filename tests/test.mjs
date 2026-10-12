// End-to-end checks for the tea picker. Serves index.html locally and drives it in headless Chrome
// over the DevTools protocol, so the only requirements are Node 22+ and Chrome.
//
//   node tests/test.mjs
//
// Set CHROME to the browser binary if it is not `google-chrome`. Exits non-zero if any check fails.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const siteDir = join(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'tea-picker-test-')); // browser profile and screenshots
const profile = join(scratch, 'profile');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The site's files are read fresh on every request, so reloads in the tests always see the current ones.
const siteFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'],
};
let offline = false; // while set, every connection is dropped, as if the network had gone
let pageRequests = 0;
const server = createServer((req, res) => {
  if (offline) {
    req.socket.destroy();
    return;
  }
  const file = siteFiles[new URL(req.url, 'http://localhost').pathname];
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  if (file[0] === 'index.html') pageRequests++;
  res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' });
  res.end(readFileSync(join(siteDir, file[0])));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const HTTP_PORT = server.address().port;

const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--no-first-run', '--disable-gpu', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=600,700', 'about:blank'], { stdio: 'ignore' });
let chromeError = null;
chrome.on('error', e => { chromeError = e; });
const cleanup = async () => {
  server.close();
  if (chrome.exitCode === null && !chromeError) {
    const exited = new Promise(r => chrome.once('exit', r));
    await Promise.race([exited, sleep(1500)]);
    if (chrome.exitCode === null) {
      chrome.kill();
      await Promise.race([exited, sleep(5000)]);
    }
    await sleep(300);
  }
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
};

let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`); };

try {
  // Chrome picks its own debugging port and writes it to a file in the profile folder.
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    if (chromeError) throw new Error(`could not start Chrome (${chromeError.message}); set CHROME to the browser binary`);
    const portFile = join(profile, 'DevToolsActivePort');
    if (!existsSync(portFile)) continue;
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch {}
  }
  if (!target) throw new Error('Chrome did not open a debugging port in time');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0; const pending = new Map(); const listeners = [];
  ws.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    if (msg.id) { pending.get(msg.id)(msg); pending.delete(msg.id); } else listeners.forEach(l => l(msg));
  });
  const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const errors = [];
  listeners.push(m => { if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text); });
  const load = async (path = '/index.html') => {
    const done = new Promise(r => listeners.push(m => m.method === 'Page.loadEventFired' && r()));
    await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}${path}` });
    await done;
  };
  const run = async expr => {
    const res = await send('Runtime.evaluate', { expression: `(() => { ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text);
    return res.result.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  const pressEscape = async () => {
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  };

  const helpers = `
    const $ = s => document.querySelector(s);
    const texts = () => [...document.querySelectorAll('#list li .text')].map(e => e.textContent);
    const stored = () => JSON.parse(localStorage.getItem('webapp.strings') || '[]').map(i => i.text);
    const add = v => { $('#add-input').value = v; $('#add-form').requestSubmit(); };
    const row = t => [...document.querySelectorAll('#list li')].find(li => li.querySelector('.text')?.textContent === t);
    const btn = (t, label) => [...row(t).querySelectorAll('button')].find(b => b.textContent === label);
    const err = () => $('#error').hidden ? '' : $('#error').textContent;
    const dialog = $('#teas-dialog');
    const shown = s => $(s).getClientRects().length > 0;
    const middle = s => { $(s).scrollIntoView({ block: 'nearest' }); const r = $(s).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    const editorParts = ['#teas-title', '#close-teas', '#add-form', '#add-input', '#list', '#empty'];
  `;
  const ev = expr => run(helpers + expr);

  await load();
  await ev(`localStorage.clear();`);
  await load();

  check('empty state shown on first load', await ev(`return !$('#empty').hidden && texts().length === 0;`));
  check('no teas: blank wheel shown, spin button disabled, no labels', await ev(`const g = $('#wheel-spin'); return g.querySelectorAll('circle.empty').length === 1 && g.querySelectorAll('path, text').length === 0 && $('#spin-button').disabled && $('#wheel svg').getBoundingClientRect().width > 200;`));
  const order = await ev(`const top = s => $(s).getBoundingClientRect().top; return ['.teapot', '#wheel svg', '#spin-button', '#hint'].map(top);`);
  check('landing: teapot, wheel, spin button, then the empty-wheel hint', order.every((v, i) => i === 0 || v > order[i - 1]), order.join(','));
  check('no teas: the disabled spin button holds its colour still', await ev(`return $('#spin-button').disabled && getComputedStyle($('#spin-button')).animationPlayState === 'paused';`));
  check('landing: hint points to the tea editor, in Slovenian', await ev(`return shown('#hint') && $('#hint').textContent === 'Kolo je prazno. Čaje dodaš z gumbom »Seznam čajev«.';`));
  const head = await ev(`const mid = r => r.left + r.width / 2; const m = $('main').getBoundingClientRect(), pot = $('.teapot').getBoundingClientRect(), wheel = $('#wheel svg').getBoundingClientRect();
    return { potOff: mid(pot) - mid(m), potTop: pot.top, gapToWheel: wheel.top - pot.bottom, potSize: pot.width, potHeight: pot.height, potHidden: $('.teapot').getAttribute('aria-hidden'), noCat: !document.querySelector('[class*=cat]'),
      headings: document.querySelectorAll('h1').length, titleCard: /izbirnik/i.test(document.body.innerText), headerKids: [...$('header').children].map(e => e.tagName.toLowerCase()).join(), tab: document.title };`);
  check('title card is gone: no heading and no "IZBIRNIK ČAJA" text on the page (the tab title stays)', head.headings === 0 && !head.titleCard && head.headerKids === 'svg' && head.tab === 'Izbirnik čaja', JSON.stringify(head));
  check('teapot: a little larger (72px), centred above the wheel, hidden from screen readers', head.noCat && Math.abs(head.potOff) < 1 && head.potSize === 72 && head.potHeight === 72 && head.potTop >= 0 && head.gapToWheel >= 8 && head.potHidden === 'true', JSON.stringify(head));
  const steamA = await ev(`const wisps = [...document.querySelectorAll('.teapot .pot-steam')]; const pot = $('.teapot ellipse.pot-body').getBoundingClientRect();
    return { wisps: wisps.length, names: wisps.map(w => getComputedStyle(w).animationName).join(), states: wisps.map(w => w.getAnimations()[0]?.playState).join(), endless: wisps.every(w => getComputedStyle(w).animationIterationCount === 'infinite'),
      seconds: parseFloat(getComputedStyle(wisps[0]).animationDuration), staggered: getComputedStyle(wisps[0]).animationDelay !== getComputedStyle(wisps[1]).animationDelay,
      abovePot: wisps.every(w => w.getBoundingClientRect().bottom <= pot.top + 8), others: [...$('.teapot').querySelectorAll('*')].filter(e => !e.classList.contains('pot-steam') && e.getAnimations().length).length,
      frame: wisps.map(w => getComputedStyle(w).transform + getComputedStyle(w).opacity).join(), parts: ['.pot-handle', 'path.pot-body', 'ellipse.pot-body', '.pot-shine'].every(q => $('.teapot ' + q)) };`);
  await sleep(600);
  const steamB = await ev(`return [...document.querySelectorAll('.teapot .pot-steam')].map(w => getComputedStyle(w).transform + getComputedStyle(w).opacity).join();`);
  check('teapot: has body, spout, handle and lid; only the steam moves, slowly and endlessly', steamA.wisps === 2 && steamA.names === 'steam,steam' && steamA.states === 'running,running' && steamA.endless && steamA.seconds >= 2 && steamA.staggered && steamA.abovePot && steamA.others === 0 && steamA.parts && steamA.frame !== steamB, JSON.stringify(steamA) + ' -> ' + steamB);
  const opener = await ev(`const mid = r => r.left + r.width / 2; const b = $('#edit-teas').getBoundingClientRect(); return { text: $('#edit-teas').textContent, belowHint: b.top >= $('#hint').getBoundingClientRect().bottom, off: mid(b) - mid($('main').getBoundingClientRect()) };`);
  check('landing: "Seznam čajev" button sits centred below the wheel section', opener.text === 'Seznam čajev' && opener.belowHint && Math.abs(opener.off) < 1, JSON.stringify(opener));
  check('landing: tea editor is closed, none of it is shown', await ev(`return !dialog.open && editorParts.every(s => !shown(s)) && [...$('main').children].map(e => e.tagName + '#' + e.id).join() === 'HEADER#,DIV#wheel,BUTTON#edit-teas';`));

  await clickAt(...await ev(`return middle('#edit-teas');`));
  const opened = await ev(`return { open: dialog.open, modal: dialog.matches(':modal'), parts: editorParts.filter(s => s !== '#list').every(shown), title: $('#teas-title').textContent, labelled: dialog.getAttribute('aria-labelledby'), focusInside: dialog.contains(document.activeElement), focus: document.activeElement.id, pageLocked: getComputedStyle(document.documentElement).overflow };`);
  check('editor: clicking the button opens a modal dialog titled "Čaji"', opened.open && opened.modal && opened.parts && opened.title === 'Čaji' && opened.labelled === 'teas-title', JSON.stringify(opened));
  check('editor: focus moves into the dialog (not the text field, so a phone keyboard stays down)', opened.focusInside && opened.focus === 'close-teas', JSON.stringify(opened));
  check('editor: page behind the dialog cannot scroll', opened.pageLocked === 'hidden', opened.pageLocked);
  const place = await ev(`const d = dialog.getBoundingClientRect(), w = $('#wheel svg').getBoundingClientRect(); return { left: d.left, right: d.right, top: d.top, bottom: d.bottom, vw: innerWidth, vh: innerHeight, coversWheelTop: d.top < w.bottom };`);
  check('editor: dialog fits inside the window', place.left >= 0 && place.right <= place.vw && place.top >= 0 && place.bottom <= place.vh, JSON.stringify(place));
  // The create/update/delete checks below run with the editor open, as a person would use it.
  check('add input has maxlength 20', await ev(`return $('#add-input').maxLength === 20;`));

  await ev(`add('hello');`);
  check('create: item rendered', JSON.stringify(await ev(`return texts();`)) === '["hello"]');
  const weights = await ev(`const w = el => getComputedStyle(el).fontWeight; return { tea: w($('#list li .text')), wheel: w($('#wheel-spin text')), buttons: [...document.querySelectorAll('#list li button')].map(w).join(), body: w(document.body) };`);
  check('listed teas are bold; wheel labels and row buttons unchanged', weights.tea === '700' && weights.wheel === '600' && weights.buttons === '400,400' && weights.body === '400', JSON.stringify(weights));
  check('create: item stored in localStorage', JSON.stringify(await ev(`return stored();`)) === '["hello"]');
  check('create: input cleared, empty state hidden', await ev(`return $('#add-input').value === '' && $('#empty').hidden;`));

  await ev(`add('   ');`);
  check('blank tea rejected with error', await ev(`return texts().length === 1 && err() !== '';`), await ev(`return err();`));

  await ev(`add('x'.repeat(21));`);
  check('21 chars rejected with error', await ev(`return texts().length === 1 && /največ 20 znakov/.test(err());`), await ev(`return err();`));

  await ev(`add('y'.repeat(20));`);
  check('exactly 20 chars accepted, error cleared', await ev(`return texts()[0] === 'y'.repeat(20) && err() === '';`));

  await ev(`add('  padded  ');`);
  check('whitespace trimmed; newest first', JSON.stringify(await ev(`return texts();`)) === JSON.stringify(['padded', 'y'.repeat(20), 'hello']));

  await ev(`add('<b>bold</b>');`);
  check('HTML is shown as text, not parsed', await ev(`return texts()[0] === '<b>bold</b>' && !$('#list li .text b');`));

  await ev(`btn('hello', 'Uredi').click();`);
  check('edit: row becomes focused input with value', await ev(`const i = $('#list li form input'); return i && i.value === 'hello' && i.maxLength === 20 && document.activeElement === i;`));
  await ev(`const i = $('#list li form input'); i.value = 'hello world'; i.closest('form').requestSubmit();`);
  check('update: saved to list and storage', await ev(`return texts().includes('hello world') && !texts().includes('hello') && stored().includes('hello world') && !$('#list li form');`));

  await ev(`btn('padded', 'Uredi').click(); const i = $('#list li form input'); i.value = 'z'.repeat(21); i.closest('form').requestSubmit();`);
  check('update: 21 chars rejected, stays in edit mode', await ev(`return /največ 20 znakov/.test(err()) && !!$('#list li form') && stored().includes('padded');`));
  await ev(`const i = $('#list li form input'); i.value = 'changed'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  check('update: Escape cancels without saving', await ev(`return texts().includes('padded') && !texts().includes('changed') && !$('#list li form') && err() === '';`));
  await ev(`btn('padded', 'Uredi').click(); [...$('#list li form').querySelectorAll('button')].find(b => b.textContent === 'Prekliči').click();`);
  check('update: Cancel button exits edit mode', await ev(`return !$('#list li form') && texts().includes('padded');`));

  await ev(`btn('padded', 'Izbriši').click();`);
  check('delete: removed from list and storage', await ev(`return !texts().includes('padded') && !stored().includes('padded') && texts().length === 3;`));

  check('editor: wheel behind the dialog already shows the teas', await ev(`return dialog.open && [...$('#wheel-spin').querySelectorAll('text')].map(t => t.textContent).join('|') === texts().join('|') && $('#hint').hidden;`));
  await ev(`btn('hello world', 'Uredi').click();`);
  await pressEscape();
  check('editor: Escape while editing a tea cancels the edit, dialog stays open', await ev(`return dialog.open && !$('#list li form') && texts().includes('hello world');`));
  await pressEscape();
  check('editor: Escape again closes the dialog and returns focus to the button', await ev(`return !dialog.open && document.activeElement.id === 'edit-teas' && editorParts.every(s => !shown(s)) && getComputedStyle(document.documentElement).overflow !== 'hidden';`));

  await ev(`$('#edit-teas').click(); btn('hello world', 'Uredi').click(); add('   ');`);
  const reopened = await ev(`return { open: dialog.open, editing: !!$('#list li form'), error: err() };`);
  check('editor: reopened with an edit in progress and an error', reopened.open && reopened.editing && reopened.error !== '', JSON.stringify(reopened));
  await clickAt(...await ev(`return middle('#close-teas');`));
  check('editor: "Zapri" closes it', await ev(`return !dialog.open && $('#close-teas').textContent === 'Zapri';`));
  await ev(`$('#edit-teas').click();`);
  check('editor: reopening starts clean, with the edit abandoned and the error gone', await ev(`return dialog.open && !$('#list li form') && err() === '' && texts().includes('hello world');`));
  await clickAt(...await ev(`return middle('#teas-title');`));
  check('editor: clicking inside the dialog keeps it open', await ev(`return dialog.open;`));
  const outside = await ev(`const d = dialog.getBoundingClientRect(); return [d.left / 2, d.top / 2, d.left, d.top];`);
  await clickAt(outside[0], outside[1]);
  check('editor: clicking the dimmed area outside closes it', await ev(`return !dialog.open;`), `clicked ${outside[0]},${outside[1]} dialog at ${outside[2]},${outside[3]}`);

  const before = JSON.stringify(await ev(`return texts();`));
  await load();
  check('editor: closed again after a reload', await ev(`return !dialog.open && editorParts.every(s => !shown(s));`));
  check('persistence: same items after reload', JSON.stringify(await ev(`return texts();`)) === before, before);

  await ev(`localStorage.setItem('webapp.strings', '{not json');`);
  await load();
  check('corrupt storage falls back to empty list', await ev(`return texts().length === 0 && !$('#empty').hidden;`));
  await ev(`add('recovered');`);
  check('app still works after corrupt storage', JSON.stringify(await ev(`return stored();`)) === '["recovered"]');

  // ---- wheel ----
  const wheelHelpers = `
    const spin = $('#wheel-spin');
    const slices = () => [...spin.querySelectorAll('path, circle')];
    const labels = () => [...spin.querySelectorAll('text')].map(t => t.textContent);
    const fills = () => slices().map(s => s.getAttribute('fill'));
    const centre = el => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; };
  `;
  const wv = expr => run(helpers + wheelHelpers + expr);
  const shoot = async name => {
    await wv(`window.scrollTo(0, 0);`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(scratch, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
  };

  check('wheel: one tea draws a full circle with its label', await wv(`return !$('#wheel').hidden && slices().length === 1 && slices()[0].tagName === 'circle' && labels().join() === 'recovered';`));
  check('landing: with teas, the hint is gone and the page is still just heading, wheel and button', await wv(`return !shown('#hint') && !dialog.open && editorParts.every(s => !shown(s)) && shown('#wheel svg') && shown('#spin-button');`));

  const animBefore = await wv(`const a = spin.getAnimations()[0]; window.__anim = a; return { state: a.playState, duration: a.effect.getTiming().duration, iterations: a.effect.getTiming().iterations === Infinity, t: a.currentTime, m: getComputedStyle(spin).transform };`);
  check('wheel: spin animation running, 40s per turn, endless', animBefore.state === 'running' && animBefore.duration === 40000 && animBefore.iterations, JSON.stringify(animBefore));

  await wv(`add('second item'); add('exactly twenty chars');`);
  check('wheel: one slice per tea, labels in list order', await wv(`return slices().length === 3 && slices().every(s => s.tagName === 'path') && labels().join('|') === texts().join('|');`), await wv(`return labels().join('|');`));
  await sleep(700);
  const animAfter = await wv(`const a = spin.getAnimations()[0]; return { same: a === window.__anim, t: a.currentTime, m: getComputedStyle(spin).transform };`);
  check('wheel: visibly rotating over time', animAfter.m !== animBefore.m && animAfter.m.startsWith('matrix'), `${animBefore.m} -> ${animAfter.m}`);
  check('wheel: adding teas does not restart the spin', animAfter.same && animAfter.t > animBefore.t + 500, JSON.stringify(animAfter));
  const offset = await wv(`const a = centre(spin), b = centre($('#wheel .hub')); return Math.hypot(a[0] - b[0], a[1] - b[1]);`);
  check('wheel: rotates about its own centre', offset < 1, `centre offset ${offset}px`);
  await shoot('wheel-3');

  await wv(`btn('second item', 'Uredi').click(); const i = $('#list li form input'); i.value = 'renamed'; i.closest('form').requestSubmit();`);
  // Geometry is read in the wheel's own units and mapped to the screen, because Chrome reports loose
  // on-screen boxes for rotated shapes.
  const rim = await wv(`const svg = $('#wheel svg'), cs = getComputedStyle(svg), box = svg.getBoundingClientRect(), b = parseFloat(cs.borderTopWidth), disc = spin.getBBox(), m = svg.getScreenCTM();
    const edge = (x, y) => new DOMPoint(x, y).matrixTransform(m); const R = disc.width / 2;
    return { widths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].join(), style: cs.borderTopStyle, radius: cs.borderTopLeftRadius, round: Math.abs(box.width - box.height) < 0.5,
      discRadius: R, discCentred: Math.abs(disc.x + R) < 0.01 && Math.abs(disc.y + R) < 0.01,
      gapLeft: edge(-R, 0).x - (box.left + b), gapRight: (box.right - b) - edge(R, 0).x, gapTop: edge(0, -R).y - (box.top + b), gapBottom: (box.bottom - b) - edge(0, R).y,
      oldRim: !!$('#wheel .rim'), hubOff: Math.hypot(centre(svg)[0] - centre($('#wheel .hub'))[0], centre(svg)[1] - centre($('#wheel .hub'))[1]), pointerOverRim: $('#wheel .pointer').getBoundingClientRect().top < box.top + b };`);
  check('wheel: the rim is a solid round border, hugging the slices all the way round', new Set(rim.widths.split(',')).size === 1 && parseFloat(rim.widths) >= 4 && rim.style === 'solid' && rim.radius === '50%' && rim.round && Math.abs(rim.discRadius - 96) < 0.01 && rim.discCentred && [rim.gapLeft, rim.gapRight, rim.gapTop, rim.gapBottom].every(g => Math.abs(g) < 0.5) && !rim.oldRim && rim.hubOff < 0.5 && rim.pointerOverRim, JSON.stringify(rim));
  check('wheel: follows an edit', await wv(`return labels().includes('renamed') && !labels().includes('second item');`));
  await wv(`btn('renamed', 'Izbriši').click();`);
  check('wheel: follows a delete', await wv(`return slices().length === 2 && !labels().includes('renamed');`));

  // Grow to 30 teas, checking colours and label fit at every size.
  const samples = ['WWWWWWWWWWWWWWWWWWWW', 'a', 'pizza night', 'iiiiiiiiiiiiiiiiiiii', 'Call the plumber!', 'x y z', 'supercalifragilistic', 'Tokyo'];
  let colourClash = '', overflow = '';
  for (let n = 3; n <= 30; n++) {
    await wv(`add(${JSON.stringify(samples[n % samples.length])});`);
    const r = await wv(`
      const f = fills();
      const clash = f.some((c, i) => c === f[(i + 1) % f.length]);
      const tooLong = [...spin.querySelectorAll('text')].some(t => t.getComputedTextLength() > 78.5);
      // each label's inner end must be no taller than its slice is wide there
      const k = 2 * Math.sin(Math.PI / f.length);
      const tooTall = f.length > 2 && [...spin.querySelectorAll('text')].some(t => +t.getAttribute('font-size') > k * (92 - t.getComputedTextLength()) + 0.05);
      return { n: f.length, clash, tooLong, tooTall };`);
    if (r.n !== n) colourClash += `count ${r.n}!=${n} `;
    if (r.clash) colourClash += `n=${n} `;
    if (r.tooLong || r.tooTall) overflow += `n=${n}${r.tooLong ? ' long' : ''}${r.tooTall ? ' tall' : ''}; `;
    if (n === 12) await shoot('wheel-12');
  }
  check('wheel: neighbouring slices never share a colour (3..30 teas)', colourClash === '', colourClash);
  check('wheel: every label fits inside its slice (3..30 teas)', overflow === '', overflow);
  await shoot('wheel-30');

  await wv(`while ($('#list li')) $('#list li button.danger').click();`);
  check('wheel: back to a blank disc with the button disabled when the list is empty', await wv(`return slices().length === 1 && slices()[0].classList.contains('empty') && labels().length === 0 && $('#spin-button').disabled && spin.getAnimations().length === 1;`));

  // ---- spin button, landing, sign, confetti ----
  const spinHelpers = `
    const spinBtn = $('#spin-button');
    // The sign reads "pon., 12. okt." / "Čaj dneva:" / "SENCHA"; the date is checked separately and dropped here.
    const sign = () => ($('#result').hidden || getComputedStyle($('#result')).visibility === 'hidden') ? null : $('#result').textContent.replace($('#result-date').textContent, '').trim();
    // Rendered rotation, read back from the browser rather than from the app's own state.
    const shownAngle = () => { const m = new DOMMatrix(getComputedStyle(spin).transform); return Math.atan2(m.b, m.a) * 180 / Math.PI; };
    // Which label points straight up at the pointer, and how far off-centre it is.
    const underPointer = () => {
      let tea = null, off = 1e9;
      for (const t of spin.querySelectorAll('text')) {
        const local = parseFloat(t.getAttribute('transform').slice(7));
        const d = Math.abs((((local + shownAngle() + 90) % 360) + 540) % 360 - 180);
        if (d < off) { off = d; tea = t.textContent; }
      }
      // Is the spot just under the pointer tip inside the highlighted slice? Mapped through the slice's own
      // on-screen transform, so it holds wherever the page happens to be scrolled.
      const w = spin.querySelector('.winner');
      const sliceIsWinner = !!w && w.isPointInFill(new DOMPoint(0, -94).matrixTransform($('#wheel svg').getScreenCTM()).matrixTransform(w.getScreenCTM().inverse()));
      return { tea, off, half: 180 / spin.querySelectorAll('text').length, sliceIsWinner, winners: spin.querySelectorAll('.winner').length };
    };
    const state = () => ({ sign: sign(), disabled: spinBtn.disabled, anims: spin.getAnimations().length, confetti: document.querySelectorAll('canvas.confetti').length, ...underPointer() });
  `;
  const sv = expr => run(helpers + wheelHelpers + spinHelpers + expr);
  const landedOk = s => s.sign === `Čaj dneva: ${s.tea.toUpperCase()}` && s.sliceIsWinner && s.winners === 1 && s.off < s.half * 0.75 && !s.disabled;

  check('tab title is "Izbirnik čaja", page language is Slovenian', await sv(`return document.title === 'Izbirnik čaja' && !$('h1') && document.documentElement.lang === 'sl';`));
  await sv(`['Earl Grey', 'Sencha', 'Rooibos', 'Oolong', 'Chai'].forEach(add);`);
  check('spin button: labelled, enabled, below the wheel; no sign yet', await sv(`return spinBtn.textContent === 'ZAVRTI KOLOČAJ' && !spinBtn.disabled && spinBtn.getBoundingClientRect().top >= $('#wheel svg').getBoundingClientRect().bottom && sign() === null;`));
  const glowA = await sv(`const cs = getComputedStyle(spinBtn), a = spinBtn.getAnimations()[0]; return { name: cs.animationName, endless: cs.animationIterationCount, seconds: parseFloat(cs.animationDuration), state: a && a.playState, bg: cs.backgroundColor };`);
  await sleep(1500);
  const glowB = await sv(`return getComputedStyle(spinBtn).backgroundColor;`);
  check('spin button: background drifts slowly from colour to colour, endlessly', glowA.name === 'glow' && glowA.endless === 'infinite' && glowA.seconds >= 6 && glowA.state === 'running' && glowA.bg !== glowB, JSON.stringify(glowA) + ' -> ' + glowB);
  check('idle: still spinning slowly before any spin', await sv(`const a = spin.getAnimations(); return a.length === 1 && a[0].effect.getTiming().duration === 40000 && a[0].playState === 'running';`));

  // One spin in real time.
  const a0 = await sv(`const before = shownAngle(); spinBtn.click(); const t = spin.getAnimations()[0].effect.getTiming(); return { before, duration: t.duration, easing: t.easing, n: spin.getAnimations().length, disabled: spinBtn.disabled, sign: sign() };`);
  check('spin: starts a 6s decelerating animation, button disabled, sign hidden', a0.duration === 6000 && a0.n === 1 && a0.disabled && a0.sign === null && a0.easing.startsWith('cubic-bezier'), JSON.stringify(a0));
  const speedA = await sv(`return [shownAngle(), performance.now()];`);
  await sleep(120);
  const speedB = await sv(`return [shownAngle(), performance.now()];`);
  const degPerSec = (((speedB[0] - speedA[0]) % 360) + 360) % 360 / ((speedB[1] - speedA[1]) / 1000);
  check('spin: turning much faster than the 9 deg/s idle', degPerSec > 90, `${degPerSec.toFixed(0)} deg/s`);
  await sv(`spinBtn.click();`);
  check('spin: a second click mid-spin is ignored', await sv(`return spin.getAnimations().length === 1 && spinBtn.disabled;`));
  await sleep(6300);
  const landed = await sv(`return state();`);
  check('land: sign names the tea under the pointer, slice highlighted, button re-enabled', landedOk(landed), JSON.stringify(landed));
  check('landing: sign appears below the spin button, tea editor stays closed', await sv(`const r = $('#result').getBoundingClientRect(); return r.top >= spinBtn.getBoundingClientRect().bottom && !dialog.open && editorParts.every(s => !shown(s));`));
  const dated = await sv(`const now = new Date();
    const expected = ['ned.', 'pon.', 'tor.', 'sre.', 'čet.', 'pet.', 'sob.'][now.getDay()] + ', ' + now.getDate() + '. ' + ['jan.', 'feb.', 'mar.', 'apr.', 'maj', 'jun.', 'jul.', 'avg.', 'sep.', 'okt.', 'nov.', 'dec.'][now.getMonth()];
    return { expected, date: $('#result-date').textContent, full: $('#result').textContent, smaller: parseFloat(getComputedStyle($('#result-date')).fontSize) < parseFloat(getComputedStyle($('#result')).fontSize) };`);
  check('sign: carries today\'s date, abbreviated, with the weekday, in Slovenian', dated.date === dated.expected && dated.full.startsWith(`${dated.expected} Čaj dneva: `) && dated.smaller, JSON.stringify(dated));
  check('land: wheel is at rest on the winner', landed.anims === 0, JSON.stringify(landed));
  check('land: confetti canvas appears', landed.confetti === 1);
  check('land: sign is big and in view', await sv(`const r = $('#result').getBoundingClientRect(); return parseFloat(getComputedStyle($('#result')).fontSize) >= 24 && r.top >= 0;`));
  await sleep(450);
  check('land: confetti is actually drawn', await sv(`const c = $('canvas.confetti'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n > 500;`));
  await shoot('spin-landed');
  await sleep(3600);
  check('land: confetti cleans itself up', await sv(`return document.querySelectorAll('canvas').length === 0;`));
  await sleep(2400);
  const resumed = await sv(`const a = spin.getAnimations(); return { n: a.length, duration: a[0]?.effect.getTiming().duration, sign: sign(), winners: spin.querySelectorAll('.winner').length };`);
  check('after the pause: slow spin resumes, sign and highlight stay', resumed.n === 1 && resumed.duration === 40000 && resumed.sign === landed.sign && resumed.winners === 1, JSON.stringify(resumed));

  const settle = async () => {
    for (let nudges = 0; nudges < 10; nudges++) {
      await sleep(25);
      if (!(await sv(`if (!spinBtn.disabled) return false; spin.getAnimations().forEach(a => a.finish()); return true;`))) return nudges;
    }
    throw new Error('wheel never settled');
  };
  const fastSpin = async (midSpin = '') => {
    await sv(`spinBtn.click(); ${midSpin} spin.getAnimations()[0].finish();`);
    const nudges = await settle();
    return { ...(await sv(`return state();`)), nudges };
  };

  // Many spins, fast-forwarded: every landing must agree with the sign, and all teas must come up.
  const seen = new Set(); let bad = '', again = '', last = landed.tea;
  for (let i = 0; i < 80; i++) {
    const s = await fastSpin();
    if (!landedOk(s)) bad += JSON.stringify(s) + ' ';
    if (s.tea === last) again += `spin ${i}: ${s.tea}; `;
    last = s.tea;
    seen.add(s.tea);
  }
  check('80 spins: never the same tea twice in a row', again === '', again);
  check('80 spins: sign always matches the slice under the pointer', bad === '', bad.slice(0, 400));
  check('80 spins: the pick is random across all 5 teas', seen.size === 5, [...seen].join(','));

  await sv(`spinBtn.click(); btn('Sencha', 'Izbriši').click(); btn('Chai', 'Izbriši').click(); spin.getAnimations()[0].finish();`);
  await settle();
  const mid = await sv(`return state();`);
  check('list changed mid-spin: result still matches what is under the pointer', mid.sign === `Čaj dneva: ${mid.tea.toUpperCase()}` && mid.sliceIsWinner && mid.winners === 1 && mid.off < mid.half && !mid.disabled && !['Sencha', 'Chai'].includes(mid.tea), JSON.stringify(mid));

  await sv(`btn(${JSON.stringify(mid.tea)}, 'Uredi').click(); const i = $('#list li form input'); i.value = 'Renamed tea'; i.closest('form').requestSubmit();`);
  check('editing the winner updates the sign', await sv(`return sign() === 'Čaj dneva: RENAMED TEA';`), await sv(`return sign();`));
  await sv(`btn('Renamed tea', 'Izbriši').click();`);
  check('deleting the winner removes the sign', await sv(`return sign() === null && spin.querySelectorAll('.winner').length === 0;`));

  await sv(`while (document.querySelectorAll('#list li').length > 1) $('#list li button.danger').click(); spinBtn.click(); spin.getAnimations()[0].finish();`);
  await sleep(25);
  check('a single tea can be spun and wins', await sv(`return sign() === 'Čaj dneva: ' + texts()[0].toUpperCase() && spin.querySelector('circle.winner') !== null;`), await sv(`return sign();`));

  // Uppercase sign, original case everywhere else (list is down to one tea here).
  await sv(`btn(texts()[0], 'Uredi').click(); const i = $('#list li form input'); i.value = 'žajbelj Čaj šipek'; i.closest('form').requestSubmit();`);
  const up = await sv(`return { sign: sign(), shown: $('#result').innerText, list: texts(), wheel: labels(), stored: stored() };`);
  check('sign shows the tea in uppercase, including č/š/ž', up.sign === 'Čaj dneva: ŽAJBELJ ČAJ ŠIPEK' && up.shown.split('\n').length === 3 && up.shown.split('\n').slice(1).join('\n') === 'Čaj dneva:\nŽAJBELJ ČAJ ŠIPEK', JSON.stringify(up));
  const lines = await sv(`const mid = r => r.left + r.width / 2; const range = document.createRange(); range.setStartAfter($('#result-date')); range.setEndBefore($('#result-name'));
    const date = $('#result-date').getBoundingClientRect(), label = range.getBoundingClientRect(), name = $('#result-name').getBoundingClientRect(), box = $('#result').getBoundingClientRect();
    return { labelText: range.toString().trim(), dateText: $('#result-date').textContent, order: [date.top, date.bottom, label.top, label.bottom, name.top, name.bottom].map(Math.round), offs: [date, label, name].map(r => Math.round(mid(r) - mid(box))), inside: date.top >= box.top && name.bottom <= box.bottom,
      rows: [range.getClientRects().length, Math.round(name.height / parseFloat(getComputedStyle($('#result')).lineHeight))] };`);
  check('sign: three centred lines, the date first, then "Čaj dneva:", then the tea', lines.labelText === 'Čaj dneva:' && /^[a-zčš]{3}\.?, \d{1,2}\. [a-z]{3}\.?$/.test(lines.dateText) && lines.order[1] <= lines.order[2] + 4 && lines.order[0] < lines.order[2] && lines.order[3] <= lines.order[4] + 4 && lines.order[2] < lines.order[4] && lines.offs.every(o => Math.abs(o) < 2) && lines.inside && lines.rows.join() === '1,1', JSON.stringify(lines));
  check('list, wheel label and saved data keep the original case', [up.list, up.wheel, up.stored].every(a => a.length === 1 && a[0] === 'žajbelj Čaj šipek'), JSON.stringify(up));
  await sv(`btn('žajbelj Čaj šipek', 'Uredi').click(); const i = $('#list li form input'); i.value = 'ALREADY UPPER 123'; i.closest('form').requestSubmit();`);
  check('an already-uppercase tea is unchanged on the sign', await sv(`return sign() === 'Čaj dneva: ALREADY UPPER 123';`), await sv(`return sign();`));

  // ---- the pick is saved, and a spin never repeats the current tea ----
  const savedPick = `(() => { const saved = JSON.parse(localStorage.getItem('webapp.winner') || 'null'); const it = JSON.parse(localStorage.getItem('webapp.strings') || '[]').find(i => saved && i.id === saved.id); return it ? it.text : null; })()`;
  await ev(`localStorage.clear();`);
  await load();
  await sv(`['Zeleni', 'Črni', 'Meta'].forEach(add);`);
  check('nothing saved before the first spin', await sv(`return localStorage.getItem('webapp.winner') === null && sign() === null;`));
  const first = await fastSpin();
  check('pick is saved in localStorage', (await sv(`return ${savedPick};`)) === first.tea, first.tea);

  // Spinning again must not move what sits below the sign. Positions are page positions, so scrolling does not matter.
  const layout = `(() => { const y = el => Math.round((el.getBoundingClientRect().top + scrollY) * 10) / 10; const r = $('#result'), cs = getComputedStyle(r);
    return { listButton: y($('#edit-teas')), signTop: y(r), signHeight: Math.round(r.offsetHeight * 10) / 10, absent: r.hidden, visibility: cs.visibility, sign: sign(), popping: r.getAnimations().length, text: r.textContent }; })()`;
  const atRest = await sv(`return ${layout};`);
  await sv(`spinBtn.click();`);
  const whileSpinning = await sv(`return ${layout};`);
  check('while spinning: the old sign is blanked but keeps its place and size', !whileSpinning.absent && whileSpinning.visibility === 'hidden' && whileSpinning.sign === null && whileSpinning.signTop === atRest.signTop && whileSpinning.signHeight === atRest.signHeight && whileSpinning.text === atRest.text, JSON.stringify([atRest, whileSpinning]));
  check('while spinning: "Seznam čajev" stays exactly where it was', whileSpinning.listButton === atRest.listButton, `${atRest.listButton} -> ${whileSpinning.listButton}`);
  await sleep(700);
  const midSpin = await sv(`return ${layout};`);
  check('mid-spin: still in the same place', midSpin.listButton === atRest.listButton && midSpin.visibility === 'hidden', JSON.stringify(midSpin));
  await sv(`spin.getAnimations()[0].finish();`);
  await settle();
  const afterLanding = await sv(`return ${layout};`);
  const landedTea = (await sv(`return state();`)).tea;
  check('after landing: the sign is back with the new tea and a pop-in', afterLanding.visibility === 'visible' && afterLanding.sign !== null && afterLanding.sign !== atRest.sign && afterLanding.popping === 1, JSON.stringify(afterLanding));
  check('after landing: "Seznam čajev" has still not moved', afterLanding.listButton === atRest.listButton && afterLanding.signHeight === atRest.signHeight, `${atRest.listButton} -> ${afterLanding.listButton}`);

  await load();
  const back = await sv(`return { sign: sign(), winners: spin.querySelectorAll('.winner').length, canvases: document.querySelectorAll('canvas').length, idle: spin.getAnimations()[0]?.effect.getTiming().duration, disabled: spinBtn.disabled };`);
  check('reload: sign and highlight come back, wheel idles, no confetti replay', back.sign === afterLanding.sign && back.winners === 1 && back.canvases === 0 && back.idle === 40000 && !back.disabled, JSON.stringify(back));

  let prev = landedTea, repeats = '', wrong = '';
  const picked = new Set();
  for (let i = 0; i < 60; i++) {
    if (i % 12 === 0) await load(); // the rule must hold across reloads too, i.e. against the saved pick
    const s = await fastSpin();
    if (s.tea === prev) repeats += `spin ${i}: ${s.tea}; `;
    if (!landedOk(s) || (await sv(`return ${savedPick};`)) !== s.tea) wrong += JSON.stringify(s) + ' ';
    prev = s.tea; picked.add(s.tea);
  }
  check('60 spins of 3 teas with reloads: never the current tea again', repeats === '', repeats);
  check('60 spins of 3 teas: landing, sign and saved pick always agree; all 3 come up', wrong === '' && picked.size === 3, wrong.slice(0, 300) + [...picked]);

  await sv(`btn('Meta', 'Izbriši').click();`);
  const two = [];
  for (let i = 0; i < 8; i++) two.push((await fastSpin()).tea);
  check('2 teas: picks strictly alternate', two.every((t, i) => i === 0 || t !== two[i - 1]), two.join(','));

  await sv(`btn(${JSON.stringify(two[7])}, 'Izbriši').click();`);
  check('deleting the picked tea clears the saved pick', await sv(`return localStorage.getItem('webapp.winner') === null && sign() === null;`));
  await load();
  check('reload after that: no sign', await sv(`return sign() === null && spin.querySelectorAll('.winner').length === 0;`));
  const lone = [(await fastSpin()).tea, (await fastSpin()).tea];
  check('1 tea: it can only win again, and the spin still completes', lone[0] === lone[1] && lone[0] === two[6], lone.join(','));

  // ---- the day of the pick is saved with it, and that saved day is what the sign shows ----
  const dayState = `(() => { const now = new Date(); const pad = n => String(n).padStart(2, '0'); const raw = localStorage.getItem('webapp.winner'); let saved = null; try { saved = JSON.parse(raw); } catch {}
    return { raw, saved, today: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()), todayText: new Intl.DateTimeFormat('sl', { weekday: 'short', day: 'numeric', month: 'short' }).format(now),
      date: $('#result-date').textContent, dateHeight: $('#result-date').getBoundingClientRect().height, sign: sign(), whole: $('#result').hidden ? null : $('#result').innerText }; })()`;
  await ev(`localStorage.clear();`);
  await load();
  await sv(`['Zeleni', 'Črni', 'Meta'].forEach(add);`);
  const dayPick = await fastSpin();
  const fresh = await sv(`return ${dayState};`);
  check('pick is saved together with the day it was made', fresh.saved && fresh.saved.day === fresh.today && Object.keys(fresh.saved).sort().join() === 'day,id', fresh.raw);
  check('sign shows that day right after the spin', fresh.date === fresh.todayText && fresh.dateHeight > 0, JSON.stringify(fresh));

  // Make the saved pick an older one. (March 2026: the 5th is a Thursday, the 6th a Friday.)
  const [oldDay, oldText] = fresh.today === '2026-03-05' ? ['2026-03-06', 'pet., 6. mar.'] : ['2026-03-05', 'čet., 5. mar.'];
  await sv(`const saved = JSON.parse(localStorage.getItem('webapp.winner')); saved.day = '${oldDay}'; localStorage.setItem('webapp.winner', JSON.stringify(saved));`);
  await load();
  const older = await sv(`return ${dayState};`);
  check('reload: sign shows the saved day, not today', older.date === oldText && older.date !== older.todayText && older.sign === `Čaj dneva: ${dayPick.tea.toUpperCase()}` && older.whole === `${oldText}\nČaj dneva:\n${dayPick.tea.toUpperCase()}`, JSON.stringify(older));
  await sv(`add('Kamilica'); btn('Kamilica', 'Uredi').click(); const i = $('#list li form input'); i.value = 'Lipa'; i.closest('form').requestSubmit(); btn('Lipa', 'Izbriši').click();`);
  const afterEdits = await sv(`return ${dayState};`);
  check('editing the list leaves the saved day alone', afterEdits.date === oldText && afterEdits.saved.day === oldDay, JSON.stringify(afterEdits));
  await sv(`spinBtn.click();`);
  const midSpinDay = await sv(`return ${dayState};`);
  check('during a spin the saved pick and its day are still the old ones', midSpinDay.saved.day === oldDay && midSpinDay.sign === null, JSON.stringify(midSpinDay));
  await sv(`spin.getAnimations()[0].finish();`);
  await settle();
  const respun = await sv(`return ${dayState};`);
  check('a new spin saves and shows today', respun.saved.day === respun.today && respun.date === respun.todayText && respun.sign !== older.sign, JSON.stringify(respun));

  // A pick saved by an earlier version of the page (bare id, no day) still loads; it just has no date.
  await sv(`localStorage.setItem('webapp.winner', JSON.parse(localStorage.getItem('webapp.winner')).id);`);
  await load();
  const legacy = await sv(`return ${dayState};`);
  check('old-format saved pick: tea still shown, date line simply absent', legacy.sign === respun.sign && legacy.date === '' && legacy.dateHeight === 0 && legacy.whole === legacy.sign.replace(': ', ':\n') && !/invalid/i.test(legacy.whole), JSON.stringify(legacy));
  for (const badDay of ['2026-13-45', '2026-02-30', 'yesterday', 20261012, null]) {
    await sv(`const id = JSON.parse(localStorage.getItem('webapp.strings')).find(i => 'Čaj dneva: ' + i.text.toUpperCase() === ${JSON.stringify(respun.sign)}).id; localStorage.setItem('webapp.winner', JSON.stringify({ id, day: ${JSON.stringify(badDay)} }));`);
    await load();
    const bad = await sv(`return ${dayState};`);
    check(`unusable saved day (${JSON.stringify(badDay)}): tea shown without a date`, bad.sign === respun.sign && bad.date === '' && !/invalid|NaN/i.test(bad.whole), JSON.stringify(bad));
  }
  const upgraded = await fastSpin();
  const upgradedState = await sv(`return ${dayState};`);
  check('next spin after that saves the new format with today', upgradedState.saved && upgradedState.saved.day === upgradedState.today && upgradedState.date === upgradedState.todayText && upgraded.tea.toUpperCase() === upgradedState.sign.slice('Čaj dneva: '.length), JSON.stringify(upgradedState));

  // Same tea written in different cases reads identically on the sign, so it counts as the same tea.
  await ev(`localStorage.clear();`);
  await load();
  await sv(`['Meta', 'META', 'meta', 'Zeleni'].forEach(add);`);
  const names = [];
  for (let i = 0; i < 20; i++) names.push((await fastSpin()).sign);
  check('same name in different cases is never picked back to back', names.every((n, i) => i === 0 || n !== names[i - 1]) && new Set(names).size === 2, names.slice(0, 6).join(' | '));
  await sv(`btn('Zeleni', 'Izbriši').click();`);
  const allSame = await fastSpin();
  check('only same-named teas left: spin still completes', allSame.sign === 'Čaj dneva: META' && !allSame.disabled, JSON.stringify(allSame));

  // Another tab changing the saved pick is reflected here.
  await ev(`localStorage.clear();`);
  await load();
  await sv(`['A1', 'B2', 'C3'].forEach(add);`);
  let cur = (await fastSpin()).tea;
  const other = ['A1', 'B2', 'C3'].find(t => t !== cur);
  await sv(`const id = JSON.parse(localStorage.getItem('webapp.strings')).find(i => i.text === ${JSON.stringify(other)}).id; localStorage.setItem('webapp.winner', JSON.stringify({ id, day: '2026-03-05' })); window.dispatchEvent(new StorageEvent('storage', { key: 'webapp.winner' }));`);
  check('pick changed in another tab shows up here, with its saved day', await sv(`return sign() === 'Čaj dneva: ${other}' && $('#result-date').textContent === 'čet., 5. mar.';`), await sv(`return $('#result').textContent;`));
  cur = other;

  // Shrink the list mid-spin so the slices resize under the wheel; the current tea must still never win.
  let nudged = 0, dodge = '';
  for (let i = 0; i < 40; i++) {
    const victim = ['A1', 'B2', 'C3'].filter(t => t !== cur)[i % 2];
    const s = await fastSpin(`btn('${victim}', 'Izbriši').click();`);
    nudged += s.nudges;
    if (s.tea === cur || s.tea === victim || s.sign !== `Čaj dneva: ${s.tea}` || !s.sliceIsWinner || s.off >= s.half || s.disabled) dodge += `try ${i} cur=${cur} victim=${victim}: ${JSON.stringify(s)} `;
    cur = s.tea;
    await sv(`add('${victim}');`);
  }
  check('list shrinks mid-spin (40 tries): current tea still never wins', dodge === '', dodge.slice(0, 400));
  check('...and the roll-on correction really was exercised', nudged >= 3, `roll-ons: ${nudged}`);

  // A device that asks for reduced motion still gets the full show. Chrome on Android reports that
  // setting when system animations are off, and the page once went static there because of it.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await load();
  await sv(`add('Second tea');`);
  check('reduced-motion device: media query really is emulated', await sv(`return matchMedia('(prefers-reduced-motion: reduce)').matches;`));
  check('reduced-motion device: wheel idles at 40s per turn', await sv(`const a = spin.getAnimations(); return a.length === 1 && a[0].playState === 'running' && a[0].effect.getTiming().duration === 40000;`));
  const rmStart = await sv(`spinBtn.click(); const a = spin.getAnimations(); return { n: a.length, duration: a[0]?.effect.getTiming().duration, sign: sign(), disabled: spinBtn.disabled };`);
  check('reduced-motion device: click starts the 6s spin, no instant result', rmStart.n === 1 && rmStart.duration === 6000 && rmStart.sign === null && rmStart.disabled, JSON.stringify(rmStart));
  await sleep(6300);
  const rm = await sv(`return state();`);
  check('reduced-motion device: lands on the winner with confetti', landedOk(rm) && rm.confetti === 1, JSON.stringify(rm));
  await sleep(400);
  check('reduced-motion device: confetti is drawn', await sv(`const c = $('canvas.confetti'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n > 500;`));
  // Same again at an Android phone's viewport, pixel density and touch input, reduced motion still on.
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' });
  await ev(`localStorage.clear();`);
  await load();
  await sv(`['Zeleni', 'Črni', 'Meta', 'Kamilica', 'Šipek'].forEach(add);`);
  check('phone: wheel fits the screen width and idles', await sv(`const r = $('#wheel svg').getBoundingClientRect(); return r.width > 250 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth && spin.getAnimations().length === 1;`));
  const tap = async (x, y) => {
    for (const type of ['touchStart', 'touchEnd']) await send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchStart' ? [{ x, y }] : [] });
    await sleep(300);
  };
  check('phone: teapot, wheel, spin button and "Seznam čajev" all fit on the first screen', await sv(`return scrollY === 0 && $('#edit-teas').getBoundingClientRect().bottom <= innerHeight && $('.teapot').getBoundingClientRect().top >= 0 && spinBtn.getBoundingClientRect().bottom <= $('#edit-teas').getBoundingClientRect().top;`));
  await tap(...await sv(`return middle('#edit-teas');`));
  const sheet = await sv(`const d = dialog.getBoundingClientRect(), i = $('#add-input').getBoundingClientRect(); return { open: dialog.open, left: d.left, right: d.right, top: d.top, bottom: d.bottom, vw: innerWidth, vh: innerHeight, inputBottom: i.bottom, rows: document.querySelectorAll('#list li').length, rowsShown: [...document.querySelectorAll('#list li')].every(li => li.getBoundingClientRect().bottom <= d.bottom) };`);
  check('phone: tapping "Seznam čajev" opens the editor, inside the screen', sheet.open && sheet.left >= 0 && sheet.right <= sheet.vw && sheet.top >= 0 && sheet.bottom <= sheet.vh && sheet.rows === 5, JSON.stringify(sheet));
  check('phone: add field sits in the top half, clear of an on-screen keyboard', sheet.inputBottom < sheet.vh / 2, JSON.stringify(sheet));
  const shotE = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(scratch, 'phone-editor.png'), Buffer.from(shotE.result.data, 'base64'));
  await tap(...await sv(`return middle('#close-teas');`));
  check('phone: tapping "Zapri" closes the editor', await sv(`return !dialog.open;`));
  const box = await sv(`spinBtn.scrollIntoView({ block: 'center' }); const r = spinBtn.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];`);
  for (const type of ['touchStart', 'touchEnd']) await send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchStart' ? [{ x: box[0], y: box[1] }] : [] });
  await sleep(300);
  check('phone: tapping the button starts the 6s spin', await sv(`const a = spin.getAnimations(); return a.length === 1 && a[0].effect.getTiming().duration === 6000 && sign() === null;`));
  await sleep(6200);
  const phone = await sv(`return state();`);
  check('phone: lands on the winner with confetti', landedOk(phone) && phone.confetti === 1, JSON.stringify(phone));
  await sleep(450);
  const shotP = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(scratch, 'phone.png'), Buffer.from(shotP.result.data, 'base64'));
  await sleep(1200);
  const signBox = await sv(`const r = $('#result').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: innerHeight };`);
  const phoneSign = await sv(`const range = document.createRange(); range.setStartAfter($('#result-date')); range.setEndBefore($('#result-name')); const lh = parseFloat(getComputedStyle($('#result-date')).lineHeight);
    return { dateRows: Math.round($('#result-date').getBoundingClientRect().height / lh), labelRows: range.getClientRects().length, dateFirst: $('#result-date').getBoundingClientRect().bottom <= range.getBoundingClientRect().top + 4, editBelow: $('#edit-teas').getBoundingClientRect().top >= $('#result').getBoundingClientRect().bottom };`);
  check('phone: date line, then "Čaj dneva:", each on one line; list button below the sign', phoneSign.dateRows === 1 && phoneSign.labelRows === 1 && phoneSign.dateFirst && phoneSign.editBelow, JSON.stringify(phoneSign));
  const thick = await sv(`const w = el => ['Top', 'Right', 'Bottom', 'Left'].map(s => getComputedStyle(el)['border' + s + 'Width']).join(); return { rim: w($('#wheel svg')), sign: w($('#result')) };`);
  check('phone: wheel rim and sign border are equally thick', thick.rim === thick.sign && new Set(thick.rim.split(',')).size === 1, JSON.stringify(thick));
  check('phone: sign ends up fully on screen', signBox.top >= 0 && signBox.bottom <= signBox.vh + 0.5, JSON.stringify(signBox));
  const shotQ = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(scratch, 'phone-settled.png'), Buffer.from(shotQ.result.data, 'base64'));
  await send('Emulation.setEmulatedMedia', { features: [] });

  // The wheel's rim must stand out from the page behind it in both light and dark themes.
  const luminance = `c => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }`;
  for (const scheme of ['light', 'dark']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await ev(`localStorage.clear();`);
    await load();
    await ev(`['Zeleni', 'Črni', 'Meta', 'Kamilica'].forEach(add); window.scrollTo(0, 0);`);
    const rimColour = await ev(`const lum = ${luminance}; const probe = document.createElement('div'); probe.style.background = 'Canvas'; document.body.append(probe);
      const page = getComputedStyle(probe).backgroundColor; probe.remove(); const rim = getComputedStyle($('#wheel svg')).borderTopColor;
      const a = lum(rim), b = lum(page); const [r, g, bl] = rim.match(/[\\d.]+/g).map(Number);
      return { scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', rim, page, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), colourful: Math.max(r, g, bl) - Math.min(r, g, bl) > 80 };`);
    check(`wheel rim (${scheme} theme): a real colour that contrasts with the page background`, rimColour.scheme === scheme && rimColour.rim !== rimColour.page && rimColour.contrast >= 3 && rimColour.colourful, JSON.stringify(rimColour));
    const glow = await ev(`const lum = ${luminance}; const b = $('#spin-button'), a = b.getAnimations()[0], d = a.effect.getTiming().duration; a.pause(); const seen = [];
      for (let i = 0; i < 18; i++) { a.currentTime = d * i / 18; const cs = getComputedStyle(b), x = lum(cs.backgroundColor), y = lum(cs.color); seen.push({ bg: cs.backgroundColor, border: cs.borderTopColor, contrast: (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }); }
      a.play(); return { colours: new Set(seen.map(o => o.bg)).size, worst: Math.min(...seen.map(o => o.contrast)), borderFollows: seen.every(o => o.bg === o.border), first: seen[0].bg, third: seen[6].bg, twoThirds: seen[12].bg };`);
    check(`spin button (${scheme} theme): label stays readable through the whole colour cycle`, glow.colours >= 12 && glow.worst >= 4.5 && glow.borderFollows && new Set([glow.first, glow.third, glow.twoThirds]).size === 3, JSON.stringify(glow));
    await ev(`$('#spin-button').click(); document.getElementById('wheel-spin').getAnimations()[0].finish();`);
    await sleep(600);
    const trim = await ev(`const sides = el => { const cs = getComputedStyle(el); return ['Top', 'Right', 'Bottom', 'Left'].map(s => cs['border' + s + 'Width'] + ' ' + cs['border' + s + 'Style'] + ' ' + cs['border' + s + 'Color']); };
      return { shown: !$('#result').hidden, rim: sides($('#wheel svg')), sign: sides($('#result')) };`);
    check(`sign border (${scheme} theme): same colour and same thickness as the wheel rim`, trim.shown && new Set([...trim.rim, ...trim.sign]).size === 1 && /^[4-9]px solid /.test(trim.rim[0]), JSON.stringify(trim));
    await ev(`window.scrollTo(0, 0);`);
    const shotT = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(scratch, `landing-${scheme}.png`), Buffer.from(shotT.result.data, 'base64'));
    if (scheme === 'dark') {
      await ev(`$('#edit-teas').click();`);
      const shotD = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(scratch, 'editor-dark.png'), Buffer.from(shotD.result.data, 'base64'));
    }
  }
  await send('Emulation.setEmulatedMedia', { features: [] });

  // No English left anywhere a person can see or a screen reader can read.
  await ev(`localStorage.clear();`);
  await load();
  await ev(`add('Meta'); add('Zeleni'); $('#spin-button').click(); document.getElementById('wheel-spin').getAnimations()[0].finish();`);
  await sleep(25);
  await ev(`$('#edit-teas').click(); btn('Meta', 'Uredi').click();`);
  const english = await ev(`
    const seen = [document.title, document.body.innerText, $('#hint').textContent, ...[...document.querySelectorAll('[placeholder], [aria-label]')].flatMap(e => [e.getAttribute('placeholder'), e.getAttribute('aria-label')])].join(' | ');
    $('#add-input').value = ''; $('#add-form').requestSubmit();
    return (seen + ' | ' + err()).match(/\\b(add|edit|delete|save|cancel|tea|teas|spin|wheel|string|strings|characters?|day|new|yet|enter|close|empty|button)\\b/gi);`);
  check('no English UI text remains', english === null, String(english));
  check('expected Slovenian labels are shown', await ev(`const t = document.body.innerText; return ['Seznam čajev', 'Čaji', 'Zapri', 'Dodaj', 'Shrani', 'Prekliči', 'Uredi', 'Izbriši', 'ZAVRTI KOLOČAJ', 'Čaj dneva:', 'Vnesi vsaj en znak.'].every(w => t.includes(w)) && $('#add-input').placeholder === 'Dodaj čaj (največ 20 znakov)';`));

  // ---- installable as an app, and usable without a connection ----
  await ev(`localStorage.clear();`);
  await load();
  const manifest = (await send('Page.getAppManifest')).result;
  const app = JSON.parse(manifest.data || '{}');
  check('app: manifest is linked and parses without errors', manifest.url.endsWith('/manifest.webmanifest') && manifest.errors.length === 0, JSON.stringify(manifest.errors));
  check('app: named like the page, opens in its own window at the page\'s own folder', app.name === await ev(`return document.title;`) && app.short_name.length <= 12 && app.display === 'standalone' && app.start_url === './' && app.scope === './' && app.lang === 'sl', JSON.stringify(app));
  const icons = await ev(`const base = $('link[rel=manifest]').href;
    return Promise.all(${JSON.stringify(app.icons || [])}.map(icon => new Promise(done => {
      const img = new Image();
      img.onload = () => done({ ...icon, real: img.naturalWidth + 'x' + img.naturalHeight });
      img.onerror = () => done({ ...icon, real: 'missing' });
      img.src = new URL(icon.src, base);
    })));`);
  check('app: icons load at their stated sizes; 192px, 512px and a maskable one are there', icons.every(i => i.real === i.sizes && i.type === 'image/png') && ['192x192', '512x512'].every(size => icons.some(i => i.sizes === size && !i.purpose)) && icons.some(i => i.purpose === 'maskable' && i.sizes === '512x512'), JSON.stringify(icons));
  const blockers = (await send('Page.getInstallabilityErrors')).result.installabilityErrors;
  check('app: Chrome finds nothing that stops it being installed', blockers.length === 0, JSON.stringify(blockers));
  check('app: theme colour matches the manifest, tab icon loads', await ev(`return $('meta[name=theme-color]').content === ${JSON.stringify(app.theme_color)} && fetch($('link[rel=icon]').href).then(r => r.ok && r.headers.get('content-type') === 'image/svg+xml');`));

  await ev(`return navigator.serviceWorker.ready.then(() => {});`);
  await load();
  check('offline: the service worker is in charge of the page', await ev(`const c = navigator.serviceWorker.controller; return !!c && c.scriptURL.endsWith('/sw.js') && c.state === 'activated';`));
  await ev(`['Zeleni', 'Črni', 'Meta'].forEach(add);`);
  const requestsBefore = pageRequests;
  await load();
  check('online: the page still comes from the network, so a new version shows up at once', pageRequests === requestsBefore + 1, `${pageRequests - requestsBefore} requests`);
  offline = true;
  for (const path of ['/index.html', '/']) {
    await load(path);
    // A file that was never saved shows whether the server can still be reached.
    const off = await ev(`return fetch('not-saved').then(() => true, () => false).then(online => ({ online, title: document.title, teas: texts().join(), slices: document.querySelectorAll('#wheel-spin path').length, idle: $('#wheel-spin').getAnimations().length, button: !$('#spin-button').disabled }));`);
    check(`offline: ${path} opens with the saved teas and a turning wheel`, !off.online && off.title === app.name && off.teas === 'Meta,Črni,Zeleni' && off.slices === 3 && off.idle === 1 && off.button, JSON.stringify(off));
  }
  await ev(`$('#spin-button').click(); $('#wheel-spin').getAnimations()[0].finish();`);
  await sleep(25);
  check('offline: the wheel can be spun and the pick is saved', await ev(`return !$('#result').hidden && $('#result-name').textContent !== '' && localStorage.getItem('webapp.winner') !== null;`));
  offline = false;
  await load();
  check('back online: page loads from the network again, pick still there', pageRequests === requestsBefore + 2 && await ev(`return !$('#result').hidden;`), `${pageRequests - requestsBefore} requests`);

  check('no uncaught page errors', errors.length === 0, errors.join('; '));
  // Ask Chrome to quit by itself: killing only the main process leaves helpers that keep writing to the profile.
  await Promise.race([send('Browser.close'), sleep(2000)]);
} catch (e) {
  failures++;
  console.log('ERROR', e.stack || e);
} finally {
  await cleanup();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
console.log(`Screenshots: ${scratch}`);
process.exit(failures ? 1 : 0);
