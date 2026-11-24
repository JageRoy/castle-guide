// Castle build guide — kiosk app.
//
// Everything the castle is made of comes from data/ (written by
// blender/castle_build.py guide()): castle.bin holds the same meshes that
// were exported as STLs, parts.json says which box each part lives in and
// where it ends up. steps.json is the Hebrew script.
//
// URL options:  ?pi      lighter rendering for the Raspberry Pi 4
//               ?fps     frame-rate readout
//               ?idle=N  seconds before the attract loop (default 90)
//               ?step=N  open at step N (testing)

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

const qs = new URLSearchParams(location.search);
const PI_MODE = qs.has('pi');
const IDLE_MS = (Number(qs.get('idle')) || 90) * 1000;

const STONE = '#d8ccb6';
const BIN = { w: 10, d: 7.5, h: 3.4, z: 29, gap: 21 };
const FLY_MS = 2400;

const $ = (id) => document.getElementById(id);
const ui = {
  app: $('app'), canvas: $('scene'), panel: $('panel'),
  count: $('count'), progress: $('progress'), badge: $('badge'), badgeText: $('badge-text'),
  partline: $('partline'), title: $('title'), text: $('text'), legend: $('legend'),
  prev: $('prev'), next: $('next'), replay: $('replay'), explode: $('explode'),
  attract: $('attract'), loading: $('loading'), fps: $('fps'),
};

// ------------------------------------------------------------------ easing
const ease = {
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
  outBack: (t) => { const c = 1.4; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
};

// ------------------------------------------------------------------ tweens
const tweens = new Set();
function tween(ms, fn, { delay = 0, done } = {}) {
  const tw = { start: performance.now() + delay, ms, fn, done, finished: false };
  tw.finish = () => {
    if (tw.finished) return;
    tw.finished = true; tweens.delete(tw); fn(1); done && done();
  };
  tweens.add(tw);
  return tw;
}
function runTweens(now) {
  for (const tw of [...tweens]) {
    if (now < tw.start) continue;
    const t = Math.min(1, (now - tw.start) / tw.ms);
    tw.fn(t);
    if (t >= 1) tw.finish();
  }
}
function finishAll(filter = () => true) {
  for (const tw of [...tweens]) if (filter(tw)) tw.finish();
}

// ------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({
  canvas: ui.canvas, antialias: !PI_MODE, alpha: true, powerPreference: 'high-performance',
});
renderer.setPixelRatio(PI_MODE ? 1 : Math.min(window.devicePixelRatio, 1.5));
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x1b2c42, 120, 260);
const camera = new THREE.PerspectiveCamera(34, 1, 0.5, 600);
const controls = new OrbitControls(camera, ui.canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 30;
controls.maxDistance = 170;
controls.minPolarAngle = 0.15;
controls.maxPolarAngle = 1.38;
controls.rotateSpeed = 0.7;
controls.autoRotateSpeed = 0.6;

scene.add(new THREE.HemisphereLight(0xe3ecff, 0x4b4232, 1.35));
const sun = new THREE.DirectionalLight(0xfff1da, 2.1);
sun.position.set(35, 60, 28);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x9db8ff, 0.45);
fill.position.set(-40, 20, -30);
scene.add(fill);

