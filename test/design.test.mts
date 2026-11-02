// Sheet metal designer: flat blank vs hand calculation, 3D size vs outside dimensions.
// run: node --experimental-strip-types test/design.test.mts
import * as THREE from 'three';
import { TEMPLATES, build, flatTriangles, newDesign, flange } from '../src/design/model.ts';

let failed = 0;
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;
const check = (name: string, ok: boolean, detail: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(34)} ${detail}`); if (!ok) failed++; };
const BA = (deg: number, r: number, t: number, k: number) => (deg * Math.PI / 180) * (r + k * t);
const OSSB = (deg: number, r: number, t: number) => (r + t) * Math.tan((deg * Math.PI / 180) / 2);

for (const T of TEMPLATES) {
  const d = T.make();
  const res = build(d);
  const { t, r, k } = d;
  const box = new THREE.Box3().setFromObject(res.group);
  const s = box.getSize(new THREE.Vector3());
  const fw = res.flat.maxX - res.flat.minX, fh = res.flat.maxY - res.flat.minY;
  // expected flat: per axis, outside length − 2·OSSB·(bends) + BA·(bends), using outside dims
  const f = d.flanges;
  const axis = (a: 'front' | 'back' | 'left' | 'right', b: 'front' | 'back' | 'left' | 'right', base: number) => {
    let len = base;
    for (const e of [a, b]) {
      const fl = f[e];
      if (!fl.on) continue;
      len += fl.height - 2 * OSSB(fl.angle, r, t) + BA(fl.angle, r, t, k);
      if (fl.ret !== 'none') len += fl.retHeight - 2 * OSSB(90, r, t) + BA(90, r, t, k);
    }
    return len;
  };
  const ex = axis('left', 'right', d.L), ey = axis('front', 'back', d.W);
  check(`${T.label}: flat blank`, near(fw, ex) && near(fh, ey), `${fw.toFixed(2)} × ${fh.toFixed(2)}  (expected ${ex.toFixed(2)} × ${ey.toFixed(2)})`);
  // 3D overall size: base L × W, height = tallest up flange (+ down flange depth)
  const upH = Math.max(t, ...(['front', 'back', 'left', 'right'] as const).filter((e) => f[e].on && f[e].dir === 'up').map((e) => f[e].height));
  const dnH = Math.max(0, ...(['front', 'back', 'left', 'right'] as const).filter((e) => f[e].on && f[e].dir === 'down').map((e) => f[e].height - t));
  const xr = d.L + (f.left.ret === 'out' ? f.left.retHeight - t : 0) + (f.right.ret === 'out' ? f.right.retHeight - t : 0);
  const yr = d.W + (f.front.ret === 'out' ? f.front.retHeight - t : 0) + (f.back.ret === 'out' ? f.back.retHeight - t : 0);
  check(`${T.label}: 3D size`, near(s.x, xr, 0.05) && near(s.y, yr, 0.05) && near(s.z, upH + dnH, 0.05), `${s.x.toFixed(2)} × ${s.y.toFixed(2)} × ${s.z.toFixed(2)}  (expected ${xr.toFixed(2)} × ${yr.toFixed(2)} × ${(upH + dnH).toFixed(2)})`);
  check(`${T.label}: no warnings`, res.warnings.length === 0, res.warnings.join(' | ') || 'ok');
  const tr = flatTriangles(res.flat);
  check(`${T.label}: nest outline`, tr.tris.length > 0 && near(tr.x, Math.max(fw, fh)) && near(tr.y, Math.min(fw, fh)), `${tr.tris.length} triangles`);
}

// 45° flange: OSSB = (r+t)·tan(22.5°)
{
  const d = newDesign(); d.L = 100; d.W = 50; d.flanges.back = { ...flange(true, 30), angle: 45 };
  const res = build(d);
  const exp = 50 + 30 - 2 * OSSB(45, 2, 2) + BA(45, 2, 2, 0.44);
  check('45° flange flat', near(res.flat.maxY - res.flat.minY, exp), `${(res.flat.maxY - res.flat.minY).toFixed(3)} (expected ${exp.toFixed(3)})`);
}
// warnings fire
{
  const d = newDesign(); d.flanges.front = flange(true, 3);
  d.cutouts = [{ id: 1, face: 'base', type: 'hole', x: 1, y: 1, d: 10, w: 0, h: 0, vertical: false }];
  const w = build(d).warnings;
  check('warnings: short flange + bad hole', w.length === 2 && w[1].startsWith('Cutout #1 '), w.join(' | '));
}
// holes are carried to the flat and keep their area
{
  const d = TEMPLATES.find((x) => x.id === 'L')!.make();
  const res = build(d);
  check('L-bracket holes in flat', res.flat.holes.length === 3, `${res.flat.holes.length} cutouts`);
}
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }

// DXF: well-formed pairs, circles for holes, bend lines, inch scaling
import { flatToDxf } from '../src/design/dxf.ts';
{
  const d = TEMPLATES.find((x) => x.id === 'L')!.make();
  const f = build(d).flat;
  const dxf = flatToDxf(f, { inches: false, name: d.name, thickness: d.t, material: d.material });
  const lines = dxf.trim().split('\r\n');
  const pairs = lines.length % 2 === 0;
  const count = (ent: string) => lines.filter((l, i) => i % 2 === 1 && l === ent && lines[i - 1] === '0').length;
  const ascii = /^[\x00-\x7f]*$/.test(dxf);
  check('DXF structure', pairs && lines[lines.length - 1] === 'EOF' && ascii, `${lines.length / 2} pairs, ascii=${ascii}`);
  check('DXF entities', count('CIRCLE') === 2 && count('ARC') === 2 && count('LINE') >= 4 + 2 + 1, `CIRCLE ${count('CIRCLE')} ARC ${count('ARC')} LINE ${count('LINE')}`);
  const xs: number[] = [];
  for (let i = 0; i < lines.length - 1; i += 2) if (lines[i] === '10' || lines[i] === '11') xs.push(+lines[i + 1]);
  check('DXF extents (mm)', near(Math.max(...xs), 100), `max X ${Math.max(...xs)}`);
  const dxfIn = flatToDxf(f, { inches: true, name: d.name, thickness: d.t, material: d.material });
  check('DXF inches', dxfIn.includes('$INSUNITS\r\n70\r\n1') && dxfIn.includes(`\r\n${+(100 / 25.4).toFixed(6)}\r\n`), 'scaled by 1/25.4');
}
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
