/** Nesting screen: blank list, settings, results and sheet drawings. */
import { fillSheet, nestQuantity, type NestPart, type NestResult, type NestSettings } from './nesting';
import { analysePart, isSheet, type PartType } from './parts';
import { num, uLabel, toDisp, fromDisp, area, inputStep, onUnit, getUnit, type Unit } from './units';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const r1 = num; // lengths in the current display unit
const LEN_INPUTS = ['sheetW', 'sheetH', 'margin', 'gap'];
const roundIn = (v: number, u: Unit) => (u === 'mm' ? Math.round(v * 10) / 10 : Math.round(v * 1000) / 1000);
const LOCK = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const UNLOCK = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>';
const STORE = 'pccad.nest.v1';
/** Opaque tint of a colour over the sheet background — overlapping triangles then show no seams. */
function tint(hex: string, k = 0.55) {
  const c = (h: string) => parseInt(h, 16);
  const [r, g, b] = [c(hex.slice(1, 3)), c(hex.slice(3, 5)), c(hex.slice(5, 7))];
  const bg = [15, 26, 46];
  return `rgb(${Math.round(r * k + bg[0] * (1 - k))},${Math.round(g * k + bg[1] * (1 - k))},${Math.round(b * k + bg[2] * (1 - k))})`;
}

export class NestUI {
  private parts: PartType[] = [];
  private mode: 'fill' | 'qty' = 'fill';
  private previewId: string | null = null;
  private last: NestResult | null = null;
  private timer = 0;
  onCountChange: (n: number) => void = () => {};

  constructor() {
    // defaults are set here in mm (never trust the raw HTML values — they'd be read in the display unit)
    const imperial = getUnit() === 'in';
    $<HTMLSelectElement>('sheetPreset').value = imperial ? '3048x1524' : '3000x1500';
    this.setLen('sheetW', imperial ? 3048 : 3000);
    this.setLen('sheetH', imperial ? 1524 : 1500);
    this.setLen('margin', imperial ? 9.525 : 10);
    this.setLen('gap', imperial ? 6.35 : 5);
    this.loadSettings();
    $('sheetPreset').addEventListener('change', () => {
      const v = $<HTMLSelectElement>('sheetPreset').value;
      if (v !== 'custom') { const [w, h] = v.split('x').map(Number); this.setLen('sheetW', w); this.setLen('sheetH', h); }
      this.schedule();
    });
    for (const id of ['sheetW', 'sheetH', 'margin', 'gap', 'sets']) $(id).addEventListener('input', () => {
      if (id === 'sheetW' || id === 'sheetH') $<HTMLSelectElement>('sheetPreset').value = this.presetFor();
      this.schedule();
    });
    $('allowRot').addEventListener('change', () => this.schedule());
    $('kfac').addEventListener('change', () => this.reUnfold());
    $('nestMode').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.onclick = () => {
      this.mode = b.dataset.m as 'fill' | 'qty';
      $('nestMode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      $('setsFld').hidden = this.mode !== 'qty';
      $('modeHint').textContent = this.mode === 'fill'
        ? 'How many of the selected parts fit on one sheet (keeps the assembly ratio when several parts are selected).'
        : 'How many sheets a production run needs. One set = the quantities in the Qty column.';
      this.schedule();
    });
    $('nestSheetOnly').onclick = () => { this.parts.forEach((p) => (p.nest = isSheet(p))); this.renderTable(); this.schedule(); };
    $('nestNone').onclick = () => { this.parts.forEach((p) => (p.nest = false)); this.renderTable(); this.schedule(); };
    $('nestPng').onclick = () => this.savePng();
    onUnit((prev) => {
      // convert what's typed in the length boxes, then repaint everything
      for (const id of LEN_INPUTS) { const mm = fromDisp(+$<HTMLInputElement>(id).value || 0, prev); this.setLen(id, mm); }
      // swap untouched defaults for the shop-friendly equivalent (10/5 mm ⇄ 3/8" / 1/4")
      const pairs: [string, number, number][] = [['margin', 10, 9.525], ['gap', 5, 6.35]];
      for (const [id, metric, imperial] of pairs) {
        const mm = this.getLen(id, 0), from = getUnit() === 'in' ? metric : imperial, to = getUnit() === 'in' ? imperial : metric;
        if (Math.abs(mm - from) < 0.06) this.setLen(id, to);
      }
      this.paintUnitLabels();
      this.refresh();
    });
    this.paintUnitLabels();
  }