// ------------------------------------------------------------------ helpers
function radialTexture(inner, outer, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, inner); grd.addColorStop(1, outer);
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function labelTexture(text, color) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 160;
  const g = c.getContext('2d');
  g.direction = 'rtl';
  g.font = '800 104px Heebo, Arial';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = color === '#F2C200' ? '#2a2100' : '#ffffff';
  g.fillText(text, 256, 88);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function stage() {
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(52, 72),
    new THREE.MeshLambertMaterial({ color: 0x5a6a4c }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(52, 54, 72),
    new THREE.MeshLambertMaterial({ color: 0x3b4733 }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = -0.02;
  scene.add(rim);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(58, 58),
    new THREE.MeshBasicMaterial({
      map: radialTexture('rgba(0,0,0,0.42)', 'rgba(0,0,0,0)'), transparent: true, depthWrite: false,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;
  scene.add(shadow);
}

// ------------------------------------------------------------------ state
let kit, steps, parts = [], byNum = new Map(), bins = {}, boxById = {};
let current = -1, exploded = false, explodeF = 0, focusBox = null;
let lastInput = performance.now(), attract = false;
let camTween = null;

const mats = { stone: new THREE.MeshLambertMaterial({ color: STONE }) };

// ------------------------------------------------------------------ load
async function load() {
  const [k, s, buf] = await Promise.all([
    fetch('data/parts.json').then((r) => r.json()),
    fetch('data/steps.json').then((r) => r.json()),
    fetch('data/castle.bin').then((r) => r.arrayBuffer()),
  ]);
  kit = k; steps = s;
  try { await Promise.all([document.fonts.load('800 40px Heebo'), document.fonts.load('400 20px Heebo')]); } catch (_) {}

  const f32 = new Float32Array(buf);
  const geos = {};
  for (const [type, m] of Object.entries(kit.meshes)) {
    const start = m.offset / 4;
    const data = f32.subarray(start, start + m.tris * 18);
    const ib = new THREE.InterleavedBuffer(data, 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
    g.setAttribute('normal', new THREE.InterleavedBufferAttribute(ib, 3, 3));
    g.computeBoundingBox();
    geos[type] = g;
  }

  for (const b of kit.boxes) {
    boxById[b.id] = b;
    mats[b.id] = new THREE.MeshLambertMaterial({ color: b.color, emissive: b.color, emissiveIntensity: 0 });
    mats['ghost_' + b.id] = new THREE.MeshBasicMaterial({
      color: b.color, transparent: true, opacity: 0.22, depthWrite: false,
    });
  }

  stage();
  buildBins();

  const typeCount = {}, typeIndex = {};
  for (const p of kit.parts) typeCount[p.type] = (typeCount[p.type] || 0) + 1;
  for (const p of kit.parts) {
    typeIndex[p.type] = (typeIndex[p.type] || 0) + 1;
    const geo = geos[p.type];
    const mesh = new THREE.Mesh(geo, mats.stone);
    const ghost = new THREE.Mesh(geo, mats['ghost_' + p.box]);
    const M = new THREE.Matrix4().fromArray(p.matrix);
    const homePos = new THREE.Vector3(), homeQuat = new THREE.Quaternion(), s = new THREE.Vector3();
    M.decompose(homePos, homeQuat, s);
    ghost.position.copy(homePos); ghost.quaternion.copy(homeQuat);
    ghost.visible = false;
    mesh.visible = false;
    scene.add(mesh, ghost);
    const bb = geo.boundingBox;
    const part = {
      ...p, mesh, ghost, homePos, homeQuat,
      base: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: 1,
      height: bb.max.y - bb.min.y,
      index: typeIndex[p.type], of: typeCount[p.type],
      explodeVec: new THREE.Vector3(),
    };
    const out = new THREE.Vector3(homePos.x, 0, homePos.z);
    const lift = /roof/.test(p.type) ? 6 : p.type === 'portcullis' ? 8 : 0;
    if (out.length() > 1) out.normalize().multiplyScalar(p.type === 'portcullis' ? 4 : 7); else out.set(0, 0, 0);
    part.explodeVec.set(out.x, lift, out.z);
    parts.push(part);
    byNum.set(p.num, part);
  }
  layoutInventory();
  buildProgress();
  buildLegend();
}

function buildBins() {
  const xs = [-BIN.gap, 0, BIN.gap];
  kit.boxes.forEach((b, i) => {
    const g = new THREE.Group();
    g.position.set(xs[i] ?? i * BIN.gap, 0, BIN.z);
    const m = mats[b.id];
    const inner = new THREE.MeshLambertMaterial({ color: new THREE.Color(b.color).multiplyScalar(0.55) });
    const t = 0.35, { w, d, h } = BIN;
    const add = (geo, mat, x, y, z) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); g.add(o); return o; };
    add(new THREE.BoxGeometry(w, t, d), inner, 0, t / 2, 0);
    add(new THREE.BoxGeometry(w, h, t), m, 0, h / 2, d / 2 - t / 2);
    add(new THREE.BoxGeometry(w, h, t), m, 0, h / 2, -d / 2 + t / 2);
    add(new THREE.BoxGeometry(t, h, d), m, w / 2 - t / 2, h / 2, 0);
    add(new THREE.BoxGeometry(t, h, d), m, -w / 2 + t / 2, h / 2, 0);
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 0.92, w * 0.92 * 160 / 512),
      new THREE.MeshBasicMaterial({ map: labelTexture(b.label_he, b.color), transparent: true, depthWrite: false }),
    );
    label.position.set(0, h * 0.5, d / 2 + 0.02);
    g.add(label);
    g.userData.box = b.id;
    g.traverse((o) => { o.userData.box = b.id; });
    scene.add(g);
    bins[b.id] = { group: g, pos: g.position.clone(), lid: 0 };
  });
}

// Parts laid out in front of their own bin for the "what's in the box" step.
function layoutInventory() {
  const slots = {
    tower: [[-4.8, -9], [4.8, -9], [-4.8, 1], [4.8, 1]],
    keep: [[0, -22]],
    wall: [[0, -26], [0, -20], [0, -14]],
    gate_wall: [[0, -6]],
    portcullis: [[0, 4]],
    tower_roof: [[-4.8, -9], [4.8, -9], [-4.8, 1], [4.8, 1]],
    keep_roof: [[0, -22]],
  };
  const used = {};
  for (const p of parts) {
    const bin = bins[p.box];
    const k = (used[p.type] = (used[p.type] || 0) + 1) - 1;
    const [dx, dz] = slots[p.type][k];
    p.invPos = new THREE.Vector3(bin.pos.x + dx, 0, BIN.z - 10 + dz);
    p.invQuat = new THREE.Quaternion();
  }
}

// ------------------------------------------------------------------ part motion
function setPart(p, pos, quat, scale = 1) {
  p.base.copy(pos); p.quat.copy(quat); p.scale = scale;
}
function place(p, { active = false } = {}) {
  p.mesh.visible = true;
  p.mesh.material = active ? mats[p.box] : mats.stone;
  setPart(p, p.homePos, p.homeQuat);
  p.ghost.visible = false;
}
function hide(p) {
  p.mesh.visible = false; p.ghost.visible = false;
}

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), ID = new THREE.Quaternion();

