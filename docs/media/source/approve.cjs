const { chromium } = require('playwright');
const fs = require('fs');
const out = __dirname + '/approve-frames'; fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);
const SCALE = 2, VW = 390, VH = 684;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: SCALE });
  const s = await b.newPage({ viewport: { width: 880, height: 560 }, deviceScaleFactor: SCALE });
  await s.goto('file://' + __dirname + '/stage.html'); await s.evaluate(() => document.fonts.ready);
  await p.goto('http://localhost:8787/approve');
  await p.fill('input[name=passphrase]', 'local-test-passphrase');
  await Promise.all([p.waitForNavigation(), p.click('button:has-text("Sign in")')]);
  await p.goto('http://localhost:8787/approve');
  await p.addStyleTag({ content: '#tap{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:rgba(255,122,138,.5);border:3px solid #2A2238;z-index:9;pointer-events:none;display:none}' });
  await p.evaluate(() => { const t = document.createElement('div'); t.id = 'tap'; document.body.appendChild(t); });
  const gid = await p.evaluate(() => [...document.querySelectorAll('input[type=checkbox]')].find(i => i.closest('.box')?.textContent.includes('grok-bot')).value);
  const G = `input[value="${gid}"]`;
  let n = 0;
  async function frame(cap, sub, mood = 'idle', count = 1, hop = 0) {
    const buf = await p.screenshot();
    await s.evaluate(([src, cap, sub, mood, hop]) => window.set(src, cap, sub, mood, hop), ['data:image/png;base64,' + buf.toString('base64'), cap, sub, mood, hop]);
    const sb = await s.screenshot();
    for (let i = 0; i < count; i++) fs.writeFileSync(`${out}/f${String(n++).padStart(4, '0')}.png`, sb);
  }
  const tap = (x, y) => p.evaluate(([x, y]) => { const t = document.getElementById('tap'); t.style.left = x + 'px'; t.style.top = y + 'px'; t.style.display = x < 0 ? 'none' : 'block'; }, [x, y]);
  const c1 = 'Your agents propose.', s1 = 'Each proposal shows who asked, the change and the evidence.';
  await frame(c1, s1, 'idle', 14);
  await frame(c1, s1, 'blink', 2);
  await frame(c1, s1, 'idle', 8);
  // Scroll to the third proposal.
  const box = await p.locator(G).boundingBox();
  const target = Math.max(0, box.y - 300);
  for (let i = 1; i <= 10; i++) { const k = 1 - Math.pow(1 - i / 10, 3); await p.evaluate((y) => window.scrollTo(0, y), target * k); await frame(c1, s1); }
  const c2 = 'You pick.', s2 = 'Tick what should be saved. The rest waits.';
  const cb = await p.locator(G).boundingBox();
  await frame(c2, s2, 'idle', 6);
  await tap(cb.x + cb.width / 2, cb.y + cb.height / 2); await frame(c2, s2, 'idle', 3);
  await p.locator(G).uncheck(); await frame(c2, s2, 'idle', 3);
  await tap(-1, -1); await frame(c2, s2, 'idle', 8);
  const ab = await p.locator('button:has-text("Approve ticked")').boundingBox();
  await tap(ab.x + ab.width / 2, ab.y + ab.height / 2); await frame(c2, s2, 'idle', 3);
  await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent === 'Approve ticked'); b.style.transform = 'translate(2px,2px)'; b.style.boxShadow = '1px 1px 0 #2A2238'; });
  await frame(c2, s2, 'idle', 3);
  await Promise.all([p.waitForNavigation(), p.click('button:has-text("Approve ticked")')]);
  const c3 = 'Saved. One commit each.', s3 = 'Every agent sees it in its next session.';
  for (let i = 0; i < 12; i++) await frame(c3, s3, 'happy', 1, Math.abs(Math.sin(i * Math.PI / 4)) * 18 * (1 - i / 12));
  await frame(c3, s3, 'happy', 26);
  console.log('frames', n, p.url());
  await b.close();
})();
