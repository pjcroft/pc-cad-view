/**
 * Importer layer. Every importer turns a File into a THREE.Group (the model tree).
 * The viewer never cares where the geometry came from, so a server-side converter for
 * proprietary formats (SLDPRT, NX/Creo PRT, CATPart...) can be added later as one more importer.
 */
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { getUnit } from './units';

export type Quality = 'draft' | 'normal' | 'fine';
export type Stage = 'read' | 'engine' | 'parse' | 'build';
export type Progress = (msg: string, stage?: Stage) => void;

export interface MetaProp { key: string; value: string; num?: number; unit?: string }
export interface FileHeader { name?: string; date?: string; author?: string; organization?: string; preprocessor?: string; system?: string; schema?: string; lengthUnit?: string; assumedUnit?: boolean }

export interface ImportResult {
  root: THREE.Group;
  format: string;
  engine: string;
  parseMs: number;
  header?: FileHeader;
}

const DEFAULT_COLOR = new THREE.Color(0.72, 0.76, 0.82);

export function makeMaterial(color: THREE.Color): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: 0.25,
    roughness: 0.45,
    side: THREE.DoubleSide,
    polygonOffset: true, // keeps edge lines crisp on top of faces
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

/* ---------------- format table ---------------- */
interface FormatInfo { label: string; kind: 'brep' | 'mesh' | 'future'; occt?: string }
export const FORMATS: Record<string, FormatInfo> = {
  stp: { label: 'STEP', kind: 'brep', occt: 'step' },
  step: { label: 'STEP', kind: 'brep', occt: 'step' },
  igs: { label: 'IGES', kind: 'brep', occt: 'iges' },
  iges: { label: 'IGES', kind: 'brep', occt: 'iges' },
  brep: { label: 'BREP', kind: 'brep', occt: 'brep' },
  brp: { label: 'BREP', kind: 'brep', occt: 'brep' },
  stl: { label: 'STL', kind: 'mesh' },
  obj: { label: 'OBJ', kind: 'mesh' },
  glb: { label: 'glTF', kind: 'mesh' },
  gltf: { label: 'glTF', kind: 'mesh' },
  '3mf': { label: '3MF', kind: 'mesh' },
  // Proprietary — need the server-side converter (phase 3)
  sldprt: { label: 'SolidWorks part', kind: 'future' },
  sldasm: { label: 'SolidWorks assembly', kind: 'future' },
  prt: { label: 'NX / Creo part', kind: 'future' },
  asm: { label: 'Creo assembly', kind: 'future' },
  catpart: { label: 'CATIA part', kind: 'future' },
  catproduct: { label: 'CATIA product', kind: 'future' },
  ipt: { label: 'Inventor part', kind: 'future' },
  iam: { label: 'Inventor assembly', kind: 'future' },
  x_t: { label: 'Parasolid', kind: 'future' },
  x_b: { label: 'Parasolid', kind: 'future' },
};

export const ACCEPT = Object.keys(FORMATS).filter((k) => FORMATS[k].kind !== 'future').map((k) => '.' + k).join(',');

export function extOf(name: string): string {
  const m = /\.([^.]+)$/.exec(name.toLowerCase());
  return m ? m[1] : '';
}

export class UnsupportedFormatError extends Error {
  constructor(public ext: string, public future: boolean) {
    super(future
      ? `${FORMATS[ext].label} files (.${ext}) need the server converter, which is planned for a later version. For now, export STEP from your CAD system and open that.`
      : `.${ext || '?'} is not a supported file type.`);
  }
}

/* ---------------- B-rep via OpenCascade worker ---------------- */
let worker: Worker | null = null;
let reqId = 0;

function getWorker(): Worker {
  if (!worker) worker = new Worker(new URL('occt/cad-worker.js', document.baseURI));
  return worker;
}

interface WorkerMesh {
  name: string;
  color: number[] | null;
  faces: { first: number; last: number; color: number[] | null }[];
  position: Float32Array;
  normal: Float32Array | null;
  index: Uint32Array;
}
interface WorkerNode { name: string; meshes: number[]; children: WorkerNode[] }

