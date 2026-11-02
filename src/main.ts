import * as THREE from 'three';
import { Viewer, type Axis, type ViewName, type PickInfo, type MeasureInfo } from './viewer';
import { num, len, lenPrecise, uLabel, getUnit, setUnit, onUnit, convertProp, type Unit } from './units';
import { importFile, ACCEPT, metaSummary, type Quality, type FileHeader, type MetaProp } from './importers';
import { buildCatalog, analyseAll, analysePart, isSheet, type PartType } from './parts';
import { NestUI } from './nest-ui';
import { DesignUI, PC3D_EXT } from './design/ui';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const viewer = new Viewer($('vp'));
const fileIn = $<HTMLInputElement>('fileIn');
fileIn.accept = ACCEPT + ',.' + PC3D_EXT;

let currentFile: File | null = null;
let quality: Quality = 'normal';
let activeTool: string | null = null;
const rowOf = new Map<THREE.Object3D, HTMLElement>();
let catalog: PartType[] = [];
let cancelAnalysis: (() => void) | null = null;
const nest = new NestUI();
nest.onCountChange = (n) => { $('nestBadge').hidden = n === 0; $('nestBadge').textContent = String(n); };
const partOf = (m: THREE.Mesh) => catalog.find((p) => p.id === m.userData.partType);

/* ---------------- sheet metal designer ---------------- */
let designCount = 0;
const DESIGN_COLORS = ['#fb923c', '#e879f9', '#facc15', '#2dd4bf', '#818cf8'];
const design = new DesignUI({
  toast: (m, ok) => toast(m, ok),
  sendToNest: (d, flat, tri) => {
    const p: PartType = {
      id: `d${++designCount}`, name: d.name || 'Designed part', meshes: [], qty: 1,
      swatch: '#bcc7d6', color: DESIGN_COLORS[(designCount - 1) % DESIGN_COLORS.length],
      material: d.material, thickness: d.t, tSource: 'design',
      flat: { x: tri.x, y: tri.y }, flatSource: 'design',
      flatInfo: { x: tri.x, y: tri.y, area: flat.area, bends: flat.bends.length, thickness: d.t, outline: tri.tris, confidence: 'good' },
      analysed: true, nest: true, perSet: 1, lockRot: false,
    };
    nest.addDesignPart(p);
    setMode('nest');
    toast(`${p.name} added to Nesting (${num(tri.x)} × ${num(tri.y)} ${uLabel()})`, true);
  },
});

/* ---------------- mode switch ---------------- */
type Mode = 'view' | 'design' | 'nest';
let mode: Mode = 'view';
function setMode(m: Mode) {
  mode = m;
  $('modes').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  document.querySelector<HTMLElement>('.work')!.hidden = m !== 'view';
  $('designScreen').hidden = m !== 'design';
  $('nestScreen').hidden = m !== 'nest';
  viewer.setActive(m === 'view');   // only the visible 3D view renders
  design.setActive(m === 'design');
  if (m === 'nest') nest.refresh();
}
$('modes').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.onclick = () => setMode(b.dataset.mode as Mode));

/* ---------------- open ---------------- */
$('openBtn').onclick = $('openBtn2').onclick = () => fileIn.click();
fileIn.onchange = () => { if (fileIn.files?.[0]) openFile(fileIn.files[0]); fileIn.value = ''; };

let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); $('drop').classList.remove('hidden'); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); if (viewer.model) $('drop').classList.add('hidden'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f); else if (viewer.model) $('drop').classList.add('hidden');
});

