// Sheet metal designer: flat blanks vs hand calculation, 3D sizes, chains, DXF, v1 upgrade.
// run: node --experimental-strip-types test/design.test.mts
import * as THREE from 'three';
import { TEMPLATES, build, flatTriangles, newDesign, chain, seg, upgradeV1, EDGES, type Design } from '../src/design/model.ts';
import { flatToDxf } from '../src/design/dxf.ts';

let failed = 0;
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;
const check = (name: string, ok: boolean, detail: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(36)} ${detail}`); if (!ok) failed++; };
const BA = (deg: number, r: number, t: number, k: number) => (deg * Math.PI / 180) * (r + k * t);
const OSSB = (deg: number, r: number, t: number) => (r + t) * Math.tan((deg * Math.PI / 180) / 2);
// expected flat length along one axis: base + Σ over each chain flange (H − 2·OSSB + BA)
const axis = (d: Design, a: 'front' | 'back' | 'left' | 'right', b: 'front' | 'back' | 'left' | 'right', base: number) =>
  [a, b].reduce((len, e) => len + d.chains[e].segs.reduce((x, s) => x + s.height - 2 * OSSB(s.angle, d.r, d.t) + BA(s.angle, d.r, d.t, d.k), 0), base);
const size3 = (g: THREE.Object3D) => new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());

const EXPECT3D: Record<string, [number, number, number]> = {
  flat: [200, 100, 2], L: [100, 80, 60], U: [300, 120, 40], Z: [150, 60, 78], hat: [400, 106, 40], C: [400, 100, 50], tray: [300, 200, 40],
};
for (const T of TEMPLATES) {
  const d = T.make();
  const res = build(d);
  const fw = res.flat.maxX - res.flat.minX, fh = res.flat.maxY - res.flat.minY;
  const ex = axis(d, 'left', 'right', d.L), ey = axis(d, 'front', 'back', d.W);
  check(`${T.label}: flat blank`, near(fw, ex) && near(fh, ey), `${fw.toFixed(2)} × ${fh.toFixed(2)}  (expected ${ex.toFixed(2)} × ${ey.toFixed(2)})`);
  const s = size3(res.group), e3 = EXPECT3D[T.id];
  check(`${T.label}: 3D size`, near(s.x, e3[0], 0.05) && near(s.y, e3[1], 0.05) && near(s.z, e3[2], 0.05), `${s.x.toFixed(2)} × ${s.y.toFixed(2)} × ${s.z.toFixed(2)}  (expected ${e3.join(' × ')})`);
  check(`${T.label}: no warnings`, res.warnings.length === 0, res.warnings.join(' | ') || 'ok');
  const tr = flatTriangles(res.flat);
  check(`${T.label}: nest outline`, tr.tris.length > 0 && near(tr.x, Math.max(fw, fh)) && near(tr.y, Math.min(fw, fh)), `${tr.tris.length} triangles`);
  const free = EDGES.filter((e) => !d.chains[e].segs.length).length + EDGES.filter((e) => d.chains[e].segs.length).length;
  check(`${T.label}: clickable edges`, res.handles.length === free, `${res.handles.length} handles (one per base edge or chain end)`);
}

// a 3-flange chain built by "clicking" edges: up 40, up 20, down 15
{
  const d = newDesign(); d.L = 300; d.W = 100;
  d.chains.back = chain(seg(40, 'up'), seg(20, 'up'), seg(15, 'down'));
  const res = build(d);
  const exp = axis(d, 'front', 'back', d.W);
  check('3-flange chain: flat', near(res.flat.maxY - res.flat.minY, exp), `${(res.flat.maxY - res.flat.minY).toFixed(3)} (expected ${exp.toFixed(3)})`);
  check('3-flange chain: 3 bend lines', res.flat.bends.length === 3 && res.flat.bends.map((b) => (b.up ? 'U' : 'D')).join('') === 'UUD', res.flat.bends.map((b) => (b.up ? 'UP' : 'DOWN')).join(', '));
  const end = res.handles.find((h) => h.edge === 'back')!;
  check('3-flange chain: end handle', !!end && end.seg === 3, `next flange would be #${end?.seg + 1}`);
  check('3-flange chain: no warnings', res.warnings.length === 0, res.warnings.join(' | ') || 'ok');
}
// 45° flange: OSSB = (r+t)·tan(22.5°)
{
  const d = newDesign(); d.L = 100; d.W = 50; d.chains.back = chain(seg(30, 'up', 45));
  const res = build(d);
  const exp = 50 + 30 - 2 * OSSB(45, 2, 2) + BA(45, 2, 2, 0.44);
  check('45° flange flat', near(res.flat.maxY - res.flat.minY, exp), `${(res.flat.maxY - res.flat.minY).toFixed(3)} (expected ${exp.toFixed(3)})`);
}
// cutout on the 2nd flange of a chain lands in the flat at the right distance
{
  const d = newDesign(); d.L = 200; d.W = 100;
  d.chains.back = chain(seg(40, 'up'), seg(30, 'up'));
  d.cutouts = [{ id: 1, face: 'back/1', type: 'hole', x: 100, y: 15, d: 6, w: 0, h: 0, vertical: false }];
  const res = build(d);
  const o = OSSB(90, 2, 2), ba = BA(90, 2, 2, 0.44);
  const yTan = 100 - o;                                   // base tangent line at the back
  const exp = yTan + ba + (40 - 2 * o) + ba + (15 - o);   // bend 1 + flange 1 straight + bend 2 + into flange 2
  const h = res.flat.holes[0] as { cx: number; cy: number };
  check('hole on flange 2: flat position', near(h.cx, 100) && near(h.cy, exp), `y = ${h.cy.toFixed(3)} (expected ${exp.toFixed(3)})`);
  check('hole on flange 2: no warnings', res.warnings.length === 0, res.warnings.join(' | ') || 'ok');
}
// warnings fire
{
  const d = newDesign(); d.chains.front = chain(seg(3));
  d.cutouts = [{ id: 1, face: 'base', type: 'hole', x: 1, y: 1, d: 10, w: 0, h: 0, vertical: false }];
  const w = build(d).warnings;
  check('warnings: short flange + bad hole', w.length === 2 && w[1].startsWith('Cutout #1 '), w.join(' | '));
}
// v1 .pc3d (flanges + returns) upgrades to chains with identical flat
{
  const v1: Record<string, unknown> = {
    name: 'Old hat', material: 'Mild steel', t: 2, r: 2, k: 0.44, relief: 2, L: 400, W: 60,
    flanges: {
      front: { on: true, height: 40, angle: 90, dir: 'up', inset0: 0, inset1: 0, ret: 'out', retHeight: 25 },
      back: { on: true, height: 40, angle: 90, dir: 'up', inset0: 0, inset1: 0, ret: 'out', retHeight: 25 },
      left: { on: false }, right: { on: false },
    },
    cutouts: [{ id: 1, face: 'front', type: 'hole', x: 200, y: 20, d: 6, w: 0, h: 0, vertical: false }],
  };
  upgradeV1(v1);
  const d = v1 as unknown as Design;
  const hat = TEMPLATES.find((x) => x.id === 'hat')!.make();
  const a = build(d).flat, b = build(hat).flat;
  check('v1 upgrade: chains', d.chains.front.segs.map((s) => s.dir).join() === 'up,down' && (d.cutouts[0].face === 'front/0'), JSON.stringify(d.chains.front.segs));
  check('v1 upgrade: same flat as template', near(a.maxY - a.minY, b.maxY - b.minY), `${(a.maxY - a.minY).toFixed(2)} vs ${(b.maxY - b.minY).toFixed(2)}`);
}
// DXF: well-formed, circles for holes, bend lines, inch scaling
{
  const d = TEMPLATES.find((x) => x.id === 'L')!.make();
  const f = build(d).flat;
  const dxf = flatToDxf(f, { inches: false, name: d.name, thickness: d.t, material: d.material });
  const lines = dxf.trim().split('\r\n');
  const count = (ent: string) => lines.filter((l, i) => i % 2 === 1 && l === ent && lines[i - 1] === '0').length;
  check('DXF structure', lines.length % 2 === 0 && lines[lines.length - 1] === 'EOF' && /^[\x00-\x7f]*$/.test(dxf), `${lines.length / 2} pairs`);
  check('DXF entities', count('CIRCLE') === 2 && count('ARC') === 2 && count('LINE') >= 7, `CIRCLE ${count('CIRCLE')} ARC ${count('ARC')} LINE ${count('LINE')}`);
  const dxfIn = flatToDxf(f, { inches: true, name: d.name, thickness: d.t, material: d.material });
  check('DXF inches', dxfIn.includes('$INSUNITS\r\n70\r\n1') && dxfIn.includes(`\r\n${+(100 / 25.4).toFixed(6)}\r\n`), 'scaled by 1/25.4');
}
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
