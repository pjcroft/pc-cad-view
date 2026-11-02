/**
 * Parametric sheet metal part: a rectangular base; each base edge can carry a CHAIN of flanges
 * (flange on the base edge, then a flange on that flange's free edge, and so on), plus holes /
 * slots / rectangular cutouts on the base or any flange.
 *
 * Conventions (all lengths in mm):
 *  - Base L (along X) × W (along Y) are OUTSIDE (mold-line) dimensions. Front edge is y = 0, left is x = 0.
 *  - A flange's height is its OUTSIDE length, mold-line vertex to vertex (or to its free end).
 *  - Bend radius r is the INSIDE radius. Outside setback OSSB = (r + t)·tan(θ/2).
 *  - Bend allowance BA = θ·(r + K·t). Flat straight length = outside length − setbacks at both ends.
 *  - Flange direction UP / DOWN is as seen looking at the top of the flat blank (press-brake convention).
 *  - Cutout positions are centres. Base: (x from left edge, y from front edge).
 *    Flange: (x = position along the base edge in base axes, y = distance along the flange from its
 *    starting mold-line vertex — for the first flange that is the height above the base's outside face).
 */
import * as THREE from 'three';

export type Edge = 'front' | 'back' | 'left' | 'right';
export const EDGES: Edge[] = ['front', 'back', 'left', 'right'];
export const EDGE_NAME: Record<Edge, string> = { front: 'Front', back: 'Back', left: 'Left', right: 'Right' };
/** 'base' or `${edge}/${index}` — e.g. 'front/0' is the first flange on the front edge. */
export type Face = string;
export type CutType = 'hole' | 'slot' | 'rect';

export interface Segment { height: number; angle: number; dir: 'up' | 'down' }
export interface Chain { segs: Segment[]; inset0: number; inset1: number }

export interface Cutout {
  id: number;
  face: Face;
  type: CutType;
  x: number;
  y: number;
  d: number;               // hole diameter / slot width
  w: number;               // slot overall length / rect width (along x / along the edge)
  h: number;               // rect height (along y / along the flange)
  vertical: boolean;       // slot runs along y / along the flange
}

export interface Design {
  name: string;
  material: string;
  t: number;
  r: number;
  k: number;
  relief: number;
  L: number;
  W: number;
  chains: Record<Edge, Chain>;
  cutouts: Cutout[];
}

export type Prim =
  | { type: 'circle'; cx: number; cy: number; r: number }
  | { type: 'slot'; cx: number; cy: number; len: number; wid: number; alongY: boolean }
  | { type: 'rect'; cx: number; cy: number; w: number; h: number };

export interface BendLine { a: [number, number]; b: [number, number]; up: boolean; angle: number; r: number }

export interface FlatPattern {
  loops: [number, number][][];   // outline loops (first = outer), y up
  holes: Prim[];
  bends: BendLine[];
  minX: number; minY: number; maxX: number; maxY: number;
  area: number;                  // net area (outline − holes), mm²
}

/** An edge you can click in 3D to add a flange: a free base edge or the free end of a chain. */
export interface EdgeHandle { edge: Edge; seg: number; a: THREE.Vector3; b: THREE.Vector3 }

/**
 * Exact solid recipe (for STEP export): each piece is a planar profile in XY extruded along +Z by
 * `depth`, then placed with the rigid transform `m` (column-major 4×4). Same geometry as the 3D view.
 */
export type SolidPiece =
  | { type: 'poly'; pts: [number, number][]; holes: Prim[]; depth: number; m: number[] }
  | { type: 'sector'; oc: number; positive: boolean; theta: number; r: number; t: number; depth: number; m: number[] };

export interface BuildResult { group: THREE.Group; flat: FlatPattern; warnings: string[]; handles: EdgeHandle[]; solids: SolidPiece[] }

export const faceId = (e: Edge, i: number) => `${e}/${i}`;
export function parseFace(f: Face): { edge: Edge; seg: number } | null {
  const m = /^(front|back|left|right)(?:\/(\d+))?$/.exec(f);
  return m ? { edge: m[1] as Edge, seg: m[2] ? +m[2] : 0 } : null;
}
export const faceName = (f: Face) => { const p = parseFace(f); return p ? `${EDGE_NAME[p.edge]} flange ${p.seg + 1}` : 'Base'; };

