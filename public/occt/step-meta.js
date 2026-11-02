/* PC 3D CAD — STEP metadata reader.
   Pulls per-part properties that OpenCascade's mesher ignores: material, density, thickness,
   SolidWorks/Inventor custom properties ("user defined attributes"), plus the file header
   (originating CAD system, author, date). Pure JS, runs inside the import worker.

   Encodings handled:
     PROPERTY_DEFINITION(name, desc, #target) + PROPERTY_DEFINITION_REPRESENTATION(#pd, #rep)
       + REPRESENTATION(name, (items), ctx) with DESCRIPTIVE_ / MEASURE_ / VALUE_REPRESENTATION_ITEM
     MATERIAL_DESIGNATION(name, (#targets))
   Targets are walked back to the owning PRODUCT so properties attach to the right part. */

// eslint-disable-next-line no-unused-vars
function readStepMeta(bytes) {
  const text = new TextDecoder('latin1').decode(bytes);
  const out = { header: readHeader(text), parts: {} };
  out.header.lengthUnit = fileLengthUnit(text);
  if (!/PROPERTY_DEFINITION|MATERIAL_DESIGNATION/.test(text)) return out;

  const WANT = new Set([
    'PRODUCT', 'PRODUCT_DEFINITION_FORMATION', 'PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE',
    'PRODUCT_DEFINITION', 'PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS', 'PRODUCT_DEFINITION_SHAPE',
    'NEXT_ASSEMBLY_USAGE_OCCURRENCE', 'PROPERTY_DEFINITION', 'PROPERTY_DEFINITION_REPRESENTATION',
    'REPRESENTATION', 'DESCRIPTIVE_REPRESENTATION_ITEM', 'MEASURE_REPRESENTATION_ITEM',
    'VALUE_REPRESENTATION_ITEM', 'MATERIAL_DESIGNATION', 'DERIVED_UNIT', 'DERIVED_UNIT_ELEMENT',
    'CONVERSION_BASED_UNIT', 'GENERAL_PROPERTY_ASSOCIATION', 'GENERAL_PROPERTY',
  ]);
  const ents = scanEntities(text, WANT);
  const get = (r) => (r && r.ref ? ents.get(r.ref) : undefined);
  const args = (e) => (e.args ??= parseArgs(e.raw));

  /* ---- walk any target back to its PRODUCT name ---- */
  const prodName = new Map();
  function productOf(ref, depth = 0) {
    const e = ents.get(ref);
    if (!e || depth > 8) return null;
    const a = args(e);
    switch (e.type) {
      case 'PRODUCT': return str(a[1]) || str(a[0]);
      case 'PRODUCT_DEFINITION_FORMATION':
      case 'PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE': return a[2]?.ref ? productOf(a[2].ref, depth + 1) : null;
      case 'PRODUCT_DEFINITION':
      case 'PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS': return a[2]?.ref ? productOf(a[2].ref, depth + 1) : null;
      case 'PRODUCT_DEFINITION_SHAPE': return a[2]?.ref ? productOf(a[2].ref, depth + 1) : null;
      case 'NEXT_ASSEMBLY_USAGE_OCCURRENCE': return a[4]?.ref ? productOf(a[4].ref, depth + 1) : null;
      case 'PROPERTY_DEFINITION': return a[2]?.ref ? productOf(a[2].ref, depth + 1) : null;
      default: return null;
    }
  }
  const owner = (ref) => {
    if (!prodName.has(ref)) prodName.set(ref, productOf(ref));
    return prodName.get(ref);
  };
  const add = (part, key, value, num, unit) => {
    if (!part || value === '' || value == null) return;
    const list = (out.parts[part] ??= []);
    if (!list.some((p) => p.key === key && p.value === value)) list.push({ key, value, num, unit });
  };

  /* ---- property definitions ---- */
  for (const e of ents.values()) {
    if (e.type !== 'PROPERTY_DEFINITION_REPRESENTATION') continue;
    const a = args(e);
    const pd = get(a[0]), rep = get(a[1]);
    if (!pd || pd.type !== 'PROPERTY_DEFINITION' || !rep || rep.type !== 'REPRESENTATION') continue;
    const pa = args(pd);
    const pdName = str(pa[0]).toLowerCase(), pdDesc = str(pa[1]);
    const part = pa[2]?.ref ? owner(pa[2].ref) : null;
    if (!part) continue;
    const repName = str(args(rep)[0]);
    for (const it of args(rep)[1] || []) {
      const ie = get(it);
      if (!ie) continue;
      const ia = args(ie);
      const iname = str(ia[0]);
      if (/^data format$/i.test(iname)) continue;
      let key = iname, value = '', num, unit;
      if (ie.type === 'DESCRIPTIVE_REPRESENTATION_ITEM') {
        const desc = str(ia[1]);
        value = desc && desc !== iname ? desc : iname;
        if (desc && desc !== iname && pdName !== 'material property') key = iname; else key = '';
      } else if (ie.type === 'MEASURE_REPRESENTATION_ITEM' || ie.type === 'VALUE_REPRESENTATION_ITEM') {
        const m = ia[1];
        if (m && m.type) { num = typeof m.args[0] === 'number' ? m.args[0] : Number(str(m.args[0])); }
        else if (typeof m === 'number') num = m;
        else value = str(m);
        if (num !== undefined && !Number.isNaN(num)) {
          const u = unitInfo(get(ia[2]), m && m.type);
          unit = u.label;
          num = num * u.toBase;
          value = fmtNum(num) + (unit ? ' ' + unit : '');
        }
      } else continue;

      // Friendly keys for the standard material encoding
      const ctx = (pdDesc + ' ' + repName + ' ' + iname).toLowerCase();
      if (!key || pdName === 'material property') {
        if (/density/.test(ctx)) key = 'Density';
        else if (/material/.test(ctx)) key = 'Material';
        else key = pdDesc || repName || 'Property';
      }
      // density is almost always g/cm³ or kg/m³; some exporters write wrong exponents
      if (key === 'Density' && unit && /g/.test(unit) && /cm/.test(unit)) { unit = 'g/cm³'; value = fmtNum(num) + ' ' + unit; }
      if (key === 'Density' && unit && /kg/.test(unit) && /\bm/.test(unit)) { unit = 'kg/m³'; value = fmtNum(num) + ' ' + unit; }
      add(part, tidyKey(key), value, num, unit);
    }
  }

  /* ---- MATERIAL_DESIGNATION ---- */
  for (const e of ents.values()) {
    if (e.type !== 'MATERIAL_DESIGNATION') continue;
    const a = args(e);
    const name = str(a[0]);
    const targets = Array.isArray(a[1]) ? a[1] : [a[1]];
    for (const t of targets) if (t?.ref) add(owner(t.ref), 'Material', name);
  }
  return out;

  /* ---- units ---- */
  function unitInfo(u, measureType) {
    const raw = u ? u.raw : '';
    if (/MASS_UNIT|GRAM/.test(raw) && u.type === 'DERIVED_UNIT') return { label: derivedLabel(u), toBase: 1 };
    if (u && u.type === 'DERIVED_UNIT') return { label: derivedLabel(u), toBase: 1 };
    if (/LENGTH_MEASURE/i.test(measureType || '') || /LENGTH_UNIT/.test(raw)) {
      if (/INCH/i.test(raw)) return { label: 'mm', toBase: 25.4 };
      if (/\.MILLI\./.test(raw)) return { label: 'mm', toBase: 1 };
      if (/\.CENTI\./.test(raw)) return { label: 'mm', toBase: 10 };
      if (/SI_UNIT\(\$,\.METRE\.\)/.test(raw)) return { label: 'mm', toBase: 1000 };
      return { label: 'mm', toBase: 1 };
    }
    if (/MASS_MEASURE/i.test(measureType || '')) return { label: /KILO/.test(raw) ? 'kg' : 'g', toBase: 1 };
    return { label: '', toBase: 1 };
  }
  function derivedLabel(u) {
    let num = '', den = '';
    for (const r of args(u)[0] || []) {
      const el = get(r); if (!el) continue;
      const [ur, exp] = args(el);
      const base = get(ur)?.raw || '';
      let sym = /GRAM/.test(base) ? (/KILO/.test(base) ? 'kg' : 'g') : /METRE/.test(base) ? (/MILLI/.test(base) ? 'mm' : /CENTI/.test(base) ? 'cm' : 'm') : /SECOND/.test(base) ? 's' : '?';
      const e = Math.abs(exp), sup = e === 1 ? '' : e === 2 ? '²' : e === 3 ? '³' : '^' + e;
      if (exp > 0) num += (num ? '·' : '') + sym + sup; else den += (den ? '·' : '') + sym + sup;
    }
    return den ? `${num || '1'}/${den}` : num;
  }
}

