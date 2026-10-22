import { readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { gitDate } from './src/lib/lastmod.mjs';

// lastmod comes from the post's `updated` or `date` front matter, or the last git
// commit of the page's source files. Never the build time.
const BLOG_DIR = 'src/content/blog/';
const LANGS = ['de', 'es'];
const frontMatterDate = (file) => {
  const fm = readFileSync(file, 'utf8').split('---')[1] ?? '';
  const field = (k) => fm.match(new RegExp(`^${k}:\\s*(\\S+)`, 'm'))?.[1];
  return field('updated') ?? field('date');
};
// Keys: 'slug' for English, 'lang/slug' for translations.
const postDates = {};
for (const dir of ['', ...LANGS.map((l) => `${l}/`)]) {
  let files = [];
  try { files = readdirSync(BLOG_DIR + dir).filter((f) => f.endsWith('.md')); } catch {}
  for (const f of files) postDates[dir + f.replace(/\.md$/, '')] = frontMatterDate(BLOG_DIR + dir + f);
}
const newest = (dates) => dates.filter(Boolean).sort().pop();
const homeDate = () => gitDate('src/pages/index.astro', 'src/pages/[lang]/index.astro', 'src/components', 'src/lib/strings.ts');
const pageDates = {
  '/': homeDate,
  '/de': homeDate,
  '/es': homeDate,
  '/blog': () => newest(Object.entries(postDates).filter(([k]) => !k.includes('/')).map(([, v]) => v)),
  '/privacy': () => gitDate('src/pages/privacy.astro', 'src/components/PrivacyPage.astro', '../docs/privacy-policy.md'),
  '/de/privacy': () => gitDate('src/pages/[lang]/privacy.astro', 'src/components/PrivacyPage.astro', '../docs/privacy-policy.de.md'),
  '/es/privacy': () => gitDate('src/pages/[lang]/privacy.astro', 'src/components/PrivacyPage.astro', '../docs/privacy-policy.es.md'),
};

// Astro writes a nested 404 page as <lang>/404/index.html. Move it to <lang>/404.html, like the English one.
const flat404 = {
  name: 'flat-404',
  hooks: {
    'astro:build:done': ({ dir }) => {
      const out = fileURLToPath(dir);
      for (const l of LANGS) {
        renameSync(`${out}${l}/404/index.html`, `${out}${l}/404.html`);
        rmSync(`${out}${l}/404`, { recursive: true });
      }
    },
  },
};

export default defineConfig({
  site: 'https://nib.emuye.dev',
  // Links and the sitemap use /blog, not /blog/, so each page has one URL.
  trailingSlash: 'never',
  // Emit the pattern-demo script as a file, so the Content-Security-Policy needs no script hash.
  vite: { build: { assetsInlineLimit: 0 } },
  // Writes sitemap-index.xml on every build, so new blog posts are listed automatically.
  integrations: [
    flat404,
    sitemap({
      // 404 pages are noindex and never belong in the sitemap.
      filter: (page) => !/\/404\/?$/.test(page),
      serialize(item) {
        const path = new URL(item.url).pathname.replace(/(.)\/$/, '$1');
        const post = path.match(/^\/(?:(de|es)\/)?blog\/(.+)$/)?.slice(1).filter(Boolean).join('/');
        const blogIndex = path.match(/^\/(de|es)\/blog$/)?.[1];
        const lastmod = post ? postDates[post] : blogIndex ? newest(Object.entries(postDates).filter(([k]) => k.startsWith(`${blogIndex}/`)).map(([, v]) => v)) : pageDates[path]?.();
        if (lastmod) item.lastmod = lastmod;
        return item;
      },
    }),
  ],
});