/* ---------------- defaults & templates ---------------- */
export const seg = (height = 40, dir: 'up' | 'down' = 'up', angle = 90): Segment => ({ height, angle, dir });
export const chain = (...segs: Segment[]): Chain => ({ segs, inset0: 0, inset1: 0 });

export function newDesign(): Design {
  return {
    name: 'New part', material: 'Mild steel', t: 2, r: 2, k: 0.44, relief: 2,
    L: 200, W: 100,
    chains: { front: chain(), back: chain(), left: chain(), right: chain() },
    cutouts: [],
  };
}

/** A sensible height for a newly added flange: comfortably longer than its bends need. */
export function defaultHeight(d: Design) { return Math.max(25, Math.ceil((4 * (d.r + d.t) + 5) / 5) * 5); }

export const TEMPLATES: { id: string; label: string; make: () => Design }[] = [
  { id: 'flat', label: 'Flat blank', make: () => ({ ...newDesign(), name: 'Flat blank', L: 200, W: 100 }) },
  {
    id: 'L', label: 'L-bracket', make: () => {
      const d = { ...newDesign(), name: 'L-bracket', L: 100, W: 80, t: 3, r: 3, relief: 3 };
      d.chains.back = chain(seg(60));
      d.cutouts = [{ id: 1, face: 'base', type: 'hole', x: 25, y: 35, d: 9, w: 20, h: 10, vertical: false },
        { id: 2, face: 'base', type: 'hole', x: 75, y: 35, d: 9, w: 20, h: 10, vertical: false },
        { id: 3, face: 'back/0', type: 'slot', x: 50, y: 38, d: 9, w: 30, h: 10, vertical: false }];
      return d;
    },
  },
  { id: 'U', label: 'U-channel', make: () => { const d = { ...newDesign(), name: 'U-channel', L: 300, W: 120 }; d.chains.front = chain(seg(40)); d.chains.back = chain(seg(40)); return d; } },
  { id: 'Z', label: 'Z-bracket', make: () => { const d = { ...newDesign(), name: 'Z-bracket', L: 150, W: 60 }; d.chains.front = chain(seg(40, 'up')); d.chains.back = chain(seg(40, 'down')); return d; } },
  {
    id: 'hat', label: 'Hat channel', make: () => {
      const d = { ...newDesign(), name: 'Hat channel', L: 400, W: 60 };
      d.chains.front = chain(seg(40, 'up'), seg(25, 'down')); d.chains.back = chain(seg(40, 'up'), seg(25, 'down'));
      return d;
    },
  },
  {
    id: 'C', label: 'C-channel (lips)', make: () => {
      const d = { ...newDesign(), name: 'C-channel', L: 400, W: 100 };
      d.chains.front = chain(seg(50, 'up'), seg(15, 'up')); d.chains.back = chain(seg(50, 'up'), seg(15, 'up'));
      return d;
    },
  },
  {
    id: 'tray', label: 'Box / tray', make: () => {
      const d = { ...newDesign(), name: 'Tray', L: 300, W: 200, t: 1.5, r: 1.5, relief: 1.5 };
      for (const e of EDGES) d.chains[e] = chain(seg(40));
      return d;
    },
  },
];

/* ---------------- per-edge geometry ---------------- */
interface SegInfo { s: Segment; theta: number; ossb: number; ba: number; hs: number }
interface EdgeInfo {
  e: Edge;
  segs: SegInfo[];
  on: boolean;
  ossb0: number;          // setback of the first bend (sets the base's tangent line)
  s0: number; s1: number; // span along the edge (base axis coordinate)
  E: number;              // edge length
  total: number;          // flat length of the whole chain beyond the base tangent line
}

const DEG = Math.PI / 180;