function fmtNum(n) {
  const a = Math.abs(n);
  return (a >= 100 ? n.toFixed(1) : a >= 1 ? n.toFixed(3) : n.toPrecision(3)).replace(/\.?0+$/, '');
}
function tidyKey(k) {
  k = k.replace(/_/g, ' ').replace(/\s+measure$/i, '').trim();
  return k.charAt(0).toUpperCase() + k.slice(1);
}

/* ---------- native length unit (what the model was drawn in) ---------- */
function fileLengthUnit(text) {
  // complex unit entities: "( ... LENGTH_UNIT() ... );" — a conversion-based one (INCH/FOOT) means
  // the model was authored in it; otherwise read the SI prefix
  const re = /=\s*\(([^;]*?LENGTH_UNIT\s*\(\s*\)[^;]*);/g;
  let m, first = null;
  while ((m = re.exec(text))) {
    const e = m[1].toUpperCase();
    const conv = /CONVERSION_BASED_UNIT\s*\(\s*'([^']+)'/.exec(e);
    if (conv) return /INCH/.test(conv[1]) ? 'in' : /FOOT|FEET/.test(conv[1]) ? 'ft' : conv[1].toLowerCase();
    if (!first) first = /\.MILLI\./.test(e) ? 'mm' : /\.CENTI\./.test(e) ? 'cm' : /\.METRE\./.test(e) ? 'm' : null;
  }
  return first;
}