// bin -> up out of the bin -> over the castle -> straight down into place
function flyIn(p, delay = 0) {
  const bin = bins[p.box].pos;
  const start = new THREE.Vector3(bin.x, 0.4, bin.z);
  const top = new THREE.Vector3(bin.x, 12, bin.z);
  const dropH = Math.max(10, p.height * 0.9);
  const above = p.homePos.clone().add(new THREE.Vector3(0, dropH, 0));
  p.mesh.material = mats[p.box];
  if (!p.mesh.visible) setPart(p, start, ID, 0.25);
  return tween(FLY_MS, (t) => {
    p.mesh.visible = true;
    p.mesh.material = mats[p.box];
    p.ghost.visible = t < 1;
    if (t < 0.28) {
      const u = ease.out(t / 0.28);
      _v.lerpVectors(start, top, u);
      setPart(p, _v, ID, 0.25 + 0.75 * u);
      bumpBin(p.box, 1 - u);
    } else if (t < 0.7) {
      const u = ease.inOut((t - 0.28) / 0.42);
      _v.lerpVectors(top, above, u);
      _v.y += Math.sin(Math.PI * u) * 5;
      _q.slerpQuaternions(ID, p.homeQuat, u);
      setPart(p, _v, _q, 1);
    } else {
      const u = ease.out((t - 0.7) / 0.3);
      _v.lerpVectors(above, p.homePos, u);
      setPart(p, _v, p.homeQuat, 1);
    }
  }, { delay, done: () => { p.ghost.visible = false; setPart(p, p.homePos, p.homeQuat, 1); } });
}