function edgeInfos(d: Design): Record<Edge, EdgeInfo> {
  const { t, r, k } = d;
  const info = {} as Record<Edge, EdgeInfo>;
  for (const e of EDGES) {
    const c = d.chains[e];
    const segs: SegInfo[] = c.segs.map((s) => {
      const theta = Math.min(170, Math.max(1, s.angle)) * DEG;
      return { s, theta, ossb: (r + t) * Math.tan(theta / 2), ba: theta * (r + k * t), hs: 0 };
    });
    segs.forEach((si, j) => { si.hs = si.s.height - si.ossb - (segs[j + 1]?.ossb ?? 0); });
    const E = e === 'front' || e === 'back' ? d.L : d.W;
    info[e] = { e, segs, on: segs.length > 0, ossb0: segs[0]?.ossb ?? 0, s0: 0, s1: E, E, total: segs.reduce((a, si) => a + si.ba + Math.max(0, si.hs), 0) };
  }
  // spans: trim at corners where the neighbouring edge is flanged (open-corner relief)
  const adj: Record<Edge, [Edge, Edge]> = { front: ['left', 'right'], back: ['left', 'right'], left: ['front', 'back'], right: ['front', 'back'] };
  for (const e of EDGES) {
    const [a, b] = adj[e];
    const i = info[e];
    i.s0 = (info[a].on ? info[a].ossb0 + d.relief : 0) + d.chains[e].inset0;
    i.s1 = i.E - (info[b].on ? info[b].ossb0 + d.relief : 0) - d.chains[e].inset1;
  }
  return info;
}

/* ---------------- rectilinear union → outline loops ---------------- */
type Rect = [number, number, number, number]; // x0, y0, x1, y1

export function unionRects(rects: Rect[]): [number, number][][] {
  const rs = rects.filter((q) => q[2] - q[0] > 1e-9 && q[3] - q[1] > 1e-9);
  if (!rs.length) return [];
  const xs = [...new Set(rs.flatMap((q) => [q[0], q[2]]))].sort((a, b) => a - b);
  const ys = [...new Set(rs.flatMap((q) => [q[1], q[3]]))].sort((a, b) => a - b);
  const nx = xs.length - 1, ny = ys.length - 1;
  const filled = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= nx || j >= ny) return false;
    const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
    return rs.some((q) => cx > q[0] && cx < q[2] && cy > q[1] && cy < q[3]);
  };
  const grid: boolean[][] = [];
  for (let i = 0; i < nx; i++) { grid[i] = []; for (let j = 0; j < ny; j++) grid[i][j] = filled(i, j); }
  const F = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && grid[i][j];
  // directed boundary edges, counter-clockwise around filled cells
  const next = new Map<string, [number, number][]>();
  const key = (i: number, j: number) => `${i},${j}`;
  const add = (a: [number, number], b: [number, number]) => { const k = key(a[0], a[1]); (next.get(k) ?? next.set(k, []).get(k)!).push(b); };
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    if (!grid[i][j]) continue;
    if (!F(i, j - 1)) add([i, j], [i + 1, j]);         // bottom
    if (!F(i + 1, j)) add([i + 1, j], [i + 1, j + 1]); // right
    if (!F(i, j + 1)) add([i + 1, j + 1], [i, j + 1]); // top
    if (!F(i - 1, j)) add([i, j + 1], [i, j]);         // left
  }
  const loops: [number, number][][] = [];
  for (const [k0] of next) {
    while ((next.get(k0) ?? []).length) {
      const loop: [number, number][] = [];
      let cur = k0.split(',').map(Number) as [number, number];
      let guard = 0;
      do {
        loop.push([xs[cur[0]], ys[cur[1]]]);
        const list = next.get(key(cur[0], cur[1]))!;
        const nb = list.shift()!;
        cur = nb;
      } while (key(cur[0], cur[1]) !== k0 && guard++ < 100000);
      loops.push(simplify(loop));
    }
  }
  // outer loop first (largest area)
  loops.sort((a, b) => Math.abs(polyArea(b)) - Math.abs(polyArea(a)));
  return loops;
}