  /** Write a mm value into a length input, in the display unit. */
  private setLen(id: string, mm: number) { $<HTMLInputElement>(id).value = String(roundIn(toDisp(mm), getUnit())); }
  private getLen(id: string, dflt: number) { const v = +$<HTMLInputElement>(id).value; return Number.isFinite(v) && v >= 0 ? fromDisp(v) : dflt; }

  private paintUnitLabels() {
    document.querySelectorAll('.nest-settings .u').forEach((el) => (el.textContent = uLabel()));
    for (const id of LEN_INPUTS) $<HTMLInputElement>(id).step = inputStep(id === 'margin' || id === 'gap');
  }

  kFactor() { return Math.min(1, Math.max(0, +$<HTMLInputElement>('kfac').value || 0.44)); }

  setParts(parts: PartType[]) {
    this.parts = parts;
    this.previewId = null;
    this.renderTable();
    this.schedule();
  }

  /** Called as background analysis finishes parts. */
  refresh() { this.renderTable(); this.schedule(); }

  toggle(id: string, on = true) {
    const p = this.parts.find((x) => x.id === id);
    if (!p) return;
    if (!p.analysed) analysePart(p, this.kFactor());
    p.nest = on;
    this.previewId = id;
    this.renderTable();
    this.schedule();
  }

