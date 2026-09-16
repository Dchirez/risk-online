// Aperçu SVG statique d'une carte générée : node preview-map.mjs middle_earth → preview/middle_earth.svg
import { writeFileSync, mkdirSync } from 'node:fs';
const id = process.argv[2] ?? 'middle_earth';
const { MAP_DATA: M } = await import(`../src/core/maps/${id}.js`);
const path = (polys) => polys.map((poly) => poly.map((r) => 'M' + r.map(([x, y]) => `${x} ${y}`).join('L') + 'Z').join('')).join('');
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${M.width} ${M.height}" width="${M.width}" height="${M.height}"><rect width="100%" height="100%" fill="#d8c48f"/>`;
for (const z of M.zones ?? []) svg += `<path d="M${z.ring.map(([x,y])=>`${x} ${y}`).join('L')}Z" fill="#b9a87a" opacity=".5"/><text x="${z.label[0]}" y="${z.label[1]}" font-size="20" text-anchor="middle" fill="#4a3d1e">${z.name}</text>`;
for (const c of Object.values(M.continents)) svg += `<path d="${path(c.polys)}" fill="none" stroke="${c.color}" stroke-width="10" stroke-opacity=".5"/>`;
for (const [tid, t] of Object.entries(M.territories)) svg += `<path d="${path(t.polys)}" fill="${M.continents[t.continent].color}" stroke="#2b2010" stroke-width="1"/>`;
for (const line of M.ridges ?? []) svg += `<polyline points="${line.map(([x,y])=>`${x},${y}`).join(' ')}" fill="none" stroke="#2b2010" stroke-width="5" stroke-dasharray="2 6" stroke-linecap="round"/>`;
for (const [a, b] of M.seaRoutes) { const A = M.territories[a].label, B = M.territories[b].label; svg += `<line x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}" stroke="#2b2010" stroke-dasharray="6 5"/>`; }
for (const t of Object.values(M.territories)) svg += `<circle cx="${t.label[0]}" cy="${t.label[1]}" r="12" fill="#1e1710"/><text x="${t.label[0]}" y="${t.label[1]+24}" font-size="11" font-weight="700" text-anchor="middle" fill="#fff" stroke="#000" stroke-width="2" paint-order="stroke">${t.name}</text>`;
for (const c of Object.values(M.continents)) svg += `<circle cx="${c.label[0]}" cy="${c.label[1]}" r="24" fill="${c.color}" fill-opacity=".4" stroke="${c.color}" stroke-width="2"/><text x="${c.label[0]}" y="${c.label[1]+7}" font-size="20" text-anchor="middle">+${c.bonus}</text><text x="${c.label[0]}" y="${c.label[1]+44}" font-size="11" text-anchor="middle">${c.name}</text>`;
for (const o of M.oceanLabels) svg += `<text x="${o.pos[0]}" y="${o.pos[1]}" font-size="22" font-style="italic" text-anchor="middle" fill="#7d6a3c">${o.name}</text>`;
svg += '</svg>';
mkdirSync(new URL('./preview/', import.meta.url), { recursive: true });
writeFileSync(new URL(`./preview/${id}.svg`, import.meta.url), svg);
console.log(`→ tools/preview/${id}.svg`);