function simplify(loop: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const p = loop[(i + n - 1) % n], c = loop[i], q = loop[(i + 1) % n];
    const cross = (c[0] - p[0]) * (q[1] - c[1]) - (c[1] - p[1]) * (q[0] - c[0]);
    if (Math.abs(cross) > 1e-9) out.push(c);
  }
  return out;
}

export function polyArea(p: [number, number][]) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; }
  return a / 2;
}

/* ---------------- cutout shapes ---------------- */
/** Polygon of a cutout primitive (for triangulation / 3D holes), counter-clockwise. */
export function primPoly(p: Prim, seg = 32): [number, number][] {
  const pts: [number, number][] = [];
  if (p.type === 'circle') {
    for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2; pts.push([p.cx + p.r * Math.cos(a), p.cy + p.r * Math.sin(a)]); }
  } else if (p.type === 'rect') {
    const hw = p.w / 2, hh = p.h / 2;
    pts.push([p.cx - hw, p.cy - hh], [p.cx + hw, p.cy - hh], [p.cx + hw, p.cy + hh], [p.cx - hw, p.cy + hh]);
  } else {
    const rr = p.wid / 2, half = Math.max(0, p.len / 2 - rr);
    const n = seg / 2;
    // stadium along X, then rotate if along Y
    const raw: [number, number][] = [];
    for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + (i / n) * Math.PI; raw.push([half + rr * Math.cos(a), rr * Math.sin(a)]); }
    for (let i = 0; i <= n; i++) { const a = Math.PI / 2 + (i / n) * Math.PI; raw.push([-half + rr * Math.cos(a), rr * Math.sin(a)]); }
    for (const [x, y] of raw) pts.push(p.alongY ? [p.cx - y, p.cy + x] : [p.cx + x, p.cy + y]);
  }
  return pts;
}

function primBox(p: Prim): Rect {
  if (p.type === 'circle') return [p.cx - p.r, p.cy - p.r, p.cx + p.r, p.cy + p.r];
  if (p.type === 'rect') return [p.cx - p.w / 2, p.cy - p.h / 2, p.cx + p.w / 2, p.cy + p.h / 2];
  const a = p.len / 2, b = p.wid / 2;
  return p.alongY ? [p.cx - b, p.cy - a, p.cx + b, p.cy + a] : [p.cx - a, p.cy - b, p.cx + a, p.cy + b];
}

/** Cutout as a primitive in a face's own 2D coordinates (X = along x / along the edge, Y = along y / up the flange). */
function cutPrim(c: Cutout, X: number, Y: number, swapXY = false): Prim {
  if (c.type === 'hole') return { type: 'circle', cx: X, cy: Y, r: c.d / 2 };
  if (c.type === 'slot') return { type: 'slot', cx: X, cy: Y, len: Math.max(c.w, c.d), wid: c.d, alongY: swapXY ? !c.vertical : c.vertical };
  return swapXY ? { type: 'rect', cx: X, cy: Y, w: c.h, h: c.w } : { type: 'rect', cx: X, cy: Y, w: c.w, h: c.h };
}

const inside = (b: Rect, area: Rect, m = 0) => b[0] >= area[0] + m - 1e-6 && b[1] >= area[1] + m - 1e-6 && b[2] <= area[2] - m + 1e-6 && b[3] <= area[3] - m + 1e-6;

