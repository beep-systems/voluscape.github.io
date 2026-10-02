// Extract still frames only; original video bytes are never rewritten.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from './serve.mjs';
const require = createRequire(import.meta.url);
const { chromium } = (await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve('playwright')))).default;
const root = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(await readFile(new URL('../catalog.json', import.meta.url)));
const server = await createServer(root);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PREVIEW_BROWSER ? { executablePath: process.env.PREVIEW_BROWSER } : {}) });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await mkdir(new URL('../assets/posters/', import.meta.url), { recursive: true });
  for (const [index, scene] of catalog.entries()) {
    const images = await page.evaluate(async ({ path, social }) => {
      const video = document.createElement('video');
      video.muted = true; video.preload = 'auto'; video.src = path;
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve; video.onerror = () => reject(new Error('Video decode failed'));
      });
      await new Promise(resolve => { video.onseeked = resolve; video.currentTime = Math.min(3, video.duration / 2); });
      const capture = width => {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = width * 9 / 16;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', .8).split(',')[1];
      };
      const images = [capture(640), social ? capture(1200) : null];
      video.removeAttribute('src'); video.load();
      return images;
    }, { path: scene.video, social: index === 0 });
    await writeFile(new URL(`../${scene.poster}`, import.meta.url), Buffer.from(images[0], 'base64'));
    if (images[1]) await writeFile(new URL('../assets/social-preview.jpg', import.meta.url), Buffer.from(images[1], 'base64'));
    console.log(`Extracted poster: ${scene.id}`);
  }
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
