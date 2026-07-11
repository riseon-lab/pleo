// Pleo UI smoke test: signup -> generate (mock) -> encrypted asset -> views.
import { chromium } from 'playwright';

const BASE = process.env.PLEO_TEST_BASE || 'http://127.0.0.1:3210';
const SHOTS = new URL('.', import.meta.url).pathname + 'shots/';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
mkdirSync(SHOTS, { recursive: true });

function tinyPng(seed = 0) { // 16x16 rgb png, pure construction
  const w = 16, hgt = 16;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (tag, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(tag), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, (seed * 37) % 256)]);
  const raw = Buffer.concat(Array.from({ length: hgt }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const results = [];
const check = (name, cond, detail = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  [${detail}]`}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });

// ---- signup ----
await page.goto(BASE);
await page.waitForSelector('#boot form', { timeout: 10000 });
check('signup form on first boot', await page.locator('#boot button').textContent() === 'Create account');
await page.fill('input[placeholder="Password"]', 'hunter22hunter22');
await page.fill('input[placeholder="Confirm password"]', 'hunter22hunter22');
await page.screenshot({ path: SHOTS + '01-signup.png' });
await page.click('#boot button.btn');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
check('entered app after signup', true);

// ---- running view: generate ----
await page.waitForSelector('.run-layout', { timeout: 10000 });
await page.fill('textarea[placeholder="Prompt…"]', 'a lighthouse at dusk, oil painting');
await page.fill('.grid2 label:has(span:text("Steps")) input', '4');
await page.selectOption('select:below(span:text("Resolution"))', 'Portrait 832 × 1216');
const box = await page.locator('.preview-box').boundingBox();
check('preview box is portrait (aspect matches 832x1216)', box && box.height > box.width, JSON.stringify(box));
await page.click('button:text("Generate")');
await page.waitForSelector('#cancel-btn:not([hidden])', { timeout: 15000 });
check('cancel button appears while running', true);
await page.waitForSelector('.preview-box img:not([hidden])', { timeout: 20000 });
await page.screenshot({ path: SHOTS + '02-generating.png' });
await page.waitForSelector('.toast-success', { timeout: 60000 });
const toastText = await page.locator('.toast-success').first().textContent();
check('generated image auto-saved encrypted', toastText.includes('Saved to assets'), toastText);
await page.waitForTimeout(500);
await page.screenshot({ path: SHOTS + '03-done.png' });
const queueBadges = await page.locator('.queue-item .badge').allTextContents();
check('queue shows completed job', queueBadges.includes('done'), queueBadges.join(','));
const headBadge = await page.locator('.view-head .badge').textContent();
check('runner badge live-updates with model name', headBadge.toLowerCase().includes('z image base') && headBadge.includes('ready'), headBadge);

// lightbox from preview
await page.click('.preview-box img');
await page.waitForSelector('.lightbox-frame img');
const closeBtn = await page.locator('.lightbox-close').boundingBox();
const lbImg = await page.locator('.lightbox-frame img').boundingBox();
check('lightbox close button outside image corner', closeBtn && lbImg && closeBtn.y + closeBtn.height <= lbImg.y + 2, JSON.stringify({ closeBtn, lbImg }));
await page.screenshot({ path: SHOTS + '04-lightbox.png' });
await page.keyboard.press('Escape');

// ---- assets: decrypt on the fly ----
await page.click('.nav-item[data-path="assets"]');
await page.waitForSelector('.asset-tile img', { timeout: 15000 });
await page.waitForFunction(() => {
  const i = document.querySelector('.asset-tile img');
  return i && i.naturalWidth > 0;
}, { timeout: 15000 });
const natural = await page.locator('.asset-tile img').first().evaluate(img => ({ w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 5) }));
check('asset decrypts to a real image', natural.w === 832 && natural.h === 1216 && natural.src === 'blob:', JSON.stringify(natural));
await page.click('.asset-tile');
await page.waitForSelector('.lightbox-meta');
const metaTxt = await page.locator('.lightbox-meta').textContent();
check('decrypted metadata shows prompt + seed', metaTxt.includes('lighthouse') && metaTxt.includes('seed'), metaTxt);
await page.screenshot({ path: SHOTS + '05-assets.png' });
await page.keyboard.press('Escape');

// ---- models ----
await page.click('.nav-item[data-path="models"]');
await page.waitForSelector('.model-card');
const cards = await page.locator('.model-card').count();
check('4 model cards', cards === 4, String(cards));
const chips = await page.locator('.model-card .badge').allTextContents();
check('mock mode badges shown', chips.some(c => c.includes('mock')), chips.join(','));
await page.screenshot({ path: SHOTS + '06-models.png' });

// ---- loras ----
await page.click('.nav-item[data-path="loras"]');
await page.waitForSelector('.tabs');
await page.click('.tab[data-t="civitai"]');
check('civitai tab renders', await page.locator('h3:text("Download from Civitai")').count() === 1);
await page.click('.tab[data-t="hf"]');
check('hf tab renders', await page.locator('h3:text("Download from Hugging Face")').count() === 1);

// ---- settings ----
await page.click('.side-foot .nav-item');
await page.waitForSelector('h3:text("API credentials")');
await page.fill('input[placeholder="hf_…"]', 'hf_testkey123');
await page.click('button:text("Save keys")');
await page.waitForSelector('.toast-success');
check('api keys saved encrypted', true);
const statusText = await page.locator('.card:has(h3:text("Status"))').textContent();
check('status shows mock mode', statusText.includes('mock'), statusText);
const modToggle = page.locator('input[type=checkbox]');
await modToggle.check();
await page.waitForSelector('.toast-success:text-matches("Moderation enabled")', { timeout: 5000 }).catch(() => {});
check('moderation toggled on (fail-closed notice shown)', (await page.locator('.card:has(h3:text("Content moderation"))').textContent()).includes('BLOCKED'));
await modToggle.uncheck();
await page.screenshot({ path: SHOTS + '07-settings.png' });

// ---- persistence across reload ----
await page.reload();
await page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
check('session survives reload (no re-login)', true);
await page.click('.nav-item[data-path="running"]');
await page.waitForSelector('.run-layout');
const promptVal = await page.inputValue('textarea[placeholder="Prompt…"]');
check('prompt persisted across reload', promptVal.includes('lighthouse'), promptVal);
const keysVal = await (async () => {
  await page.click('.side-foot .nav-item');
  await page.waitForSelector('input[placeholder="hf_…"]');
  return page.inputValue('input[placeholder="hf_…"]');
})();
check('api key decrypts after reload', keysVal === 'hf_testkey123', keysVal);

// ---- sidebar collapse + mobile ----
await page.click('#collapse-btn');
check('sidebar collapses', await page.locator('#app.collapsed').count() === 1);
await page.click('#collapse-btn');
await page.setViewportSize({ width: 390, height: 844 });
await page.click('.nav-item[data-path="running"]');
await page.waitForTimeout(400);
const sideBox = await page.locator('#sidebar').boundingBox();
check('mobile: nav docks to bottom', sideBox && sideBox.y > 700, JSON.stringify(sideBox));
const maxRight = () => Math.max(...[...document.querySelectorAll('*')]
  .filter(el => el.getBoundingClientRect().width > 50)
  .map(el => el.getBoundingClientRect().right));
const overflow = await page.evaluate(`(${maxRight})() - window.innerWidth`);
check('mobile: no element wider than viewport', overflow <= 1, `${Math.round(overflow)}px overflow`);
const inputPx = await page.locator('textarea[placeholder="Prompt…"]').evaluate(el => getComputedStyle(el).fontSize);
check('mobile: inputs are 16px (no iOS focus zoom)', inputPx === '16px', inputPx);
await page.screenshot({ path: SHOTS + '08-mobile.png' });

// ---- data studio ----
await page.click('.nav-item[data-path="data-studio"]');
await page.waitForSelector('.notice');
check('data studio plaintext notice shown', (await page.locator('.notice').textContent()).includes('unencrypted'));
await page.fill('input[placeholder="New dataset name"]', 'ui set');
await page.click('button:text("Create")');
await page.waitForSelector('button:text("Upload images")', { timeout: 10000 });
const pngPath = SHOTS + 'upload.png';
writeFileSync(pngPath, tinyPng(7));
await page.setInputFiles('input[type=file][accept="image/*"][multiple]', [pngPath]);
await page.waitForSelector('.ds-item textarea', { timeout: 15000 });
check('dataset image uploaded via UI', await page.locator('.ds-item').count() === 1);
await page.fill('input[placeholder="e.g. xk3mple"]', 'uiword1');
await page.click('.card:has(h3:text("Captions")) button:text("Save")');
await page.waitForSelector('.toast-success', { timeout: 10000 });
await page.click('button:text("Start captioner")');
await page.waitForSelector('button:text("Stop captioner"):not([disabled])', { timeout: 20000 });
check('captioner started from UI', true);
await page.click('button:text("Auto-caption"):not([disabled])');
await page.waitForFunction(() => {
  const t = document.querySelector('.ds-item textarea');
  return t && t.value.length > 5;
}, { timeout: 30000 });
const capVal = await page.inputValue('.ds-item textarea');
check('auto-caption filled with trigger word', capVal.startsWith('uiword1'), capVal);
await page.screenshot({ path: SHOTS + '09-datastudio.png' });

// ---- training ----
await page.click('.nav-item[data-path="training"]');
await page.waitForSelector('h3:text("New LoRA training job")');
await page.fill('input[placeholder="e.g. my-character-v1"]', 'ui lora');
await page.fill('label:has(span:text("Total steps")) input', '200');
await page.fill('label:has(span:text-matches("Checkpoint saves")) input', '100');
await page.fill('textarea[placeholder*="sample prompt"]', 'uiword1 test portrait');
await page.fill('label:has(span:text-matches("RunPod")) input', '0.60');
await page.click('button:text("Generate")'); // trigger word generator
check('trigger word generated', (await page.inputValue('input[placeholder="auto-added to captions"]')).length >= 6);
await page.click('button:text("Start training")');
await page.waitForSelector('.card .badge:text("running")', { timeout: 20000 });
check('training job running in UI', true);
await page.waitForSelector('.card .badge:text("done")', { timeout: 60000 });
check('training job completes in UI', true);
await page.waitForSelector('h3:text("Checkpoints")', { timeout: 10000 });
const ckptRows = await page.locator('.list-row:has(button:text("Use as LoRA"))').count();
check('checkpoints listed with promote buttons', ckptRows >= 2, String(ckptRows));
await page.waitForFunction(() => {
  const i = document.querySelector('.ckpt-sample');
  return i && i.naturalWidth > 0;
}, { timeout: 15000 });
check('checkpoint sample thumbnails render', true);
check('loss curve rendered', await page.locator('.loss-chart path').count() >= 1);
check('samples strip present', await page.locator('h3:text("Samples")').count() === 1);
await page.click('.list-row button:text("Use as LoRA")');
await page.waitForSelector('.toast-success', { timeout: 10000 });
const trainOverflow = await page.evaluate(`(${maxRight})() - window.innerWidth`);
check('mobile: training page fits viewport', trainOverflow <= 1, `${Math.round(trainOverflow)}px overflow`);
await page.screenshot({ path: SHOTS + '10-training.png' });

// ---- logout -> login roundtrip ----
await page.setViewportSize({ width: 1440, height: 900 });
await page.click('.side-foot .nav-item');
await page.click('button:text("Log out")');
await page.waitForSelector('#boot form', { timeout: 15000 });
check('logout returns to gate', true);
const btnTxt = await page.locator('#boot button.btn').textContent();
check('gate shows Unlock (not signup)', btnTxt === 'Unlock', btnTxt);
await page.fill('input[placeholder="Password"]', 'hunter22hunter22');
await page.click('#boot button.btn');
await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
check('login works after logout', true);

const realErrors = pageErrors.filter(e => !e.includes('favicon'));
check('no console/page errors', realErrors.length === 0, realErrors.join(' | '));

await browser.close();
const fails = results.filter(r => !r[1]);
console.log(`\n${results.length - fails.length}/${results.length} UI checks passed`);
process.exit(fails.length ? 1 : 0);