/* ---------------- loading dialog ---------------- */
const STEPS = ['read', 'engine', 'parse', 'build', 'analyse'] as const;
type Step = typeof STEPS[number];
const STEP_WEIGHT: Record<Step, number> = { read: 5, engine: 10, parse: 45, build: 15, analyse: 25 };
const busy = {
  t0: 0, timer: 0, step: 'read' as Step, frac: 0, stepT0: 0, sizeMB: 0,
  open(file: File, isBrep: boolean) {
    this.t0 = performance.now();
    this.sizeMB = file.size / 1048576;
    $('loadTitle').textContent = file.name;
    $('loadSize').textContent = `· ${fmtSize(file.size)}`;
    $('loadMsg').textContent = 'Please wait — the model will be ready to use in a moment.';
    $('loadSkip').hidden = true;
    $('anaCount').textContent = '';
    document.querySelectorAll<HTMLElement>('#loadSteps li').forEach((li) => {
      li.className = '';
      if (li.dataset.step === 'engine' && !isBrep) li.classList.add('skip'); // mesh files don't need the CAD engine
    });
    $('loading').hidden = false;
    (document.activeElement as HTMLElement | null)?.blur();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      const s = (performance.now() - this.t0) / 1000;
      $('loadTime').textContent = `${s.toFixed(1)} s`;
      // big assemblies: after a few seconds of sheet metal checking, offer to carry on in the background
      if (this.step === 'analyse' && s > 4) $('loadSkip').hidden = false;
      // the CAD engine gives no progress while reading geometry: ease the bar forward
      // using a rough time estimate from the file size, so it never looks frozen
      if (this.step === 'parse') {
        const est = Math.max(2, this.sizeMB * 1.5);
        const t = (performance.now() - this.stepT0) / 1000;
        this.set('parse', Math.min(0.95, 1 - Math.exp(-t / est)));
        if (t > 6) $('loadMsg').textContent = 'Large or detailed model — reading the geometry can take a little while. Please wait.';
      }
    }, 100);
    this.set('read');
  },
  set(step: Step, frac = 0) {
    if (step !== this.step) this.stepT0 = performance.now();
    this.step = step; this.frac = frac;
    const idx = STEPS.indexOf(step);
    document.querySelectorAll<HTMLElement>('#loadSteps li').forEach((li) => {
      const i = STEPS.indexOf(li.dataset.step as Step);
      li.classList.toggle('done', i < idx);
      li.classList.toggle('active', i === idx);
    });
    if (step !== 'parse') $('loadMsg').textContent = step === 'analyse'
      ? 'Almost there — measuring thickness and flat blanks for each part.'
      : 'Please wait — the model will be ready to use in a moment.';
    let pct = 0;
    STEPS.forEach((s, i) => { if (i < idx) pct += STEP_WEIGHT[s]; });
    pct += STEP_WEIGHT[step] * frac;
    ($('loadBar') as HTMLElement).style.width = `${Math.min(100, pct)}%`;
  },
  close() { clearInterval(this.timer); $('loading').hidden = true; },
  isOpen() { return !$('loading').hidden; },
};
/** Let the browser paint the dialog before a heavy main-thread step. */
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

async function openFile(file: File) {
  if (busy.isOpen()) return;
  // a saved sheet metal design opens in the Design screen
  if (file.name.toLowerCase().endsWith('.' + PC3D_EXT)) {
    if (viewer.model) $('drop').classList.add('hidden');
    setMode('design');
    await design.open(file);
    return;
  }
  currentFile = file;
  $('toast').hidden = true;
  busy.open(file, /\.(stp|step|igs|iges|brep|brp)$/i.test(file.name));
  const t0 = performance.now();
  try {
    await nextFrame();
    const res = await importFile(file, quality, (_m, stage) => { if (stage) busy.set(stage); });
    busy.set('build');
    await nextFrame();
    setTool(null);
    // show the model in the units it was drawn in (STEP files declare it)
    const fu = res.header?.lengthUnit;
    if (fu && !res.header?.assumedUnit) {
      const want = fu === 'in' || fu === 'ft' ? 'in' : 'mm';
      if (want !== getUnit()) { setUnit(want); toast(`Drawn in ${UNIT_NAME[fu] ?? fu} — showing ${want === 'in' ? 'inches' : 'millimetres'}. Switch any time with the mm / inch toggle.`, true, 6000); }
    }
    viewer.setPickOnce(null);
    viewer.setModel(res.root);
    viewer.onReorient();
    $('drop').classList.add('hidden');
    buildTree(res.root);
    showFileInfo(file, res.format, res.engine, performance.now() - t0, res.header);
    showSelection(null);
    document.title = `${file.name} · PC 3D CAD`;
    // compile shaders and draw a frame so the model is on screen when the dialog closes
    try {
      const r = viewer.renderer;
      if (r.extensions.has('KHR_parallel_shader_compile')) await r.compileAsync(viewer.scene, viewer.camera);
      else r.compile(viewer.scene, viewer.camera);
    } catch { /* compile on first draw instead */ }
    await nextFrame();
    busy.set('analyse');
    const analysed = startCatalog((done, total) => {
      busy.set('analyse', total ? done / total : 1);
      $('anaCount').textContent = total > 1 ? `${done} / ${total}` : '';
    });
    // wait for the check, unless the user chooses to carry on
    await Promise.race([analysed, new Promise<void>((r) => ($('loadSkip').onclick = () => r()))]);
    busy.set('analyse', 1);
    await nextFrame();
  } catch (err) {
    toast((err as Error).message || String(err));
    if (!viewer.model) $('drop').classList.remove('hidden');
  } finally {
    busy.close();
  }
}