function importBrep(file: File, occtFormat: string, quality: Quality, progress: Progress): Promise<ImportResult> {
  return file.arrayBuffer().then((buffer) => new Promise<ImportResult>((resolve, reject) => {
    const w = getWorker();
    const id = ++reqId;
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data;
      if (d.id !== id) return;
      if (d.type === 'progress') {
        progress(d.stage === 'engine' ? 'Starting CAD engine…' : 'Reading B-rep geometry and tessellating…', d.stage === 'engine' ? 'engine' : 'parse');
        return;
      }
      w.removeEventListener('message', onMsg);
      if (d.type === 'error') return reject(new Error(d.message));
      progress('Building scene…', 'build');
      const root = buildFromOcct(d.root, d.meshes, file.name);
      if (d.meta) attachMeta(root, d.meta.parts || {});
      resolve({ root, format: FORMATS[extOf(file.name)].label, engine: 'OpenCascade (WASM)', parseMs: d.ms, header: d.meta?.header });
    };
    w.addEventListener('message', onMsg);
    w.onerror = (e) => { w.removeEventListener('message', onMsg); worker = null; reject(new Error(e.message || 'CAD engine failed to load.')); };
    w.postMessage({ id, format: occtFormat, buffer, quality }, [buffer]);
  }));
}

function buildFromOcct(rootNode: WorkerNode, meshes: WorkerMesh[], fileName: string): THREE.Group {
  const toMesh = (m: WorkerMesh, i: number): THREE.Mesh => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
    if (m.normal) g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
    g.setIndex(new THREE.BufferAttribute(m.index, 1));
    if (!m.normal) g.computeVertexNormals();

    const base = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : DEFAULT_COLOR.clone();
    const faceColored = m.faces.some((f) => f.color);
    let mat: THREE.Material | THREE.Material[];
    if (faceColored) {
      // Per-face colours: one draw group per B-rep face, materials shared by colour
      const mats: THREE.MeshStandardMaterial[] = [];
      const key = new Map<string, number>();
      for (const f of m.faces) {
        const c = f.color ? new THREE.Color(f.color[0], f.color[1], f.color[2]) : base;
        const k = c.getHexString();
        if (!key.has(k)) { key.set(k, mats.length); mats.push(makeMaterial(c)); }
        g.addGroup(f.first * 3, (f.last - f.first + 1) * 3, key.get(k)!);
      }
      mat = mats;
    } else {
      mat = makeMaterial(base);
    }
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = m.name || `Body ${i + 1}`;
    mesh.userData.brepFaces = m.faces.length;
    mesh.userData.faces = m.faces.map((f) => [f.first, f.last]); // B-rep face triangle ranges (for unfolding)
    return mesh;
  };

  const walk = (n: WorkerNode, fallback: string): THREE.Group => {
    const grp = new THREE.Group();
    grp.name = n.name || fallback;
    grp.userData.unnamed = !n.name;
    n.meshes.forEach((mi) => grp.add(toMesh(meshes[mi], mi)));
    (n.children || []).forEach((c, i) => grp.add(walk(c, `Assembly ${i + 1}`)));
    return grp;
  };
  // Collapse nameless single-child wrappers (STEP files often nest an empty root)
  let top = walk(rootNode, fileName);
  while (top.userData.unnamed && top.children.length === 1 && top.children[0] instanceof THREE.Group) {
    top = top.children[0] as THREE.Group;
  }
  top.removeFromParent();
  return top;
}

/** Attach STEP part properties to the meshes: by mesh (product) name, else the nearest named assembly node. */
function attachMeta(root: THREE.Object3D, parts: Record<string, MetaProp[]>) {
  const names = Object.keys(parts);
  if (!names.length) return;
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const find = (name: string) => parts[name] ?? parts[lower.get(name.toLowerCase()) ?? ''];
  root.traverse((o) => {
    const own = find(o.name);
    if (own) o.userData.meta = own;
  });
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh || o.userData.meta) return;
    // a part's body is often a child of the product node that carries the properties
    const p = o.parent;
    if (p && p.userData.meta && p.children.filter((c) => (c as THREE.Mesh).isMesh).length === 1) o.userData.meta = p.userData.meta;
  });
}

