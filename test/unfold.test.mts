// Node check of thickness + unfold against hand-calculated flat sizes.
// run: node --experimental-strip-types test/unfold.test.mts
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as THREE from 'three';
import { detectThickness, unfoldPart } from '../src/sheetmetal.ts';
const require = createRequire(import.meta.url);
const occt = await require('occt-import-js')();

// expected flat blanks (hand calculation, K = 0.44): [thickness, X, Y] in mm
const EXPECT: Record<string, [number, number, number]> = {
  'sheetmetal-test-asm.step|L-bracket 3mm': [3, 80 + 60 + (Math.PI / 2) * (3 + 0.44 * 3), 100],
  'sheetmetal-test-asm.step|U-channel 2mm': [2, 300, 120 + 80 + Math.PI * (2 + 0.44 * 2)],
  'sheetmetal-test-asm.step|Base plate 3mm': [3, 200, 150],
  'inch-bracket.step|*': [3.175, (5 + (Math.PI / 2) * (0.125 + 0.44 * 0.125)) * 25.4, 101.6],
};
const file = process.argv[2] ?? 'samples/sheetmetal-test-asm.step';
let failed = 0;
const res = occt.ReadFile('step', fs.readFileSync(file), { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 });
for (const m of res.meshes) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.attributes.position.array), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(m.index.array), 1));
  const mesh = new THREE.Mesh(g);
  mesh.userData.faces = m.brep_faces.map((f: any) => [f.first, f.last]);
  const t0 = performance.now();
  const t = detectThickness(mesh);
  const f = t ? unfoldPart(mesh, t, 0.44) : null;
  const base = file.split('/').pop();
  const exp = EXPECT[`${base}|${m.name}`] ?? EXPECT[`${base}|*`];
  if (exp) {
    const ok = t !== null && Math.abs(t - exp[0]) < 0.01 && f && Math.abs(f.x - Math.max(exp[1], exp[2])) < 0.1 && Math.abs(f.y - Math.min(exp[1], exp[2])) < 0.1;
    if (!ok) failed++;
    process.stdout.write(ok ? 'PASS ' : 'FAIL ');
  }
  console.log(m.name.padEnd(16), 't=', t, f ? `flat ${f.x.toFixed(2)} x ${f.y.toFixed(2)}  bends ${f.bends}  ${f.confidence} ${f.note ?? ''}` : 'no unfold', `(${(performance.now() - t0).toFixed(0)} ms)`);
}
if (failed) { console.error(`${failed} unfold check(s) failed`); process.exit(1); }