function toast(msg: string, ok = false, ms = ok ? 2500 : 7000) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast' + (ok ? ' ok' : ''); t.hidden = false;
  clearTimeout((t as any)._h);
  (t as any)._h = setTimeout(() => (t.hidden = true), ms);
}

/* ---------------- info panels ---------------- */
const fmtSize = (b: number) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
const fmtNum = (n: number) => Math.round(n).toLocaleString();
const short = num;
const dimHtml = (v: number) => `${num(v)} <small>${uLabel()}</small>`;
const swatch = (m: THREE.Mesh) => {
  const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
  return mat?.color ? '#' + mat.color.getHexString() : '#999';
};

const UNIT_NAME: Record<string, string> = { in: 'inches', ft: 'feet', mm: 'millimetres', cm: 'centimetres', m: 'metres' };
let lastFileInfo: Parameters<typeof showFileInfo> | null = null;
function showFileInfo(file: File, format: string, engine: string, ms: number, h?: FileHeader) {
  lastFileInfo = [file, format, engine, ms, h];
  const st = viewer.stats();
  const sys = h?.system && !/^(unknown|none)?$/i.test(h.system.trim()) ? h.system.trim() : '';
  const date = h?.date ? h.date.slice(0, 10) : '';
  $('fileInfo').innerHTML = `
    <dt>Name</dt><dd title="${esc(file.name)}">${esc(file.name)}</dd>
    <dt>Format</dt><dd>${format}${h?.schema ? ` <span class="muted">(${esc(h.schema.replace('AUTOMOTIVE_DESIGN', 'AP214').replace('CONFIG_CONTROL_DESIGN', 'AP203').replace(/AP242.*/, 'AP242'))})</span>` : ''}</dd>
    ${sys ? `<dt>Created in</dt><dd title="${esc(sys)}">${esc(sys)}</dd>` : ''}
    ${h?.lengthUnit ? `<dt>Drawn in</dt><dd>${UNIT_NAME[h.lengthUnit] ?? esc(h.lengthUnit)}${h.assumedUnit ? ' <span class="muted">(assumed)</span>' : ''}</dd>` : ''}
    ${date ? `<dt>Exported</dt><dd>${esc(date)}</dd>` : ''}
    <dt>Size</dt><dd>${fmtSize(file.size)}</dd>
    <dt>Opened in</dt><dd>${(ms / 1000).toFixed(2)} s</dd>
    <dt>Engine</dt><dd>${engine}</dd>`;
  const s = st.box.getSize(new THREE.Vector3());
  $('dims').innerHTML = `
    <div class="dim x"><span>X</span><b>${dimHtml(s.x)}</b></div>
    <div class="dim y"><span>Y</span><b>${dimHtml(s.y)}</b></div>
    <div class="dim z"><span>Z</span><b>${dimHtml(s.z)}</b></div>`;
  $('miniStats').innerHTML = `<span><b>${st.bodies}</b> bodies</span><span><b>${fmtNum(st.tris)}</b> triangles</span><span>grid <b>${num(viewer.gridStep())}</b> ${uLabel()}</span>`;
}

function pathOf(o: THREE.Object3D): string {
  const parts: string[] = [];
  for (let p = o.parent; p && p !== viewer.scene; p = p.parent) parts.unshift(p.name);
  return parts.join(' › ');
}

