/**
 * Part catalogue: groups identical bodies (same name + same shape) into part types with a quantity,
 * then works out sheet-metal data for each in the background:
 *   thickness  ← file property, else ray-cast detection
 *   flat blank ← file flat-pattern property, else automatic unfold, else manual entry
 */
import * as THREE from 'three';
import { metaSummary, type MetaProp } from './importers';
import { detectThickness, unfoldPart, type FlatResult } from './sheetmetal';

export type Source = 'file' | 'auto' | 'manual';

export interface PartType {
  id: string;
  name: string;
  meshes: THREE.Mesh[];
  qty: number;
  swatch: string;       // model colour
  color: string;        // nesting colour
  meta?: MetaProp[];
  material?: string;
  thickness: number | null;
  tSource: Source | null;
  flat: { x: number; y: number } | null;
  flatSource: Source | null;
  flatInfo?: FlatResult;
  analysed: boolean;
  // nesting choices
  nest: boolean;
  perSet: number;
  lockRot: boolean;
}

const NEST_COLORS = ['#22d3ee', '#f59e0b', '#a78bfa', '#4ade80', '#f87171', '#38bdf8', '#fb923c', '#e879f9', '#facc15', '#2dd4bf', '#d9c7a5', '#818cf8'];

export function buildCatalog(meshes: readonly THREE.Mesh[]): PartType[] {
  const map = new Map<string, PartType>();
  for (const m of meshes) {
    const g = m.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const s = g.boundingBox!.getSize(new THREE.Vector3());
    const dims = [s.x, s.y, s.z].sort((a, b) => a - b).map((v) => v.toFixed(1)).join('x');
    const tris = g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
    const key = `${m.name}|${tris}|${dims}`;
    let p = map.get(key);
    if (!p) {
      const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
      const meta = m.userData.meta as MetaProp[] | undefined;
      p = {
        id: 'p' + map.size, name: m.name, meshes: [], qty: 0,
        swatch: mat?.color ? '#' + mat.color.getHexString() : '#999',
        color: NEST_COLORS[map.size % NEST_COLORS.length],
        meta, material: metaSummary(meta).material,
        thickness: null, tSource: null, flat: null, flatSource: null, analysed: false,
        nest: false, perSet: 1, lockRot: false,
      };
      map.set(key, p);
    }
    p.meshes.push(m);
    p.qty++;
    m.userData.partType = p.id;
  }
  const list = [...map.values()];
  list.forEach((p) => (p.perSet = p.qty));
  return list;
}

export function analysePart(p: PartType, kFactor: number) {
  const rep = p.meshes[0];
  const sum = metaSummary(p.meta);
  if (sum.thickness) { p.thickness = sum.thickness; p.tSource = 'file'; }
  else {
    if (rep.userData.sheetT === undefined) rep.userData.sheetT = detectThickness(rep);
    p.thickness = rep.userData.sheetT; p.tSource = p.thickness ? 'auto' : null;
  }
  if (p.flatSource === 'manual') { p.analysed = true; return; }
  if (sum.flatX && sum.flatY) {
    p.flat = { x: Math.max(sum.flatX, sum.flatY), y: Math.min(sum.flatX, sum.flatY) };
    p.flatSource = 'file';
  }
  // unfold too when possible (gives the preview shape, and a size if the file had none)
  if (p.thickness) {
    try {
      const f = unfoldPart(rep, p.thickness, kFactor);
      if (f) {
        p.flatInfo = f;
        if (p.flatSource !== 'file') { p.flat = { x: f.x, y: f.y }; p.flatSource = 'auto'; }
      }
    } catch (e) { console.warn('unfold failed', p.name, e); }
  }
  p.analysed = true;
}

/** Analyse all parts in small batches so the page stays responsive on big assemblies. */
export function analyseAll(list: PartType[], kFactor: number, onProgress: (done: number) => void): () => void {
  let i = 0, cancelled = false;
  const step = () => {
    if (cancelled) return;
    const t0 = performance.now();
    while (i < list.length && performance.now() - t0 < 30) analysePart(list[i++], kFactor);
    onProgress(i);
    if (i < list.length) setTimeout(step, 0);
  };
  setTimeout(step, 0);
  return () => { cancelled = true; };
}

export const isSheet = (p: PartType) => !!p.thickness && !!p.flat;
