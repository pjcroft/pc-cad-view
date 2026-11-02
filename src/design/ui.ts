/** Design screen: parametric sheet metal part editor with live 3D, flat pattern, DXF and .pc3d files. */
import * as THREE from 'three';
import { Viewer, type ViewName } from '../viewer';
import { makeMaterial } from '../importers';
import { num, uLabel, toDisp, fromDisp, area, inputStep, getUnit, onUnit } from '../units';
import { build, flatTriangles, newDesign, chain, seg, defaultHeight, upgradeV1, faceId, faceName, parseFace, TEMPLATES, EDGES, EDGE_NAME, polyArea, primPoly, type Design, type Edge, type Cutout, type CutType, type FlatPattern, type BuildResult, type EdgeHandle } from './model';
import { flatToDxf } from './dxf';
import type { SolidPiece } from './model';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const STORE = 'pccad.design.v1';
export const PC3D_EXT = 'pc3d';

// g/cm³, matched loosely on the material name (for a weight estimate)
const DENSITY: [RegExp, number][] = [[/alu/i, 2.7], [/stainless|inox|30[4-9]|316/i, 8.0], [/copper|cu\b/i, 8.96], [/brass/i, 8.5], [/titan/i, 4.5], [/steel|galv|dc0|s235|s355|crs|hrs/i, 7.85]];
const density = (m: string) => DENSITY.find(([re]) => re.test(m))?.[1] ?? 7.85;

// cross-section icons for the template buttons
const TPL_ICON: Record<string, string> = {
  flat: 'M4 14h28', L: 'M4 16h22v-12', U: 'M5 4v12h26v-12', Z: 'M4 4v8h28v8', hat: 'M2 6h7v10h18v-10h7', C: 'M10 4h-5v12h26v-12h-5', tray: 'M4 6v10h28v-10M9 6v6M27 6v6',
};

export interface DesignHost {
  sendToNest: (d: Design, flat: FlatPattern, tris: { tris: [number, number][][]; x: number; y: number }) => void;
  toast: (msg: string, ok?: boolean) => void;
}

export class DesignUI {
  d: Design;
  private viewer: Viewer | null = null;
  private res: BuildResult | null = null;
  private timer = 0;
  private nextCutId = 1;
  private active = false;
  private selFlange: { edge: Edge; seg: number } | null = null;
  private hoverHandle: THREE.Mesh | null = null;
  private hoverRaf = 0;
  private handleClickAt = 0;

  constructor(private host: DesignHost) {
    this.d = this.restore() ?? TEMPLATES[1].make();
    this.nextCutId = Math.max(0, ...this.d.cutouts.map((c) => c.id)) + 1;
    this.renderTemplates();
    this.renderForm();
    // static inputs
    $('dzName').addEventListener('input', (e) => { this.d.name = (e.target as HTMLInputElement).value; this.schedule(); });
    $('dzMaterial').addEventListener('input', (e) => { this.d.material = (e.target as HTMLInputElement).value; this.schedule(); });
    document.querySelectorAll<HTMLInputElement>('.design .fgrid input[data-k]').forEach((inp) => inp.addEventListener('input', () => {
      const k = inp.dataset.k as 't' | 'r' | 'k' | 'relief' | 'L' | 'W';
      const v = +inp.value;
      if (!Number.isFinite(v)) return;
      this.d[k] = inp.classList.contains('len') ? fromDisp(v) : v;
      this.schedule();
    }));
    document.querySelectorAll<HTMLButtonElement>('.dz-add [data-add]').forEach((b) => b.onclick = () => this.addCut(b.dataset.add as CutType));
    document.querySelectorAll<HTMLButtonElement>('.dz-views [data-dzv]').forEach((b) => b.onclick = () => {
      if (!this.viewer) return;
      const v = b.dataset.dzv!;
      if (v === 'fit') this.viewer.fit(); else this.viewer.setView(v as ViewName);
    });
    $('dzDxf').onclick = () => this.exportDxf();
    $('dzStep').onclick = () => this.exportStep();
    $('dzNest').onclick = () => { if (this.res && this.res.flat.loops.length) this.host.sendToNest(this.cloneDesign(), this.res.flat, flatTriangles(this.res.flat)); };
    $('dzSave').onclick = () => this.save();
    $('dzOpen').onclick = () => $('dzFile').click();
    $<HTMLInputElement>('dzFile').onchange = () => { const f = $<HTMLInputElement>('dzFile').files?.[0]; if (f) this.open(f); $<HTMLInputElement>('dzFile').value = ''; };
    onUnit(() => { this.renderForm(); this.renderFlat(); });
  }