let lastPick: PickInfo | null = null;
function showSelection(p: PickInfo | null) {
  lastPick = p;
  rowOf.forEach((r) => r.classList.remove('sel'));
  $('parts').querySelectorAll('.prow').forEach((r) => r.classList.toggle('sel', !!p && (r as HTMLElement).dataset.id === p.mesh.userData.partType));
  if (!p) { $('selInfo').innerHTML = '<p class="muted small">Click a part in the 3D view or the tree.</p>'; return; }
  const m = p.mesh;
  const box = new THREE.Box3().setFromObject(m);
  const s = box.getSize(new THREE.Vector3());
  const faces = m.userData.brepFaces as number | undefined;
  const pt = p.point;
  $('selInfo').innerHTML = `
    <div class="sel-name"><span class="sw" style="background:${swatch(m)}"></span>${esc(m.name)}</div>
    <div class="sel-path">${esc(pathOf(m))}</div>
    <dl>
      <dt>Size</dt><dd>${short(s.x)} × ${short(s.y)} × ${short(s.z)} ${uLabel()}</dd>
      ${partOf(m) && partOf(m)!.qty > 1 ? `<dt>Qty in model</dt><dd>${partOf(m)!.qty}</dd>` : ''}
      ${metaSummary(m.userData.meta).material ? `<dt>Material</dt><dd><span class="mat">${esc(metaSummary(m.userData.meta).material!)}</span></dd>` : ''}
      ${faces ? `<dt>B-rep faces</dt><dd>${faces}</dd>` : ''}
      ${pt.lengthSq() ? `<dt>Picked point</dt><dd>${pt.x.toFixed(2)}, ${pt.y.toFixed(2)}, ${pt.z.toFixed(2)}</dd>` : ''}
    </dl>
    ${sheetBox(m, p)}
    ${propsBox(m.userData.meta)}
    <div class="sel-acts">
      <button class="sbtn" id="selIso">Isolate</button>
      <button class="sbtn" id="selHide">Hide</button>
      <button class="sbtn" id="selFit">Zoom to</button>
    </div>
    ${p.normal ? `<div class="sel-acts face-acts"><span class="muted small">Picked face:</span><button class="sbtn" id="faceNormal" title="Look straight at this face">Normal to</button><button class="sbtn" id="faceDown" title="Rotate the model so this face sits on the floor">Face down</button><button class="sbtn" id="faceUp" title="Rotate the model so this face points up">Face up</button></div>` : ''}
    ${partOf(m)?.flat ? `<div class="sel-acts"><button class="sbtn acc" id="selNest">Add to nesting →</button></div>` : ''}`;
  if (p.normal) {
    const n = p.normal.clone();
    $('faceNormal').onclick = () => viewer.normalTo(n);
    $('faceDown').onclick = () => viewer.faceDown(n);
    $('faceUp').onclick = () => viewer.faceUp(n);
  }
  const nb = document.getElementById('selNest');
  if (nb) nb.onclick = () => { const pt = partOf(m); if (pt) { nest.toggle(pt.id, true); setMode('nest'); } };
  $('selIso').onclick = () => { viewer.isolate(m); syncTreeVis(); viewer.fit(); };
  $('selHide').onclick = () => { m.visible = false; viewer.select(null); syncTreeVis(); };
  $('selFit').onclick = () => { viewer.isolate(m); viewer.fit(); setTimeout(() => { viewer.isolate(null); syncTreeVis(); }, 0); };
  const row = rowOf.get(m);
  if (row) {
    row.classList.add('sel');
    // expand ancestors and scroll into view
    for (let k = row.parentElement?.closest('.kids'); k; k = k.parentElement?.closest('.kids')) {
      k.classList.remove('closed');
      k.previousElementSibling?.querySelector('.car')?.classList.add('open');
    }
    row.scrollIntoView({ block: 'nearest' });
  }
}
viewer.onSelect = showSelection;

function sheetBox(m: THREE.Mesh, pick: PickInfo): string {
  const pt = partOf(m);
  if (!pt) return '';
  if (!pt.analysed) analysePart(pt, nest.kFactor());
  let at = '';
  if (pick.normal && pick.point.lengthSq()) {
    const th = viewer.thicknessAt(m, pick.point, pick.normal);
    if (th && th < viewer.stats().box.getSize(new THREE.Vector3()).length()) at = `<dt>Thickness at click</dt><dd>${len(th)}</dd>`;
  }
  if (!pt.thickness) return at ? `<dl style="margin-top:.4rem">${at}</dl>` : '';
  const src = (s: string | null) => s === 'file' ? '<span class="src file">from file</span>' : s === 'manual' ? '<span class="src">manual</span>' : '<span class="src">auto</span>';
  return `<div class="sm-box">
    <div class="sm-h">Sheet metal ${src(pt.tSource)}</div>
    <dl>
      <dt>Thickness</dt><dd>${len(pt.thickness)}</dd>
      ${pt.flat ? `<dt>Flat blank${pt.flatSource !== pt.tSource ? ` <span class="muted">(${pt.flatSource === 'file' ? 'file' : pt.flatSource === 'manual' ? 'manual' : 'unfold'})</span>` : ''}</dt><dd>${short(pt.flat.x)} × ${short(pt.flat.y)} ${uLabel()}</dd>` : ''}
      ${pt.flatInfo ? `<dt>Bends</dt><dd>${pt.flatInfo.bends}</dd>` : ''}
      ${at}
    </dl></div>`;
}

