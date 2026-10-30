// Records the walkthrough with a visible cursor, click ripples and wheel scrolling.
// Usage: node record.js [warm]   (reads durations_in.txt, writes marks2.json)
// Needs the app on APP_URL (default http://localhost:3600/) with the feedback webhook pointed at local_feedback_sink.py.
const { chromium } = require('playwright');
const fs = require('fs');
const dur = Object.fromEntries(fs.readFileSync('durations_in.txt', 'utf8').trim().split('\n').map(l => { const [k, v] = l.split(' '); return [k, +v * 1000]; }));
const PAD = 700;
const URL = process.env.APP_URL || 'http://localhost:3600/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CURSOR = () => {
  const install = () => {
    if (document.getElementById('__cursor')) return;
    const c = document.createElement('div');
    c.id = '__cursor';
    c.setAttribute('popover', 'manual');
    c.innerHTML = '<svg width="24" height="30" viewBox="0 0 24 30"><path d="M3 2 L3 23 L8.6 17.8 L12.3 27 L16 25.4 L12.4 16.4 L20 16.4 Z" fill="#111" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', inset: 'auto', left: '0', top: '0', margin: '0', padding: '0', border: '0',
      background: 'transparent', overflow: 'visible', pointerEvents: 'none', transform: 'translate(-100px,-100px)',
      filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))' });
    document.body.appendChild(c);
    c.showPopover();
    let lastDialog = null;
    const raise = () => { // keep the cursor above modal dialogs (both live in the top layer)
      const d = document.querySelector('dialog[open]');
      if (d !== lastDialog) { lastDialog = d; c.hidePopover(); c.showPopover(); }
    };
    addEventListener('mousemove', (e) => { raise(); c.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`; }, true);
    addEventListener('mousedown', (e) => {
      raise();
      const r = document.createElement('div');
      r.setAttribute('popover', 'manual');
      Object.assign(r.style, { position: 'fixed', inset: 'auto', margin: '0', padding: '0', border: '0', left: (e.clientX - 16) + 'px', top: (e.clientY - 16) + 'px',
        width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(245,185,66,.5)', pointerEvents: 'none',
        transition: 'transform .5s ease-out, opacity .5s ease-out' });
      document.body.appendChild(r); r.showPopover(); c.hidePopover(); c.showPopover();
      requestAnimationFrame(() => { r.style.transform = 'scale(1.9)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 600);
    }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install); else install();
};

(async () => {
  const warm = process.argv[2] === 'warm';
  const ctx = await chromium.launchPersistentContext('profile2', {
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' },
    viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, colorScheme: 'dark',
    geolocation: { latitude: 28.63151, longitude: 77.21902 }, permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
    ...(warm ? {} : { recordVideo: { dir: 'rec2', size: { width: 1280, height: 720 } } }),
  });
  await ctx.addInitScript(CURSOR);
  await ctx.addInitScript(() => { // a desktop browser has no SMS app; keep the page from navigating away
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.href.startsWith('sms:')) return; return orig.call(this); };
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  // Start from a clean, dark, one-contact state every run.
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('rasta-trusted-contacts', JSON.stringify([{ name: 'Didi', phone: '+919810012345' }])); sessionStorage.clear(); });

  let mx = 900, my = 420;
  const moveTo = async (x, y, ms = 650) => {
    const steps = Math.max(8, Math.min(26, Math.round(ms / 25)));
    const sx = mx, sy = my;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      await page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
      await sleep(ms / steps);
    }
    mx = x; my = y;
  };
  const center = async (loc) => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  const hover = async (loc, ms) => { const [x, y] = await center(loc); await moveTo(x, y, ms); };
  const click = async (loc, ms) => { await hover(loc, ms); await page.mouse.down(); await sleep(70); await page.mouse.up(); };
  /** Wheel-scroll the side panel until `sel` sits around the given viewport y. */
  const wheelTo = async (sel, targetY = 360) => {
    await moveTo(230, 520, 450);
    for (let i = 0; i < 40; i++) {
      const b = await page.locator(sel).first().boundingBox();
      const delta = b.y + b.height / 2 - targetY;
      if (Math.abs(delta) < 30) break;
      await page.mouse.wheel(0, Math.max(-120, Math.min(120, delta)));
      await sleep(45);
    }
    await sleep(250);
  };

  const t0 = Date.now();
  const marks = {};
  const scene = async (id, fn) => {
    const s = Date.now();
    marks[id] = { start: (s - t0) / 1000 };
    await fn();
    const left = dur[id] + PAD - (Date.now() - s);
    if (left > 0) await sleep(left);
    marks[id].end = (Date.now() - t0) / 1000;
    console.log(id, marks[id], 'overran by', Math.max(0, -left), 'ms');
  };

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.mouse.move(mx, my);
  await sleep(4500);

  await scene('intro', async () => { await sleep(1200); await moveTo(700, 380, 1400); });

  await scene('search', async () => {
    const pick = async (input, text) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        await click(input, 600); await input.fill(''); await page.keyboard.type(text, { delay: 45 });
        try { await page.waitForSelector('.suggestions li', { timeout: 8000 }); break; } catch { if (attempt === 3) throw new Error('no suggestions'); }
      }
      await sleep(300);
      await click(page.locator('.suggestions li').first(), 450);
    };
    await pick(page.locator('.search input').nth(0), 'Connaught Place');
    await pick(page.locator('.search input').nth(1), 'Lajpat Nagar Central');
    await click(page.getByRole('button', { name: '11 pm' }), 500);
    await page.waitForSelector('.card', { timeout: 60000 });
  });

  await scene('map', async () => {
    await sleep(1500);
    await click(page.locator('.maplibregl-ctrl-zoom-in'), 700);
    await sleep(1200);
    const box = await page.locator('.stage').boundingBox();
    await moveTo(box.x + box.width * 0.55, box.y + box.height * 0.68, 700);
    await page.mouse.down();
    await moveTo(box.x + box.width * 0.55, box.y + box.height * 0.36, 1500);
    await page.mouse.up();
  });

  await scene('score', async () => {
    await wheelTo('.bars', 380);
    for (const r of ['Open places', 'Light', 'Road type', 'Help nearby', 'CCTV']) {
      await hover(page.locator('.bars th', { hasText: r }), 380); await sleep(320);
    }
  });

  await scene('timeline', async () => {
    await wheelTo('.timeline', 360);
    const cols = page.locator('.timeline svg rect');
    const n = await cols.count();
    for (let i = 0; i < n; i += 2) await hover(cols.nth(i), 140);
    await hover(cols.nth(Math.floor(n / 2)), 300);
  });

  await scene('metro', async () => {
    const card = page.locator('.card', { hasText: 'Walk + metro' });
    await wheelTo('.card >> text=Walk + metro', 300);
    await click(card, 600);
    await sleep(900);
    await wheelTo('.warn', 330);
  });

  await scene('share', async () => {
    await wheelTo('.share-block', 300);
    await click(page.getByRole('button', { name: 'Edit contacts' }), 600);
    const dlg = page.locator('dialog.contacts');
    await click(dlg.getByLabel('Name'), 500); await page.keyboard.type('Papa', { delay: 55 });
    await click(dlg.getByLabel('Phone number'), 400); await page.keyboard.type('98110 98110', { delay: 45 });
    await click(dlg.getByRole('button', { name: 'Add' }), 400);
    await sleep(500);
    await click(dlg.getByRole('button', { name: 'Done' }), 500);
    await click(page.getByRole('button', { name: /Send to my 2 contacts/ }), 600);
    await page.waitForSelector('.share-status >> text=Press send', { timeout: 15000 });
  });

  await scene('feedback', async () => {
    await wheelTo('.feedback', 360);
    const fb = page.locator('.feedback');
    await click(fb.locator('.chip', { hasText: 'Walk + metro' }), 450);
    await click(fb.getByRole('radio', { name: 'People and open shops around' }), 400);
    await click(fb.getByRole('button', { name: 'Send', exact: true }), 400);
    await page.waitForSelector('.feedback.done');
  });

  await scene('theme', async () => {
    await wheelTo('.brand', 120);
    await click(page.locator('.theme-toggle'), 650);
    await sleep(600);
    await moveTo(900, 400, 700);
  });

  marks.end = (Date.now() - t0) / 1000;
  const video = page.video();
  await ctx.close();
  if (video) {
    fs.writeFileSync('marks2.json', JSON.stringify({ video: await video.path(), marks }, null, 1));
    console.log('video', await video.path());
  }
})();