/* ---------------- main build ---------------- */
export function build(d: Design, color = new THREE.Color(0.72, 0.76, 0.82), makeMat?: (c: THREE.Color) => THREE.Material): BuildResult {
  const warnings: string[] = [];
  const { t, r, L, W } = d;
  if (!(t > 0) || !(L > 0) || !(W > 0) || r < 0) {
    return { group: new THREE.Group(), flat: emptyFlat(), warnings: ['Thickness, length and width must be greater than zero.'], handles: [], solids: [] };
  }
  const info = edgeInfos(d);
  const isAdj = (a: Edge, b: Edge) => ((a === 'front' || a === 'back') !== (b === 'front' || b === 'back'));

  for (const e of EDGES) {
    const i = info[e];
    i.segs.forEach((si, j) => {
      const need = si.ossb + (i.segs[j + 1]?.ossb ?? 0);
      if (si.hs <= 0) warnings.push(`${EDGE_NAME[e]} flange ${j + 1} is too short for its bends (needs more than ${need.toFixed(1)} mm).`);
    });
    if (i.on && i.s1 - i.s0 <= 0) warnings.push(`${EDGE_NAME[e]} flanges have no length left after corner reliefs and insets.`);
    if (i.on && i.segs[0].s.angle > 90 && EDGES.some((n) => n !== e && info[n].on && isAdj(e, n)))
      warnings.push(`${EDGE_NAME[e]} flange is bent past 90° next to another flange — check the corners don't clash.`);
  }
  const ok = (e: Edge) => info[e].on && info[e].s1 - info[e].s0 > 0 && info[e].segs.every((si) => si.hs > 0);

  // base outline (in base coords): core to the tangent lines + "ears" beside partial flanges
  const xL = info.left.on ? info.left.ossb0 : 0, xR = info.right.on ? L - info.right.ossb0 : L;
  const yF = info.front.on ? info.front.ossb0 : 0, yB = info.back.on ? W - info.back.ossb0 : W;
  const rel = d.relief;
  const baseRects: Rect[] = [[xL, yF, xR, yB]];
  for (const e of EDGES) {
    const i = info[e];
    if (!i.on) continue;
    const lo = e === 'front' || e === 'back' ? xL : yF, hi = e === 'front' || e === 'back' ? xR : yB;
    for (const [a, b] of [[lo, i.s0 - rel], [i.s1 + rel, hi]] as [number, number][]) {
      if (b - a <= 1e-6) continue;
      if (e === 'front') baseRects.push([a, 0, b, yF]);
      if (e === 'back') baseRects.push([a, yB, b, W]);
      if (e === 'left') baseRects.push([0, a, xL, b]);
      if (e === 'right') baseRects.push([xR, a, L, b]);
    }
  }

  // flat pattern rectangles: base + one strip per flange chain
  const flatRects: Rect[] = [...baseRects];
  for (const e of EDGES) {
    if (!ok(e)) continue;
    const i = info[e], T = i.total;
    if (e === 'right') flatRects.push([xR, i.s0, xR + T, i.s1]);
    if (e === 'left') flatRects.push([xL - T, i.s0, xL, i.s1]);
    if (e === 'front') flatRects.push([i.s0, yF - T, i.s1, yF]);
    if (e === 'back') flatRects.push([i.s0, yB, i.s1, yB + T]);
  }
  // flat position: u along the edge, dist = distance outward from the base tangent line
  const flatPt = (e: Edge, u: number, dist: number): [number, number] => {
    if (e === 'right') return [xR + dist, u];
    if (e === 'left') return [xL - dist, u];
    if (e === 'front') return [u, yF - dist];
    return [u, yB + dist];
  };
  // flat distance to the start of flange j's bend
  const startDist = (i: EdgeInfo, j: number) => i.segs.slice(0, j).reduce((a, si) => a + si.ba + si.hs, 0);

  // cutouts → flat primitives + per-face 3D holes
  const holes: Prim[] = [];
  const faceHoles = new Map<Face, Prim[]>();
  const pushFace = (f: Face, p: Prim) => { (faceHoles.get(f) ?? faceHoles.set(f, []).get(f)!).push(p); };
  for (const c of d.cutouts) {
    if (c.face === 'base') {
      const p = cutPrim(c, c.x, c.y);
      if (!inside(primBox(p), [xL, yF, xR, yB])) warnings.push(`Cutout #${c.id} (${c.type} on the base) is off the part or in a bend zone.`);
      holes.push(p); pushFace('base', p);
      continue;
    }
    const pf = parseFace(c.face);
    const i = pf ? info[pf.edge] : null;
    const si = pf && i ? i.segs[pf.seg] : null;
    if (!pf || !i || !si || !ok(pf.edge)) { warnings.push(`Cutout #${c.id} is ignored: ${pf ? faceName(c.face).toLowerCase() : 'its face'} doesn't exist or is invalid.`); continue; }
    const o = c.y - si.ossb;                         // along the flange from the end of its bend
    const fp = cutPrim(c, c.x, o);                   // face coords: X = along edge, Y = along the flange
    if (!inside(primBox(fp), [i.s0, 0, i.s1, si.hs])) warnings.push(`Cutout #${c.id} (${c.type} on the ${faceName(c.face).toLowerCase()}) is off the flange or in a bend zone.`);
    pushFace(c.face, fp);
    const [fx, fy] = flatPt(pf.edge, c.x, startDist(i, pf.seg) + si.ba + o);
    holes.push(cutPrim(c, fx, fy, pf.edge === 'left' || pf.edge === 'right'));
  }

  // bend lines (centre of each bend zone)
  const bends: BendLine[] = [];
  for (const e of EDGES) {
    if (!ok(e)) continue;
    const i = info[e];
    i.segs.forEach((si, j) => {
      const dist = startDist(i, j) + si.ba / 2;
      bends.push({ a: flatPt(e, i.s0, dist), b: flatPt(e, i.s1, dist), up: si.s.dir === 'up', angle: si.s.angle, r });
    });
  }

  const loops = unionRects(flatRects);
  const all = loops.flat();
  const holeArea = holes.reduce((a, p) => a + Math.abs(polyArea(primPoly(p, 48))), 0);
  const flat: FlatPattern = {
    loops, holes, bends,
    minX: Math.min(...all.map((p) => p[0])), minY: Math.min(...all.map((p) => p[1])),
    maxX: Math.max(...all.map((p) => p[0])), maxY: Math.max(...all.map((p) => p[1])),
    area: loops.reduce((a, l, k) => a + (k === 0 ? Math.abs(polyArea(l)) : -Math.abs(polyArea(l))), 0) - holeArea,
  };

  /* ---------------- 3D ---------------- */
  const mat = makeMat ? makeMat(color) : new THREE.MeshStandardMaterial({ color, metalness: 0.25, roughness: 0.45, side: THREE.DoubleSide });
  const group = new THREE.Group();
  group.name = d.name || 'Part';
  const extrudeOpts = { depth: t, bevelEnabled: false, curveSegments: 24 };
  const handles: EdgeHandle[] = [];
  const solids: SolidPiece[] = [];

  const shapeFrom = (outline: [number, number][], hs: Prim[]) => {
    const s = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const h of hs) s.holes.push(new THREE.Path(primPoly(h).map(([x, y]) => new THREE.Vector2(x, y))));
    return s;
  };
  const addMesh = (g: THREE.BufferGeometry, name: string, tag: Record<string, unknown>, m?: THREE.Matrix4) => {
    if (m) { g.applyMatrix4(m); if (m.determinant() < 0) flipWinding(g); }
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = name;
    Object.assign(mesh.userData, tag);
    group.add(mesh);
  };

  const baseLoops = unionRects(baseRects);
  if (baseLoops.length) {
    addMesh(new THREE.ExtrudeGeometry(shapeFrom(baseLoops[0], faceHoles.get('base') ?? []), extrudeOpts), 'Base', { kind: 'base' });
    solids.push({ type: 'poly', pts: baseLoops[0], holes: faceHoles.get('base') ?? [], depth: t, m: new THREE.Matrix4().toArray() });
  }

  // free base edges are clickable (mid-thickness, along the outside edge)
  const h2 = t / 2;
  const baseEdge: Record<Edge, [THREE.Vector3, THREE.Vector3]> = {
    front: [new THREE.Vector3(0, 0, h2), new THREE.Vector3(L, 0, h2)],
    back: [new THREE.Vector3(0, W, h2), new THREE.Vector3(L, W, h2)],
    left: [new THREE.Vector3(0, 0, h2), new THREE.Vector3(0, W, h2)],
    right: [new THREE.Vector3(L, 0, h2), new THREE.Vector3(L, W, h2)],
  };
  for (const e of EDGES) if (!info[e].on) handles.push({ edge: e, seg: 0, a: baseEdge[e][0], b: baseEdge[e][1] });

  const zhat = new THREE.Vector3(0, 0, 1);
  const P = new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1); // slab (X=w, Y=o, Z=thk) → local (o, z, w)
  const fold = (oc: number, zc: number, ang: number) =>
    new THREE.Matrix4().makeTranslation(oc, zc, 0).multiply(new THREE.Matrix4().makeRotationZ(ang)).multiply(new THREE.Matrix4().makeTranslation(-oc, -zc, 0));
  const sector = (oc: number, positive: boolean, theta: number, w0: number, span: number) => {
    const s = new THREE.Shape();
    if (positive) {
      const zc = r + t, a0 = -Math.PI / 2;
      s.absarc(oc, zc, r + t, a0, a0 + theta, false);
      s.absarc(oc, zc, Math.max(r, 1e-4), a0 + theta, a0, true);
    } else {
      const zc = -r, a0 = Math.PI / 2;
      s.absarc(oc, zc, r + t, a0, a0 - theta, true);
      s.absarc(oc, zc, Math.max(r, 1e-4), a0 - theta, a0, false);
    }
    const g = new THREE.ExtrudeGeometry(s, { depth: span, bevelEnabled: false, curveSegments: Math.max(8, Math.round(theta / DEG / 6)) });
    g.translate(0, 0, w0);
    return g;
  };

  for (const e of EDGES) {
    if (!ok(e)) continue;
    const i = info[e];
    // local edge frame: o outward, z up, w = o × z along the edge
    let oDir: THREE.Vector3, origin: THREE.Vector3, wPlus: boolean;
    if (e === 'front') { oDir = new THREE.Vector3(0, -1, 0); origin = new THREE.Vector3(L, yF, 0); wPlus = false; }
    else if (e === 'back') { oDir = new THREE.Vector3(0, 1, 0); origin = new THREE.Vector3(0, yB, 0); wPlus = true; }
    else if (e === 'right') { oDir = new THREE.Vector3(1, 0, 0); origin = new THREE.Vector3(xR, W, 0); wPlus = false; }
    else { oDir = new THREE.Vector3(-1, 0, 0); origin = new THREE.Vector3(xL, 0, 0); wPlus = true; }
    const wDir = new THREE.Vector3().crossVectors(oDir, zhat);
    const toW = (u: number) => (wPlus ? u : i.E - u);
    const w0 = Math.min(toW(i.s0), toW(i.s1)), w1 = Math.max(toW(i.s0), toW(i.s1));
    const span = w1 - w0;
    // M accumulates: edge frame, then each bend's fold (about its own centre, in flat-state coordinates)
    let M = new THREE.Matrix4().makeBasis(oDir, zhat, wDir).setPosition(origin);
    let oAcc = 0;
    i.segs.forEach((si, j) => {
      const up = si.s.dir === 'up';
      const zc = up ? r + t : -r;
      const tag = { kind: 'flange', edge: e, seg: j };
      addMesh(sector(oAcc, up, si.theta, w0, span), `${EDGE_NAME[e]} bend ${j + 1}`, tag, M.clone());
      solids.push({ type: 'sector', oc: oAcc, positive: up, theta: si.theta, r, t, depth: span, m: M.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, w0)).toArray() });
      M = M.clone().multiply(fold(oAcc, zc, (up ? 1 : -1) * si.theta));
      const slabHoles = (faceHoles.get(faceId(e, j)) ?? []).map((p) => ({ ...mapPrimX(p, toW), cy: p.cy + oAcc }) as Prim);
      const slab = new THREE.ExtrudeGeometry(shapeFrom([[w0, oAcc], [w1, oAcc], [w1, oAcc + si.hs], [w0, oAcc + si.hs]], slabHoles), extrudeOpts);
      addMesh(slab, `${EDGE_NAME[e]} flange ${j + 1}`, tag, M.clone().multiply(P));
      solids.push({ type: 'poly', pts: [[w0, oAcc], [w1, oAcc], [w1, oAcc + si.hs], [w0, oAcc + si.hs]], holes: slabHoles, depth: t, m: M.clone().multiply(P).toArray() });
      oAcc += si.hs;
      if (j === i.segs.length - 1) {
        // the chain's free end is clickable: add the next flange there
        const a = new THREE.Vector3(oAcc, h2, w0).applyMatrix4(M), b = new THREE.Vector3(oAcc, h2, w1).applyMatrix4(M);
        handles.push({ edge: e, seg: j + 1, a, b });
      }
    });
  }
  return { group, flat, warnings, handles, solids };
}