function propsBox(meta?: MetaProp[]): string {
  if (!meta || !meta.length) return '';
  return `<details class="props" open><summary>File properties (${meta.length})</summary><dl>${meta.map((p) => `<dt title="${esc(p.key)}">${esc(p.key)}</dt><dd title="${esc(p.value)}">${esc(convertProp(p.value, p.num, p.unit))}</dd>`).join('')}</dl></details>`;
}

/* ---------------- part catalogue (parts list tab + nesting) ---------------- */
function startCatalog(onProgress?: (done: number, total: number) => void): Promise<void> {
  cancelAnalysis?.();
  catalog = buildCatalog(viewer.allMeshes());
  nest.setParts(catalog);
  renderPartsList();
  let lastPaint = 0;
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  if (!catalog.length) finish();
  cancelAnalysis = analyseAll(catalog, nest.kFactor(), (done) => {
    onProgress?.(done, catalog.length);
    if (done === catalog.length) finish();
    const now = performance.now();
    if (done < catalog.length && now - lastPaint < 400) return;
    lastPaint = now;
    renderPartsList();
    nest.refresh();
    if (done === catalog.length) {
      const sel = viewer.selectedMesh();
      if (sel) showSelection({ mesh: sel, point: new THREE.Vector3(), normal: null });
      const n = catalog.filter(isSheet).length;
      if (n && $('toast').hidden) toast(`${n} sheet metal part${n > 1 ? 's' : ''} found — flat blanks ready in Nesting`, true);
    }
  });
  return finished;
}

function renderPartsList() {
  const box = $('parts');
  const total = catalog.reduce((a, p) => a + p.qty, 0);
  box.innerHTML = `<div class="parts-head"><span></span><span>Part</span><span></span><span>Qty</span></div>`;
  for (const p of [...catalog].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name))) {
    const row = document.createElement('div');
    row.className = 'prow';
    row.dataset.id = p.id;
    row.dataset.name = p.name.toLowerCase();
    const sub = [p.material ? esc(p.material) : '', p.flat ? `flat ${short(p.flat.x)}×${short(p.flat.y)}` : ''].filter(Boolean).join(' · ');
    row.innerHTML = `<span class="sw" style="background:${p.swatch}"></span><span class="nm">${esc(p.name)}${sub ? `<small>${sub}</small>` : ''}</span>${p.thickness ? `<span class="thk">t ${short(p.thickness)}</span>` : '<span></span>'}<span class="qty">×${p.qty}</span>`;
    row.onclick = () => viewer.select(p.meshes[0]);
    row.ondblclick = () => { viewer.isolate(p.meshes); syncTreeVis(); viewer.fit(); };
    box.appendChild(row);
  }
  if (!$('parts').hidden) $('treeCount').textContent = `${catalog.length} types`;
}

$('leftTabs').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.onclick = () => {
  $('leftTabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  const parts = b.dataset.tab === 'parts';
  $('tree').hidden = parts; $('parts').hidden = !parts;
  const total = catalog.reduce((a, p) => a + p.qty, 0);
  if (viewer.model) $('treeCount').textContent = parts ? `${catalog.length} types` : `${total} part${total === 1 ? '' : 's'}`;
});