/** Pull material / thickness / flat-pattern size out of part properties (SolidWorks, Inventor, Creo naming). */
export function metaSummary(meta: MetaProp[] | undefined) {
  const out: { material?: string; thickness?: number; flatX?: number; flatY?: number } = {};
  if (!meta) return out;
  const num = (p: MetaProp) => p.num ?? parseFloat(p.value.replace(',', '.'));
  for (const p of meta) {
    const k = p.key.toLowerCase();
    if (!out.material && /^material|material$|werkstoff|materiale/.test(k) && !/density|mass/.test(k)) out.material = p.value;
    else if (out.thickness === undefined && /thickness|sheet ?metal ?thk|^thk$|^gauge thickness|spessore|blechdicke/.test(k)) { const v = num(p); if (v > 0) out.thickness = v; }
    else if (out.flatX === undefined && /bounding box length|flat ?pattern ?(extents )?(length|x)|flatpattern(extents)?length|blank ?length|sviluppo ?x/.test(k)) { const v = num(p); if (v > 0) out.flatX = v; }
    else if (out.flatY === undefined && /bounding box width|flat ?pattern ?(extents )?(width|y)|flatpattern(extents)?width|blank ?width|sviluppo ?y/.test(k)) { const v = num(p); if (v > 0) out.flatY = v; }
  }
  return out;
}

/* ---------------- mesh formats via three.js loaders ---------------- */
async function importMesh(file: File, ext: string, progress: Progress): Promise<ImportResult> {
  progress('Reading mesh…', 'parse');
  const t0 = performance.now();
  const buf = await file.arrayBuffer();
  const root = new THREE.Group();
  root.name = file.name;

  const restyle = (o: THREE.Object3D) => o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      const m = c as THREE.Mesh;
      const old = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
      const col = old && (old as any).color ? (old as any).color.clone() : DEFAULT_COLOR.clone();
      m.material = makeMaterial(col);
      if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals();
    }
  });

  if (ext === 'stl') {
    const g = new STLLoader().parse(buf);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, makeMaterial(DEFAULT_COLOR.clone()));
    mesh.name = file.name.replace(/\.[^.]+$/, '');
    root.add(mesh);
  } else if (ext === 'obj') {
    const o = new OBJLoader().parse(new TextDecoder().decode(buf));
    restyle(o); root.add(...o.children);
  } else if (ext === '3mf') {
    const o = new ThreeMFLoader().parse(buf);
    restyle(o); root.add(o);
  } else {
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    root.add(gltf.scene); // keep glTF PBR materials as authored
  }
  // STL/OBJ/3MF carry no reliable unit: read them in the current display unit (inches → scale to mm)
  const unit = ext === 'glb' || ext === 'gltf' ? 'm' : getUnit();
  if (unit === 'in') root.scale.setScalar(25.4);
  if (unit === 'm') root.scale.multiplyScalar(1000); // glTF is metres by spec
  root.updateMatrixWorld(true);
  return { root, format: FORMATS[ext].label, engine: 'three.js loader', parseMs: performance.now() - t0, header: { lengthUnit: unit, assumedUnit: unit !== 'm' } };
}

/* ---------------- entry point ---------------- */
export async function importFile(file: File, quality: Quality, progress: Progress): Promise<ImportResult> {
  const ext = extOf(file.name);
  const info = FORMATS[ext];
  if (!info) throw new UnsupportedFormatError(ext, false);
  if (info.kind === 'future') throw new UnsupportedFormatError(ext, true);
  // Phase 3 hook: if (info.kind === 'future') return importViaServer(file, progress);
  if (info.kind === 'brep') return importBrep(file, info.occt!, quality, progress);
  return importMesh(file, ext, progress);
}
