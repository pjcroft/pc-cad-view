/**
 * Rectangular blank nesting (MaxRects, best-short-side-fit) for quick "how many fit" answers.
 * Parts are treated as their flat-blank rectangles, so results are conservative — a true-shape
 * nest from CAM software can usually fit a few more of irregular parts.
 */

export interface NestPart { id: string; name: string; w: number; h: number; perSet: number; color: string; lockRot?: boolean }
export interface Placed { id: string; x: number; y: number; w: number; h: number; rot: boolean }
export interface SheetLayout { placed: Placed[]; used: number }
export interface NestSettings { sheetW: number; sheetH: number; margin: number; gap: number; rotate: boolean }
export interface NestResult {
  sheets: SheetLayout[];
  counts: Record<string, number>;
  sets: number;            // complete sets placed
  utilisation: number;     // blank area / sheet area, over all sheets
  unplaceable: string[];   // parts bigger than the usable sheet
}

interface FreeRect { x: number; y: number; w: number; h: number }

class MaxRects {
  free: FreeRect[];
  placed: Placed[] = [];
  constructor(W: number, H: number) { this.free = [{ x: 0, y: 0, w: W, h: H }]; }

  insert(id: string, w: number, h: number, allowRot: boolean): Placed | null {
    let best: { r: FreeRect; rot: boolean; s1: number; s2: number } | null = null;
    for (const r of this.free) {
      for (const rot of allowRot && w !== h ? [false, true] : [false]) {
        const pw = rot ? h : w, ph = rot ? w : h;
        if (pw > r.w + 1e-9 || ph > r.h + 1e-9) continue;
        const s1 = Math.min(r.w - pw, r.h - ph), s2 = Math.max(r.w - pw, r.h - ph);
        // prefer bottom-left-ish placement on ties so layouts look tidy
        if (!best || s1 < best.s1 - 1e-9 || (Math.abs(s1 - best.s1) < 1e-9 && (s2 < best.s2 - 1e-9 || (Math.abs(s2 - best.s2) < 1e-9 && r.y + r.x * 1e-3 < best.r.y + best.r.x * 1e-3)))) {
          best = { r, rot, s1, s2 };
        }
      }
    }
    if (!best) return null;
    const p: Placed = { id, x: best.r.x, y: best.r.y, w: best.rot ? h : w, h: best.rot ? w : h, rot: best.rot };
    this.split(p);
    this.placed.push(p);
    return p;
  }

  private split(p: FreeRect) {
    const out: FreeRect[] = [];
    for (const r of this.free) {
      if (p.x >= r.x + r.w || p.x + p.w <= r.x || p.y >= r.y + r.h || p.y + p.h <= r.y) { out.push(r); continue; }
      if (p.x > r.x) out.push({ x: r.x, y: r.y, w: p.x - r.x, h: r.h });
      if (p.x + p.w < r.x + r.w) out.push({ x: p.x + p.w, y: r.y, w: r.x + r.w - p.x - p.w, h: r.h });
      if (p.y > r.y) out.push({ x: r.x, y: r.y, w: r.w, h: p.y - r.y });
      if (p.y + p.h < r.y + r.h) out.push({ x: r.x, y: p.y + p.h, w: r.w, h: r.y + r.h - p.y - p.h });
    }
    // prune rects contained in others
    this.free = out.filter((a, i) => !out.some((b, j) => i !== j && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h && (i > j || a.w !== b.w || a.h !== b.h || a.x !== b.x || a.y !== b.y)));
  }
}

/** Usable area: margin on all sides; each part is grown by the gap, so the usable area grows by one gap too. */
function usable(s: NestSettings) { return { W: s.sheetW - 2 * s.margin + s.gap, H: s.sheetH - 2 * s.margin + s.gap }; }

function toSheet(mr: MaxRects, s: NestSettings, area: (id: string) => number): SheetLayout {
  return {
    placed: mr.placed.map((p) => ({ ...p, x: p.x + s.margin, y: p.y + s.margin, w: p.w - s.gap, h: p.h - s.gap })),
    used: mr.placed.reduce((a, p) => a + area(p.id), 0),
  };
}

function fits(p: NestPart, s: NestSettings) {
  const { W, H } = usable(s);
  const w = p.w + s.gap, h = p.h + s.gap;
  return (w <= W && h <= H) || (s.rotate && !p.lockRot && h <= W && w <= H);
}