/* ---------- header ---------- */
function readHeader(text) {
  const h = {};
  const hs = text.indexOf('HEADER;'), he = text.indexOf('ENDSEC;', hs);
  if (hs < 0 || he < 0) return h;
  const head = text.slice(hs, he).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const fn = /FILE_NAME\s*\(([\s\S]*?)\)\s*;/.exec(head);
  if (fn) {
    const a = parseArgs(fn[1]);
    h.name = str(a[0]); h.date = str(a[1]);
    const lst = (v) => (Array.isArray(v) ? v : [v]).map(str).filter(Boolean).join(', ');
    h.author = lst(a[2]);
    h.organization = lst(a[3]);
    h.preprocessor = str(a[4]); h.system = str(a[5]);
  }
  const fs = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/.exec(head);
  if (fs) h.schema = fs[1].replace(/ \{.*$/, '');
  return h;
}

/* ---------- tokenizer ---------- */
// Scan "#id = TYPE(...);" records, keeping only wanted types and complex "( ... )" entities (units).
function scanEntities(text, want) {
  const map = new Map();
  let i = text.indexOf('DATA;');
  if (i < 0) i = 0;
  const n = text.length;
  while (i < n) {
    const h = text.indexOf('#', i);
    if (h < 0) break;
    let j = h + 1, id = 0;
    while (j < n) { const c = text.charCodeAt(j); if (c < 48 || c > 57) break; id = id * 10 + c - 48; j++; }
    while (j < n && text.charCodeAt(j) <= 32) j++;
    if (text[j] !== '=' || j === h + 1) { i = h + 1; continue; }
    j++;
    while (j < n && text.charCodeAt(j) <= 32) j++;
    // record end: next ';' outside quotes
    let k = j, q = false;
    for (; k < n; k++) {
      const c = text[k];
      if (c === "'") q = !q;
      else if (c === ';' && !q) break;
    }
    if (text[j] === '(') {
      map.set(id, { type: '', raw: text.slice(j, k) });
    } else {
      const p = text.indexOf('(', j);
      const type = text.slice(j, p).trim();
      if (want.has(type)) map.set(id, { type, raw: text.slice(p + 1, text.lastIndexOf(')', k)) });
    }
    i = k + 1;
  }
  return map;
}

// Parse a STEP argument list into JS values: 'str', 1.5, {ref}, [list], {type,args}, null for $ / *
function parseArgs(s) {
  let i = 0;
  const n = s.length;
  const ws = () => { while (i < n && s.charCodeAt(i) <= 32) i++; };
  function val() {
    ws();
    const c = s[i];
    if (c === "'") {
      let r = ''; i++;
      while (i < n) {
        if (s[i] === "'") { if (s[i + 1] === "'") { r += "'"; i += 2; continue; } i++; break; }
        r += s[i++];
      }
      return decodeStr(r);
    }
    if (c === '#') { i++; let d = ''; while (i < n && /\d/.test(s[i])) d += s[i++]; return { ref: +d }; }
    if (c === '(') { i++; return list(')'); }
    if (c === '$' || c === '*') { i++; return null; }
    if (c === '.') { const e = s.indexOf('.', i + 1); const v = s.slice(i, e + 1); i = e + 1; return v; }
    if (/[-+\d]/.test(c)) { let d = ''; while (i < n && /[-+\d.eE]/.test(s[i])) d += s[i++]; return parseFloat(d); }
    // typed value: NAME(args)
    let t = ''; while (i < n && /[A-Za-z0-9_]/.test(s[i])) t += s[i++];
    ws();
    if (s[i] === '(') { i++; return { type: t, args: list(')') }; }
    return t;
  }
  function list(end) {
    const r = [];
    ws();
    if (s[i] === end) { i++; return r; }
    while (i < n) {
      r.push(val());
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === end) { i++; break; }
      i++;
    }
    return r;
  }
  return list('\u0000');
}

function decodeStr(s) {
  return s
    .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_, h) => h.match(/.{4}/g).map((x) => String.fromCharCode(parseInt(x, 16))).join(''))
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\S\\(.)/g, (_, ch) => String.fromCharCode(ch.charCodeAt(0) + 128));
}
function str(v) { return typeof v === 'string' ? v : ''; }
