/**
 * Flat pattern → DXF (AutoCAD R12 ASCII — the most widely accepted by laser / CAM software).
 * Layers: CUT (outline + cutouts, true circles/arcs), BEND (bend lines, dashed), NOTES (bend notes).
 * Units: millimetres or inches ($INSUNITS 4 / 1).
 */
import type { FlatPattern, Prim } from './model';

export function flatToDxf(f: FlatPattern, opts: { inches: boolean; name: string; thickness: number; material: string }): string {
  const k = opts.inches ? 1 / 25.4 : 1;
  const n = (v: number) => (Math.round(v * k * 1e6) / 1e6).toString();
  // put the blank's lower-left corner at 0,0
  const X = (x: number) => n(x - f.minX), Y = (y: number) => n(y - f.minY);
  const out: string[] = [];
  const g = (code: number, val: string | number) => out.push(String(code), String(val));

  // header
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, opts.inches ? 1 : 4);
  g(9, '$EXTMIN'); g(10, 0); g(20, 0);
  g(9, '$EXTMAX'); g(10, n(f.maxX - f.minX)); g(20, n(f.maxY - f.minY));
  g(0, 'ENDSEC');

  // tables: line types + layers
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 2);
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0);
  const dash = opts.inches ? 0.2 : 5, gap = opts.inches ? 0.1 : 2.5;
  g(0, 'LTYPE'); g(2, 'DASHED'); g(70, 0); g(3, 'Dashed __ __ __'); g(72, 65); g(73, 2); g(40, dash + gap); g(49, dash); g(49, -gap);
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, 3);
  const layer = (name: string, color: number, lt: string) => { g(0, 'LAYER'); g(2, name); g(70, 0); g(62, color); g(6, lt); };
  layer('CUT', 7, 'CONTINUOUS');
  layer('BEND', 1, 'DASHED');
  layer('NOTES', 3, 'CONTINUOUS');
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  // entities
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const line = (lay: string, x1: number, y1: number, x2: number, y2: number) => {
    g(0, 'LINE'); g(8, lay); g(10, X(x1)); g(20, Y(y1)); g(30, 0); g(11, X(x2)); g(21, Y(y2)); g(31, 0);
  };
  const circle = (cx: number, cy: number, r: number) => { g(0, 'CIRCLE'); g(8, 'CUT'); g(10, X(cx)); g(20, Y(cy)); g(30, 0); g(40, n(r)); };
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
    g(0, 'ARC'); g(8, 'CUT'); g(10, X(cx)); g(20, Y(cy)); g(30, 0); g(40, n(r)); g(50, a0); g(51, a1);
  };
  const text = (x: number, y: number, h: number, s: string, rot: number) => {
    g(0, 'TEXT'); g(8, 'NOTES'); g(10, X(x)); g(20, Y(y)); g(30, 0); g(40, n(h)); g(1, s); g(50, rot);
  };

  for (const loop of f.loops) {
    for (let i = 0; i < loop.length; i++) {
      const [x1, y1] = loop[i], [x2, y2] = loop[(i + 1) % loop.length];
      line('CUT', x1, y1, x2, y2);
    }
  }
  for (const p of f.holes) prim(p);
  function prim(p: Prim) {
    if (p.type === 'circle') return circle(p.cx, p.cy, p.r);
    if (p.type === 'rect') {
      const x0 = p.cx - p.w / 2, x1 = p.cx + p.w / 2, y0 = p.cy - p.h / 2, y1 = p.cy + p.h / 2;
      line('CUT', x0, y0, x1, y0); line('CUT', x1, y0, x1, y1); line('CUT', x1, y1, x0, y1); line('CUT', x0, y1, x0, y0);
      return;
    }
    const r = p.wid / 2, half = Math.max(0, p.len / 2 - r);
    if (half < 1e-9) return circle(p.cx, p.cy, r);
    if (!p.alongY) {
      line('CUT', p.cx - half, p.cy - r, p.cx + half, p.cy - r);
      line('CUT', p.cx - half, p.cy + r, p.cx + half, p.cy + r);
      arc(p.cx + half, p.cy, r, 270, 90);
      arc(p.cx - half, p.cy, r, 90, 270);
    } else {
      line('CUT', p.cx - r, p.cy - half, p.cx - r, p.cy + half);
      line('CUT', p.cx + r, p.cy - half, p.cx + r, p.cy + half);
      arc(p.cx, p.cy + half, r, 0, 180);
      arc(p.cx, p.cy - half, r, 180, 360);
    }
  }

  const th = Math.max(2, Math.min(f.maxX - f.minX, f.maxY - f.minY) * 0.03);
  for (const b of f.bends) {
    line('BEND', b.a[0], b.a[1], b.b[0], b.b[1]);
    const mx = (b.a[0] + b.b[0]) / 2, my = (b.a[1] + b.b[1]) / 2;
    const rot = Math.abs(b.a[0] - b.b[0]) < 1e-6 ? 90 : 0;
    const off = th * 0.6;
    text(rot ? mx - off : mx, rot ? my : my + off, th, `${b.up ? 'UP' : 'DOWN'} ${b.angle}%%d R${+(opts.inches ? b.r / 25.4 : b.r).toFixed(3)}`, rot);
  }
  // title just below the blank (R12 text must be plain ASCII)
  const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, '?');
  text(f.minX, f.minY - th * 2, th, ascii(`${opts.name} - t=${+(opts.inches ? opts.thickness / 25.4 : opts.thickness).toFixed(3)}${opts.inches ? ' in' : ' mm'}${opts.material ? ' - ' + opts.material : ''}`), 0);
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}