/** Best simple grid for a single part (both orientations, plus a mixed strip) — often beats greedy packing. */
function bestGrid(p: NestPart, s: NestSettings): Placed[] {
  const { W, H } = usable(s);
  const w = p.w + s.gap, h = p.h + s.gap;
  const grid = (cw: number, ch: number, x0: number, y0: number, AW: number, AH: number, rot: boolean) => {
    const out: Placed[] = [];
    const nx = Math.floor(AW / cw + 1e-9), ny = Math.floor(AH / ch + 1e-9);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) out.push({ id: p.id, x: x0 + i * cw, y: y0 + j * ch, w: cw, h: ch, rot });
    return out;
  };
  const options: Placed[][] = [grid(w, h, 0, 0, W, H, false)];
  if (s.rotate && !p.lockRot) {
    options.push(grid(h, w, 0, 0, W, H, true));
    // columns of one orientation, remaining strip filled with the other (both ways)
    for (const [cw, ch, rot] of [[w, h, false], [h, w, true]] as [number, number, boolean][]) {
      const ow = rot ? w : h, oh = rot ? h : w;
      const maxCols = Math.floor(W / cw + 1e-9);
      for (let cols = 1; cols < maxCols; cols++) {
        const a = grid(cw, ch, 0, 0, cols * cw, H, rot);
        const b = grid(ow, oh, cols * cw, 0, W - cols * cw, H, !rot);
        options.push(a.concat(b));
      }
      const maxRows = Math.floor(H / ch + 1e-9);
      for (let rows = 1; rows < maxRows; rows++) {
        const a = grid(cw, ch, 0, 0, W, rows * ch, rot);
        const b = grid(ow, oh, 0, rows * ch, W, H - rows * ch, !rot);
        options.push(a.concat(b));
      }
    }
  }
  return options.reduce((best, o) => (o.length > best.length ? o : best), []);
}

/** Fill ONE sheet with as many as possible. Several parts → keep the per-set ratio (whole sets). */
export function fillSheet(parts: NestPart[], s: NestSettings): NestResult {
  const area = (id: string) => { const p = parts.find((x) => x.id === id)!; return p.w * p.h; };
  const ok = parts.filter((p) => fits(p, s));
  const unplaceable = parts.filter((p) => !fits(p, s)).map((p) => p.name);
  const counts: Record<string, number> = Object.fromEntries(parts.map((p) => [p.id, 0]));
  const sheetArea = s.sheetW * s.sheetH;
  if (!ok.length) return { sheets: [], counts, sets: 0, utilisation: 0, unplaceable };

  if (ok.length === 1) {
    const p = ok[0];
    // greedy MaxRects vs best grid — keep the larger
    const { W, H } = usable(s);
    const mr = new MaxRects(W, H);
    while (mr.insert(p.id, p.w + s.gap, p.h + s.gap, s.rotate && !p.lockRot)) { /* fill */ }
    const grid = bestGrid(p, s);
    if (grid.length > mr.placed.length) mr.placed = grid;
    const sheet = toSheet(mr, s, area);
    counts[p.id] = sheet.placed.length;
    return { sheets: [sheet], counts, sets: Math.floor(sheet.placed.length / Math.max(1, p.perSet)), utilisation: sheet.used / sheetArea, unplaceable };
  }

  // multiple parts: add whole sets (largest first) until one doesn't fit, then top up singles in ratio order
  const { W, H } = usable(s);
  const mr = new MaxRects(W, H);
  const order = [...ok].sort((a, b) => b.w * b.h - a.w * a.h);
  let sets = 0;
  for (;;) {
    const snapshotFree = mr.free.map((r) => ({ ...r })), snapshotPlaced = mr.placed.length;
    let okSet = true;
    for (const p of order) {
      for (let k = 0; k < p.perSet; k++) if (!mr.insert(p.id, p.w + s.gap, p.h + s.gap, s.rotate && !p.lockRot)) { okSet = false; break; }
      if (!okSet) break;
    }
    if (!okSet) { mr.free = snapshotFree; mr.placed.length = snapshotPlaced; break; }
    sets++;
  }
  const sheet = toSheet(mr, s, area);
  sheet.placed.forEach((p) => counts[p.id]++);
  return { sheets: [sheet], counts, sets, utilisation: sheet.used / sheetArea, unplaceable };
}

/** Nest `sets` complete sets across as many sheets as needed. */
export function nestQuantity(parts: NestPart[], sets: number, s: NestSettings): NestResult {
  const area = (id: string) => { const p = parts.find((x) => x.id === id)!; return p.w * p.h; };
  const ok = parts.filter((p) => fits(p, s));
  const unplaceable = parts.filter((p) => !fits(p, s)).map((p) => p.name);
  const counts: Record<string, number> = Object.fromEntries(parts.map((p) => [p.id, 0]));
  const queue: NestPart[] = [];
  for (const p of [...ok].sort((a, b) => b.w * b.h - a.w * a.h)) for (let k = 0; k < p.perSet * sets; k++) queue.push(p);
  const { W, H } = usable(s);
  const sheets: SheetLayout[] = [];
  let guard = 0;
  while (queue.length && guard++ < 500) {
    const mr = new MaxRects(W, H);
    for (let i = 0; i < queue.length;) {
      const p = queue[i];
      if (mr.insert(p.id, p.w + s.gap, p.h + s.gap, s.rotate && !p.lockRot)) { queue.splice(i, 1); counts[p.id]++; } else i++;
    }
    if (!mr.placed.length) break;
    sheets.push(toSheet(mr, s, area));
  }
  const used = sheets.reduce((a, sh) => a + sh.used, 0);
  return { sheets, counts, sets, utilisation: sheets.length ? used / (sheets.length * s.sheetW * s.sheetH) : 0, unplaceable };
}
