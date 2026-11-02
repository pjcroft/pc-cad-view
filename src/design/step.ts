/**
 * Designed part → STEP (AP214) as ONE merged B-rep solid: exact planes and cylinders (bends, holes,
 * slot ends), not triangles — so SolidWorks / Inventor / Fusion import it as a real solid body and
 * can recognise it as sheet metal.
 *
 * Uses replicad + an OpenCascade WASM build that can model and write STEP. It's large (~23 MB), so
 * it's only downloaded the first time someone exports STEP.
 */
import * as THREE from 'three';
import type { Prim, SolidPiece } from './model';

type Replicad = typeof import('replicad');
// replicad's solid type is deeply generic; we only need these three operations
interface CadSolid {
  fuse(o: CadSolid): CadSolid;
  simplify(): CadSolid;
  rotate(angleDeg: number, position: number[], direction: number[]): CadSolid;
  translate(v: number[]): CadSolid;
}

let loading: Promise<Replicad> | null = null;

/** Load replicad + OpenCascade once (browser; Vite serves the .wasm as an asset). */
export function loadCad(): Promise<Replicad> {
  if (!loading) {
    loading = (async () => {
      const [R, ocMod, wasm] = await Promise.all([
        import('replicad'),
        import('replicad-opencascadejs'),
        import('replicad-opencascadejs/wasm?url'),
      ]);
      const quiet = () => {};
      const oc = await (ocMod.default as unknown as (o: object) => Promise<unknown>)({ locateFile: () => wasm.default, print: quiet, printErr: quiet });
      R.setOC(oc as Parameters<typeof R.setOC>[0]);
      return R;
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/** Build the merged solid and return the STEP file text. */
export async function buildStep(R: Replicad, solids: SolidPiece[], name: string, inches = false): Promise<string> {
  if (!solids.length) throw new Error('Nothing to export.');
  let solid = place(piece(R, solids[0]), solids[0].m);
  for (let i = 1; i < solids.length; i++) solid = solid.fuse(place(piece(R, solids[i]), solids[i].m));
  try { solid = solid.simplify(); } catch { /* keep un-simplified faces */ }
  const blob = R.exportSTEP([{ shape: solid as never, name: name || 'Part' }], { unit: inches ? 'INCH' : 'MM', modelUnit: 'MM' });
  return await blob.text();
}

/* ---------------- pieces ---------------- */
function piece(R: Replicad, p: SolidPiece): CadSolid {
  let drawing;
  if (p.type === 'poly') {
    const pen = R.draw(p.pts[0]);
    for (let i = 1; i < p.pts.length; i++) pen.lineTo(p.pts[i]);
    drawing = pen.close();
    for (const h of p.holes) drawing = drawing.cut(holeDrawing(R, h));
  } else {
    const ri = Math.max(p.r, 0.01), ro = p.r + p.t; // an arc needs a radius: treat r = 0 as 0.01 mm
    const zc = p.positive ? p.r + p.t : -p.r;
    const a0 = p.positive ? -Math.PI / 2 : Math.PI / 2, a1 = p.positive ? a0 + p.theta : a0 - p.theta, am = (a0 + a1) / 2;
    const pt = (rad: number, a: number): [number, number] => [p.oc + rad * Math.cos(a), zc + rad * Math.sin(a)];
    drawing = R.draw(pt(ro, a0)).threePointsArcTo(pt(ro, a1), pt(ro, am)).lineTo(pt(ri, a1)).threePointsArcTo(pt(ri, a0), pt(ri, am)).close();
  }
  return drawing.sketchOnPlane('XY').extrude(p.depth) as unknown as CadSolid;
}

function holeDrawing(R: Replicad, h: Prim) {
  if (h.type === 'circle') return R.drawCircle(h.r).translate([h.cx, h.cy]);
  if (h.type === 'rect') return R.drawRectangle(h.w, h.h).translate([h.cx, h.cy]);
  if (h.len - h.wid < 1e-6) return R.drawCircle(h.wid / 2).translate([h.cx, h.cy]);
  const d = R.drawRoundedRectangle(h.len, h.wid, h.wid / 2 - 1e-6);
  return (h.alongY ? d.rotate(90, [0, 0]) : d).translate([h.cx, h.cy]);
}

/** Apply a rigid 4×4 transform (from the design model) as rotate-about-origin, then translate. */
function place(s: CadSolid, m: number[]): CadSolid {
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  new THREE.Matrix4().fromArray(m).decompose(pos, q, sc);
  let out = s;
  const w = Math.min(1, Math.max(-1, q.w));
  const angle = 2 * Math.acos(w);
  if (angle > 1e-9) {
    const k = Math.sqrt(1 - w * w) || 1;
    out = out.rotate((angle * 180) / Math.PI, [0, 0, 0], [q.x / k, q.y / k, q.z / k]);
  }
  if (pos.lengthSq() > 0) out = out.translate([pos.x, pos.y, pos.z]);
  return out;
}
