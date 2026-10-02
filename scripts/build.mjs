import { readFile, writeFile, mkdir, cp, stat, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
import { validateCatalog } from '../assets/catalog.js';

const root = fileURLToPath(new URL('../', import.meta.url));
export const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export function renderDirectory(catalog) {
  return `<ul class="scene-list">\n${catalog.map(scene => `        <li><h3><a href="#test=${encodeURIComponent(scene.id)}">${escapeHTML(scene.title)}</a></h3><p>${escapeHTML(scene.description ?? '')}</p></li>`).join('\n')}\n      </ul>`;
}
export function withDirectory(html, catalog) {
  const marker = /<!-- catalog:start -->[\s\S]*?<!-- catalog:end -->/;
  if (!marker.test(html)) throw new Error('Missing static catalog markers.');
  return html.replace(marker, `<!-- catalog:start -->\n      ${renderDirectory(catalog)}\n      <!-- catalog:end -->`);
}
export async function build(destination = resolve(root, 'dist')) {
  const catalog = validateCatalog(JSON.parse(await readFile(resolve(root, 'catalog.json'), 'utf8')), 'https://voluscape.beep.systems/');
  const html = withDirectory(await readFile(resolve(root, 'index.html'), 'utf8'), catalog);
  // A fresh, allowlisted artifact prevents local reports and configuration leaking.
  destination = resolve(destination);
  const outputRelative = relative(root, destination);
  if (!outputRelative || outputRelative === 'build' || outputRelative.startsWith('..') || isAbsolute(outputRelative)
    || !['dist', 'build'].includes(outputRelative.split(/[\\/]/)[0])) throw new Error('Output must be inside project dist/ or build/.');
  const files = new Set(['index.html', 'catalog.json', 'robots.txt', 'sitemap.xml',
    'assets/gallery.css', 'assets/gallery.js', 'assets/catalog.js', 'assets/favicon.svg', 'assets/social-preview.jpg',
    'viewer/embed.html', 'viewer/embed.js', 'viewer/embed.css', 'viewer/index.css', 'viewer/index.js',
    'viewer/settings.json', 'viewer/framing.js', 'viewer/level.js', 'viewer/LICENSE', 'viewer/PLAYCANVAS-LICENSE']);
  for (const scene of catalog) {
    files.add(scene.video);
    if (scene.poster) files.add(scene.poster);
    for (const result of scene.results) { files.add(result.scene); if (result.settings) files.add(result.settings); }
  }
  for (const file of files) {
    const source = resolve(root, file);
    const rel = relative(root, source);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`File outside project: ${file}`);
    if (!(await stat(source)).isFile()) throw new Error(`Not a file: ${file}`);
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const file of [...files].sort()) {
    const target = resolve(destination, file);
    await mkdir(resolve(target, '..'), { recursive: true });
    if (file === 'index.html') await writeFile(target, html);
    else if (file === 'viewer/index.js') await writeFile(target, (await readFile(resolve(root, file), 'utf8')).replace(/^\/\/# sourceMappingURL=.*\r?\n?/gm, ''));
    else await cp(resolve(root, file), target);
  }
  await writeFile(resolve(destination, '.nojekyll'), '');
  return files;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--content')) {
    const catalog = validateCatalog(JSON.parse(await readFile(resolve(root, 'catalog.json'), 'utf8')), 'https://voluscape.beep.systems/');
    await writeFile(resolve(root, 'index.html'), withDirectory(await readFile(resolve(root, 'index.html'), 'utf8'), catalog));
    console.log('Updated static scene directory.');
  } else {
    const files = await build();
    console.log(`Built ${files.size + 1} files in dist/.`);
  }
}