/** Upgrade designs saved before flange chains (v1: one flange + optional 90° return per edge). */
export function upgradeV1(x: Record<string, unknown>): void {
  const fl = x.flanges as Record<string, { on?: boolean; height?: number; angle?: number; dir?: string; inset0?: number; inset1?: number; ret?: string; retHeight?: number }> | undefined;
  if (!fl || x.chains) return;
  const chains: Record<string, Chain> = {};
  for (const e of EDGES) {
    const f = fl[e];
    const c = chain();
    if (f?.on) {
      const dir = f.dir === 'down' ? 'down' : 'up';
      c.segs.push(seg(f.height ?? 40, dir, f.angle ?? 90));
      if (f.ret === 'in' || f.ret === 'out') c.segs.push(seg(f.retHeight ?? 15, f.ret === 'in' ? dir : dir === 'up' ? 'down' : 'up', 90));
      c.inset0 = f.inset0 ?? 0; c.inset1 = f.inset1 ?? 0;
    }
    chains[e] = c;
  }
  x.chains = chains;
  delete x.flanges;
  for (const c of (x.cutouts as { face?: string }[] | undefined) ?? []) if (c.face && /^(front|back|left|right)$/.test(c.face)) c.face += '/0';
}

/** Map a face-coordinate primitive's X (along the edge, base axes) into slab w coordinates. */
function mapPrimX(p: Prim, toW: (u: number) => number): Prim {
  return { ...p, cx: toW(p.cx) } as Prim; // shapes are symmetric about their centre, so a mirrored axis is fine
}

