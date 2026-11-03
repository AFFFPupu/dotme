const { chromium } = require('playwright');
const [,, page_, out, fps, scale, w, h, stills] = process.argv;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: +scale });
  await p.goto('file://' + __dirname + '/' + page_);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(500);
  require('fs').mkdirSync(out, { recursive: true });
  const T = await p.evaluate(() => window.T);
  const times = stills ? stills.split(',').map(Number) : Array.from({ length: Math.ceil(T * fps) }, (_, i) => i / fps);
  for (let i = 0; i < times.length; i++) {
    await p.evaluate((t) => window.render(t), times[i]);
    await p.screenshot({ path: `${out}/f${String(i).padStart(4, '0')}.png` });
  }
  await b.close();
})();