  /** The Design screen's 3D viewer (for automated checks). */
  get view() { return this.viewer; }

  /** Called when the Design screen is shown / hidden. */
  setActive(on: boolean) {
    this.active = on;
    if (on && !this.viewer) {
      this.viewer = new Viewer($('dzVp'));
      this.viewer.onSelect = (p) => this.onPick(p?.mesh ?? null);
      const canvas = this.viewer.renderer.domElement;
      canvas.addEventListener('pointermove', (e) => {
        cancelAnimationFrame(this.hoverRaf);
        this.hoverRaf = requestAnimationFrame(() => this.onHover(e.clientX, e.clientY));
      });
      canvas.addEventListener('pointerleave', () => this.onHover(-1, -1));
      // edge handles win over the part underneath: intercept the click before the viewer selects
      let down = { x: 0, y: 0 };
      canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; }, true);
      canvas.addEventListener('pointerup', (e) => {
        if (e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
        const h = this.handleAt(e.clientX, e.clientY);
        if (!h) return;
        // don't stop the event: the orbit controls need this pointerup too. Just ignore the
        // part selection the viewer makes right after (see onPick).
        this.handleClickAt = performance.now();
        this.addFlange(h.userData.edge as Edge);
      }, true);
      this.rebuild(false);
    }
    this.viewer?.setActive(on);
    if (on) this.rebuild(true);
  }

  /* ---------------- form ---------------- */
  private renderTemplates() {
    $('dzTemplates').innerHTML = TEMPLATES.map((t) => `<button data-tpl="${t.id}" title="${esc(t.label)}"><svg viewBox="0 0 36 20"><path d="${TPL_ICON[t.id] ?? ''}"/></svg>${esc(t.label)}</button>`).join('');
    $('dzTemplates').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.onclick = () => {
      const t = TEMPLATES.find((x) => x.id === b.dataset.tpl)!;
      this.d = t.make();
      this.nextCutId = Math.max(0, ...this.d.cutouts.map((c) => c.id)) + 1;
      this.renderForm();
      this.rebuild(false);
      $('dzTemplates').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    });
  }

  private lenVal(mm: number) { const v = toDisp(mm); return String(getUnit() === 'mm' ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000); }

  renderForm() {
    const d = this.d;
    $('dzUnits').textContent = uLabel();
    $<HTMLInputElement>('dzName').value = d.name;
    $<HTMLInputElement>('dzMaterial').value = d.material;
    document.querySelectorAll<HTMLInputElement>('.design .fgrid input[data-k]').forEach((inp) => {
      const k = inp.dataset.k as 't' | 'r' | 'k' | 'relief' | 'L' | 'W';
      if (inp.classList.contains('len')) { inp.value = this.lenVal(d[k]); inp.step = inputStep(k !== 'L' && k !== 'W'); }
      else inp.value = String(d[k]);
    });
    this.renderFlanges();
    this.renderCuts();
  }

  private chainSummary(e: Edge) {
    const segs = this.d.chains[e].segs;
    if (!segs.length) return 'no flange — click its edge in 3D or ＋';
    return segs.map((sg) => `${num(sg.height)}${sg.angle !== 90 ? ` ${sg.angle}°` : ''} ${sg.dir}`).join(' → ') + ` ${uLabel()}`;
  }

  private renderFlanges() {
    const box = $('dzFlanges');
    const st = inputStep(true);
    box.innerHTML = EDGES.map((e) => {
      const c = this.d.chains[e];
      const rows = c.segs.map((sg, j) => {
        const sel = this.selFlange && this.selFlange.edge === e && this.selFlange.seg === j;
        return `<div class="seg-row${sel ? ' sel' : ''}" data-j="${j}">
          <span class="seg-n" title="${j === 0 ? 'Bends off the base' : `Bends off flange ${j}`}">${j + 1}</span>
          <label>Height<input data-s="height" type="number" step="${st}" value="${this.lenVal(sg.height)}"></label>
          <label>Angle °<input data-s="angle" type="number" min="1" max="170" step="1" value="${sg.angle}"></label>
          <label>Direction<select data-s="dir"><option value="up" ${sg.dir === 'up' ? 'selected' : ''}>Up</option><option value="down" ${sg.dir === 'down' ? 'selected' : ''}>Down</option></select></label>
          <button class="x" data-del="${j}" title="Remove this flange">✕</button>
        </div>`;
      }).join('');
      return `<div class="fl ${c.segs.length ? 'on' : ''}" data-e="${e}">
        <div class="fl-h"><b>${EDGE_NAME[e]}</b><small>${esc(this.chainSummary(e))}</small><button class="fl-add" data-add="${e}" title="${c.segs.length ? 'Add a flange to the end of this chain' : 'Add a flange on this edge'}">＋</button></div>
        ${c.segs.length ? `<div class="fl-body">${rows}
          <div class="fl-insets">
            <label>Inset start<input data-i="inset0" type="number" min="0" step="${st}" value="${this.lenVal(c.inset0)}"></label>
            <label>Inset end<input data-i="inset1" type="number" min="0" step="${st}" value="${this.lenVal(c.inset1)}"></label>
            <button class="sbtn" data-add="${e}">＋ Add flange to end</button>
          </div></div>` : ''}
      </div>`;
    }).join('');
    box.querySelectorAll<HTMLElement>('.fl').forEach((card) => {
      const e = card.dataset.e as Edge;
      const c = this.d.chains[e];
      card.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((b) => b.onclick = () => this.addFlange(e));
      card.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => b.onclick = () => this.removeFlange(e, +b.dataset.del!));
      card.querySelectorAll<HTMLElement>('.seg-row').forEach((row) => {
        const j = +row.dataset.j!;
        const sg = c.segs[j];
        row.addEventListener('focusin', () => this.setSel({ edge: e, seg: j }, false));
        row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-s]').forEach((inp) => {
          inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', () => {
            const key = inp.dataset.s!;
            if (key === 'dir') sg.dir = inp.value as 'up' | 'down';
            else { const v = +inp.value; if (!Number.isFinite(v)) return; if (key === 'angle') sg.angle = v; else sg.height = fromDisp(v); }
            const sm = card.querySelector('.fl-h small');
            if (sm) sm.textContent = this.chainSummary(e);
            this.schedule();
          });
        });
      });
      card.querySelectorAll<HTMLInputElement>('[data-i]').forEach((inp) => inp.addEventListener('input', () => {
        const v = +inp.value; if (!Number.isFinite(v)) return;
        c[inp.dataset.i as 'inset0' | 'inset1'] = fromDisp(v);
        this.schedule();
      }));
    });
  }

  /** Add a flange on a free base edge, or on the free end of that edge's chain. */
  private addFlange(e: Edge) {
    const c = this.d.chains[e];
    const prev = c.segs[c.segs.length - 1];
    c.segs.push(seg(defaultHeight(this.d), prev ? prev.dir : 'up'));
    this.selFlange = { edge: e, seg: c.segs.length - 1 };
    this.renderFlanges();
    this.renderCuts();
    this.schedule();
    this.scrollToSel();
  }

  private removeFlange(e: Edge, j: number) {
    const c = this.d.chains[e];
    c.segs.splice(j, 1);
    // cutouts on that flange go; later flanges on the chain shift down one
    this.d.cutouts = this.d.cutouts.filter((x) => x.face !== faceId(e, j)).map((x) => {
      const pf = parseFace(x.face);
      return pf && pf.edge === e && pf.seg > j ? { ...x, face: faceId(e, pf.seg - 1) } : x;
    });
    this.selFlange = null;
    this.renderFlanges();
    this.renderCuts();
    this.schedule();
  }

  private setSel(sel: { edge: Edge; seg: number } | null, scroll = true) {
    this.selFlange = sel;
    document.querySelectorAll<HTMLElement>('#dzFlanges .seg-row').forEach((row) => {
      const e = row.closest<HTMLElement>('.fl')!.dataset.e;
      row.classList.toggle('sel', !!sel && sel.edge === e && sel.seg === +row.dataset.j!);
    });
    if (scroll) this.scrollToSel();
  }

  private scrollToSel() {
    requestAnimationFrame(() => document.querySelector('#dzFlanges .seg-row.sel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  /* ---------------- 3D: clickable edges ---------------- */
  private onPick(mesh: THREE.Mesh | null) {
    if (!mesh || performance.now() - this.handleClickAt < 250) return;
    const u = mesh.userData;
    if (u.handle) { this.addFlange(u.edge as Edge); return; }
    if (u.kind === 'flange') this.setSel({ edge: u.edge, seg: u.seg });
    else this.setSel(null, false);
  }

  private onHover(cx: number, cy: number) {
    const tip = $('dzTip');
    const m = cx < 0 ? null : this.handleAt(cx, cy);
    if (m !== this.hoverHandle) {
      if (this.hoverHandle) { const hm = this.hoverHandle.material as THREE.MeshBasicMaterial; hm.color.set('#22d3ee'); hm.opacity = 0.55; }
      if (m) { const mm = m.material as THREE.MeshBasicMaterial; mm.color.set('#fbbf24'); mm.opacity = 0.95; }
      this.hoverHandle = m;
    }
    if (this.viewer) this.viewer.renderer.domElement.style.cursor = m ? 'pointer' : '';
    if (!m) { tip.hidden = true; return; }
    const r = $('dzVp').getBoundingClientRect();
    const edge = m.userData.edge as Edge;
    const n = this.d.chains[edge].segs.length;
    tip.textContent = n ? `＋ Add flange ${n + 1} to the ${EDGE_NAME[edge].toLowerCase()} chain` : `＋ Add a flange on the ${EDGE_NAME[edge].toLowerCase()} edge`;
    tip.style.transform = `translate(${cx - r.left + 14}px, ${cy - r.top + 14}px)`;
    tip.hidden = false;
  }

  /** The edge handle under the cursor: nearest on screen within ~12 px (handles are thin; this makes them easy to hit). */
  private handleAt(cx: number, cy: number): THREE.Mesh | null {
    const v = this.viewer;
    if (!v || !v.model) return null;
    const r = v.renderer.domElement.getBoundingClientRect();
    const scr = (p: THREE.Vector3) => { const q = p.clone().project(v.camera); return { x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height, z: q.z }; };
    let best: THREE.Mesh | null = null, bestD = 12;
    v.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.userData.handle) return;
      const a = scr(m.userData.a), b = scr(m.userData.b);
      if (a.z > 1 || b.z > 1) return; // behind the camera
      const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((cx - a.x) * dx + (cy - a.y) * dy) / L2));
      const d = Math.hypot(cx - (a.x + t * dx), cy - (a.y + t * dy));
      if (d < bestD) { bestD = d; best = m; }
    });
    return best;
  }

  /** Glowing cylinders along every edge that can take a new flange (drawn on top so far edges stay visible). */
  private handleMeshes(hs: EdgeHandle[]): THREE.Mesh[] {
    const size = Math.max(this.d.L, this.d.W);
    const rad = Math.max(this.d.t * 0.9, size * 0.007);
    return hs.map((h) => {
      const len = h.a.distanceTo(h.b);
      const g = new THREE.CylinderGeometry(rad, rad, len, 12, 1);
      const mat = new THREE.MeshBasicMaterial({ color: '#22d3ee', transparent: true, opacity: 0.55, depthWrite: false, depthTest: false });
      const mesh = new THREE.Mesh(g, mat);
      mesh.position.copy(h.a).add(h.b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), h.b.clone().sub(h.a).normalize());
      mesh.name = `Add flange (${EDGE_NAME[h.edge]})`;
      Object.assign(mesh.userData, { handle: true, noEdges: true, edge: h.edge, seg: h.seg, a: h.a.clone(), b: h.b.clone() });
      mesh.raycast = () => {}; // picked by screen distance instead (see handleAt)
      mesh.renderOrder = 3;
      return mesh;
    });
  }

  private addCut(type: CutType) {
    const d = this.d;
    const c: Cutout = { id: this.nextCutId++, face: 'base', type, x: d.L / 2, y: d.W / 2, d: type === 'slot' ? 8 : 10, w: type === 'slot' ? 30 : 40, h: 20, vertical: false };
    d.cutouts.push(c);
    this.renderCuts();
    this.schedule();
  }

  private renderCuts() {
    const box = $('dzCuts');
    const st = inputStep(true);
    if (!this.d.cutouts.length) { box.innerHTML = '<p class="dz-hint" style="margin-top:0">No cutouts yet.</p>'; return; }
    const faces = ['base', ...EDGES.flatMap((e) => this.d.chains[e].segs.map((_, j) => faceId(e, j)))];
    const faceOpts = (sel: string) => [...faces, ...(faces.includes(sel) ? [] : [sel])].map((f) => `<option value="${f}" ${f === sel ? 'selected' : ''}>${esc(faceName(f))}${faces.includes(f) ? '' : ' (missing)'}</option>`).join('');
    box.innerHTML = this.d.cutouts.map((c) => {
      const L = (k: 'x' | 'y' | 'd' | 'w' | 'h', label: string) => `<label>${label}<input data-c="${k}" type="number" step="${st}" value="${this.lenVal(c[k])}"></label>`;
      const sizes = c.type === 'hole' ? L('d', 'Ø') + '<span></span>'
        : c.type === 'slot' ? L('w', 'Length') + L('d', 'Width')
        : L('w', 'Width') + L('h', 'Height');
      return `<div class="cut" data-id="${c.id}">
        <span class="cut-ico">#${c.id} ${c.type === 'rect' ? 'cutout' : c.type}</span>
        <span>${c.type === 'slot' ? `<label class="tog" style="padding:0;font-size:.74rem"><input type="checkbox" data-c="vertical" ${c.vertical ? 'checked' : ''}><span></span>Runs along Y</label>` : ''}</span>
        <button class="x" title="Remove">✕</button>
        <div class="cut-face"><label>Face<select data-c="face">${faceOpts(c.face)}</select></label></div>
        <div class="cut-grid">${L('x', 'X')}${L('y', 'Y')}${sizes}</div></div>`;
    }).join('');
    box.querySelectorAll<HTMLElement>('.cut').forEach((row) => {
      const c = this.d.cutouts.find((x) => x.id === +row.dataset.id!)!;
      row.querySelector<HTMLButtonElement>('.x')!.onclick = () => { this.d.cutouts = this.d.cutouts.filter((x) => x !== c); this.renderCuts(); this.schedule(); };
      row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-c]').forEach((inp) => {
        const key = inp.dataset.c!;
        inp.addEventListener(inp.tagName === 'SELECT' || (inp as HTMLInputElement).type === 'checkbox' ? 'change' : 'input', () => {
          if (key === 'face') { c.face = inp.value as Cutout['face']; this.defaultPos(c); this.renderCuts(); }
          else if (key === 'vertical') c.vertical = (inp as HTMLInputElement).checked;
          else { const v = +inp.value; if (!Number.isFinite(v)) return; (c as unknown as Record<string, number>)[key] = fromDisp(v); }
          this.schedule();
        });
      });
    });
  }

  /** Centre a cutout on its new face. */
  private defaultPos(c: Cutout) {
    const pf = parseFace(c.face);
    if (!pf) { c.x = this.d.L / 2; c.y = this.d.W / 2; return; }
    const sg = this.d.chains[pf.edge].segs[pf.seg];
    c.x = (pf.edge === 'front' || pf.edge === 'back' ? this.d.L : this.d.W) / 2;
    c.y = (sg?.height ?? defaultHeight(this.d)) / 2;
  }

  /* ---------------- build + draw ---------------- */
  private schedule() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.rebuild(true), 40);
    this.persist();
  }

  private rebuild(keepView: boolean) {
    this.res = build(this.d, new THREE.Color(0.74, 0.78, 0.84), makeMaterial);
    for (const h of this.handleMeshes(this.res.handles)) this.res.group.add(h);
    this.hoverHandle = null;
    $('dzTip').hidden = true;
    if (this.viewer && this.active) this.viewer.setModel(this.res.group, keepView);
    this.renderFlat();
    const w = this.res.warnings;
    $('dzWarn').hidden = !w.length;
    $('dzWarn').innerHTML = w.map((x) => `⚠ ${esc(x)}`).join('<br>');
    // flag cutouts named in warnings
    $('dzCuts').querySelectorAll<HTMLElement>('.cut').forEach((row) => {
      const c = this.d.cutouts.find((x) => x.id === +row.dataset.id!);
      row.classList.toggle('bad', !!c && w.some((m) => m.startsWith(`Cutout #${c.id} `)));
    });
    const okFlat = !!this.res.flat.loops.length;
    $<HTMLButtonElement>('dzDxf').disabled = !okFlat;
    $<HTMLButtonElement>('dzStep').disabled = !okFlat || !!this.stepBusy;
    $<HTMLButtonElement>('dzNest').disabled = !okFlat;
  }

  private renderFlat() {
    if (!this.res) return;
    const f = this.res.flat;
    if (!f.loops.length) { $('dzFlat').innerHTML = '<p class="muted small">No flat pattern — check the sizes.</p>'; $('dzFlatInfo').innerHTML = ''; return; }
    const W = f.maxX - f.minX, H = f.maxY - f.minY;
    const k = 320 / Math.max(W, H);          // draw in a ~320-unit box so text stays crisp
    const pad = 40;
    const tx = (x: number) => (x - f.minX) * k, ty = (y: number) => (f.maxY - y) * k; // flip Y (flat data is y-up)
    const path = (pts: [number, number][]) => 'M' + pts.map(([x, y]) => `${tx(x).toFixed(2)} ${ty(y).toFixed(2)}`).join('L') + 'Z';
    const outline = f.loops.map(path).join('') + f.holes.map((p) => path(primPoly(p, 40))).join('');
    const bends = f.bends.map((b) => {
      const x1 = tx(b.a[0]), y1 = ty(b.a[1]), x2 = tx(b.b[0]), y2 = ty(b.b[1]);
      const vertical = Math.abs(x1 - x2) < 1e-6;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const label = `${b.up ? 'UP' : 'DOWN'} ${b.angle}° R${num(b.r)}`;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${b.up ? '#22d3ee' : '#f59e0b'}" stroke-width="1.2" stroke-dasharray="5 3"/>
        <text x="${vertical ? mx - 4 : mx}" y="${vertical ? my : my - 4}" fill="${b.up ? '#67e8f9' : '#fbbf24'}" font-size="9" font-weight="700" text-anchor="middle" font-family="system-ui,sans-serif"${vertical ? ` transform="rotate(-90 ${mx - 4} ${my})"` : ''}>${label}</text>`;
    }).join('');
    const sw = W * k, sh = H * k;
    $('dzFlat').innerHTML = `<svg viewBox="${-pad} ${-pad} ${sw + pad * 2} ${sh + pad * 2}">
      <path d="${outline}" fill="rgba(34,211,238,.18)" fill-rule="evenodd" stroke="#e8eefc" stroke-width="1.2" stroke-linejoin="round"/>
      ${bends}
      <path d="M0 -16H${sw}M0 -21v10M${sw} -21v10M-16 0V${sh}M-21 0h10M-21 ${sh}h10" stroke="#93a4c4" stroke-width="1" fill="none"/>
      <text x="${sw / 2}" y="-22" fill="#e8eefc" font-size="12" font-weight="700" text-anchor="middle" font-family="system-ui,sans-serif">${num(W)} ${uLabel()}</text>
      <text x="-22" y="${sh / 2}" fill="#e8eefc" font-size="12" font-weight="700" text-anchor="middle" font-family="system-ui,sans-serif" transform="rotate(-90 -22 ${sh / 2})">${num(H)} ${uLabel()}</text>
    </svg>`;
    const kg = (f.area / 1e6) * (this.d.t / 1000) * density(this.d.material) * 1000; // m² × m × kg/m³
    const lb = kg * 2.20462;
    $('dzFlatInfo').innerHTML = `
      <dt>Blank size</dt><dd>${num(W)} × ${num(H)} ${uLabel()}</dd>
      <dt>Net area</dt><dd>${area(f.area, getUnit() === 'mm' ? 4 : 3)}</dd>
      <dt>Bends</dt><dd>${f.bends.length}</dd>
      <dt>Cutouts</dt><dd>${f.holes.length}</dd>
      <dt>Weight (est.)</dt><dd>${getUnit() === 'in' ? `${lb.toFixed(2)} lb` : `${kg.toFixed(3)} kg`} <span class="muted">· ${density(this.d.material)} g/cm³</span></dd>`;
    void polyArea;
  }

  /* ---------------- files ---------------- */
  private fileBase() { return (this.d.name || 'part').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'part'; }

  private download(name: string, data: string, type: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  private exportDxf() {
    if (!this.res || !this.res.flat.loops.length) return;
    const inches = getUnit() === 'in';
    this.download(`${this.fileBase()}-flat.dxf`, flatToDxf(this.res.flat, { inches, name: this.d.name, thickness: this.d.t, material: this.d.material }), 'application/dxf');
    this.host.toast(`DXF exported in ${inches ? 'inches' : 'mm'}`, true);
  }

  private stepBusy = false;

  /** Folded part → STEP solid. Loads the modelling engine on first use. */
  private async exportStep() {
    if (!this.res || !this.res.flat.loops.length || this.stepBusy) return;
    const btn = $<HTMLButtonElement>('dzStep');
    const label = btn.innerHTML;
    const solids: SolidPiece[] = this.res.solids;
    const name = this.d.name, inches = getUnit() === 'in';
    this.stepBusy = true; btn.disabled = true;
    try {
      const { loadCad, buildStep } = await import('./step');
      const first = !this.stepReady;
      if (first) btn.innerHTML = '<span class="mini-spin"></span>Loading STEP engine…';
      const R = await loadCad();
      this.stepReady = true;
      btn.innerHTML = '<span class="mini-spin"></span>Building solid…';
      await new Promise((r) => setTimeout(r, 30)); // let the label paint
      const step = await buildStep(R, solids, name, inches);
      this.download(`${this.fileBase()}.stp`, step, 'model/step');
      this.host.toast(`STEP exported (${inches ? 'inches' : 'mm'}) — one solid body`, true);
    } catch (e) {
      this.host.toast(`STEP export failed: ${(e as Error).message || e}`);
    } finally {
      this.stepBusy = false; btn.disabled = false; btn.innerHTML = label;
    }
  }
  private stepReady = false;

  private save() {
    const doc = { format: 'pc3d', version: 2, app: 'PC 3D CAD', saved: new Date().toISOString(), units: 'mm', design: this.d };
    this.download(`${this.fileBase()}.${PC3D_EXT}`, JSON.stringify(doc, null, 2), 'application/x-pc3d+json');
    this.host.toast(`Saved ${this.fileBase()}.${PC3D_EXT}`, true);
  }

  /** Open a .pc3d design file (also used when one is dropped on the app). */
  async open(file: File) {
    try {
      const doc = JSON.parse(await file.text());
      if (!doc || doc.format !== 'pc3d' || typeof doc.design !== 'object') throw new Error('not a PC 3D CAD design');
      if (doc.version > 2) this.host.toast('This design was saved by a newer version — some settings may be ignored.');
      this.d = normalise(doc.design);
      this.nextCutId = Math.max(0, ...this.d.cutouts.map((c) => c.id)) + 1;
      $('dzTemplates').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      this.renderForm();
      this.rebuild(false);
      this.persist();
      this.host.toast(`Opened ${file.name}`, true);
    } catch (e) {
      this.host.toast(`Couldn't open ${file.name}: ${(e as Error).message}`);
    }
  }

  private cloneDesign(): Design { return JSON.parse(JSON.stringify(this.d)); }

  /* ---------------- remember the last design in this browser ---------------- */
  private persist() { try { localStorage.setItem(STORE, JSON.stringify(this.d)); } catch { /* ignore */ } }
  private restore(): Design | null {
    try { const v = localStorage.getItem(STORE); return v ? normalise(JSON.parse(v)) : null; } catch { return null; }
  }
}