let lastMeasure: MeasureInfo | null = null;
viewer.onMeasure = (m: MeasureInfo | null, pending: boolean) => {
  if (!pending) lastMeasure = m;
  if (pending) {
    $('measHint').textContent = m ? '' : (viewer as any).measurePts?.length === 1 ? 'Click the second point' : 'Click the first point';
    return;
  }
  if (!m) return;
  $('measHint').textContent = 'Click again to start a new one';
  const d = m.b.clone().sub(m.a);
  $('measCard').hidden = false;
  $('measInfo').innerHTML = `
    <div class="meas-big">${lenPrecise(m.dist)}</div>
    <dl><dt>ΔX</dt><dd>${lenPrecise(Math.abs(d.x))}</dd><dt>ΔY</dt><dd>${lenPrecise(Math.abs(d.y))}</dd><dt>ΔZ</dt><dd>${lenPrecise(Math.abs(d.z))}</dd></dl>`;
};

/* ---------------- tree ---------------- */
const ICON = {
  car: '<svg class="car" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  asm: '<svg class="ti" viewBox="0 0 24 24"><path d="M12 2 21 7v10l-9 5-9-5V7z"/><path d="M12 12 21 7M12 12 3 7M12 12v10"/></svg>',
  part: '<svg class="ti part" viewBox="0 0 24 24"><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.3"/></svg>',
};

function buildTree(root: THREE.Object3D) {
  rowOf.clear();
  const tree = $('tree');
  tree.innerHTML = '';
  let parts = 0;
  const make = (o: THREE.Object3D, depth: number): HTMLElement => {
    const kids = o.children.filter((c) => c.name !== '__edges' && ((c as THREE.Mesh).isMesh || c.type === 'Group' || c.type === 'Object3D'));
    const isMesh = (o as THREE.Mesh).isMesh;
    if (isMesh) parts++;
    const node = document.createElement('div');
    node.className = 'node';
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.name = o.name.toLowerCase();
    row.innerHTML = `${ICON.car}${isMesh ? `<span class="sw" style="background:${swatch(o as THREE.Mesh)}"></span>` : ICON.asm}<span class="nm">${esc(o.name || '(unnamed)')}</span><button class="eye" title="Show / hide">${ICON.eye}</button>`;
    const car = row.querySelector('.car')!;
    if (!kids.length) car.classList.add('none');
    node.appendChild(row);
    rowOf.set(o, row);
    let box: HTMLElement | null = null;
    if (kids.length) {
      box = document.createElement('div');
      box.className = 'kids' + (depth >= 1 ? ' closed' : '');
      if (depth < 1) car.classList.add('open');
      kids.forEach((k) => box!.appendChild(make(k, depth + 1)));
      node.appendChild(box);
    }
    car.addEventListener('click', (e) => { e.stopPropagation(); box?.classList.toggle('closed'); car.classList.toggle('open'); });
    row.querySelector('.eye')!.addEventListener('click', (e) => { e.stopPropagation(); o.visible = !o.visible; if (!o.visible && viewer.selectedMesh() && isAncestor(o, viewer.selectedMesh()!)) viewer.select(null); syncTreeVis(); });
    row.addEventListener('click', () => {
      if (isMesh) viewer.select(o as THREE.Mesh);
      else { box?.classList.toggle('closed'); car.classList.toggle('open'); }
    });
    row.addEventListener('dblclick', () => { viewer.isolate(o); syncTreeVis(); viewer.fit(); });
    return node;
  };
  tree.appendChild(make(root, 0));
  $('treeCount').textContent = `${parts} part${parts === 1 ? '' : 's'}`;
  $<HTMLInputElement>('treeSearch').disabled = false;
  $<HTMLButtonElement>('showAll').disabled = false;
}

function isAncestor(a: THREE.Object3D, b: THREE.Object3D) {
  for (let p: THREE.Object3D | null = b; p; p = p.parent) if (p === a) return true;
  return false;
}

function syncTreeVis() {
  rowOf.forEach((row, o) => {
    let shown = true;
    for (let p: THREE.Object3D | null = o; p && p !== viewer.scene; p = p.parent) if (!p.visible) { shown = false; break; }
    row.classList.toggle('hid', !shown);
    row.querySelector('.eye')!.innerHTML = o.visible ? ICON.eye : ICON.eyeOff;
  });
}

$('showAll').onclick = () => { viewer.isolate(null); syncTreeVis(); viewer.fit(); };

