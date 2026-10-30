const { chromium } = require('playwright');
const fs = require('fs');
const dur = Object.fromEntries(fs.readFileSync('durations.txt', 'utf8').trim().split('\n').map(l => { const [k, v] = l.split(' '); return [k, +v * 1000]; }));
const PAD = 600;
const URL = 'http://localhost:3500/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const warm = process.argv[2] === 'warm';
  const ctx = await chromium.launchPersistentContext('profile', {
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' },
    viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
    permissions: ['clipboard-read', 'clipboard-write'],
    ...(warm ? {} : { recordVideo: { dir: 'rec', size: { width: 1280, height: 720 } } }),
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const t0 = Date.now();
  const marks = {};
  let sceneStart = 0;
  const scene = async (id, fn) => {
    sceneStart = Date.now();
    marks[id] = { start: (sceneStart - t0) / 1000 };
    await fn();
    const left = dur[id] + PAD - (Date.now() - sceneStart);
    if (left > 0) await sleep(left);
    marks[id].end = (Date.now() - t0) / 1000;
    console.log(id, marks[id], 'overran by', Math.max(0, -left), 'ms');
  };
  const pickSuggestion = async (input, text) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await input.click(); await input.fill(''); await input.pressSequentially(text, { delay: 55 });
      try { await page.waitForSelector('.suggestions li', { timeout: 8000 }); break; } catch { if (attempt === 3) throw new Error('no suggestions'); }
    }
    await sleep(350);
    await page.locator('.suggestions li').first().click();
  };
  const panelTo = (sel, block = 'start') => page.locator(sel).first().evaluate((el, b) => el.scrollIntoView({ behavior: 'smooth', block: b }), block);

  await page.goto(URL, { waitUntil: 'networkidle' });
  await sleep(4000); // tiles settle

  await scene('intro', async () => { await sleep(500); });

  await scene('search', async () => {
    await pickSuggestion(page.locator('.search input').nth(0), 'Connaught Place');
    await pickSuggestion(page.locator('.search input').nth(1), 'Lajpat Nagar Central');
    await sleep(300);
    await page.getByRole('button', { name: '11 pm' }).click();
    await page.waitForSelector('.card', { timeout: 60000 });
  });

  await scene('map', async () => {
    await sleep(2500);
    const zoomIn = page.locator('.maplibregl-ctrl-zoom-in');
    await zoomIn.click(); await sleep(1800);
    // pan along the route a little
    const box = await page.locator('.stage').boundingBox();
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.65);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.35, { steps: 40 }); await page.mouse.up();
  });

  await scene('score', async () => {
    await panelTo('.bars', 'center'); await sleep(900);
    for (const r of ['Light', 'Road type', 'Help nearby', 'CCTV']) {
      await page.locator('.bars th', { hasText: r }).hover(); await sleep(700);
    }
  });

  await scene('timeline', async () => {
    await panelTo('.timeline', 'center'); await sleep(700);
    const cols = page.locator('.timeline svg rect');
    const n = await cols.count();
    for (let i = 0; i < n; i += 2) { await cols.nth(i).hover(); await sleep(150); }
    await cols.nth(Math.floor(n / 2)).hover();
  });

  await scene('metro', async () => {
    await page.mouse.move(10, 10);
    const card = page.locator('.card', { hasText: 'Walk + metro' });
    await card.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' })); await sleep(600);
    await card.click(); await sleep(1200);
    await panelTo('.warn', 'center');
  });

  await scene('share', async () => {
    await panelTo('.share', 'center'); await sleep(500);
    await page.locator('a.btn.primary').first().hover(); await sleep(1200);
    await page.getByRole('button', { name: 'Copy message' }).first().click();
  });

  await scene('feedback', async () => {
    await panelTo('.feedback', 'center'); await sleep(500);
    const fb = page.locator('.feedback');
    await fb.locator('.chip', { hasText: 'Walk + metro' }).click(); await sleep(450);
    await fb.getByRole('radio', { name: 'People and open shops around' }).click(); await sleep(450);
    await fb.getByRole('radio', { name: "Yes, some stretches don't" }).click(); await sleep(450);
    await fb.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForSelector('.feedback.done');
  });

  marks.end = (Date.now() - t0) / 1000;
  const video = page.video();
  await ctx.close();
  if (video) {
    const p = await video.path();
    fs.writeFileSync('marks.json', JSON.stringify({ video: p, marks }, null, 1));
    console.log('video', p);
  }
})();
