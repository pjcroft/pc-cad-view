import { fillSheet, nestQuantity } from '../src/nesting.ts';
const S = { sheetW: 3000, sheetH: 1500, margin: 10, gap: 5, rotate: true };
const L = { id: 'L', name: 'L-bracket', w: 146.77, h: 100, perSet: 2, color: '#f00' };
const U = { id: 'U', name: 'U-channel', w: 300, h: 209.05, perSet: 1, color: '#0f0' };
const P = { id: 'P', name: 'Plate', w: 200, h: 150, perSet: 1, color: '#00f' };
let t = performance.now();
const a = fillSheet([L], S); console.log('L only, fill sheet:', a.counts.L, 'util', (a.utilisation*100).toFixed(1)+'%', (performance.now()-t).toFixed(0)+'ms');
const a2 = fillSheet([L], { ...S, rotate: false }); console.log('L only, no rotation:', a2.counts.L);
// sanity: theoretical grid max
console.log('  grid check 0°:', Math.floor((3000-20+5)/(151.77))*Math.floor((1500-20+5)/105), ' 90°:', Math.floor((2985)/105)*Math.floor(1485/151.77));
t = performance.now();
const b = fillSheet([L, U, P], S); console.log('set of 2L+U+P fill:', b.sets, 'sets', b.counts, 'util', (b.utilisation*100).toFixed(1)+'%', (performance.now()-t).toFixed(0)+'ms');
t = performance.now();
const c = nestQuantity([L, U, P], 50, S); console.log('50 sets ->', c.sheets.length, 'sheets', c.counts, 'util', (c.utilisation*100).toFixed(1)+'%', (performance.now()-t).toFixed(0)+'ms');
// overlap + bounds check
for (const sh of [...a.sheets, ...b.sheets, ...c.sheets]) {
  for (const p of sh.placed) { if (p.x < 10-1e-6 || p.y < 10-1e-6 || p.x+p.w > 2990+1e-6 || p.y+p.h > 1490+1e-6) throw new Error('out of bounds '+JSON.stringify(p)); }
  for (let i=0;i<sh.placed.length;i++) for (let j=i+1;j<sh.placed.length;j++) { const p=sh.placed[i], q=sh.placed[j];
    if (p.x < q.x+q.w+5-1e-6 && q.x < p.x+p.w+5-1e-6 && p.y < q.y+q.h+5-1e-6 && q.y < p.y+p.h+5-1e-6) { const ox = Math.min(p.x+p.w,q.x+q.w)-Math.max(p.x,q.x), oy=Math.min(p.y+p.h,q.y+q.h)-Math.max(p.y,q.y); if (ox > -5+1e-6 && oy > -5+1e-6) throw new Error('gap violated'); } }
}
console.log('bounds + gap checks passed');