$<HTMLInputElement>('treeSearch').addEventListener('input', (e) => {
  const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
  rowOf.forEach((row, o) => {
    const nm = row.querySelector('.nm')!;
    const name = o.name || '(unnamed)';
    const i = q ? name.toLowerCase().indexOf(q) : -1;
    nm.innerHTML = i >= 0 ? esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length)) : esc(name);
  });
  $('parts').querySelectorAll<HTMLElement>('.prow').forEach((r) => (r.style.display = !q || r.dataset.name!.includes(q) ? '' : 'none'));
  // show nodes that match or contain matches
  const nodes = [...$('tree').querySelectorAll<HTMLElement>('.node')].reverse();
  for (const n of nodes) {
    const row = n.firstElementChild as HTMLElement;
    const self = !q || row.dataset.name!.includes(q);
    const kidHit = [...n.querySelectorAll(':scope > .kids > .node')].some((k) => (k as HTMLElement).style.display !== 'none');
    n.style.display = self || kidHit ? '' : 'none';
    if (q && kidHit) { n.querySelector(':scope > .kids')?.classList.remove('closed'); row.querySelector('.car')?.classList.add('open'); }
  }
});

/* ---------------- toolbar ---------------- */
const tb = $('toolbar');
tb.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.onclick = () => viewer.setView(b.dataset.view as ViewName));
tb.querySelector<HTMLButtonElement>('[data-act=fit]')!.onclick = () => viewer.fit();
tb.querySelector<HTMLButtonElement>('[data-act=shot]')!.onclick = () => {
  if (!viewer.model) return;
  const a = document.createElement('a');
  a.href = viewer.screenshot();
  a.download = (currentFile?.name.replace(/\.[^.]+$/, '') || 'model') + '.png';
  a.click();
};
tb.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) => b.onclick = () => {
  const on = !b.classList.contains('on');
  b.classList.toggle('on', on);
  const k = b.dataset.toggle;
  if (k === 'edges') viewer.setEdges(on);
  if (k === 'wire') viewer.setWireframe(on);
  if (k === 'xray') viewer.setXray(on);
});
tb.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.onclick = () => setTool(activeTool === b.dataset.tool ? null : b.dataset.tool!));

function setTool(t: string | null) {
  if (t && !viewer.model) return;
  if (t) viewer.setPickOnce(null);
  activeTool = t;
  tb.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('tool-on', b.dataset.tool === t));
  ['section', 'explode', 'measure'].forEach((k) => ($('pop-' + k).hidden = k !== t));
  applySection();
  viewer.setMeasuring(t === 'measure');
  if (t !== 'measure') $('measCard').hidden = true;
  $('measHint').textContent = 'Click the first point';
  if (t !== 'explode') { viewer.explode(0); $<HTMLInputElement>('expPos').value = '0'; $('expVal').textContent = '0%'; }
}

/* face tools: normal-to and re-orientation */
const FACE_TOOLS = {
  normal: { label: 'Normal to', hint: 'Click a face to look straight at it', run: (p: PickInfo) => viewer.normalTo(p.normal!) },
  down: { label: 'Face down', hint: 'Click the face that should sit on the floor', run: (p: PickInfo) => viewer.faceDown(p.normal!) },
} as const;
type FaceTool = keyof typeof FACE_TOOLS;
let pendingFace: FaceTool | null = null;

function faceTool(kind: FaceTool) {
  if (!viewer.model) return;
  if (pendingFace === kind) { viewer.setPickOnce(null); return; } // second press cancels
  // a face picked by clicking in the 3D view? use it straight away
  if (lastPick?.normal && viewer.selectedMesh()) { FACE_TOOLS[kind].run(lastPick); return; }
  setTool(null);
  pendingFace = kind;
  $('pickLbl').textContent = FACE_TOOLS[kind].label;
  $('pickHint').textContent = FACE_TOOLS[kind].hint;
  viewer.setPickOnce((p) => FACE_TOOLS[kind].run(p));
}
viewer.onPickModeChange = (on) => {
  $('pop-pick').hidden = !on;
  if (!on) pendingFace = null;
  tb.querySelectorAll<HTMLButtonElement>('[data-face]').forEach((b) => b.classList.toggle('tool-on', on && b.dataset.face === pendingFace));
};
viewer.onReorient = () => { tb.querySelector<HTMLButtonElement>('[data-act=resetori]')!.disabled = !viewer.isReoriented(); };
tb.querySelectorAll<HTMLButtonElement>('[data-face]').forEach((b) => b.onclick = () => faceTool(b.dataset.face as FaceTool));
tb.querySelector<HTMLButtonElement>('[data-act=flip]')!.onclick = () => viewer.model && viewer.flip();
tb.querySelector<HTMLButtonElement>('[data-act=resetori]')!.onclick = () => viewer.resetOrientation();
$('pickCancel').onclick = () => viewer.setPickOnce(null);

