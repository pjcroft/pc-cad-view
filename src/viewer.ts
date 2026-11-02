/**
 * 3D viewport: rendering, camera/views, selection, section plane, explode and measure.
 * CAD convention: Z is up.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { detectThickness } from './sheetmetal';
import { lenPrecise, getUnit } from './units';

export type ViewName = 'iso' | 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right';
export type Axis = 'x' | 'y' | 'z';

export interface PickInfo { mesh: THREE.Mesh; point: THREE.Vector3; normal: THREE.Vector3 | null }
export interface MeasureInfo { a: THREE.Vector3; b: THREE.Vector3; dist: number }

const ACCENT = new THREE.Color('#22d3ee');
const SELECT = new THREE.Color('#f59e0b');

const VIEW_DIRS: Record<ViewName, [number, number, number]> = {
  iso: [1, -1, 0.8],
  front: [0, -1, 0],
  back: [0, 1, 0],
  top: [0, -0.0001, 1],
  bottom: [0, 0.0001, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
};

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  model: THREE.Group | null = null;
  private meshes: THREE.Mesh[] = [];
  private modelBox = new THREE.Box3();
  private modelCenter = new THREE.Vector3();
  private modelSize = 1;
  private grid: THREE.Object3D | null = null;

  private selected: THREE.Mesh | null = null;
  onSelect: (p: PickInfo | null) => void = () => {};
  onMeasure: (m: MeasureInfo | null, pending: boolean) => void = () => {};

  // display state
  private edgesOn = true;
  private wireOn = false;
  private xrayOn = false;

  // section
  private clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private sectionAxis: Axis = 'z';
  private sectionPos = 0.5;
  private sectionFlip = false;
  private sectionOn = false;
  private sectionHelper: THREE.Mesh;
  private sectionUniform = { value: 0 };

  // measure
  private measuring = false;
  private measurePts: THREE.Vector3[] = [];
  private measureGroup = new THREE.Group();
  private measureLabel: HTMLDivElement;
  private measureMid: THREE.Vector3 | null = null;

  // camera animation
  private anim: { t0: number; dur: number; p0: THREE.Vector3; p1: THREE.Vector3; c0: THREE.Vector3; c1: THREE.Vector3 } | null = null;

  // orientation triad
  private triadScene = new THREE.Scene();
  private triadCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 20);

  private raycaster = new THREE.Raycaster();
  private downAt = { x: 0, y: 0 };

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.autoClear = false;
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1e6);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(300, -300, 240);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.9;
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1, -0.6, 1.4);
    this.camera.add(key); // headlight follows the camera
    this.scene.add(this.camera, new THREE.HemisphereLight(0xdbeafe, 0x0b1220, 0.6));

    this.sectionHelper = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }),
    );
    const rim = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
      new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.8 }),
    );
    this.sectionHelper.add(rim);
    this.sectionHelper.visible = false;
    this.sectionHelper.renderOrder = 10;
    this.scene.add(this.sectionHelper, this.measureGroup);

    this.measureLabel = document.createElement('div');
    this.measureLabel.className = 'measure-label';
    this.measureLabel.hidden = true;
    host.appendChild(this.measureLabel);

    this.buildTriad();
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /* ---------------- model ---------------- */
  setModel(root: THREE.Group) {
    this.clearModel();
    this.model = root;
    this.scene.add(root);
    root.updateMatrixWorld(true);

    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      this.meshes.push(m);
      m.geometry.computeBoundingBox();
      m.geometry.computeBoundingSphere();
      for (const mat of this.mats(m)) this.patchMaterial(mat);
      m.userData.origPos = m.position.clone();
      m.userData.worldCenter = m.geometry.boundingBox!.getCenter(new THREE.Vector3()).applyMatrix4(m.matrixWorld);
    });

    this.modelBox.setFromObject(root);
    this.modelBox.getCenter(this.modelCenter);
    this.modelSize = this.modelBox.getSize(new THREE.Vector3()).length() || 1;
    this.camera.near = this.modelSize / 1000;
    this.camera.far = this.modelSize * 100;
    this.camera.updateProjectionMatrix();

    this.buildEdges();
    this.buildGrid();
    this.setSection(this.sectionOn, this.sectionAxis, this.sectionPos, this.sectionFlip);
    this.setView('iso', false);
  }

  clearModel() {
    this.select(null);
    this.clearMeasure();
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) this.mats(m).forEach((x) => x.dispose());
      });
    }
    if (this.grid) { this.scene.remove(this.grid); this.grid = null; }
    this.model = null;
    this.meshes = [];
  }

  stats() {
    let tris = 0;
    for (const m of this.meshes) {
      const g = m.geometry;
      tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    }
    return { bodies: this.meshes.length, tris, box: this.modelBox.clone() };
  }

  private mats(m: THREE.Mesh): THREE.Material[] {
    return Array.isArray(m.material) ? m.material : [m.material];
  }

  /** Tint back faces while sectioning, so cut solids read as solid instead of hollow. */
  private patchMaterial(mat: THREE.Material) {
    if (mat.userData.patched) return;
    mat.userData.patched = true;
    mat.side = THREE.DoubleSide;
    const u = this.sectionUniform;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSection = u;
      shader.fragmentShader = 'uniform float uSection;\n' + shader.fragmentShader.replace(
        '#include <tonemapping_fragment>',
        'if (uSection > 0.5 && !gl_FrontFacing) gl_FragColor.rgb = vec3(0.08, 0.55, 0.64);\n#include <tonemapping_fragment>',
      );
    };
    mat.customProgramCacheKey = () => 'pccad-section';
    mat.needsUpdate = true;
  }

  private buildEdges() {
    const { tris } = this.stats();
    const lineMat = new THREE.LineBasicMaterial({ color: 0x0b1220, transparent: true, opacity: 0.55 });
    for (const m of this.meshes) {
      // Skip edge extraction on huge meshes (scanned STL etc.) — too slow and too busy to look at
      if (tris > 3_000_000) break;
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 28), lineMat);
      e.name = '__edges';
      e.raycast = () => {};
      e.visible = this.edgesOn;
      m.add(e);
    }
  }

  private buildGrid() {
    const size = this.modelSize * 1.6;
    // round grid step to a "nice" number (1, 2, 5 × 10^n) in the display unit
    const u = getUnit() === 'in' ? 25.4 : 1;
    const raw = size / 20 / u, p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw)! * u;
    const div = Math.ceil(size / step);
    const grid = new THREE.GridHelper(div * step, div, 0x22d3ee, 0x22d3ee);
    const gm = grid.material as THREE.LineBasicMaterial;
    gm.transparent = true; gm.opacity = 0.12; gm.depthWrite = false;
    grid.rotation.x = Math.PI / 2;
    grid.position.set(this.modelCenter.x, this.modelCenter.y, this.modelBox.min.z - this.modelSize * 0.002);
    grid.raycast = () => {};
    grid.userData.step = step;
    this.grid = grid;
    this.scene.add(grid);
  }

  gridStep(): number { return this.grid?.userData.step ?? 0; }

  /** Rebuild the floor grid (e.g. after a units change, so steps stay round numbers). */
  rebuildGrid() {
    if (!this.model) return;
    if (this.grid) this.scene.remove(this.grid);
    this.buildGrid();
  }

  /* ---------------- views ---------------- */
  setView(v: ViewName, animate = true) {
    const dir = new THREE.Vector3(...VIEW_DIRS[v]).normalize();
    this.fitTo(dir, animate);
  }

  fit(animate = true) {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.fitTo(dir, animate);
  }

  private fitTo(dir: THREE.Vector3, animate: boolean) {
    const box = new THREE.Box3();
    for (const m of this.meshes) if (this.isShown(m)) box.expandByObject(m);
    if (box.isEmpty()) box.copy(this.modelBox);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fitFov = this.camera.aspect < 1 ? 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect) : fov;
    const dist = (sphere.radius / Math.sin(fitFov / 2)) * 1.08;
    const pos = sphere.center.clone().addScaledVector(dir, dist);
    if (!animate) {
      this.camera.position.copy(pos);
      this.controls.target.copy(sphere.center);
      this.controls.update();
      return;
    }
    this.anim = { t0: performance.now(), dur: 450, p0: this.camera.position.clone(), p1: pos, c0: this.controls.target.clone(), c1: sphere.center.clone() };
  }

  private isShown(o: THREE.Object3D): boolean {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  }

  /* ---------------- display modes ---------------- */
  setEdges(on: boolean) {
    this.edgesOn = on;
    for (const m of this.meshes) m.children.forEach((c) => { if (c.name === '__edges') c.visible = on || m === this.selected; });
  }

  setWireframe(on: boolean) {
    this.wireOn = on;
    for (const m of this.meshes) this.mats(m).forEach((x) => { (x as THREE.MeshStandardMaterial).wireframe = on; });
  }

  setXray(on: boolean) {
    this.xrayOn = on;
    for (const m of this.meshes) this.mats(m).forEach((x) => {
      x.transparent = on;
      x.opacity = on ? 0.28 : 1;
      x.depthWrite = !on;
      x.needsUpdate = true;
    });
  }

  displayState() { return { edges: this.edgesOn, wire: this.wireOn, xray: this.xrayOn }; }

  /* ---------------- section ---------------- */
  setSection(on: boolean, axis: Axis, pos: number, flip: boolean) {
    Object.assign(this, { sectionOn: on, sectionAxis: axis, sectionPos: pos, sectionFlip: flip });
    this.sectionUniform.value = on ? 1 : 0;
    this.renderer.clippingPlanes = on ? [this.clipPlane] : [];
    this.sectionHelper.visible = on && !!this.model;
    if (!on || !this.model) return;

    const b = this.modelBox, i = { x: 0, y: 1, z: 2 }[axis];
    const lo = b.min.getComponent(i), hi = b.max.getComponent(i);
    const pad = (hi - lo) * 0.001;
    const at = lo - pad + (hi - lo + 2 * pad) * pos;
    const n = new THREE.Vector3().setComponent(i, flip ? 1 : -1);
    this.clipPlane.normal.copy(n);
    this.clipPlane.constant = -n.getComponent(i) * at;

    // translucent helper plane, nudged a hair to the kept side so it isn't clipped itself
    const size = b.getSize(new THREE.Vector3()).multiplyScalar(1.15);
    const c = this.modelCenter.clone().setComponent(i, at + n.getComponent(i) * this.modelSize * 1e-4);
    this.sectionHelper.position.copy(c);
    this.sectionHelper.rotation.set(0, 0, 0);
    if (axis === 'x') { this.sectionHelper.rotation.y = Math.PI / 2; this.sectionHelper.scale.set(size.z, size.y, 1); }
    if (axis === 'y') { this.sectionHelper.rotation.x = Math.PI / 2; this.sectionHelper.scale.set(size.x, size.z, 1); }
    if (axis === 'z') { this.sectionHelper.scale.set(size.x, size.y, 1); }
  }

  sectionValue(): number {
    const i = { x: 0, y: 1, z: 2 }[this.sectionAxis];
    return -this.clipPlane.constant / this.clipPlane.normal.getComponent(i);
  }

  /* ---------------- explode ---------------- */
  explode(k: number) {
    const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
    for (const m of this.meshes) {
      const wc: THREE.Vector3 = m.userData.worldCenter;
      const target = wc.clone().add(tmpA.copy(wc).sub(this.modelCenter).multiplyScalar(k * 1.2));
      const parent = m.parent!;
      parent.updateMatrixWorld(true);
      const l0 = parent.worldToLocal(tmpA.copy(wc));
      const l1 = parent.worldToLocal(tmpB.copy(target));
      m.position.copy(m.userData.origPos).add(l1.sub(l0));
    }
    if (this.selected) this.onSelect(this.selectedInfo());
  }

  /* ---------------- tree helpers ---------------- */
  isolate(obj: THREE.Object3D | THREE.Object3D[] | null) {
    if (!this.model) return;
    if (!obj) { this.model.traverse((o) => { if (o.name !== '__edges') o.visible = true; }); return; }
    this.model.traverse((o) => { if (o.name !== '__edges' && (o as THREE.Mesh).isMesh) o.visible = false; });
    for (const one of Array.isArray(obj) ? obj : [obj]) {
      one.traverse((o) => { if (o.name !== '__edges') o.visible = true; });
      for (let p = one.parent; p; p = p.parent) p.visible = true;
    }
  }

  allMeshes(): readonly THREE.Mesh[] { return this.meshes; }

  /* ---------------- sheet metal ---------------- */
  /** Wall thickness straight through the part from a surface point (ray along the inward normal). */
  thicknessAt(mesh: THREE.Mesh, point: THREE.Vector3, outward: THREE.Vector3): number | null {
    const eps = this.modelSize * 1e-6;
    const dir = outward.clone().normalize().negate();
    const rc = new THREE.Raycaster(point.clone().addScaledVector(dir, eps), dir);
    const h = rc.intersectObject(mesh, false).find((x) => x.distance > eps * 2);
    return h ? h.distance + eps : null;
  }

  sheetThickness(mesh: THREE.Mesh): number | null {
    if (mesh.userData.sheetT === undefined) mesh.userData.sheetT = detectThickness(mesh);
    return mesh.userData.sheetT;
  }

  /* ---------------- selection ---------------- */
  private selEdgeMat = new THREE.LineBasicMaterial({ color: SELECT, transparent: true, opacity: 1, depthTest: false });

  private setEdgeMat(m: THREE.Mesh, sel: boolean) {
    const e = m.children.find((c) => c.name === '__edges') as THREE.LineSegments | undefined;
    if (!e) return;
    if (sel) { e.userData.baseMat ??= e.material; e.material = this.selEdgeMat; e.renderOrder = 5; e.visible = true; }
    else if (e.userData.baseMat) { e.material = e.userData.baseMat; e.renderOrder = 0; e.visible = this.edgesOn; }
  }

  select(m: THREE.Mesh | null, point?: THREE.Vector3, normal?: THREE.Vector3 | null) {
    if (this.selected) {
      this.mats(this.selected).forEach((x) => (x as THREE.MeshStandardMaterial).emissive?.setRGB(0, 0, 0));
      this.setEdgeMat(this.selected, false);
    }
    this.selected = m;
    if (m) {
      this.setEdgeMat(m, true);
      this.mats(m).forEach((x) => (x as THREE.MeshStandardMaterial).emissive?.copy(SELECT).multiplyScalar(0.3));
      this.lastPick = { point: point ?? null, normal: normal ?? null };
    }
    this.onSelect(m ? this.selectedInfo() : null);
  }
  private lastPick: { point: THREE.Vector3 | null; normal: THREE.Vector3 | null } = { point: null, normal: null };

  private selectedInfo(): PickInfo {
    return { mesh: this.selected!, point: this.lastPick.point ?? new THREE.Vector3(), normal: this.lastPick.normal };
  }

  selectedMesh() { return this.selected; }

  /* ---------------- measure ---------------- */
  setMeasuring(on: boolean) {
    this.measuring = on;
    this.renderer.domElement.style.cursor = on ? 'crosshair' : '';
    if (!on) this.clearMeasure();
    else this.onMeasure(null, true);
  }

  clearMeasure() {
    this.measurePts = [];
    this.measureGroup.clear();
    this.measureLabel.hidden = true;
    this.measureMid = null;
  }

  private addMeasurePoint(p: THREE.Vector3) {
    if (this.measurePts.length === 2) this.clearMeasure();
    this.measurePts.push(p.clone());
    const r = this.modelSize * 0.005;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color: SELECT, depthTest: false }));
    dot.position.copy(p);
    dot.renderOrder = 20;
    this.measureGroup.add(dot);
    if (this.measurePts.length === 2) {
      const [a, b] = this.measurePts;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: SELECT, depthTest: false }));
      line.renderOrder = 20;
      this.measureGroup.add(line);
      const dist = a.distanceTo(b);
      this.measureMid = a.clone().add(b).multiplyScalar(0.5);
      this.measureLabel.textContent = lenPrecise(dist);
      this.measureLabel.hidden = false;
      this.onMeasure({ a, b, dist }, false);
    } else {
      this.onMeasure(null, true);
    }
  }

  /** Re-render on-canvas labels (after a units change). */
  refreshLabels() {
    if (this.measurePts.length === 2) this.measureLabel.textContent = lenPrecise(this.measurePts[0].distanceTo(this.measurePts[1]));
  }

  /* ---------------- pointer ---------------- */
  private bindPointer() {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => { this.downAt = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      if (Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 4) return; // it was a drag
      const hit = this.pick(e.clientX, e.clientY);
      if (this.measuring) { if (hit) this.addMeasurePoint(hit.point); return; }
      if (hit) this.select(hit.mesh, hit.point, hit.normal);
      else this.select(null);
    });
    el.addEventListener('dblclick', (e) => {
      const hit = this.pick(e.clientX, e.clientY);
      if (!hit) return this.fit();
      // re-centre orbit on the double-clicked point
      this.anim = { t0: performance.now(), dur: 350, p0: this.camera.position.clone(),
        p1: this.camera.position.clone().add(hit.point.clone().sub(this.controls.target)),
        c0: this.controls.target.clone(), c1: hit.point.clone() };
    });
  }

  pick(cx: number, cy: number): PickInfo | null {
    if (!this.model) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.meshes.filter((m) => this.isShown(m)), false);
    for (const h of hits) {
      if (this.sectionOn && this.clipPlane.distanceToPoint(h.point) < 0) continue; // clipped away
      const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
      if (n && n.dot(this.raycaster.ray.direction) > 0) n.negate(); // face the viewer
      return { mesh: h.object as THREE.Mesh, point: h.point, normal: n };
    }
    return null;
  }

  /* ---------------- triad ---------------- */
  private buildTriad() {
    const mk = (dir: THREE.Vector3, color: number, label: string) => {
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, color, 0.28, 0.16);
      this.triadScene.add(arrow);
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d')!;
      g.fillStyle = '#' + new THREE.Color(color).getHexString();
      g.font = 'bold 44px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, 32, 34);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
      s.position.copy(dir).multiplyScalar(1.35); s.scale.setScalar(0.5);
      this.triadScene.add(s);
    };
    mk(new THREE.Vector3(1, 0, 0), 0xf87171, 'X');
    mk(new THREE.Vector3(0, 1, 0), 0x4ade80, 'Y');
    mk(new THREE.Vector3(0, 0, 1), 0x38bdf8, 'Z');
    this.triadCam.up.set(0, 0, 1);
  }

  /* ---------------- loop ---------------- */
  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame() {
    if (this.anim) {
      const t = Math.min(1, (performance.now() - this.anim.t0) / this.anim.dur);
      const e = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(this.anim.p0, this.anim.p1, e);
      this.controls.target.lerpVectors(this.anim.c0, this.anim.c1, e);
      if (t >= 1) this.anim = null;
    }
    this.controls.update();

    const r = this.renderer;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    r.clear();
    r.clippingPlanes = this.sectionOn ? [this.clipPlane] : [];
    r.render(this.scene, this.camera);

    // measure label follows its 3D midpoint
    if (this.measureMid && !this.measureLabel.hidden) {
      const p = this.measureMid.clone().project(this.camera);
      this.measureLabel.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px) translate(-50%, -140%)`;
    }

    // orientation triad, bottom-left corner
    const s = 96;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.triadCam.position.copy(dir.multiplyScalar(8));
    this.triadCam.up.copy(this.camera.up);
    this.triadCam.lookAt(0, 0, 0);
    r.clippingPlanes = [];
    r.clearDepth();
    r.setScissorTest(true);
    r.setScissor(12, 12, s, s);
    r.setViewport(12, 12, s, s);
    r.render(this.triadScene, this.triadCam);
    r.setScissorTest(false);
  }

  screenshot(): string {
    return this.renderer.domElement.toDataURL('image/png');
  }
}