function flipWinding(g: THREE.BufferGeometry) {
  const idx = g.getIndex();
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, a); }
    idx.needsUpdate = true;
  } else {
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    for (let i = 0; i < pos.count; i += 3) {
      for (const att of [pos, nrm]) {
        if (!att) continue;
        const x = att.getX(i + 1), y = att.getY(i + 1), z = att.getZ(i + 1);
        att.setXYZ(i + 1, att.getX(i + 2), att.getY(i + 2), att.getZ(i + 2));
        att.setXYZ(i + 2, x, y, z);
      }
    }
    pos.needsUpdate = true;
  }
}

function emptyFlat(): FlatPattern { return { loops: [], holes: [], bends: [], minX: 0, minY: 0, maxX: 0, maxY: 0, area: 0 }; }

/** Flat pattern → triangles normalised into [0..X]×[0..Y] with X ≥ Y (what the nesting screen draws). */
export function flatTriangles(f: FlatPattern): { tris: [number, number][][]; x: number; y: number } {
  if (!f.loops.length) return { tris: [], x: 0, y: 0 };
  const w = f.maxX - f.minX, h = f.maxY - f.minY;
  const rot = h > w;
  const tf = ([x, y]: [number, number]): [number, number] => {
    const lx = x - f.minX, ly = y - f.minY;
    return rot ? [ly, w - lx] : [lx, ly];
  };
  const contour = f.loops[0].map(tf);
  const holePolys = [...f.loops.slice(1).map((l) => l.map(tf)), ...f.holes.map((p) => primPoly(p, 24).map(tf))];
  const faces = THREE.ShapeUtils.triangulateShape(contour.map(([x, y]) => new THREE.Vector2(x, y)), holePolys.map((hp) => hp.map(([x, y]) => new THREE.Vector2(x, y))));
  const pts = [...contour, ...holePolys.flat()];
  return { tris: faces.map((fc) => fc.map((i) => pts[i]) as [number, number][]), x: rot ? h : w, y: rot ? w : h };
}