/* section */
let secAxis: Axis = 'z', secFlip = false;
function applySection() {
  const pos = +$<HTMLInputElement>('secPos').value / 1000;
  viewer.setSection(activeTool === 'section', secAxis, pos, secFlip);
  if (activeTool === 'section') $('secVal').textContent = `${secAxis.toUpperCase()} = ${lenPrecise(viewer.sectionValue())}`;
}
$('secAxis').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.onclick = () => {
  secAxis = b.dataset.axis as Axis;
  $('secAxis').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  applySection();
});
$('secFlip').onclick = () => { secFlip = !secFlip; $('secFlip').classList.toggle('on', secFlip); applySection(); };
$('secPos').addEventListener('input', applySection);

/* explode */
$('expPos').addEventListener('input', () => {
  const v = +$<HTMLInputElement>('expPos').value;
  $('expVal').textContent = v + '%';
  viewer.explode(v / 100);
});

/* quality */
$('quality').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.onclick = () => {
  quality = b.dataset.q as Quality;
  $('quality').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  if (currentFile && /\.(stp|step|igs|iges|brep|brp)$/i.test(currentFile.name)) openFile(currentFile);
});

/* units */
function paintUnits() {
  $('units').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.u === getUnit()));
}
$('units').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.onclick = () => setUnit(b.dataset.u as Unit));
onUnit(() => {
  paintUnits();
  viewer.rebuildGrid();
  if (lastFileInfo) showFileInfo(...lastFileInfo);
  if (viewer.selectedMesh() && lastPick) showSelection(lastPick);
  if (lastMeasure && !$('measCard').hidden) viewer.onMeasure(lastMeasure, false);
  viewer.refreshLabels();
  if (activeTool === 'section') applySection();
  if (catalog.length) renderPartsList();
});
paintUnits();

/* shortcuts help */
function setHelp(open: boolean) {
  $('help').hidden = !open;
  if (open) $('helpClose').focus();
}
$('helpBtn').onclick = () => setHelp(true);
$('helpClose').onclick = () => setHelp(false);
$('help').addEventListener('click', (e) => { if (e.target === $('help')) setHelp(false); });

/* keyboard */
addEventListener('keydown', (e) => {
  const tgt = e.target as HTMLInputElement;
  if ((tgt.tagName === 'INPUT' && tgt.type !== 'range') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (busy.isOpen()) { e.preventDefault(); return; } // nothing until the model is ready
  // help overlay: ? opens/closes, Esc closes; nothing else fires while it's open
  if (k === '?') { setHelp($('help').hidden !== false); return; }
  if (!$('help').hidden) { if (k === 'escape') setHelp(false); return; }
  if (mode !== 'view' && k !== 'n' && k !== 'o' && k !== 'u') return; // 3D shortcuts only in 3D view
  const views: Record<string, ViewName> = { '0': 'iso', '1': 'front', '3': 'right', '7': 'top', '9': 'bottom' };
  if (views[k]) return viewer.setView(views[k]);
  const click = (sel: string) => tb.querySelector<HTMLButtonElement>(sel)?.click();
  if (k === 'f') click('[data-act=fit]');
  if (k === 'e') click('[data-toggle=edges]');
  if (k === 'w') click('[data-toggle=wire]');
  if (k === 'x') click('[data-toggle=xray]');
  if (k === 's') click('[data-tool=section]');
  if (k === 'v') click('[data-tool=explode]');
  if (k === 'm') click('[data-tool=measure]');
  if (k === 'escape') { viewer.setPickOnce(null); setTool(null); viewer.select(null); }
  if (k === '8') faceTool('normal');
  if (k === 'd') faceTool('down');
  if (k === 'o') fileIn.click();
  if (k === 'n') setMode(mode === 'nest' ? 'view' : 'nest');
  if (k === 'u') setUnit(getUnit() === 'mm' ? 'in' : 'mm');
});

// expose for automated checks / debugging
(window as any).pccad = { viewer, openFile, design };
