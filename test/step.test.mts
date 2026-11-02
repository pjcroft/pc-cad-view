// Design → STEP → read back with the app's own STEP reader → check: one solid, right size, and the
// independent unfold engine gives the same flat blank as the designer.
// run: node --experimental-strip-types test/step.test.mts
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as THREE from 'three';
import * as R from 'replicad';
import { TEMPLATES, build, chain, seg, newDesign } from '../src/design/model.ts';
import { buildStep } from '../src/design/step.ts';
import { detectThickness, unfoldPart } from '../src/sheetmetal.ts';

const require = createRequire(import.meta.url);
const ocInit = (await import('replicad-opencascadejs')).default as unknown as (o: object) => Promise<unknown>;
const wasmPath = require.resolve('replicad-opencascadejs/wasm');
R.setOC((await ocInit({ locateFile: () => wasmPath, print: () => {}, printErr: () => {} })) as never);
const occt = await require('occt-import-js')();

let failed = 0;
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const check = (name: string, ok: boolean, detail: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(30)} ${detail}`); if (!ok) failed++; };

const cases = [...TEMPLATES.map((t) => ({ label: t.label, d: t.make() })),
  { label: '3-flange chain', d: (() => { const d = newDesign(); d.L = 300; d.W = 100; d.chains.back = chain(seg(40, 'up'), seg(20, 'up'), seg(15, 'down')); return d; })() }];
fs.mkdirSync('test/out', { recursive: true });
for (const { label, d } of cases) {
  const res = build(d);
  const t0 = performance.now();
  const step = await buildStep(R, res.solids, d.name);
  const ms = performance.now() - t0;
  fs.writeFileSync(`test/out/${d.name.replace(/\W+/g, '-')}.step`, step);
  const back = occt.ReadFile('step', new TextEncoder().encode(step), { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 });
  const solids = (step.match(/MANIFOLD_SOLID_BREP/g) ?? []).length;
  const g = new THREE.BufferGeometry();
  const m = back.meshes[0];
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.attributes.position.array), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(m.index.array), 1));
  g.computeBoundingBox();
  const sz = g.boundingBox!.getSize(new THREE.Vector3()), exp = new THREE.Box3().setFromObject(res.group).getSize(new THREE.Vector3());
  check(`${label}: one solid`, back.success && solids === 1 && back.meshes.length === 1, `${solids} solid(s), ${(step.length / 1024).toFixed(0)} KB, ${ms.toFixed(0)} ms`);
  check(`${label}: size`, near(sz.x, exp.x, 0.05) && near(sz.y, exp.y, 0.05) && near(sz.z, exp.z, 0.05), `${sz.x.toFixed(2)} × ${sz.y.toFixed(2)} × ${sz.z.toFixed(2)}`);
  const mesh = new THREE.Mesh(g); mesh.userData.faces = m.brep_faces.map((f: { first: number; last: number }) => [f.first, f.last]);
  const t = detectThickness(mesh), f = t ? unfoldPart(mesh, t, d.k) : null;
  const fw = res.flat.maxX - res.flat.minX, fh = res.flat.maxY - res.flat.minY;
  const okFlat = !!f && near(f.x, Math.max(fw, fh), 0.15) && near(f.y, Math.min(fw, fh), 0.15) && near(t!, d.t, 0.01);
  check(`${label}: re-unfolds to flat`, okFlat, f ? `t ${t}  ${f.x.toFixed(2)} × ${f.y.toFixed(2)}  (designer ${Math.max(fw, fh).toFixed(2)} × ${Math.min(fw, fh).toFixed(2)})` : 'not detected as sheet metal');
}
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