// the reverse: back up, over, and down into its bin
function flyOut(p, ms = 1300) {
  const bin = bins[p.box].pos;
  const from = p.base.clone(), fromQ = p.quat.clone();
  const top = new THREE.Vector3(bin.x, 12, bin.z);
  const up = from.clone().add(new THREE.Vector3(0, 10, 0));
  p.ghost.visible = false;
  p.mesh.material = mats[p.box];
  return tween(ms, (t) => {
    if (t < 0.35) {
      _v.lerpVectors(from, up, ease.inOut(t / 0.35));
      setPart(p, _v, fromQ, 1);
    } else if (t < 0.75) {
      const u = ease.inOut((t - 0.35) / 0.4);
      _v.lerpVectors(up, top, u);
      _q.slerpQuaternions(fromQ, ID, u);
      setPart(p, _v, _q, 1);
    } else {
      const u = ease.inOut((t - 0.75) / 0.25);
      _v.set(bin.x, 16 - 15.6 * u, bin.z);
      setPart(p, _v, ID, 1 - 0.75 * u);
    }
  }, { done: () => hide(p) });
}

function toInventory(p, delay = 0) {
  const from = p.mesh.visible ? p.base.clone() : new THREE.Vector3(bins[p.box].pos.x, 0.4, bins[p.box].pos.z);
  const fromQ = p.mesh.visible ? p.quat.clone() : ID.clone();
  const fromS = p.mesh.visible ? p.scale : 0.25;
  p.ghost.visible = false;
  p.mesh.material = mats[p.box];
  return tween(1100, (t) => {
    p.mesh.visible = true;
    const u = ease.inOut(t);
    _v.lerpVectors(from, p.invPos, u);
    _v.y += Math.sin(Math.PI * u) * 7;
    _q.slerpQuaternions(fromQ, p.invQuat, u);
    setPart(p, _v, _q, fromS + (1 - fromS) * u);
  }, { delay });
}

function intoBin(p, delay = 0) {
  if (!p.mesh.visible) return null;
  const bin = bins[p.box].pos;
  const from = p.base.clone(), fromQ = p.quat.clone();
  return tween(800, (t) => {
    const u = ease.inOut(t);
    _v.set(from.x + (bin.x - from.x) * u, from.y + Math.sin(Math.PI * u) * 6 + (0.4 - from.y) * u, from.z + (bin.z - from.z) * u);
    _q.slerpQuaternions(fromQ, ID, u);
    setPart(p, _v, _q, 1 - 0.75 * u);
  }, { delay, done: () => hide(p) });
}

function bumpBin(id, amount) {
  const g = bins[id].group;
  g.scale.y = 1 + 0.06 * amount;
}

// ------------------------------------------------------------------ steps
function partsBefore(i) {
  const s = new Set();
  for (let k = 0; k < i; k++) for (const n of steps[k].parts || []) s.add(n);
  return s;
}

