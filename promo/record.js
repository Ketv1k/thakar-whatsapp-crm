// Renders promo/scene.html frame by frame with headless Chromium and encodes
// the frames into an MP4 with ffmpeg. See promo/README.md.
//
//   node promo/record.js                 scene.html    -> thakar-support-promo.mp4
//   node promo/record.js features        features.html -> thakar-features-promo.mp4
//   add --frames <dir> to keep the PNG frames somewhere specific
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const FPS = 30;
const SCENES = {
  scene: { out: 'thakar-support-promo.mp4', poster: 'poster.png', posterAt: 17.2 },
  features: { out: 'thakar-features-promo.mp4', poster: 'features-poster.png', posterAt: 34.5 },
};

async function main() {
  const args = process.argv.slice(2);
  const framesAt = args.indexOf('--frames');
  const framesDir = framesAt >= 0 ? args.splice(framesAt, 2)[1] : fs.mkdtempSync(path.join(os.tmpdir(), 'promo-frames-'));
  const name = args[0] || 'scene';
  if (!SCENES[name]) throw new Error(`Unknown scene "${name}" (try: ${Object.keys(SCENES).join(', ')})`);
  const OUT = path.join(__dirname, SCENES[name].out);
  const POSTER = path.join(__dirname, SCENES[name].poster);
  fs.mkdirSync(framesDir, { recursive: true });

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.join(__dirname, `${name}.html`), { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('italic 600 100px "Playfair Display"'),
      document.fonts.load('italic 700 100px "Playfair Display"'),
      document.fonts.load('700 100px "Playfair Display"'),
      ...[400, 500, 600, 700].map((w) => document.fonts.load(`${w} 30px "Work Sans"`)),
    ]);
    await document.fonts.ready;
  });
  const fontsOk = await page.evaluate(
    () => document.fonts.check('italic 600 100px "Playfair Display"') && document.fonts.check('600 30px "Work Sans"')
  );
  if (!fontsOk) throw new Error('Fonts did not load (Google Fonts unreachable?)');

  const duration = await page.evaluate(() => window.DURATION);
  const frames = Math.round(duration * FPS);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.render(t), i / FPS);
    await page.screenshot({ path: path.join(framesDir, `f${String(i).padStart(4, '0')}.png`) });
    if (i % 60 === 0) process.stdout.write(`frame ${i}/${frames}\n`);
  }
  await page.evaluate((t) => window.render(t), SCENES[name].posterAt);
  await page.screenshot({ path: POSTER });
  await browser.close();

  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(framesDir, 'f%04d.png'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT,
  ], { stdio: 'inherit' });
  console.log(`Wrote ${OUT} and ${POSTER}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
