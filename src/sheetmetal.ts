/**
 * Sheet metal flat-blank estimate from the tessellated B-rep.
 *
 * 1. Classify each B-rep face: planar or curved, and "skin" (the thickness ray through it
 *    is ≈ t) or "wall" (edges, hole bores, bend sides).
 * 2. Starting from the largest planar skin face, walk skin faces only — walls separate the two
 *    skins, so the walk stays on one side of the sheet.
 * 3. Each bend (curved skin face group) is unrolled at the neutral radius (inner R + K·t), and the
 *    flange beyond it is rotated flat and laid out after the developed length.
 * 4. Min-area rectangle of the unfolded outline = blank X × Y.
 *
 * It's an estimate for planning / quoting (no reliefs, corner closures or exact bend tables).
 */
import * as THREE from 'three';

export interface FlatResult {
  x: number;            // blank length (long side), mm
  y: number;            // blank width, mm
  area: number;         // unfolded skin area, mm²
  bends: number;
  thickness: number;
  outline: [number, number][][]; // unfolded triangles (2D) for the preview, rotated into the blank rectangle
  confidence: 'good' | 'rough';
  note?: string;
}

interface Face {
  i: number;
  tris: number[];          // triangle indices
  area: number;
  normal: THREE.Vector3;   // area-weighted
  planar: boolean;
  skin: boolean;
  keys: Set<string>;
  centroid: THREE.Vector3;
}

const DEG = Math.PI / 180;

