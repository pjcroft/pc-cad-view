/**
 * Display units. Geometry and all calculations stay in millimetres (CAD/STEP native);
 * only what's shown on screen and typed into inputs is converted.
 */
export type Unit = 'mm' | 'in';
const KEY = 'pccad.units';
const MM_PER_IN = 25.4;

let unit: Unit = (() => {
  try { const v = localStorage.getItem(KEY); if (v === 'mm' || v === 'in') return v; } catch { /* storage unavailable */ }
  // default: inches for US-locale browsers, mm elsewhere
  return /^en-US/i.test(navigator.language || '') ? 'in' : 'mm';
})();

const subs = new Set<(prev: Unit) => void>();

export const getUnit = () => unit;
export const uLabel = () => unit;
export function setUnit(u: Unit) {
  if (u === unit) return;
  const prev = unit;
  unit = u;
  try { localStorage.setItem(KEY, u); } catch { /* ignore */ }
  subs.forEach((f) => f(prev));
}
export function onUnit(f: (prev: Unit) => void) { subs.add(f); }

/** mm → number in the current unit (and back). */
export const toDisp = (mm: number, u: Unit = unit) => (u === 'mm' ? mm : mm / MM_PER_IN);
export const fromDisp = (v: number, u: Unit = unit) => (u === 'mm' ? v : v * MM_PER_IN);

const trim = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);

/** Compact number for sizes: mm → 0.1/0.01, inches → 0.001 (trailing zeros dropped). */
export function num(mm: number): string {
  const v = toDisp(mm), a = Math.abs(v);
  if (unit === 'mm') return trim(v.toFixed(a >= 100 ? 1 : 2));
  return trim(v.toFixed(a >= 100 ? 2 : 3));
}
/** Number + unit, e.g. "146.8 mm" / "5.779 in". */
export const len = (mm: number) => `${num(mm)} ${unit}`;

/** Fixed-precision length for measurements (keeps trailing zeros so values line up). */
export function lenPrecise(mm: number): string {
  const v = toDisp(mm), a = Math.abs(v);
  const d = unit === 'mm' ? (a >= 1000 ? 1 : a >= 100 ? 2 : 3) : (a >= 100 ? 2 : a >= 10 ? 3 : 4);
  return `${v.toFixed(d)} ${unit}`;
}

/** Area from mm²: m² or ft². */
export function area(mm2: number, digits = 3): string {
  return unit === 'mm' ? `${(mm2 / 1e6).toFixed(digits)} m²` : `${(mm2 / 92903.04).toFixed(digits)} ft²`;
}

/** Input step suited to the unit. */
export const inputStep = (fine = false) => (unit === 'mm' ? (fine ? '0.1' : '1') : (fine ? '0.001' : '0.01'));

/** Re-express a file property value that carries a length/area/volume unit. */
export function convertProp(value: string, numMm?: number, u?: string): string {
  if (numMm === undefined || !u) return value;
  if (u === 'mm') return len(numMm);
  if (unit === 'mm') return value;
  if (u === 'mm²') return `${trim((numMm / 645.16).toFixed(3))} in²`;
  if (u === 'mm³') return `${trim((numMm / 16387.064).toFixed(3))} in³`;
  return value;
}