/** Fill in anything missing from an older / hand-edited design, and drop junk. */
function normalise(x0: Partial<Design>): Design {
  const x = JSON.parse(JSON.stringify(x0 ?? {})) as Partial<Design>;
  upgradeV1(x as Record<string, unknown>); // designs saved before flange chains
  const d = newDesign();
  const n = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
  d.name = typeof x.name === 'string' ? x.name : d.name;
  d.material = typeof x.material === 'string' ? x.material : d.material;
  d.t = n(x.t, d.t); d.r = n(x.r, d.r); d.k = n(x.k, d.k); d.relief = n(x.relief, d.relief); d.L = n(x.L, d.L); d.W = n(x.W, d.W);
  for (const e of EDGES) {
    const c = (x.chains?.[e] ?? {}) as Partial<Design['chains'][Edge]>;
    const out = chain();
    out.inset0 = n(c.inset0, 0); out.inset1 = n(c.inset1, 0);
    for (const sg of Array.isArray(c.segs) ? c.segs : []) {
      if (!sg) continue;
      out.segs.push(seg(n(sg.height, 40), sg.dir === 'down' ? 'down' : 'up', n(sg.angle, 90)));
    }
    d.chains[e] = out;
  }
  d.cutouts = (Array.isArray(x.cutouts) ? x.cutouts : []).filter((c) => c && ['hole', 'slot', 'rect'].includes(c.type)).map((c, i) => ({
    id: n(c.id, i + 1),
    face: c.face === 'base' || parseFace(String(c.face)) ? String(c.face) : 'base', type: c.type,
    x: n(c.x, 0), y: n(c.y, 0), d: n(c.d, 10), w: n(c.w, 30), h: n(c.h, 20), vertical: !!c.vertical,
  }));
  return d;
}