export function unfoldPart(mesh: THREE.Mesh, t: number, kFactor = 0.44): FlatResult | null {
  const g = mesh.geometry;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const idx = g.index;
  if (!idx) return null;
  const ranges: [number, number][] = mesh.userData.faces;
  if (!ranges || !ranges.length) return null;

  const P = (vi: number) => new THREE.Vector3().fromBufferAttribute(pos, vi);
  const q = Math.max(t * 0.02, 1e-4);
  const key = (v: THREE.Vector3) => `${Math.round(v.x / q)},${Math.round(v.y / q)},${Math.round(v.z / q)}`;
  const triV = (tr: number) => [idx.getX(tr * 3), idx.getX(tr * 3 + 1), idx.getX(tr * 3 + 2)];

  // local-space raycasting against this mesh only
  const solo = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const rc = new THREE.Raycaster();
  const through = (p: THREE.Vector3, inward: THREE.Vector3) => {
    const eps = t * 1e-3;
    rc.set(p.clone().addScaledVector(inward, eps), inward);
    rc.far = t * 20;
    const h = rc.intersectObject(solo, false).find((x) => x.distance > eps);
    return h ? h.distance + eps : Infinity;
  };

  /* ---- 1. faces ---- */
  const faces: Face[] = ranges.map(([first, last], i) => {
    const tris: number[] = [];
    const n = new THREE.Vector3(), c = new THREE.Vector3();
    let area = 0;
    const keys = new Set<string>();
    const tn: THREE.Vector3[] = [], ta: number[] = [];
    for (let tr = first; tr <= last; tr++) {
      const [a, b, cc] = triV(tr).map(P);
      const cr = b.clone().sub(a).cross(cc.clone().sub(a));
      const ar = cr.length() / 2;
      tris.push(tr);
      if (ar > 0) { tn.push(cr.normalize()); ta.push(ar); n.addScaledVector(cr, ar); c.addScaledVector(a.clone().add(b).add(cc), ar / 3); area += ar; }
      keys.add(key(a)); keys.add(key(b)); keys.add(key(cc));
    }
    n.normalize();
    if (area > 0) c.divideScalar(area);
    const planar = tn.every((v) => v.dot(n) > Math.cos(1.5 * DEG));
    // skin test: thickness ray from the biggest triangles
    let skinVotes = 0, votes = 0;
    const order = ta.map((a, k) => k).sort((x, y) => ta[y] - ta[x]).slice(0, 3);
    for (const k of order) {
      const tr = tris[k];
      const [a, b, cc] = triV(tr).map(P);
      const cen = a.add(b).add(cc).divideScalar(3);
      const d = through(cen, tn[k].clone().negate());
      votes++;
      if (Math.abs(d - t) < t * 0.12) skinVotes++;
    }
    return { i, tris, area, normal: n, planar, skin: votes > 0 && skinVotes * 2 >= votes, keys, centroid: c };
  });

  /* ---- adjacency (faces sharing ≥ 2 boundary vertices) ---- */
  const byKey = new Map<string, number[]>();
  faces.forEach((f) => f.keys.forEach((k) => { const l = byKey.get(k); if (l) l.push(f.i); else byKey.set(k, [f.i]); }));
  const adj = faces.map(() => new Map<number, string[]>());
  byKey.forEach((list, k) => {
    for (const a of list) for (const b of list) if (a !== b) { const m = adj[a]; if (!m.has(b)) m.set(b, []); m.get(b)!.push(k); }
  });
  const shared = (a: number, b: number) => (adj[a].get(b) ?? []);
  const isNb = (a: number, b: number) => shared(a, b).length >= 2;

  /* ---- 2. base face ---- */
  const skins = faces.filter((f) => f.skin);
  if (!skins.length) return null;
  const base = skins.filter((f) => f.planar).sort((a, b) => b.area - a.area)[0];
  if (!base) return null;

  // world→flat transform per placed face (rigid 3D transform into the base plane)
  const T = new Map<number, THREE.Matrix4>();
  T.set(base.i, new THREE.Matrix4());
  const visited = new Set<number>([base.i]);
  const queue: number[] = [base.i];
  let bends = 0;
  const bendZones: { pa: THREE.Vector3[]; pc: THREE.Vector3[] }[] = [];
  const skinArea = skins.reduce((s, f) => s + f.area, 0);
  let placedArea = base.area;
  const nBase = base.normal.clone();

  const keyToPoint = (k: string) => { const [x, y, z] = k.split(',').map(Number); return new THREE.Vector3(x * q, y * q, z * q); };
  const linePts = (keys: string[]) => keys.map(keyToPoint);

  while (queue.length) {
    const ai = queue.shift()!;
    const A = faces[ai];
    const TA = T.get(ai)!;
    for (const [bi] of adj[ai]) {
      if (visited.has(bi) || !isNb(ai, bi)) continue;
      const B = faces[bi];
      if (!B.skin) continue;

      if (B.planar) {
        // coplanar continuation (face split) or zero-radius fold
        const ang = A.normal.angleTo(B.normal);
        if (ang < 2 * DEG) { T.set(bi, TA.clone()); }
        else {
          const pts = linePts(shared(ai, bi));
          const TB = foldOnto(A, B, pts, pts, ang, kFactor * t * ang, TA);
          if (!TB) continue;
          T.set(bi, TB);
          bends++;
        }
        visited.add(bi); queue.push(bi); placedArea += B.area;
        continue;
      }

      // ---- bend: gather connected curved skin faces, then the flat faces beyond it ----
      const group = [bi];
      const gset = new Set(group);
      for (let k = 0; k < group.length; k++) {
        for (const [ci] of adj[group[k]]) {
          if (gset.has(ci) || visited.has(ci) || !isNb(group[k], ci)) continue;
          const C = faces[ci];
          if (C.skin && !C.planar) { gset.add(ci); group.push(ci); }
        }
      }
      group.forEach((x) => { visited.add(x); placedArea += faces[x].area; });
      const lineA = group.flatMap((x) => shared(ai, x));
      for (const x of group) {
        for (const [ci] of adj[x]) {
          if (visited.has(ci) || gset.has(ci)) continue;
          const C = faces[ci];
          if (!C.skin || !C.planar || !isNb(x, ci)) continue;
          const lineC = group.flatMap((y) => shared(y, ci));
          const theta = A.normal.angleTo(C.normal);
          if (theta < 2 * DEG) continue;
          // skin radius from chord between the two tangent lines
          const pa = linePts(lineA), pc = linePts(lineC);
          const axis = new THREE.Vector3().crossVectors(A.normal, C.normal).normalize();
          const chord = perpDistance(avg(pa), avg(pc), axis);
          const rSkin = chord / (2 * Math.sin(theta / 2));
          // outer (convex) skin: bend centre sits on the material side of A (−normal);
          // inner (concave) skin: centre is out in the air (+normal). Test which one is R from C's tangent line.
          const cA = avg(pa);
          const cOut = cA.clone().addScaledVector(A.normal, -rSkin), cIn = cA.clone().addScaledVector(A.normal, rSkin);
          const outer = Math.abs(perpDistance(avg(pc), cOut, axis) - rSkin) < Math.abs(perpDistance(avg(pc), cIn, axis) - rSkin);
          const rInner = outer ? rSkin - t : rSkin;
          const developed = theta * (Math.max(rInner, 0) + kFactor * t);
          const TC = foldOnto(A, C, pa, pc, theta, developed, TA);
          if (!TC) continue;
          T.set(ci, TC);
          visited.add(ci); queue.push(ci); placedArea += C.area;
          bendZones.push({ pa: pa.map((p) => p.clone().applyMatrix4(TA)), pc: pc.map((p) => p.clone().applyMatrix4(TC)) });
          bends++;
        }
      }
    }
  }

  /* ---- 3. 2D outline in base-plane coordinates ---- */
  const u = new THREE.Vector3(), v = new THREE.Vector3();
  const helper = Math.abs(nBase.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  u.crossVectors(helper, nBase).normalize();
  v.crossVectors(nBase, u).normalize();
  const tris2d: [number, number][][] = [];
  const pts2d: [number, number][] = [];
  T.forEach((M, fi) => {
    const f = faces[fi];
    if (!f.planar) return;
    for (const tr of f.tris) {
      const tri = triV(tr).map((vi) => { const p = P(vi).applyMatrix4(M); return [p.dot(u), p.dot(v)] as [number, number]; });
      tris2d.push(tri);
      pts2d.push(...tri);
    }
  });
  // bend zones: the strip between the two tangent lines, flattened
  for (const z of bendZones) {
    const poly = convexHull([...z.pa, ...z.pc].map((p) => [p.dot(u), p.dot(v)] as [number, number]));
    for (let k = 1; k + 1 < poly.length; k++) { tris2d.push([poly[0], poly[k], poly[k + 1]]); pts2d.push(poly[k]); }
  }
  if (pts2d.length < 3) return null;

  const rect = minAreaRect(pts2d);
  const rot = (p: [number, number]): [number, number] => {
    const x = p[0] * rect.cos + p[1] * rect.sin, y = -p[0] * rect.sin + p[1] * rect.cos;
    return rect.swap ? [y - rect.minY, x - rect.minX] : [x - rect.minX, y - rect.minY];
  };
  const outline = tris2d.map((tri) => tri.map(rot));
  const unplaced = Math.max(0, 1 - placedArea / (skinArea / 2)); // skinArea counts both sides of the sheet
  return {
    x: rect.w, y: rect.h, area: placedArea, bends, thickness: t, outline,
    confidence: unplaced < 0.08 ? 'good' : 'rough',
    note: unplaced >= 0.08 ? `${Math.round(unplaced * 100)}% of the surface could not be unfolded` : undefined,
  };
}

/**
 * Sheet thickness: shoot rays inward from the largest triangles. Sheet metal gives the same answer
 * from almost every big face; machined/solid parts don't, so we return null for them. Mesh-local.
 */
export function detectThickness(mesh: THREE.Mesh): number | null {
  const g = mesh.geometry, pos = g.getAttribute('position'), idx = g.index;
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const vi = (t: number, k: number) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const cand: { area: number; t: number }[] = [];
  const stride = Math.max(1, Math.floor(triCount / 40000));
  for (let t = 0; t < triCount; t += stride) {
    a.fromBufferAttribute(pos, vi(t, 0)); b.fromBufferAttribute(pos, vi(t, 1)); c.fromBufferAttribute(pos, vi(t, 2));
    cand.push({ area: b.clone().sub(a).cross(c.clone().sub(a)).length(), t });
  }
  cand.sort((x, y) => y.area - x.area);
  if (!g.boundingBox) g.computeBoundingBox();
  const size = g.boundingBox!.getSize(new THREE.Vector3());
  const solo = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const rc = new THREE.Raycaster();
  const eps = size.length() * 1e-6;
  const vals: number[] = [];
  for (const { t } of cand.slice(0, 16)) {
    a.fromBufferAttribute(pos, vi(t, 0)); b.fromBufferAttribute(pos, vi(t, 1)); c.fromBufferAttribute(pos, vi(t, 2));
    const dir = b.clone().sub(a).cross(c.clone().sub(a)).normalize().negate();
    const cen = a.clone().add(b).add(c).divideScalar(3);
    rc.set(cen.addScaledVector(dir, eps), dir);
    const h = rc.intersectObject(solo, false).find((x) => x.distance > eps * 2);
    if (h) vals.push(h.distance + eps);
  }
  // cluster with a tolerance (not rounding buckets: values like 3.175 mm = 0.125" sit on rounding boundaries)
  vals.sort((p, q) => p - q);
  const n = vals.length;
  let best: number | null = null, bestN = 0;
  for (let i = 0; i < n; i++) {
    const tol = Math.max(0.01, vals[i] * 0.01);
    let j = i;
    while (j + 1 < n && vals[j + 1] - vals[i] <= tol) j++;
    if (j - i + 1 > bestN) { bestN = j - i + 1; best = vals[(i + j) >> 1]; }
  }
  if (best !== null) best = Math.round(best * 1000) / 1000;
  const dims = [size.x, size.y, size.z].sort((p, q) => p - q);
  return best !== null && n >= 4 && bestN / n >= 0.6 && best < dims[1] * 0.2 ? best : null;
}

/* rotate face C flat onto A's plane and lay it out `developed` beyond the bend line */
function foldOnto(A: Face, C: Face, lineA: THREE.Vector3[], lineC: THREE.Vector3[], theta: number, developed: number, TA: THREE.Matrix4): THREE.Matrix4 | null {
  if (!lineA.length || !lineC.length) return null;
  // bend axis = A × C normals (exact for a straight bend); fall back to the tangent line direction
  let axis = new THREE.Vector3().crossVectors(A.normal, C.normal);
  if (axis.lengthSq() < 1e-6) axis = fitLineDir(lineA) ?? axis;
  axis.normalize();
  if (axis.lengthSq() < 0.5) return null;
  // choose rotation sign that maps C.normal onto A.normal
  const q1 = new THREE.Quaternion().setFromAxisAngle(axis, theta);
  const q2 = new THREE.Quaternion().setFromAxisAngle(axis, -theta);
  const R = C.normal.clone().applyQuaternion(q1).dot(A.normal) > C.normal.clone().applyQuaternion(q2).dot(A.normal) ? q1 : q2;
  const pA = avg(lineA), pC = avg(lineC).applyQuaternion(R);
  // in-plane direction away from A, perpendicular to the bend axis
  const w = pA.clone().sub(A.centroid);
  w.addScaledVector(axis, -w.dot(axis)).addScaledVector(A.normal, -w.dot(A.normal)).normalize();
  const d = pC.clone().sub(pA);
  const tr = w.clone().multiplyScalar(developed - d.dot(w)).addScaledVector(A.normal, -d.dot(A.normal));
  const M = new THREE.Matrix4().makeTranslation(tr.x, tr.y, tr.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(R));
  return TA.clone().multiply(M);
}

function fitLineDir(pts: THREE.Vector3[]): THREE.Vector3 | null {
  if (pts.length < 2) return null;
  // farthest pair
  let a = pts[0], b = pts[1], best = -1;
  for (const p of pts) { const d = p.distanceToSquared(pts[0]); if (d > best) { best = d; a = p; } }
  best = -1;
  for (const p of pts) { const d = p.distanceToSquared(a); if (d > best) { best = d; b = p; } }
  const dir = b.clone().sub(a);
  return dir.lengthSq() > 1e-9 ? dir.normalize() : null;
}

function avg(ps: THREE.Vector3[]) { const c = new THREE.Vector3(); ps.forEach((p) => c.add(p)); return c.divideScalar(Math.max(1, ps.length)); }
function perpDistance(p: THREE.Vector3, c: THREE.Vector3, axis: THREE.Vector3) { const d = p.clone().sub(c); return d.addScaledVector(axis, -d.dot(axis)).length(); }

/** Min-area enclosing rectangle via rotating calipers on the convex hull. w ≥ h. */
export function minAreaRect(pts: [number, number][]) {
  const hull = convexHull(pts);
  let best = { area: Infinity, cos: 1, sin: 0, minX: 0, minY: 0, w: 0, h: 0, swap: false };
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i], [x2, y2] = hull[(i + 1) % hull.length];
    const L = Math.hypot(x2 - x1, y2 - y1);
    if (L < 1e-9) continue;
    const c = (x2 - x1) / L, s = (y2 - y1) / L;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of hull) {
      const rx = x * c + y * s, ry = -x * s + y * c;
      minX = Math.min(minX, rx); maxX = Math.max(maxX, rx); minY = Math.min(minY, ry); maxY = Math.max(maxY, ry);
    }
    const area = (maxX - minX) * (maxY - minY);
    if (area < best.area - 1e-6) {
      const w = maxX - minX, h = maxY - minY;
      best = { area, cos: c, sin: s, minX, minY, w: Math.max(w, h), h: Math.min(w, h), swap: h > w };
    }
  }
  return best;
}

function convexHull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [], up: [number, number][] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