function goto(i, { animate = true } = {}) {
  i = Math.max(0, Math.min(steps.length - 1, i));
  const prev = current;
  if (i === prev) return;
  finishAll();
  current = i;
  const step = steps[i];
  const forward = prev >= 0 && i === prev + 1;
  const backward = prev >= 0 && i === prev - 1;
  const done = partsBefore(i);
  const now = new Set(step.parts || []);
  setFocusBox(null);

  if (step.kind === 'overview') {
    parts.forEach((p, k) => (animate ? toInventory(p, k * 40) : (place(p), setPart(p, p.invPos, p.invQuat), p.mesh.material = mats[p.box])));
  } else if (step.kind === 'finale') {
    parts.forEach((p) => place(p));
  } else {
    let delay = 0;
    if (steps[prev]?.kind === 'overview' && animate) {
      parts.forEach((p, k) => intoBin(p, k * 25));
      delay = 900;
    }
    for (const p of parts) {
      if (done.has(p.num)) {
        if (steps[prev]?.kind !== 'overview') place(p);
      } else if (now.has(p.num)) {
        if (forward && animate) {
          // set up after the parts that are leaving have gone
        } else {
          place(p, { active: true });
        }
      } else if (backward && animate && (steps[prev].parts || []).includes(p.num)) {
        flyOut(p);
      } else if (steps[prev]?.kind !== 'overview' || !animate) {
        hide(p);
      }
    }
    if (steps[prev]?.kind === 'overview' && animate) {
      // after the inventory has gone back into the bins, rebuild the castle so far
      tween(1, () => {}, { delay: delay - 50, done: () => done.forEach((n) => place(byNum.get(n))) });
    }
    if (forward && animate) {
      [...now].forEach((n, k) => flyIn(byNum.get(n), delay + k * 420));
    }
  }
  if (step.kind === 'finale' && forward) celebrate();
  flyCamera(poseFor(i));
  render();
}

function replay() {
  const step = steps[current];
  if (!step.parts) { flyCamera(poseFor(current)); return; }
  finishAll();
  step.parts.forEach((n, k) => flyIn(byNum.get(n), k * 420));
}

function celebrate() {
  // a little hop, part by part, in build order
  let k = 0;
  for (const s of steps) for (const n of s.parts || []) {
    const p = byNum.get(n);
    tween(520, (t) => { p.base.y = p.homePos.y + Math.sin(Math.PI * t) * 1.4; }, { delay: 200 + k++ * 70 });
  }
}

// ------------------------------------------------------------------ camera
function poseFor(i) {
  const s = steps[i];
  if (s.kind === 'overview') return { target: new THREE.Vector3(0, 0, 15), az: 0.0, el: 0.92, dist: 128 };
  if (s.kind === 'finale') return { target: new THREE.Vector3(0, 7, 2), az: 0.55, el: 0.42, dist: 84 };
  const c = new THREE.Vector3();
  let top = 0;
  for (const n of s.parts) { const p = byNum.get(n); c.add(p.homePos); top = Math.max(top, p.homePos.y + p.height); }
  c.divideScalar(s.parts.length);
  // Keep the whole build area and the three bins in frame; only lean a
  // little toward the part so its joint faces the camera.
  let az = 0.25;
  const r = Math.hypot(c.x, c.z);
  if (r > 6 && s.parts.length === 1) {
    az = 0.2 + THREE.MathUtils.clamp(Math.atan2(c.x, c.z), -1.3, 1.3) * 0.25;
  }
  const target = new THREE.Vector3(c.x * 0.2, THREE.MathUtils.clamp(top * 0.3, 4, 8), 7 + c.z * 0.15);
  return { target, az, el: 0.72, dist: s.parts.length > 1 ? 104 : 100 };
}

function flyCamera(pose, ms = 1500) {
  camTween && camTween.finish();
  const fromT = controls.target.clone();
  const off = camera.position.clone().sub(controls.target);
  const fromSph = new THREE.Spherical().setFromVector3(off);
  const toSph = new THREE.Spherical(pose.dist, Math.PI / 2 - pose.el, pose.az);
  let dTheta = toSph.theta - fromSph.theta;
  dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
  const sph = new THREE.Spherical();
  camTween = tween(ms, (t) => {
    const u = ease.inOut(t);
    controls.target.lerpVectors(fromT, pose.target, u);
    sph.set(
      fromSph.radius + (toSph.radius - fromSph.radius) * u,
      fromSph.phi + (toSph.phi - fromSph.phi) * u,
      fromSph.theta + dTheta * u,
    );
    camera.position.setFromSpherical(sph).add(controls.target);
    camera.lookAt(controls.target);
  });
}

