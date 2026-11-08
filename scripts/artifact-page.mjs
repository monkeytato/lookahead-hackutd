// Turns dist-artifact/index.html into dist-artifact/artifact.html, the page published as a
// claude.ai artifact. The artifact host wraps the page in its own <html>/<head>/<body>, so this
// keeps only the title, the stylesheet/script tags and the React root. Run by `npm run build:artifact`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const dir = 'dist-artifact';
const html = readFileSync(`${dir}/index.html`, 'utf8');
const tags = [
  ...html.matchAll(/<link rel="stylesheet"[^>]*>/g),
  ...html.matchAll(/<link rel="modulepreload"[^>]*>/g),
  ...html.matchAll(/<script type="module"[^>]*><\/script>/g),
].map((m) => m[0]);
if (!tags.some((t) => t.startsWith('<script'))) throw new Error('no module script found in dist-artifact/index.html');

const page = [
  '<title>CenterGuard</title>',
  '<meta name="description" content="Data-center operations prototype: verify warnings, rank incidents by time to impact, dispatch, hand off. Static demo, all data simulated.">',
  ...tags,
  '<div id="root"></div>',
  '',
].join('\n');
writeFileSync(`${dir}/artifact.html`, page);

// files.json: published path → local path for every supporting file, for republishing to the same URL
const files = Object.fromEntries(
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !['index.html', 'artifact.html', 'files.json'].includes(e.name))
    .map((e) => {
      const rel = join(relative(dir, e.parentPath), e.name).split(sep).join('/');
      return [rel, `${dir}/${rel}`];
    }),
);
writeFileSync(`${dir}/files.json`, JSON.stringify(files, null, 1));
console.log(`wrote ${dir}/artifact.html (${tags.length} asset tags) and files.json (${Object.keys(files).length} files)`);
