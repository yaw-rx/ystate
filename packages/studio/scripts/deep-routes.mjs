import { readFileSync, mkdirSync, copyFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';

const outDir = process.argv[2] || 'public';

const entries = readdirSync(outDir).filter(e => {
    const p = join(outDir, e);
    return statSync(p).isDirectory() && existsSync(join(p, 'index.html'));
});

const hrefRe = /href="(\/[^"]+)"/g;
const tocRe = /toc-section="([^"]+)"/g;

for (const route of entries) {
    const indexPath = join(outDir, route, 'index.html');
    const html = readFileSync(indexPath, 'utf8');
    const prefix = '/' + route + '/';
    const seen = new Set();
    let m;

    while ((m = hrefRe.exec(html)) !== null) {
        if (!m[1].startsWith(prefix)) continue;
        const subPath = m[1].slice(1);
        if (seen.has(subPath)) continue;
        seen.add(subPath);
        const dir = join(outDir, subPath);
        mkdirSync(dir, { recursive: true });
        copyFileSync(indexPath, join(dir, 'index.html'));
    }

    while ((m = tocRe.exec(html)) !== null) {
        const subPath = route + '/' + m[1];
        if (seen.has(subPath)) continue;
        seen.add(subPath);
        const dir = join(outDir, subPath);
        mkdirSync(dir, { recursive: true });
        copyFileSync(indexPath, join(dir, 'index.html'));
    }

    console.log(route + ': ' + seen.size + ' deep routes');
}

const distIndex = join(dirname(outDir), 'dist', 'index.html');
try { copyFileSync(distIndex, join(outDir, '404.html')); } catch {}
