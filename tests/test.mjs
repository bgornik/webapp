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

// The page is read fresh on every request, so reloads in the tests always see the current file.
const server = createServer((req, res) => {
  if (!['/', '/index.html'].includes(new URL(req.url, 'http://localhost').pathname)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(readFileSync(join(siteDir, 'index.html')));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const HTTP_PORT = server.address().port;

const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--no-first-run', '--disable-gpu', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=600,700', 'about:blank'], { stdio: 'ignore' });
let chromeError = null;
chrome.on('error', e => { chromeError = e; });
const cleanup = () => {
  server.close();
  chrome.kill();
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
  const load = async () => {
    const done = new Promise(r => listeners.push(m => m.method === 'Page.loadEventFired' && r()));
    await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/index.html` });
    await done;
  };
  const run = async expr => {
    const res = await send('Runtime.evaluate', { expression: `(() => { ${expr} })()`, returnByValue: true });
    if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text);
    return res.result.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');

  const helpers = `
    const $ = s => document.querySelector(s);
    const texts = () => [...document.querySelectorAll('#list li .text')].map(e => e.textContent);
    const stored = () => JSON.parse(localStorage.getItem('webapp.strings') || '[]').map(i => i.text);
    const add = v => { $('#add-input').value = v; $('#add-form').requestSubmit(); };
    const row = t => [...document.querySelectorAll('#list li')].find(li => li.querySelector('.text')?.textContent === t);
    const btn = (t, label) => [...row(t).querySelectorAll('button')].find(b => b.textContent === label);
    const err = () => $('#error').hidden ? '' : $('#error').textContent;
  `;
  const ev = expr => run(helpers + expr);

  await load();
  await ev(`localStorage.clear();`);
  await load();

  check('empty state shown on first load', await ev(`return !$('#empty').hidden && texts().length === 0;`));
  check('no teas: blank wheel shown, spin button disabled, no labels', await ev(`const g = $('#wheel-spin'); return g.querySelectorAll('circle.empty').length === 1 && g.querySelectorAll('path, text').length === 0 && $('#spin-button').disabled && $('#wheel svg').getBoundingClientRect().width > 200;`));
  const order = await ev(`const top = s => $(s).getBoundingClientRect().top; return ['h1', '#wheel svg', '#spin-button', '#add-form', '#empty'].map(top);`);
  check('layout: heading, wheel, spin button, then the add form and list', order.every((v, i) => i === 0 || v > order[i - 1]), order.join(','));
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

  const before = JSON.stringify(await ev(`return texts();`));
  await load();
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
  check('layout: add form and list sit below the whole wheel section', await wv(`return $('#add-form').getBoundingClientRect().top >= $('#wheel').getBoundingClientRect().bottom && $('#list').getBoundingClientRect().top >= $('#add-form').getBoundingClientRect().bottom;`));

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
  const rim = await wv(`const svg = $('#wheel svg').getBoundingClientRect(); const el = $('#wheel .rim'); const cs = getComputedStyle(el); const px = svg.width / 200; const r = +el.getAttribute('r'), w = parseFloat(cs.strokeWidth);
    return { widthPx: w * px, outer: r + w / 2, inner: r - w / 2, visibleUnits: r + w / 2 - 96, stroke: cs.stroke, fill: cs.fill, behindSlices: !!(el.compareDocumentPosition(spin) & Node.DOCUMENT_POSITION_FOLLOWING), cx: el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2, hubx: $('#wheel .hub').getBoundingClientRect().left + $('#wheel .hub').getBoundingClientRect().width / 2 };`);
  check('wheel: thick solid rim around the slices, inside the picture, concentric', rim.visibleUnits >= 3.5 && rim.widthPx >= 7 && rim.outer <= 100 && rim.inner <= 96 && rim.fill === 'none' && rim.behindSlices && Math.abs(rim.cx - rim.hubx) < 0.5, JSON.stringify(rim));
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
    const sign = () => $('#result').hidden ? null : $('#result').textContent;
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
      const r = $('#wheel svg').getBoundingClientRect();
      const w = spin.querySelector('.winner');
      const sliceIsWinner = !!w && w.isPointInFill(new DOMPoint(r.left + r.width / 2, r.top + r.height * 6 / 200).matrixTransform(w.getScreenCTM().inverse()));
      return { tea, off, half: 180 / spin.querySelectorAll('text').length, sliceIsWinner, winners: spin.querySelectorAll('.winner').length };
    };
    const state = () => ({ sign: sign(), disabled: spinBtn.disabled, anims: spin.getAnimations().length, confetti: document.querySelectorAll('canvas.confetti').length, ...underPointer() });
  `;
  const sv = expr => run(helpers + wheelHelpers + spinHelpers + expr);
  const landedOk = s => s.sign === `Čaj dneva: ${s.tea.toUpperCase()}` && s.sliceIsWinner && s.winners === 1 && s.off < s.half * 0.75 && !s.disabled;

  check('title and heading are "Izbirnik čaja", page language is Slovenian', await sv(`return document.title === 'Izbirnik čaja' && $('h1').textContent === 'Izbirnik čaja' && document.documentElement.lang === 'sl';`));
  await sv(`['Earl Grey', 'Sencha', 'Rooibos', 'Oolong', 'Chai'].forEach(add);`);
  check('spin button: labelled, enabled, below the wheel; no sign yet', await sv(`return spinBtn.textContent === 'Zavrti kolo!' && !spinBtn.disabled && spinBtn.getBoundingClientRect().top >= $('#wheel svg').getBoundingClientRect().bottom && sign() === null;`));
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
  check('layout: sign appears between the spin button and the add form', await sv(`const r = $('#result').getBoundingClientRect(); return r.top >= spinBtn.getBoundingClientRect().bottom && r.bottom <= $('#add-form').getBoundingClientRect().top;`));
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
  check('sign shows the tea in uppercase, including č/š/ž', up.sign === 'Čaj dneva: ŽAJBELJ ČAJ ŠIPEK' && up.shown === 'Čaj dneva:\nŽAJBELJ ČAJ ŠIPEK', JSON.stringify(up));
  const lines = await sv(`const range = document.createRange(); range.selectNodeContents($('#result').firstChild); const label = range.getBoundingClientRect(); const name = $('#result-name').getBoundingClientRect(); const box = $('#result').getBoundingClientRect(); return { labelText: $('#result').firstChild.textContent.trim(), labelBottom: label.bottom, nameTop: name.top, labelMid: label.left + label.width / 2, nameMid: name.left + name.width / 2, boxMid: box.left + box.width / 2, nameInside: name.bottom <= box.bottom, nameLines: Math.round(name.height / parseFloat(getComputedStyle($('#result')).lineHeight)) };`);
  check('sign: "Čaj dneva:" on its own line, tea on the next line, both centred', lines.labelText === 'Čaj dneva:' && lines.nameTop >= lines.labelBottom - 4 && lines.nameLines === 1 && Math.abs(lines.labelMid - lines.boxMid) < 2 && Math.abs(lines.nameMid - lines.boxMid) < 2 && lines.nameInside, JSON.stringify(lines));
  check('list, wheel label and saved data keep the original case', [up.list, up.wheel, up.stored].every(a => a.length === 1 && a[0] === 'žajbelj Čaj šipek'), JSON.stringify(up));
  await sv(`btn('žajbelj Čaj šipek', 'Uredi').click(); const i = $('#list li form input'); i.value = 'ALREADY UPPER 123'; i.closest('form').requestSubmit();`);
  check('an already-uppercase tea is unchanged on the sign', await sv(`return sign() === 'Čaj dneva: ALREADY UPPER 123';`), await sv(`return sign();`));

  // ---- the pick is saved, and a spin never repeats the current tea ----
  const savedPick = `(() => { const id = localStorage.getItem('webapp.winner'); const it = JSON.parse(localStorage.getItem('webapp.strings') || '[]').find(i => i.id === id); return it ? it.text : null; })()`;
  await ev(`localStorage.clear();`);
  await load();
  await sv(`['Zeleni', 'Črni', 'Meta'].forEach(add);`);
  check('nothing saved before the first spin', await sv(`return localStorage.getItem('webapp.winner') === null && sign() === null;`));
  const first = await fastSpin();
  check('pick is saved in localStorage', (await sv(`return ${savedPick};`)) === first.tea, first.tea);
  await load();
  const back = await sv(`return { sign: sign(), winners: spin.querySelectorAll('.winner').length, canvases: document.querySelectorAll('canvas').length, idle: spin.getAnimations()[0]?.effect.getTiming().duration, disabled: spinBtn.disabled };`);
  check('reload: sign and highlight come back, wheel idles, no confetti replay', back.sign === `Čaj dneva: ${first.tea.toUpperCase()}` && back.winners === 1 && back.canvases === 0 && back.idle === 40000 && !back.disabled, JSON.stringify(back));

  let prev = first.tea, repeats = '', wrong = '';
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
  await sv(`const id = JSON.parse(localStorage.getItem('webapp.strings')).find(i => i.text === ${JSON.stringify(other)}).id; localStorage.setItem('webapp.winner', id); window.dispatchEvent(new StorageEvent('storage', { key: 'webapp.winner' }));`);
  check('pick changed in another tab shows up here', await sv(`return sign() === 'Čaj dneva: ${other}';`), await sv(`return sign();`));
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
  check('reduced-motion device: confetti is drawn, sign pops in', await sv(`const c = $('canvas.confetti'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n > 500 && getComputedStyle($('#result')).animationName === 'pop';`));
  // Same again at an Android phone's viewport, pixel density and touch input, reduced motion still on.
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' });
  await ev(`localStorage.clear();`);
  await load();
  await sv(`['Zeleni', 'Črni', 'Meta', 'Kamilica', 'Šipek'].forEach(add);`);
  check('phone: wheel fits the screen width and idles', await sv(`const r = $('#wheel svg').getBoundingClientRect(); return r.width > 250 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth && spin.getAnimations().length === 1;`));
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
  check('phone: sign ends up fully on screen', signBox.top >= 0 && signBox.bottom <= signBox.vh + 0.5, JSON.stringify(signBox));
  const shotQ = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(scratch, 'phone-settled.png'), Buffer.from(shotQ.result.data, 'base64'));
  await send('Emulation.setEmulatedMedia', { features: [] });

  // No English left anywhere a person can see or a screen reader can read.
  await ev(`localStorage.clear();`);
  await load();
  await ev(`add('Meta'); add('Zeleni'); $('#spin-button').click(); document.getElementById('wheel-spin').getAnimations()[0].finish();`);
  await sleep(25);
  await ev(`btn('Meta', 'Uredi').click();`);
  const english = await ev(`
    const seen = [document.title, document.body.innerText, ...[...document.querySelectorAll('[placeholder], [aria-label]')].flatMap(e => [e.getAttribute('placeholder'), e.getAttribute('aria-label')])].join(' | ');
    $('#add-input').value = ''; $('#add-form').requestSubmit();
    return (seen + ' | ' + err()).match(/\\b(add|edit|delete|save|cancel|tea|teas|spin|wheel|string|strings|characters?|day|new|yet|enter)\\b/gi);`);
  check('no English UI text remains', english === null, String(english));
  check('expected Slovenian labels are shown', await ev(`const t = document.body.innerText; return ['Izbirnik čaja', 'Dodaj', 'Shrani', 'Prekliči', 'Uredi', 'Izbriši', 'Zavrti kolo!', 'Čaj dneva:', 'Vnesi vsaj en znak.'].every(w => t.includes(w)) && $('#add-input').placeholder === 'Dodaj čaj (največ 20 znakov)';`));

  check('no uncaught page errors', errors.length === 0, errors.join('; '));
  ws.close();
} catch (e) {
  failures++;
  console.log('ERROR', e.stack || e);
} finally {
  cleanup();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
console.log(`Screenshots: ${scratch}`);
process.exit(failures ? 1 : 0);