// ------------------------------------------------------------------ UI
function buildProgress() {
  ui.progress.innerHTML = '';
  steps.forEach((s) => {
    const li = document.createElement('li');
    const b = s.parts ? boxById[byNum.get(s.parts[0]).box] : null;
    if (b) li.style.setProperty('--c', b.color);
    ui.progress.appendChild(li);
  });
}

function buildLegend() {
  ui.legend.innerHTML = '';
  for (const b of kit.boxes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.box = b.id;
    btn.style.setProperty('--c', b.color);
    const names = [];
    for (const n of b.parts) {
      const nm = byNum.get(n).name_he;
      if (!names.includes(nm)) names.push(nm);
    }
    btn.innerHTML = `<i class="swatch"></i><span><b>${b.label_he}</b> · ${names.join(', ')}</span><span class="n">${b.parts.length}</span>`;
    btn.addEventListener('click', () => setFocusBox(focusBox === b.id ? null : b.id));
    ui.legend.appendChild(btn);
  }
}

function setFocusBox(id) {
  focusBox = id;
  for (const btn of ui.legend.children) btn.classList.toggle('on', btn.dataset.box === id);
  if (steps[current]?.kind !== 'overview') return;
  for (const p of parts) {
    p.mesh.material = !id || p.box === id ? mats[p.box] : mats['ghost_' + p.box];
  }
  for (const [bid, b] of Object.entries(bins)) {
    const s = !id || bid === id ? 1 : 0.85;
    b.group.scale.set(s, s, s);
  }
}

function render() {
  const step = steps[current];
  ui.count.innerHTML = step.kind ? (step.kind === 'overview' ? 'מה יש בקופסאות' : 'סיום')
    : `שלב <b>${current}</b> מתוך ${steps.length - 2}`;
  [...ui.progress.children].forEach((li, k) => {
    li.classList.toggle('done', k < current);
    li.classList.toggle('now', k === current);
  });
  ui.title.textContent = step.title;
  ui.text.textContent = step.text;
  ui.legend.hidden = step.kind !== 'overview';

  if (step.parts) {
    const p0 = byNum.get(step.parts[0]);
    const b = boxById[p0.box];
    ui.badge.hidden = false;
    ui.badge.style.setProperty('--box', b.color);
    ui.badge.className = 'badge ' + b.id;
    ui.badgeText.textContent = `קחו מ${b.name_he}`;
    ui.partline.textContent = step.partline
      || (p0.of > 1 ? `${p0.name_he} · ${p0.index} מתוך ${p0.of}` : p0.name_he);
  } else {
    ui.badge.hidden = true;
    ui.partline.textContent = step.kind === 'finale' ? '15 מתוך 15 חלקים' : '';
  }
  ui.prev.disabled = current === 0;
  ui.next.innerHTML = current === steps.length - 1 ? 'מההתחלה<span class="arrow">↺</span>'
    : current === 0 ? 'מתחילים<span class="arrow">←</span>' : 'הבא<span class="arrow">←</span>';
  ui.replay.hidden = !step.parts;
}

// ------------------------------------------------------------------ layout
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const pw = attract ? 0 : ui.panel.getBoundingClientRect().width;
  renderer.setSize(w, h, false);
  // shift the castle into the free area left of the panel
  camera.aspect = (w + pw) / h;
  camera.setViewOffset(w + pw, h, pw, 0, w, h);
  camera.updateProjectionMatrix();
}