  /* ---------------- table ---------------- */
  renderTable() {
    const box = $('nestTable');
    if (!this.parts.length) { box.innerHTML = '<p class="empty-note">Open a model in 3D view first.</p>'; this.updateCount(); return; }
    // sheet metal first, then by name
    const list = [...this.parts].sort((a, b) => Number(isSheet(b)) - Number(isSheet(a)) || a.name.localeCompare(b.name));
    box.innerHTML = '<div class="nhead"><span></span><span></span><span>Part</span><span>Flat blank</span><span>Qty/set</span><span></span></div>';
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'nrow' + (p.nest ? ' on' : '') + (!p.analysed ? ' dim' : '');
      const srcLbl = p.flatSource === 'file' ? 'from file' : p.flatSource === 'manual' ? 'manual' : p.flatInfo?.confidence === 'rough' ? 'rough unfold' : 'unfolded';
      const size = p.flat
        ? `<button class="szb" title="Click to edit">${r1(p.flat.x)} × ${r1(p.flat.y)}</button><small>${srcLbl}${p.flatInfo?.bends ? ` · ${p.flatInfo.bends} bend${p.flatInfo.bends > 1 ? 's' : ''}` : ''}</small>`
        : `<button class="szb" title="Enter blank size">${p.analysed ? 'enter size' : '…'}</button><small>${p.analysed ? 'not sheet metal?' : 'analysing'}</small>`;
      row.innerHTML = `
        <input type="checkbox" ${p.nest ? 'checked' : ''} ${p.flat ? '' : 'disabled'} title="Include in nest">
        <span class="sw" style="background:${p.nest ? p.color : p.swatch}"></span>
        <span class="nm"><b title="${esc(p.name)}">${esc(p.name)}</b><small>${p.thickness ? `<span class="thk">t ${r1(p.thickness)} ${uLabel()}</span>` : ''}${p.material ? `<span class="mat" title="${esc(p.material)}">${esc(p.material)}</span>` : ''}<span>×${p.qty} in model</span></small></span>
        <span class="sz">${size}</span>
        <input class="qin" type="number" min="1" value="${p.perSet}" title="Quantity per set">
        <button class="lock ${p.lockRot ? 'on' : ''}" title="${p.lockRot ? 'Rotation locked (grain direction)' : 'Allow rotation'}">${p.lockRot ? LOCK : UNLOCK}</button>`;
      const cb = row.querySelector<HTMLInputElement>('input[type=checkbox]')!;
      cb.onclick = (e) => { e.stopPropagation(); p.nest = cb.checked; this.previewId = p.id; this.renderTable(); this.schedule(); };
      row.querySelector<HTMLInputElement>('.qin')!.onclick = (e) => e.stopPropagation();
      row.querySelector<HTMLInputElement>('.qin')!.oninput = (e) => { p.perSet = Math.max(1, Math.round(+(e.target as HTMLInputElement).value || 1)); this.schedule(); };
      row.querySelector<HTMLButtonElement>('.lock')!.onclick = (e) => { e.stopPropagation(); p.lockRot = !p.lockRot; this.renderTable(); this.schedule(); };
      row.querySelector<HTMLButtonElement>('.szb')!.onclick = (e) => { e.stopPropagation(); this.editSize(p, row); };
      row.onclick = () => { this.previewId = p.id; this.renderPreview(); box.querySelectorAll('.nrow').forEach((r) => r.classList.toggle('pv', r === row)); };
      box.appendChild(row);
    }
    this.updateCount();
    this.renderPreview();
  }

  private editSize(p: PartType, row: HTMLElement) {
    const sz = row.querySelector('.sz')!;
    const st = inputStep(true);
    sz.innerHTML = `<input type="number" step="${st}" value="${p.flat ? r1(p.flat.x) : ''}" placeholder="X"> × <input type="number" step="${st}" value="${p.flat ? r1(p.flat.y) : ''}" placeholder="Y">`;
    const [ix, iy] = [...sz.querySelectorAll('input')];
    sz.addEventListener('click', (e) => e.stopPropagation());
    ix.focus(); ix.select();
    const commit = () => {
      const x = fromDisp(+ix.value), y = fromDisp(+iy.value);
      if (x > 0 && y > 0) { p.flat = { x: Math.max(x, y), y: Math.min(x, y) }; p.flatSource = 'manual'; p.nest = true; }
      this.renderTable(); this.schedule();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') this.renderTable(); };
    ix.addEventListener('keydown', onKey); iy.addEventListener('keydown', onKey);
    iy.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ix) commit(); }, 0));
    ix.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== iy) commit(); }, 0));
  }

  private updateCount() {
    const n = this.parts.filter((p) => p.nest && p.flat).length;
    $('nestCount').textContent = `${n} selected`;
    this.onCountChange(n);
  }

  private reUnfold() {
    const k = this.kFactor();
    for (const p of this.parts) if (p.analysed && p.flatSource !== 'manual') analysePart(p, k);
    this.refresh();
  }

  /* ---------------- flat preview ---------------- */
  private renderPreview() {
    const p = this.parts.find((x) => x.id === this.previewId);
    const card = $('flatCard');
    if (!p || !p.flat) { card.hidden = true; return; }
    card.hidden = false;
    const k = 300 / Math.max(p.flat.x, p.flat.y); // draw in ~300-unit space so text renders crisply
    const W = p.flat.x * k, H = p.flat.y * k, pad = 34;
    const shape = p.flatInfo && p.flatSource !== 'manual' ? outlinePath(p.flatInfo.outline, p.flatInfo.x, p.flatInfo.y, W, H) : '';
    const fill = tint(p.color);
    $('flatPrev').innerHTML = `
      <svg viewBox="${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}">
        <rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#93a4c4" stroke-dasharray="4 3" stroke-width="1"/>
        ${shape ? `<path d="${shape}" fill="${fill}" stroke="${fill}" stroke-width=".8" stroke-linejoin="round"/>` : `<rect width="${W}" height="${H}" fill="${fill}"/>`}
        <path d="M0 ${-14}H${W}M0 ${-18}v8M${W} ${-18}v8M${-14} 0V${H}M${-18} 0h8M${-18} ${H}h8" stroke="#93a4c4" stroke-width="1" fill="none"/>
        <text x="${W / 2}" y="-20" fill="#e8eefc" font-size="13" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700">${r1(p.flat.x)} ${uLabel()}</text>
        <text x="-20" y="${H / 2}" fill="#e8eefc" font-size="13" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700" transform="rotate(-90 -20 ${H / 2})">${r1(p.flat.y)} ${uLabel()}</text>
      </svg>
      <dl>
        <dt>Part</dt><dd>${esc(p.name)}</dd>
        ${p.thickness ? `<dt>Thickness</dt><dd>${r1(p.thickness)} ${uLabel()} <span class="src ${p.tSource === 'file' ? 'file' : ''}">${p.tSource === 'file' ? 'from file' : 'measured'}</span></dd>` : ''}
        ${p.material ? `<dt>Material</dt><dd>${esc(p.material)}</dd>` : ''}
        ${p.flatInfo ? `<dt>Bends</dt><dd>${p.flatInfo.bends}</dd><dt>Unfolded area</dt><dd>${area(p.flatInfo.area, 4)}</dd>` : ''}
        ${p.flatInfo?.note ? `<dt>Note</dt><dd title="${esc(p.flatInfo.note)}">${esc(p.flatInfo.note)}</dd>` : ''}
      </dl>`;
  }

  /* ---------------- nesting ---------------- */
  private settings(): NestSettings {
    const w = this.getLen('sheetW', 3000), h = this.getLen('sheetH', 1500);
    return { sheetW: Math.max(w, h), sheetH: Math.min(w, h), margin: this.getLen('margin', 10), gap: this.getLen('gap', 5), rotate: $<HTMLInputElement>('allowRot').checked };
  }

  private presetFor() {
    const w = this.getLen('sheetW', 0), h = this.getLen('sheetH', 0);
    const hit = [...$<HTMLSelectElement>('sheetPreset').options].find((o) => {
      const [pw, ph] = o.value.split('x').map(Number);
      return Math.abs(pw - w) < 0.6 && Math.abs(ph - h) < 0.6;
    });
    return hit ? hit.value : 'custom';
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.run(), 60);
    this.saveSettings();
  }

  private run() {
    const sel = this.parts.filter((p) => p.nest && p.flat);
    const s = this.settings();
    const np: NestPart[] = sel.map((p) => ({ id: p.id, name: p.name, w: p.flat!.x, h: p.flat!.y, perSet: Math.max(1, p.perSet), color: p.color, lockRot: p.lockRot }));
    if (!np.length) { this.last = null; this.renderResults(null, s, []); return; }
    // single part in fill mode: maximise count, ignore the per-set quantity
    const res = this.mode === 'fill'
      ? fillSheet(np.length === 1 ? [{ ...np[0], perSet: 1 }] : np, s)
      : nestQuantity(np, Math.max(1, Math.round(+$<HTMLInputElement>('sets').value || 1)), s);
    this.last = res;
    this.renderResults(res, s, np);
  }

  private renderResults(res: NestResult | null, s: NestSettings, np: NestPart[]) {
    const sheetsBox = $('sheets');
    $<HTMLButtonElement>('nestPng').disabled = !res || !res.sheets.length;
    if (!res) {
      ['kpiMain', 'kpiSheets', 'kpiUtil', 'kpiArea'].forEach((id) => ($(id).textContent = '—'));
      ['kpiMainSub', 'kpiSheetsSub', 'kpiAreaSub'].forEach((id) => ($(id).textContent = '')); ($('kpiUtilBar') as HTMLElement).style.width = '0';
      sheetsBox.innerHTML = `<div class="sheets-empty"><div class="drop-ico small"><img src="logo-cad.svg" width="56" height="56" alt=""></div><p>Select one or more flat blanks on the left to see how they nest.</p></div>`;
      return;
    }
    const total = Object.values(res.counts).reduce((a, b) => a + b, 0);
    const label = $('kpiMain').previousElementSibling as HTMLElement;
    if (this.mode === 'fill') {
      if (np.length === 1) { label.textContent = 'Parts per sheet'; $('kpiMain').textContent = String(total); $('kpiMainSub').textContent = np[0].name; }
      else { label.textContent = 'Sets per sheet'; $('kpiMain').textContent = String(res.sets); $('kpiMainSub').textContent = `${total} blanks`; }
    } else {
      label.textContent = 'Sheets needed'; $('kpiMain').textContent = String(res.sheets.length); $('kpiMainSub').textContent = `${total} blanks · ${res.sets} sets`;
    }
    $('kpiSheets').textContent = String(res.sheets.length);
    $('kpiSheetsSub').textContent = `${r1(s.sheetW)} × ${r1(s.sheetH)} ${uLabel()}`;
    $('kpiUtil').textContent = `${(res.utilisation * 100).toFixed(1)}%`;
    ($('kpiUtilBar') as HTMLElement).style.width = `${Math.min(100, res.utilisation * 100)}%`;
    const setArea = np.reduce((a, p) => a + p.w * p.h * p.perSet, 0);
    const one = np.length === 1 && this.mode === 'fill';
    $('kpiArea').textContent = one ? area(np[0].w * np[0].h, getUnit() === 'mm' ? 4 : 3) : area(setArea, 3);
    $('kpiAreaSub').textContent = one ? 'per blank' : 'per set';
    if (res.unplaceable.length) $('kpiMainSub').textContent = `Too big for sheet: ${res.unplaceable.join(', ')}`;

    const max = 6;
    sheetsBox.innerHTML = '';
    res.sheets.slice(0, max).forEach((sh, i) => {
      const div = document.createElement('div');
      div.className = 'sheet';
      const cnt: Record<string, number> = {};
      sh.placed.forEach((p) => (cnt[p.id] = (cnt[p.id] ?? 0) + 1));
      div.innerHTML = `<div class="sheet-h"><span><b>Sheet ${i + 1}</b>${res.sheets.length > 1 ? ` of ${res.sheets.length}` : ''} · ${r1(s.sheetW)} × ${r1(s.sheetH)} ${uLabel()}</span><span>${sh.placed.length} blanks · ${(sh.used / (s.sheetW * s.sheetH) * 100).toFixed(1)}% used</span></div>
        ${this.sheetSvg(sh.placed, s)}
        <div class="legend">${np.filter((p) => cnt[p.id]).map((p) => `<span><i style="background:${p.color}"></i><b>${cnt[p.id]}×</b> ${esc(p.name)} <span class="muted">(${r1(p.w)}×${r1(p.h)})</span></span>`).join('')}</div>`;
      sheetsBox.appendChild(div);
    });
    if (res.sheets.length > max) {
      const more = document.createElement('p');
      more.className = 'muted small';
      more.textContent = `+ ${res.sheets.length - max} more sheet(s) not drawn.`;
      sheetsBox.appendChild(more);
    }
  }

  private sheetSvg(placed: { id: string; x: number; y: number; w: number; h: number; rot: boolean }[], s: NestSettings) {
    const W = s.sheetW, H = s.sheetH;
    const stroke = W / 900;
    const defs = this.parts.filter((p) => p.nest && p.flat).map((p) => {
      const path = p.flatInfo && p.flatSource !== 'manual' ? outlinePath(p.flatInfo.outline, p.flatInfo.x, p.flatInfo.y, p.flat!.x, p.flat!.y) : '';
      const fill = tint(p.color);
      return `<symbol id="sym-${p.id}" overflow="visible">${path ? `<path d="${path}" fill="${fill}" stroke="${fill}" stroke-width="${stroke * 0.8}" stroke-linejoin="round"/>` : `<rect width="${p.flat!.x}" height="${p.flat!.y}" fill="${fill}"/>`}</symbol>`;
    }).join('');
    const items = placed.map((p) => {
      const part = this.parts.find((x) => x.id === p.id)!;
      const t = p.rot ? `translate(${p.x + p.w} ${p.y}) rotate(90)` : `translate(${p.x} ${p.y})`;
      return `<g><use href="#sym-${p.id}" transform="${t}"/><rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="none" stroke="${part.color}" stroke-width="${stroke}"/></g>`;
    }).join('');
    const grid = Math.max(100, Math.round(W / 15 / 100) * 100);
    return `<svg viewBox="${-W * 0.01} ${-W * 0.01} ${W * 1.02} ${H + W * 0.02}" xmlns="http://www.w3.org/2000/svg">
      <defs>${defs}<pattern id="g${grid}" width="${grid}" height="${grid}" patternUnits="userSpaceOnUse"><path d="M ${grid} 0 L 0 0 0 ${grid}" fill="none" stroke="#22d3ee" stroke-opacity=".08" stroke-width="${stroke}"/></pattern></defs>
      <rect x="0" y="0" width="${W}" height="${H}" fill="#0f1a2e" stroke="#3b4f78" stroke-width="${stroke * 2}" rx="${stroke * 3}"/>
      <rect x="0" y="0" width="${W}" height="${H}" fill="url(#g${grid})"/>
      <rect x="${s.margin}" y="${s.margin}" width="${W - 2 * s.margin}" height="${H - 2 * s.margin}" fill="none" stroke="#93a4c4" stroke-opacity=".35" stroke-dasharray="${stroke * 6} ${stroke * 4}" stroke-width="${stroke}"/>
      ${items}
    </svg>`;
  }

  /* ---------------- export ---------------- */
  private async savePng() {
    const res = this.last;
    if (!res || !res.sheets.length) return;
    const svgs = [...document.querySelectorAll<SVGSVGElement>('#sheets .sheet svg')];
    const s = this.settings();
    const scale = 1600 / s.sheetW;
    const hSheet = Math.round(s.sheetH * 1.02 * scale + 0.02 * s.sheetW * scale);
    const head = 110, gapY = 40;
    const c = document.createElement('canvas');
    c.width = 1600 + 80;
    c.height = head + svgs.length * (hSheet + gapY + 30) + 40;
    const g = c.getContext('2d')!;
    g.fillStyle = '#0b1220'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#e8eefc'; g.font = 'bold 30px system-ui, sans-serif';
    g.fillText(`Nesting — ${$('kpiMain').previousElementSibling!.textContent}: ${$('kpiMain').textContent}`, 40, 52);
    g.fillStyle = '#93a4c4'; g.font = '18px system-ui, sans-serif';
    const sel = this.parts.filter((p) => p.nest && p.flat).map((p) => `${p.name} ${r1(p.flat!.x)}×${r1(p.flat!.y)}${p.thickness ? ` t${r1(p.thickness)}` : ''}`).join(' · ');
    g.fillText(`Sheet ${r1(s.sheetW)}×${r1(s.sheetH)} ${uLabel()} · margin ${r1(s.margin)} · gap ${r1(s.gap)} · ${(res.utilisation * 100).toFixed(1)}% used · ${sel}`.slice(0, 180), 40, 86);
    let y = head;
    for (let i = 0; i < svgs.length; i++) {
      const xml = new XMLSerializer().serializeToString(svgs[i]);
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      await img.decode();
      g.fillStyle = '#93a4c4'; g.font = '16px system-ui, sans-serif';
      g.fillText(`Sheet ${i + 1}`, 40, y + 18);
      g.drawImage(img, 40, y + 28, 1600, hSheet);
      y += hSheet + gapY + 30;
    }
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = 'nesting-layout.png';
    a.click();
  }

  /* ---------------- settings persistence (per browser, best effort) ---------------- */
  private saveSettings() {
    try {
      const mm = (id: string) => String(this.getLen(id, 0));
      localStorage.setItem(STORE, JSON.stringify({ preset: $<HTMLSelectElement>('sheetPreset').value, w: mm('sheetW'), h: mm('sheetH'), m: mm('margin'), g: mm('gap'), k: $<HTMLInputElement>('kfac').value, rot: $<HTMLInputElement>('allowRot').checked }));
    } catch { /* storage unavailable */ }
  }
  private loadSettings() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (!d) return;
      if (d.preset) $<HTMLSelectElement>('sheetPreset').value = d.preset;
      const setMm = (id: string, val: string) => { if (val != null && val !== '') this.setLen(id, +val); };
      setMm('sheetW', d.w); setMm('sheetH', d.h); setMm('margin', d.m); setMm('gap', d.g);
      if (d.k) $<HTMLInputElement>('kfac').value = d.k;
      $<HTMLInputElement>('allowRot').checked = d.rot !== false;
    } catch { /* ignore */ }
  }
}

/** Unfolded triangles → one SVG path, scaled from the unfold's rectangle to the blank size (handles file/manual size differences). */
function outlinePath(tris: [number, number][][], fx: number, fy: number, W: number, H: number): string {
  const sx = fx ? W / fx : 1, sy = fy ? H / fy : 1;
  let d = '';
  for (const t of tris) d += `M${(t[0][0] * sx).toFixed(2)} ${(t[0][1] * sy).toFixed(2)}L${(t[1][0] * sx).toFixed(2)} ${(t[1][1] * sy).toFixed(2)}L${(t[2][0] * sx).toFixed(2)} ${(t[2][1] * sy).toFixed(2)}Z`;
  return d;
}
