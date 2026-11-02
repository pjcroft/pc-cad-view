/* PC 3D CAD — B-rep import worker (STEP / IGES / BREP) using occt-import-js (OpenCascade WASM).
   Runs off the main thread so big files don't freeze the page. Geometry is sent back as
   transferable typed arrays. */
importScripts('occt-import-js.js', 'step-meta.js');

let occtPromise = null;
function getOcct() {
  if (!occtPromise) {
    occtPromise = occtimportjs({ locateFile: (p) => p });
  }
  return occtPromise;
}

onmessage = async (ev) => {
  const { id, format, buffer, quality } = ev.data;
  try {
    postMessage({ id, type: 'progress', stage: 'engine' });
    const occt = await getOcct();
    postMessage({ id, type: 'progress', stage: 'parse' });

    // quality: 'draft' | 'normal' | 'fine' — tessellation density
    const defl = { draft: 0.003, normal: 0.001, fine: 0.0003 }[quality || 'normal'];
    const params = {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: defl,
      angularDeflection: quality === 'fine' ? 0.25 : 0.5,
    };
    const bytes = new Uint8Array(buffer);
    // Part metadata (material, thickness, custom properties) — STEP only; never fatal
    let meta = null;
    if (format === 'step') {
      try { meta = readStepMeta(bytes); } catch (e) { meta = { header: {}, parts: {}, error: String(e) }; }
    }
    const t0 = performance.now();
    const res = occt.ReadFile(format, bytes, params);
    const ms = performance.now() - t0;
    if (!res || !res.success) throw new Error('The file could not be read. It may be damaged or use an unsupported variant.');

    const transfer = [];
    const meshes = res.meshes.map((m) => {
      const pos = new Float32Array(m.attributes.position.array);
      const nrm = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null;
      const idx = new Uint32Array(m.index.array);
      transfer.push(pos.buffer, idx.buffer);
      if (nrm) transfer.push(nrm.buffer);
      return {
        name: m.name || '',
        color: m.color || null,
        faces: (m.brep_faces || []).map((f) => ({ first: f.first, last: f.last, color: f.color || null })),
        position: pos,
        normal: nrm,
        index: idx,
      };
    });
    postMessage({ id, type: 'done', root: res.root, meshes, ms, meta }, transfer);
  } catch (e) {
    postMessage({ id, type: 'error', message: (e && e.message) || String(e) });
  }
};