// ------------------------------------------------------------------ attract
function enterAttract() {
  if (attract) return;
  attract = true;
  finishAll();
  ui.app.classList.add('attract');
  ui.attract.hidden = false;
  resize();
  exploded = false; ui.explode.setAttribute('aria-pressed', 'false');
  parts.forEach((p) => place(p));
  current = steps.length - 1;
  flyCamera({ target: new THREE.Vector3(0, 7, 0), az: 0.5, el: 0.38, dist: 80 }, 2500);
  controls.autoRotate = true;
}
function exitAttract() {
  attract = false;
  controls.autoRotate = false;
  ui.app.classList.remove('attract');
  ui.attract.hidden = true;
  resize();
  current = -1;
  goto(0);
}

// ------------------------------------------------------------------ input
function poke() { lastInput = performance.now(); }

const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let downAt = null;
ui.canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
ui.canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 8) return;
  if (steps[current]?.kind !== 'overview') return;
  const r = ui.canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const targets = [...Object.values(bins).map((b) => b.group), ...parts.map((p) => p.mesh)];
  const hit = ray.intersectObjects(targets, true)[0];
  if (!hit) return setFocusBox(null);
  let o = hit.object;
  const id = o.userData.box || parts.find((p) => p.mesh === o)?.box;
  setFocusBox(focusBox === id ? null : id);
});

window.addEventListener('pointerdown', () => { if (attract) exitAttract(); poke(); }, true);
window.addEventListener('keydown', (e) => {
  poke();
  if (attract) return exitAttract();
  if (e.key === 'ArrowLeft' || e.key === ' ' || e.key === 'Enter') next();
  if (e.key === 'ArrowRight') goto(current - 1);
});
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('resize', resize);

function next() {
  if (current === steps.length - 1) { current = -1; goto(0); return; }
  goto(current + 1);
}
ui.next.addEventListener('click', next);
ui.prev.addEventListener('click', () => goto(current - 1));
ui.replay.addEventListener('click', replay);
ui.explode.addEventListener('click', () => {
  exploded = !exploded;
  ui.explode.setAttribute('aria-pressed', String(exploded));
  const from = explodeF, to = exploded ? 1 : 0;
  tween(700, (t) => { explodeF = from + (to - from) * ease.inOut(t); });
});

// ------------------------------------------------------------------ loop
let frames = 0, fpsT = performance.now(), lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  requestAnimationFrame(frame);
  runTweens(now);
  const pulse = 0.18 + 0.14 * Math.sin(now / 260);
  for (const b of kit.boxes) mats[b.id].emissiveIntensity = pulse;
  for (const b of kit.boxes) mats['ghost_' + b.id].opacity = 0.16 + 0.12 * Math.sin(now / 300);
  const inOverview = steps[current]?.kind === 'overview';
  for (const p of parts) {
    if (!p.mesh.visible) continue;
    p.mesh.position.copy(p.base);
    if (!inOverview) p.mesh.position.addScaledVector(p.explodeVec, explodeF);
    p.mesh.quaternion.copy(p.quat);
    p.mesh.scale.setScalar(p.scale);
  }
  if (!camTween || camTween.finished) controls.update(dt);
  renderer.render(scene, camera);
  if (!attract && now - lastInput > IDLE_MS) enterAttract();
  if (qs.has('fps')) {
    frames++;
    if (now - fpsT > 1000) {
      ui.fps.hidden = false;
      ui.fps.textContent = `${Math.round(frames * 1000 / (now - fpsT))} fps · ${renderer.info.render.triangles} tris`;
      frames = 0; fpsT = now;
    }
  }
}

// ------------------------------------------------------------------ go
load().then(() => {
  camera.position.set(0, 60, 120);
  controls.target.set(0, 4, 10);
  resize();
  goto(Number(qs.get('step')) || 0, { animate: false });   // ?step=N jumps (for testing)
  ui.loading.classList.add('gone');
  requestAnimationFrame(frame);
}).catch((err) => {
  ui.loading.textContent = 'שגיאה בטעינה: ' + err.message;
  console.error(err);
});

// Offline install (only where the browser allows it: HTTPS or localhost).
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('sw:', err));
}
