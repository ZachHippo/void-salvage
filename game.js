// Void Salvage -- a bullet-hell boss rush.
// One ship against bosses built from blocks. Shred the armour, expose the core,
// blow it, bank the salvage, and spend it in the hangar before the next fight.

// ---------- setup ----------
const canvas = document.getElementById('game');
const screenCtx = canvas.getContext('2d');

// W and H are the play area in CSS pixels. The canvas backing store is W*DPR by
// H*DPR, so on a scaled display (125%, 150%, retina) nothing is blurred by the
// browser stretching a low-resolution canvas.
let W = window.innerWidth, H = window.innerHeight, DPR = 1;

const ctx = screenCtx;

// Text sizes below are written on the old pixel-font scale; this maps them onto
// the monospace look, bolding the larger headings.
function font(n) { return `${n >= 12 ? 'bold ' : ''}${Math.round(n * 1.55)}px monospace`; }

function glowOn(color, blur) { ctx.shadowColor = color; ctx.shadowBlur = blur; }
function glowOff() { ctx.shadowBlur = 0; }

// ---------- currencies ----------
// Blocks pay out in the colour they are: blue armour drops blue orbs, red guns
// drop red shards, and only a core drops white crystals.
const CUR = {
  white: { color: '#eaf6ff', shape: 'diamond' },
  red:   { color: '#ff6b9f', shape: 'diamond' },
  blue:  { color: '#8b7dff', shape: 'circle' },
};
const CUR_ORDER = ['white', 'red', 'blue'];
function emptyWallet() { return { white: 0, red: 0, blue: 0 }; }

// ---------- helpers ----------
function rand(a, b) { return a + Math.random() * (b - a); }
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function oddClamp(v, lo, hi) { v = clamp(Math.round(v), lo, hi); return v % 2 ? v : v - 1; }

// Distance from a point to a ray segment, for laser sweeps.
function distToRay(px, py, ox, oy, dx, dy, len) {
  const t = clamp((px - ox) * dx + (py - oy) * dy, 0, len);
  return Math.hypot(px - (ox + dx * t), py - (oy + dy * t));
}

// ---------- save ----------
// Salvage and upgrades persist across runs: dying costs you the fight, not the
// progress. Best level reached is the score.
const SAVE_KEY = 'voidsalvage:save:v3';
const OLD_SAVE_KEY = 'voidsalvage:save:v2';
function freshSave() { return { wallet: emptyWallet(), upgrades: {}, level: 1, bestLevel: 1, clears: 0, selected: 1 }; }

// save.level is the frontier: the first level not yet beaten. Anything from 1 up
// to it can be fought; only a win AT the frontier is a first clear.
function normalizeSave(s) {
  if (!s.selected || s.selected > s.level || s.selected < 1) s.selected = s.level;
  return s;
}
function levelName(L) { return L % 5 === 0 ? `GUARD ${L / 5}` : `LEVEL ${L}`; }

let save = loadSave();

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const s = Object.assign(freshSave(), JSON.parse(raw));
      s.wallet = Object.assign(emptyWallet(), s.wallet);
      return normalizeSave(s);
    }
    // v2 had a single salvage pool: carry it over as red and blue, keep upgrades.
    const old = localStorage.getItem(OLD_SAVE_KEY);
    if (old) {
      const o = JSON.parse(old);
      const s = Object.assign(freshSave(), { upgrades: o.upgrades || {}, level: o.level || 1,
                                             bestLevel: o.bestLevel || 1, clears: o.clears || 0 });
      const half = Math.floor((o.salvage || 0) / 2);
      s.wallet.red = half;
      s.wallet.blue = (o.salvage || 0) - half;
      return normalizeSave(s);
    }
  } catch (e) { /* blocked storage: run in memory */ }
  return freshSave();
}

function writeSave() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) {}
}

// ---------- upgrades ----------
// A tree rooted at FIGHT. A node unlocks once its parent has at least one
// level; `pos` is its place on the hangar map in grid units from the centre.
// Branches: weapons (up), defence (left), pulse and drones (right), salvage
// and engines (down).
const UPGRADES = [
  // weapons
  { id: 'damage',      name: 'Rail Slugs',      code: 'DMG', parent: null,        pos: [0, -1.6],
    max: 8, base: 45,  step: 1.36, price: { red: 1 },
    desc: l => `+${l * 25}% bullet damage` },
  { id: 'firerate',    name: 'Feed Servos',     code: 'ROF', parent: 'damage',    pos: [-1.6, -2.6],
    max: 8, base: 45,  step: 1.36, price: { red: 1 },
    desc: l => `+${Math.round(0.16 * l * 100)}% fire rate` },
  { id: 'velocity',    name: 'Coil Barrel',     code: 'VEL', parent: 'damage',    pos: [1.6, -2.6],
    max: 5, base: 50,  step: 1.4,  price: { red: 1 },
    desc: l => `+${l * 15}% bullet speed` },
  { id: 'gunHunter',   name: 'Turret Hunter',   code: 'GUN', parent: 'damage',    pos: [0, -3.3],
    max: 5, base: 70,  step: 1.45, price: { red: 1 },
    desc: l => `+${l * 25}% damage to gun blocks` },
  { id: 'coreBreaker', name: 'Core Breaker',    code: 'CORE', parent: 'gunHunter', pos: [0, -4.6],
    max: 5, base: 150, step: 1.7,  price: { red: 1, white: 0.03 },
    desc: l => `+${l * 30}% damage to the core` },
  { id: 'multi',       name: 'Split Barrel',    code: 'x2',  parent: 'firerate',  pos: [-3.1, -3.1],
    max: 4, base: 130, step: 1.85, price: { red: 1, white: 0.03 },
    desc: l => `+${l} projectile${l > 1 ? 's' : ''} per shot` },
  { id: 'crit',        name: 'Weak Point Scan', code: 'CRT', parent: 'firerate',  pos: [-1.6, -4.1],
    max: 5, base: 140, step: 1.7,  price: { red: 1, white: 0.02 },
    desc: l => `${l * 8}% chance to deal double damage` },
  { id: 'explosive',   name: 'Volatile Rounds', code: 'BOOM', parent: 'multi',    pos: [-4.6, -3.6],
    max: 4, base: 170, step: 1.85, price: { red: 1, white: 0.03 },
    desc: l => `hits splash ${28 + l * 12}px into the hull` },
  { id: 'pierce',      name: 'Penetrator',      code: 'PRC', parent: 'velocity',  pos: [1.6, -4.1],
    max: 3, base: 180, step: 1.9,  price: { red: 1, white: 0.03 },
    desc: l => `rounds punch through ${l} extra block${l > 1 ? 's' : ''}` },
  { id: 'ricochet',    name: 'Ricochet Rounds', code: 'RIC', parent: 'velocity',  pos: [3.1, -3.1],
    max: 3, base: 150, step: 1.9,  price: { blue: 1, white: 0.03 },
    desc: l => `rounds bounce ${l}x off the arena` },
  { id: 'homing',      name: 'Seeker Rounds',   code: 'SEEK', parent: 'ricochet', pos: [4.6, -3.6],
    max: 3, base: 165, step: 1.85, price: { blue: 1, white: 0.03 },
    desc: l => `rounds curve toward armour` },

  // defence
  { id: 'hull',        name: 'Plating',         code: 'HULL', parent: null,       pos: [-2.2, 0],
    max: 6, base: 85,  step: 1.48, price: { blue: 1 },
    desc: l => `+${l * 25} hull` },
  { id: 'regen',       name: 'Nanite Repair',   code: 'REP', parent: 'hull',      pos: [-3.7, -0.9],
    max: 5, base: 110, step: 1.55, price: { blue: 1 },
    desc: l => `repair ${(l * 1.5).toFixed(1)} hull per second` },
  { id: 'shield',      name: 'Deflector',       code: 'SHLD', parent: 'hull',     pos: [-3.7, 0.9],
    max: 6, base: 95,  step: 1.52, price: { blue: 1 },
    desc: l => `+${l * 20} shield, recharges out of fire` },
  { id: 'shieldRegen', name: 'Capacitor Bank',  code: 'CHG', parent: 'shield',    pos: [-5.2, 0.3],
    max: 5, base: 100, step: 1.5,  price: { blue: 1 },
    desc: l => `shield recharges ${l * 30}% faster` },
  { id: 'invuln',      name: 'Phase Frame',     code: 'PHS', parent: 'shield',    pos: [-5.2, 1.7],
    max: 4, base: 130, step: 1.6,  price: { blue: 1, white: 0.02 },
    desc: l => `+${(l * 0.15).toFixed(2)}s invulnerable after a hit` },

  // pulse and drones
  { id: 'pulse',       name: 'Pulse Capacitor', code: 'PLS', parent: null,        pos: [2.2, 0],
    max: 5, base: 115, step: 1.5,  price: { blue: 1, white: 0.02 },
    desc: l => `pulse charges ${l * 20}% faster` },
  { id: 'pulseRadius', name: 'Wide Emitter',    code: 'RAD', parent: 'pulse',     pos: [3.7, -0.9],
    max: 4, base: 90,  step: 1.5,  price: { blue: 1 },
    desc: l => `+${l * 15}% pulse radius` },
  { id: 'pulseDmg',    name: 'Overcharge',      code: 'OVR', parent: 'pulseRadius', pos: [5.2, -1.4],
    max: 5, base: 110, step: 1.55, price: { blue: 1 },
    desc: l => `+${l * 40}% pulse damage` },
  { id: 'drone',       name: 'Turret Drone',    code: 'DRN', parent: 'pulse',     pos: [3.7, 0.9],
    max: 4, base: 210, step: 1.9,  price: { red: 0.6, blue: 0.6, white: 0.04 },
    desc: l => `${l} drone${l > 1 ? 's' : ''} orbit and fire for you` },
  { id: 'droneRate',   name: 'Drone Loaders',   code: 'DRF', parent: 'drone',     pos: [5.2, 0.4],
    max: 4, base: 180, step: 1.7,  price: { red: 0.6, blue: 0.6 },
    desc: l => `drones fire ${l * 25}% faster` },
  { id: 'droneDmg',    name: 'Drone Ordnance',  code: 'DRD', parent: 'drone',     pos: [5.2, 1.8],
    max: 4, base: 200, step: 1.75, price: { red: 0.6, blue: 0.6, white: 0.03 },
    desc: l => `+${l * 30}% drone damage` },

  // salvage and engines
  { id: 'magnet',      name: 'Tractor Coil',    code: 'MAG', parent: null,        pos: [0, 1.8],
    max: 5, base: 65,  step: 1.42, price: { red: 0.5, blue: 0.5 },
    desc: l => `+${l * 40}% salvage pickup range` },
  { id: 'speed',       name: 'Thrusters',       code: 'SPD', parent: 'magnet',    pos: [-1.6, 2.8],
    max: 5, base: 75,  step: 1.42, price: { blue: 1 },
    desc: l => `+${l * 10}% top speed` },
  { id: 'redYield',    name: 'Shard Refinery',  code: 'RED', parent: 'magnet',    pos: [0, 3.2],
    max: 5, base: 120, step: 1.6,  price: { blue: 1 },
    desc: l => `+${l * 20}% red from gun blocks and cores` },
  { id: 'blueYield',   name: 'Orb Condenser',   code: 'BLU', parent: 'magnet',    pos: [1.6, 2.8],
    max: 5, base: 120, step: 1.6,  price: { red: 1 },
    desc: l => `+${l * 20}% blue from armour and cores` },
  { id: 'whiteYield',  name: 'Crystal Lattice', code: 'WHT', parent: 'blueYield', pos: [3.1, 3.4],
    max: 3, base: 250, step: 1.9,  price: { red: 0.7, blue: 0.7, white: 0.05 },
    desc: l => `+${l} white crystal${l > 1 ? 's' : ''} per core` },
];
const UP_BY_ID = Object.fromEntries(UPGRADES.map(u => [u.id, u]));

function lvlOf(id) { return save.upgrades[id] || 0; }
function isUnlocked(up) { return !up.parent || lvlOf(up.parent) > 0; }
// A price is a weight per currency, scaled by the level curve. Every currency an
// upgrade needs costs at least 1, so a white-crystal line never becomes free.
function costOf(up, level) {
  const scale = up.base * Math.pow(up.step, level);
  const cost = {};
  for (const k in up.price) cost[k] = Math.max(1, Math.round(scale * up.price[k]));
  return cost;
}
function canAfford(cost) { return Object.keys(cost).every(k => save.wallet[k] >= cost[k]); }

let S = {};
function computeStats() {
  const L = lvlOf;
  S = {
    damage:      Math.round(10 * (1 + 0.25 * L('damage'))),
    fireDelay:   0.15 / (1 + 0.16 * L('firerate')),
    shotSpeed:   760 * (1 + 0.15 * L('velocity')),
    shots:       1 + L('multi'),
    crit:        0.08 * L('crit'),
    pierce:      L('pierce'),
    gunMult:     1 + 0.25 * L('gunHunter'),
    coreMult:    1 + 0.30 * L('coreBreaker'),
    ricochet:    L('ricochet'),
    splash:      L('explosive') ? 28 + L('explosive') * 12 : 0,
    homing:      L('homing'),
    maxHull:     100 + L('hull') * 25,
    regen:       1.5 * L('regen'),
    maxShield:   L('shield') * 20,
    shieldRate:  14 * (1 + 0.30 * L('shieldRegen')),
    shieldDelay: 2.5 * (1 - 0.12 * L('shieldRegen')),
    iframes:     0.55 + 0.15 * L('invuln'),
    pulseRate:   1 + 0.20 * L('pulse'),
    pulseRadius: 260 * (1 + 0.15 * L('pulseRadius')),
    pulseDmg:    4 * (1 + 0.40 * L('pulseDmg')),
    drones:      L('drone'),
    droneDelay:  0.5 / (1 + 0.25 * L('droneRate')),
    droneDmg:    0.6 * (1 + 0.30 * L('droneDmg')),
    topSpeed:    340 * (1 + 0.10 * L('speed')),
    magnet:      150 * (1 + 0.40 * L('magnet')),
    yield:       { red: 1 + 0.2 * L('redYield'), blue: 1 + 0.2 * L('blueYield'), white: 1 },
    whiteBonus:  L('whiteYield'),
  };
}
computeStats();

// ---------- world state ----------
// Declared before resize() runs: these are `let` bindings, so touching them
// earlier would throw on the temporal dead zone rather than read as undefined.
let mode = 'title';           // title | hangar | fight | cleared | dead
let player, boss, shots, flak, orbs, particles, drones, stars, nebulae, beams;
let runWallet = emptyWallet(), popups = [];
let elapsed, shake, hitFlash, paused, fireTimer, pulseRing, titleTime;

// ---------- viewport ----------
let fieldW = 0, fieldH = 0;

function reflowField() {
  if (!stars) return;
  const w = W, h = H;
  if (!fieldW || !fieldH) {
    stars.forEach(s => { s.x = rand(0, w); s.y = rand(0, h); });
    nebulae.forEach(n => { n.x = rand(0, w); n.y = rand(0, h); });
    if (player) { player.x = w / 2; player.y = h * 0.75; }
  } else {
    const sx = w / fieldW, sy = h / fieldH;
    stars.forEach(s => { s.x *= sx; s.y *= sy; });
    nebulae.forEach(n => { n.x *= sx; n.y *= sy; });
    if (player) { player.x *= sx; player.y *= sy; }
  }
  if (boss) boss.cell = cellSize();
  fieldW = w; fieldH = h;
}

function resize() {
  DPR = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  screenCtx.setTransform(DPR, 0, 0, DPR, 0, 0);   // resizing a canvas resets its transform
  reflowField();
}
window.addEventListener('resize', resize);
document.addEventListener('fullscreenchange', resize);

// Blocks scale with the screen, so a fullscreen boss fills the space it has
// rather than sitting small in the middle of a big monitor.
function cellSize() { return clamp(Math.round(Math.min(W, H) / 19), 32, 46); }

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
}

// The fullscreen button, bottom right on every menu screen.
function fsButton() { return { x: W - 14 - 190, y: H - 14 - 40, w: 190, h: 40 }; }
function drawFsButton() {
  const b = fsButton();
  const on = !!document.fullscreenElement;
  panel(b.x, b.y, b.w, b.h, '#8fd0c6', 'rgba(26,32,38,0.92)');
  ctx.textAlign = 'center';
  ctx.font = font(8);
  ctx.fillStyle = '#cfe9e4';
  ctx.fillText(on ? '[F] WINDOWED' : '[F] FULLSCREEN', b.x + b.w / 2, b.y + 25);
  ctx.textAlign = 'left';
}
function inRect(r, x, y) { return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
resize();

// ---------- input ----------
const keys = {};
window.addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; });
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

const mouse = { x: W / 2, y: H / 2, down: false };
window.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
window.addEventListener('mousedown', () => { mouse.down = true; });
window.addEventListener('mouseup', () => { mouse.down = false; });

// ---------- world ----------
function makeField() {
  stars = [];
  for (let i = 0; i < 220; i++) {
    stars.push({ x: rand(0, W), y: rand(0, H), layer: rand(0.2, 1), size: rand(0.5, 2) });
  }
  nebulae = [];
  const colors = ['#3a1f6b', '#0f4c5c', '#5c1f4c'];
  for (let i = 0; i < 4; i++) {
    nebulae.push({
      x: rand(0, W), y: rand(0, H), r: rand(150, 320),
      color: colors[i % colors.length], dx: rand(-4, 4), dy: rand(-4, 4),
    });
  }
  fieldW = W; fieldH = H;
}
makeField();

function makePlayer() {
  computeStats();
  player = {
    x: W / 2, y: H * 0.75,
    vx: 0, vy: 0, angle: -Math.PI / 2,
    radius: 22,        // drawn size
    hitRadius: 14,     // The hitbox stays tighter than the hull, the way bullet
                       // hells do it, so a bigger ship is not a harder game.
    hull: S.maxHull, shield: S.maxShield, shieldTimer: 0,
    pulse: 0, maxPulse: 100, invuln: 0, trail: [],
  };
}

// ---------- boss construction ----------
// Blocks live on a grid in the boss's local space and rotate with it, so a hit
// test is one inverse rotation plus an O(1) grid lookup.
const GUN_UNLOCK = [
  { type: 'aimed',  from: 1 },
  { type: 'spread', from: 3 },
  { type: 'spiral', from: 5 },
  { type: 'seeker', from: 7 },
  { type: 'laser',  from: 9 },
];

function makeGun(type, level) {
  const g = { type, timer: rand(0.4, 2), phase: rand(0, Math.PI * 2), state: 'idle', charge: 0 };
  if (type === 'aimed')  g.reload = Math.max(0.55, 1.5 - level * 0.04);
  if (type === 'spread') g.reload = Math.max(1.3, 2.6 - level * 0.05);
  if (type === 'spiral') g.reload = 0.13;
  if (type === 'seeker') g.reload = Math.max(1.8, 3.2 - level * 0.06);
  if (type === 'laser')  g.reload = Math.max(2.4, 4.2 - level * 0.07);
  return g;
}

function makeBoss(level) {
  const guardian = level % 5 === 0;
  const cols = oddClamp(5 + 2 * Math.floor((level - 1) / 3) + (guardian ? 2 : 0), 5, 13);
  const rows = oddClamp(5 + 2 * Math.floor((level - 1) / 4), 5, 11);
  const cell = cellSize();
  const midC = (cols - 1) / 2, midR = (rows - 1) / 2;
  const density = 0.58 + Math.min(0.28, level * 0.015);
  const armourHp = 10 * (3 + Math.floor(level * 0.9) + (guardian ? 2 : 0));

  const grid = [];
  for (let r = 0; r < rows; r++) { grid[r] = []; for (let c = 0; c < cols; c++) grid[r][c] = null; }
  const blocks = [];

  function put(r, c, kind, hp) {
    if (grid[r][c]) return null;
    const b = { r, c, kind, hp, maxHp: hp, alive: true, flash: 0, gun: null, seed: Math.random() };
    grid[r][c] = b;
    blocks.push(b);
    return b;
  }

  // The core is laid down FIRST, so the armour pass cannot claim the centre
  // cell -- put() refuses an occupied cell, which keeps it one block per cell.
  // Built the other way round, the overwritten armour block stays in
  // boss.blocks sharing the core's coordinates, and killing that phantom (the
  // pulse and splash damage walk boss.blocks, not the grid) clears the core out
  // of the grid: still drawn, but impossible to hit.
  const coreHp = 10 * (28 + level * 9) * (guardian ? 2.2 : 1);
  const core = put(midR, midC, 'core', Math.round(coreHp));

  // Mirrored silhouette, so every boss reads as a built machine rather than noise.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c <= Math.floor(cols / 2); c++) {
      const nx = (c - midC) / (cols / 2), ny = (r - midR) / (rows / 2);
      const d = Math.hypot(nx, ny);
      if (!(d < 0.5 || Math.random() < density * (1 - d * 0.55))) continue;
      put(r, c, 'armour', armourHp);
      const mc = cols - 1 - c;
      if (mc !== c) put(r, mc, 'armour', armourHp);
    }
  }

  // Guns replace armour blocks, preferring the outside where you can reach them.
  const gunCount = Math.min(11, 2 + Math.floor(level / 2) + (guardian ? 3 : 0));
  const pool = blocks
    .filter(b => b.kind === 'armour')
    .sort((a, b) => (Math.hypot(b.c - midC, b.r - midR) - Math.hypot(a.c - midC, a.r - midR)) + rand(-0.9, 0.9));
  const open = GUN_UNLOCK.filter(u => level >= u.from);
  for (let i = 0; i < Math.min(gunCount, pool.length); i++) {
    const b = pool[i];
    b.kind = 'gun';
    b.hp = b.maxHp = Math.max(20, Math.round(armourHp * 0.7));
    b.gun = makeGun(open[i % open.length].type, level);
  }

  const armourTotal = blocks.filter(b => b.kind !== 'core').length;
  return {
    x: W / 2, y: H * 0.34, angle: 0,
    spin: (Math.random() < 0.5 ? -1 : 1) * (0.10 + level * 0.012),
    t: rand(0, 10), cols, rows, cell, grid, blocks, core, level, guardian,
    armourTotal, armourLeft: armourTotal, sealed: true,
  };
}

function blockLocal(b) {
  return { x: (b.c - (boss.cols - 1) / 2) * boss.cell, y: (b.r - (boss.rows - 1) / 2) * boss.cell };
}

function blockWorld(b) {
  const l = blockLocal(b);
  const cos = Math.cos(boss.angle), sin = Math.sin(boss.angle);
  return { x: boss.x + l.x * cos - l.y * sin, y: boss.y + l.x * sin + l.y * cos };
}

function blockAtWorld(x, y) {
  const dx = x - boss.x, dy = y - boss.y;
  const cos = Math.cos(-boss.angle), sin = Math.sin(-boss.angle);
  const lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
  const c = Math.round(lx / boss.cell + (boss.cols - 1) / 2);
  const r = Math.round(ly / boss.cell + (boss.rows - 1) / 2);
  if (r < 0 || r >= boss.rows || c < 0 || c >= boss.cols) return null;
  const b = boss.grid[r][c];
  if (!b || !b.alive) return null;
  const l = blockLocal(b);
  if (Math.abs(lx - l.x) > boss.cell / 2 || Math.abs(ly - l.y) > boss.cell / 2) return null;
  return b;
}

// ---------- fight lifecycle ----------
function startFight(level) {
  makePlayer();
  const L = clamp(level || save.selected, 1, save.level);
  boss = makeBoss(L);
  boss.firstClear = L === save.level;
  shots = []; flak = []; orbs = []; particles = []; beams = [];
  drones = [];
  for (let i = 0; i < S.drones; i++) drones.push({ phase: (Math.PI * 2 * i) / S.drones, timer: rand(0, 0.5), x: 0, y: 0 });
  runWallet = emptyWallet();
  popups = [];
  elapsed = 0; shake = 0; hitFlash = 0; fireTimer = 0; pulseRing = null;
  paused = false;
  mode = 'fight';
}

function spawnParticles(x, y, color, count, speed = 120) {
  for (let i = 0; i < count; i++) {
    const a = rand(0, Math.PI * 2), s = rand(speed * 0.2, speed);
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.3, 0.7), age: 0, color, size: rand(1.5, 3.5) });
  }
}

function breakBlock(b) {
  if (!b.alive) return;
  b.alive = false;
  // Only vacate the cell if it still holds this block, so a block can never
  // evict whatever else is standing there.
  if (boss.grid[b.r][b.c] === b) boss.grid[b.r][b.c] = null;
  const w = blockWorld(b);
  const isCore = b.kind === 'core';
  spawnParticles(w.x, w.y, BLOCK_COLOR[b.kind], isCore ? 60 : 14, isCore ? 340 : 130);
  shake = Math.max(shake, isCore ? 30 : 5);

  // Every block pays out, in its own colour.
  const L = boss.level;
  const drop = (cur, n, value) => {
    for (let i = 0; i < n; i++) {
      orbs.push({ x: w.x + rand(-8, 8), y: w.y + rand(-8, 8), vx: rand(-80, 80), vy: rand(-80, 80),
                  r: 5, cur, value: Math.max(1, Math.round(value * (S.yield[cur] || 1))) });
    }
  };
  if (b.kind === 'armour') drop('blue', 2, (2 + L * 0.8) / 2);
  if (b.kind === 'gun')    drop('red', 3, (6 + L * 2.4) / 3);
  if (isCore) {
    const g = boss.guardian ? 2 : 1;
    // White crystals are the first-clear reward. Replays still pay red and blue,
    // and those scale with the level, so farming a harder boss pays more.
    if (boss.firstClear) drop('white', 3 + Math.floor(L / 2) * g + S.whiteBonus, 1);
    drop('red', 6, (20 + L * 6) * g / 6);
    drop('blue', 6, (20 + L * 6) * g / 6);
  }

  if (isCore) {
    clearFight();
    return;
  }
  boss.armourLeft--;
  if (boss.armourLeft <= boss.armourTotal * 0.2) boss.sealed = false;
}

function damageBlock(b, dmg, crit) {
  if (!b.alive) return;
  if (b.kind === 'core' && boss.sealed) { b.flash = 0.08; return; }
  b.hp -= dmg;
  b.flash = 0.1;
  // Arcade-style damage numbers, capped so a drone swarm cannot flood the screen.
  if (popups.length < 70) {
    const w = blockWorld(b);
    popups.push({ x: w.x + rand(-6, 6), y: w.y + rand(-6, 6), text: String(Math.round(dmg)), crit: !!crit, age: 0, life: crit ? 0.8 : 0.55 });
  }
  if (b.hp <= 0) breakBlock(b);
}

function splashDamage(x, y, radius, dmg) {
  boss.blocks.forEach(b => {
    if (!b.alive) return;
    const w = blockWorld(b);
    if (dist(w.x, w.y, x, y) < radius) damageBlock(b, dmg);
  });
}

function bankRun() { CUR_ORDER.forEach(k => { save.wallet[k] += runWallet[k]; }); }

function clearFight() {
  // Killing the core ends the fight instantly, so anything still drifting --
  // including the core's own payout -- would be unreachable. The wreck is
  // salvaged for you. (Dying does not: uncollected orbs are the risk.)
  orbs.forEach(o => { runWallet[o.cur] += o.value; });
  orbs = [];
  bankRun();
  save.clears++;
  if (boss.firstClear) {
    save.level++;
    save.selected = save.level;
    if (save.level > save.bestLevel) save.bestLevel = save.level;
  }
  writeSave();
  mode = 'cleared';
}

function failFight() {
  // You keep what you actually picked up -- cash out is the point of the loop.
  bankRun();
  writeSave();
  mode = 'dead';
  spawnParticles(player.x, player.y, '#7fd8ff', 50, 330);
}

// ---------- enemy fire ----------
function addFlak(x, y, angle, speed, r, color, homing) {
  flak.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, r, color: color || '#ff5470', homing: homing || 0, life: 9 });
}

function runGun(b, dt) {
  const g = b.gun, w = blockWorld(b);
  const toPlayer = Math.atan2(player.y - w.y, player.x - w.x);
  const outward = Math.atan2(w.y - boss.y, w.x - boss.x);
  g.timer -= dt;

  if (g.type === 'laser') {
    if (g.state === 'idle' && g.timer <= 0) { g.state = 'charge'; g.charge = 0.9; g.aim = toPlayer; }
    else if (g.state === 'charge') {
      g.charge -= dt;
      if (g.charge <= 0) { g.state = 'fire'; g.charge = 0.45; }
    } else if (g.state === 'fire') {
      g.charge -= dt;
      if (g.charge <= 0) { g.state = 'idle'; g.timer = g.reload; }
    }
    if (g.state !== 'idle') {
      beams.push({ x: w.x, y: w.y, angle: g.aim, len: Math.hypot(W, H), firing: g.state === 'fire' });
    }
    return;
  }

  if (g.timer > 0) return;
  g.timer = g.reload;
  if (g.type === 'aimed') {
    addFlak(w.x, w.y, toPlayer, 260, 5);
  } else if (g.type === 'spread') {
    const n = 8;
    for (let i = 0; i < n; i++) addFlak(w.x, w.y, outward + (Math.PI * 2 * i) / n, 200, 5, '#ff7ab0');
  } else if (g.type === 'spiral') {
    g.phase += 0.55;
    addFlak(w.x, w.y, g.phase, 205, 4.5, '#ffa8d8');
  } else if (g.type === 'seeker') {
    addFlak(w.x, w.y, outward, 130, 6, '#ff4d4d', 2.2);
  }
}

// ---------- player fire ----------
function nearestBlock(x, y) {
  let best = null, bd = Infinity;
  boss.blocks.forEach(b => {
    if (!b.alive) return;
    if (b.kind === 'core' && boss.sealed) return;
    const w = blockWorld(b);
    const d = dist(w.x, w.y, x, y);
    if (d < bd) { bd = d; best = w; }
  });
  return best;
}

function firePlayer() {
  const spread = 0.09;
  for (let i = 0; i < S.shots; i++) {
    const off = (i - (S.shots - 1) / 2) * spread;
    const a = player.angle + off;
    shots.push({
      x: player.x + Math.cos(a) * player.radius,
      y: player.y + Math.sin(a) * player.radius,
      vx: Math.cos(a) * S.shotSpeed, vy: Math.sin(a) * S.shotSpeed,
      r: 5, dmg: S.damage, bounces: S.ricochet, pierce: S.pierce, last: null,
    });
  }
}

function fireDrone(d) {
  const t = nearestBlock(d.x, d.y);
  if (!t) return;
  const a = Math.atan2(t.y - d.y, t.x - d.x);
  shots.push({ x: d.x, y: d.y, vx: Math.cos(a) * 700, vy: Math.sin(a) * 700, r: 3, dmg: S.damage * S.droneDmg, bounces: 0 });
}

// ---------- update ----------
function driftField(dt, vx, vy) {
  stars.forEach(s => {
    s.x -= vx * s.layer * 0.25 * dt; s.y -= vy * s.layer * 0.25 * dt;
    if (s.x < 0) s.x += W; else if (s.x > W) s.x -= W;
    if (s.y < 0) s.y += H; else if (s.y > H) s.y -= H;
  });
  nebulae.forEach(n => {
    n.x += n.dx * dt; n.y += n.dy * dt;
    if (n.x < -n.r) n.x = W + n.r;
    if (n.x > W + n.r) n.x = -n.r;
    if (n.y < -n.r) n.y = H + n.r;
    if (n.y > H + n.r) n.y = -n.r;
  });
}

function hurtPlayer(amount) {
  if (player.invuln > 0) return;
  player.invuln = S.iframes;
  player.shieldTimer = S.shieldDelay;
  if (player.shield > 0) {
    player.shield -= amount;
    if (player.shield < 0) { player.hull += player.shield; player.shield = 0; }
  } else {
    player.hull -= amount;
  }
  shake = Math.max(shake, 11);
  hitFlash = 0.2;
  spawnParticles(player.x, player.y, '#ff4d4d', 12);
  if (player.hull <= 0) { player.hull = 0; failFight(); }
}

function update(dt) {
  elapsed += dt;
  beams = [];

  // --- ship ---
  let ax = 0, ay = 0;
  if (keys['w'] || keys['arrowup']) ay -= 1;
  if (keys['s'] || keys['arrowdown']) ay += 1;
  if (keys['a'] || keys['arrowleft']) ax -= 1;
  if (keys['d'] || keys['arrowright']) ax += 1;
  const mag = Math.hypot(ax, ay);
  if (mag > 0) { ax /= mag; ay /= mag; }

  player.vx += ax * 1900 * dt;
  player.vy += ay * 1900 * dt;
  const sp = Math.hypot(player.vx, player.vy);
  if (sp > S.topSpeed) { player.vx = (player.vx / sp) * S.topSpeed; player.vy = (player.vy / sp) * S.topSpeed; }
  player.vx -= player.vx * 6 * dt;
  player.vy -= player.vy * 6 * dt;
  player.x = clamp(player.x + player.vx * dt, player.radius, W - player.radius);
  player.y = clamp(player.y + player.vy * dt, player.radius, H - player.radius);
  player.angle = Math.atan2(mouse.y - player.y, mouse.x - player.x);

  if (mag > 0) player.trail.push({ x: player.x, y: player.y, age: 0, life: 0.32 });
  player.trail.forEach(p => (p.age += dt));
  player.trail = player.trail.filter(p => p.age < p.life);

  if (player.invuln > 0) player.invuln -= dt;
  if (S.regen) player.hull = Math.min(S.maxHull, player.hull + S.regen * dt);
  if (player.shieldTimer > 0) player.shieldTimer -= dt;
  else if (player.shield < S.maxShield) player.shield = Math.min(S.maxShield, player.shield + S.shieldRate * dt);

  fireTimer -= dt;
  if (mouse.down && fireTimer <= 0) { fireTimer = S.fireDelay; firePlayer(); }

  // --- pulse ---
  if (keys['e'] && player.pulse >= player.maxPulse) {
    player.pulse = 0;
    shake = Math.max(shake, 16);
    pulseRing = { r: 0, max: S.pulseRadius, age: 0, life: 0.45 };
    spawnParticles(player.x, player.y, '#9ff7ff', 40, 260);
    flak = flak.filter(f => dist(f.x, f.y, player.x, player.y) >= S.pulseRadius);
    splashDamage(player.x, player.y, S.pulseRadius, S.pulseDmg * S.damage);
  }

  // --- boss ---
  boss.t += dt;
  // The flight path shrinks to fit the boss, so a big Guardian never drifts off
  // the top of a short window. ext is the furthest any living block reaches while
  // spinning, so the path also opens up as the boss is shot down.
  let ext = 0;
  boss.blocks.forEach(b => { if (b.alive) { const l = blockLocal(b); ext = Math.max(ext, Math.hypot(l.x, l.y)); } });
  ext += boss.cell * 0.71;
  const swayX = Math.min(W * 0.2, Math.max(0, W / 2 - ext - 16));
  let midY = Math.max(H * 0.34, ext + 16 + H * 0.12);
  let swayY = H * 0.12;
  if (midY > H * 0.5) { midY = H * 0.5; swayY = Math.max(0, midY - ext - 16); }
  boss.x = W / 2 + Math.sin(boss.t * 0.33) * swayX;
  boss.y = midY + Math.sin(boss.t * 0.51) * swayY;
  boss.angle += boss.spin * dt;
  boss.blocks.forEach(b => {
    if (!b.alive) return;
    if (b.flash > 0) b.flash -= dt;
    if (b.gun) runGun(b, dt);
  });

  // --- drones ---
  drones.forEach(d => {
    d.phase += dt * 1.5;
    d.x = player.x + Math.cos(d.phase) * 52;
    d.y = player.y + Math.sin(d.phase) * 52;
    d.timer -= dt;
    if (d.timer <= 0) { d.timer = S.droneDelay; fireDrone(d); }
  });

  // --- player shots ---
  shots.forEach(s => {
    if (S.homing) {
      const t = nearestBlock(s.x, s.y);
      if (t) {
        const want = Math.atan2(t.y - s.y, t.x - s.x);
        const cur = Math.atan2(s.vy, s.vx);
        let diff = ((want - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        const turn = clamp(diff, -1, 1) * S.homing * 2.6 * dt;
        const spd = Math.hypot(s.vx, s.vy), na = cur + turn;
        s.vx = Math.cos(na) * spd; s.vy = Math.sin(na) * spd;
      }
    }
    s.x += s.vx * dt; s.y += s.vy * dt;
    if (s.bounces > 0) {
      if (s.x < 0 || s.x > W) { s.vx *= -1; s.x = clamp(s.x, 0, W); s.bounces--; }
      if (s.y < 0 || s.y > H) { s.vy *= -1; s.y = clamp(s.y, 0, H); s.bounces--; }
    }
  });
  shots = shots.filter(s => {
    const hit = blockAtWorld(s.x, s.y);
    if (hit && hit !== s.last) {
      let dmg = s.dmg * (hit.kind === 'gun' ? S.gunMult : hit.kind === 'core' ? S.coreMult : 1);
      const crit = Math.random() < S.crit;
      if (crit) dmg *= 2;
      damageBlock(hit, dmg, crit);
      if (S.splash) splashDamage(s.x, s.y, S.splash, s.dmg * 0.5);
      spawnParticles(s.x, s.y, '#ffd166', 5, 90);
      // a penetrator round keeps going, but never re-hits the block it is inside
      if (s.pierce > 0) { s.pierce--; s.last = hit; }
      else return false;
    }
    return s.x > -30 && s.x < W + 30 && s.y > -30 && s.y < H + 30;
  });
  if (mode !== 'fight') return;   // core just blew

  // --- enemy fire ---
  flak.forEach(f => {
    if (f.homing > 0) {
      const want = Math.atan2(player.y - f.y, player.x - f.x);
      const cur = Math.atan2(f.vy, f.vx);
      let diff = ((want - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const na = cur + clamp(diff, -1, 1) * f.homing * dt;
      const spd = Math.hypot(f.vx, f.vy);
      f.vx = Math.cos(na) * spd; f.vy = Math.sin(na) * spd;
    }
    f.x += f.vx * dt; f.y += f.vy * dt; f.life -= dt;
  });
  flak = flak.filter(f => {
    if (dist(f.x, f.y, player.x, player.y) < player.hitRadius + f.r) { hurtPlayer(9); return false; }
    return f.life > 0 && f.x > -40 && f.x < W + 40 && f.y > -40 && f.y < H + 40;
  });

  // --- beams ---
  beams.forEach(bm => {
    if (!bm.firing) return;
    const dx = Math.cos(bm.angle), dy = Math.sin(bm.angle);
    if (distToRay(player.x, player.y, bm.x, bm.y, dx, dy, bm.len) < player.hitRadius + 7) hurtPlayer(14);
  });

  // --- ramming the hull ---
  if (player.invuln <= 0 && blockAtWorld(player.x, player.y)) {
    const a = Math.atan2(player.y - boss.y, player.x - boss.x);
    player.vx = Math.cos(a) * 460; player.vy = Math.sin(a) * 460;
    hurtPlayer(16);
  }

  // --- salvage ---
  orbs.forEach(o => {
    const d = dist(o.x, o.y, player.x, player.y);
    if (d < S.magnet) {
      const a = Math.atan2(player.y - o.y, player.x - o.x);
      o.vx = Math.cos(a) * 300; o.vy = Math.sin(a) * 300;
    }
    o.x += o.vx * dt; o.y += o.vy * dt;
    o.vx -= o.vx * 1.5 * dt; o.vy -= o.vy * 1.5 * dt;
  });
  orbs = orbs.filter(o => {
    if (dist(o.x, o.y, player.x, player.y) < 20) {
      runWallet[o.cur] += o.value;
      player.pulse = Math.min(player.maxPulse, player.pulse + 6 * S.pulseRate);
      return false;
    }
    return true;
  });

  // --- dressing ---
  particles.forEach(p => {
    p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx -= p.vx * 3 * dt; p.vy -= p.vy * 3 * dt;
  });
  particles = particles.filter(p => p.age < p.life);
  popups.forEach(p => { p.age += dt; });
  popups = popups.filter(p => p.age < p.life);
  driftField(dt, player.vx, player.vy);
  if (pulseRing) {
    pulseRing.age += dt;
    pulseRing.r = pulseRing.max * (pulseRing.age / pulseRing.life);
    if (pulseRing.age >= pulseRing.life) pulseRing = null;
  }
  if (shake > 0) shake = Math.max(0, shake - dt * 40);
  if (hitFlash > 0) hitFlash -= dt;
}

function updateIdle(dt) { titleTime += dt; driftField(dt, 40, 14); }

// ---------- draw ----------
function drawBackdrop() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#07070f'); g.addColorStop(1, '#0c0c1a');
  ctx.fillStyle = g;
  ctx.fillRect(-40, -40, W + 80, H + 80);
  nebulae.forEach(n => {
    const rg = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r);
    rg.addColorStop(0, n.color + '33'); rg.addColorStop(1, n.color + '00');
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
  });
  stars.forEach(s => {
    ctx.fillStyle = `rgba(255,255,255,${0.4 + s.layer * 0.6})`;
    ctx.fillRect(s.x, s.y, s.size, s.size);
  });
}

const BLOCK_COLOR = { armour: '#8b7dff', gun: '#ff6b9f', core: '#9ff7ff' };

function roundRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Lighten (amt > 0) or darken (amt < 0) a #rrggbb colour.
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = i => clamp(Math.round(((n >> i) & 255) + amt * 255), 0, 255);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

// Cracks come off the block's own seed, so damage looks carved into that plate
// instead of flickering a fresh pattern every frame.
function drawCracks(b, h, hurt) {
  const n = hurt > 0.66 ? 3 : hurt > 0.38 ? 2 : 1;
  ctx.strokeStyle = 'rgba(6,6,16,0.7)';
  ctx.lineWidth = 1.3;
  for (let i = 0; i < n; i++) {
    const a = b.seed * 6.283 + i * 2.4;
    const ex = Math.cos(a) * h, ey = Math.sin(a) * h;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex * 0.45 + Math.cos(a + 1.7) * h * 0.3, ey * 0.45 + Math.sin(a + 1.7) * h * 0.3);
    ctx.lineTo(-ex * 0.2, -ey * 0.2);
    ctx.stroke();
  }
}

// Bevelled plate: lit from the top-left, inset panel, corner rivets.
function drawPlate(s, h, base, hurt) {
  ctx.fillStyle = shade(base, -0.08 - hurt * 0.2);
  roundRect(-h, -h, s, s, 4); ctx.fill();

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  ctx.moveTo(-h + 1.5, h - 1.5); ctx.lineTo(-h + 1.5, -h + 1.5); ctx.lineTo(h - 1.5, -h + 1.5);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.moveTo(h - 1.5, -h + 1.5); ctx.lineTo(h - 1.5, h - 1.5); ctx.lineTo(-h + 1.5, h - 1.5);
  ctx.stroke();

  ctx.fillStyle = shade(base, 0.12);
  roundRect(-h * 0.5, -h * 0.5, s * 0.5, s * 0.5, 2); ctx.fill();

  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    ctx.beginPath(); ctx.arc(sx * (h - 4.5), sy * (h - 4.5), 1.4, 0, Math.PI * 2); ctx.fill();
  }
}

// Turrets point their barrel away from the boss centre, so you can read which
// way a gun is facing before it fires.
function drawGunFace(b, h, base) {
  const l = blockLocal(b);
  const a = Math.atan2(l.y, l.x);
  ctx.save();
  ctx.rotate(a);
  ctx.fillStyle = shade(base, -0.34);
  ctx.fillRect(h * 0.3, -3.5, h + 4, 7);
  ctx.fillStyle = '#160a00';
  ctx.beginPath(); ctx.arc(h * 1.3 + 4, 0, 2.8, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = shade(base, 0.28);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, h * 0.44, 0, Math.PI * 2); ctx.stroke();
}

function drawCoreFace(s, h, hurt, sealed) {
  const pulse = 0.5 + 0.5 * Math.sin(elapsed * 4.5);
  ctx.fillStyle = sealed ? '#16323a' : '#0d3a44';
  roundRect(-h, -h, s, s, 5); ctx.fill();
  ctx.strokeStyle = sealed ? 'rgba(159,247,255,0.5)' : '#9ff7ff';
  ctx.lineWidth = 2;
  roundRect(-h + 2, -h + 2, s - 4, s - 4, 4); ctx.stroke();

  ctx.save();
  ctx.rotate(elapsed * 1.3);
  ctx.strokeStyle = `rgba(159,247,255,${sealed ? 0.4 : 0.85})`;
  ctx.lineWidth = 1.6;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * h * 0.5, Math.sin(a) * h * 0.5);
    ctx.lineTo(Math.cos(a) * h * 0.8, Math.sin(a) * h * 0.8);
    ctx.stroke();
  }
  ctx.restore();

  glowOn('#9ff7ff', sealed ? 6 : 16 + pulse * 16);
  ctx.fillStyle = sealed ? '#3d6f7d' : `rgb(${170 + Math.round(pulse * 70)},255,255)`;
  ctx.beginPath(); ctx.arc(0, 0, h * 0.36 * (1 - hurt * 0.3), 0, Math.PI * 2); ctx.fill();
  glowOff();
}

function drawBoss() {
  ctx.save();
  ctx.translate(boss.x, boss.y);
  ctx.rotate(boss.angle);
  const s = boss.cell - 3, h = s / 2;

  boss.blocks.forEach(b => {
    if (!b.alive) return;
    const l = blockLocal(b);
    const base = BLOCK_COLOR[b.kind];
    const sealed = b.kind === 'core' && boss.sealed;
    const hurt = 1 - b.hp / b.maxHp;

    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.globalAlpha = sealed ? 0.55 : 1;

    if (b.flash > 0) {
      ctx.fillStyle = '#ffffff';
      roundRect(-h, -h, s, s, 4); ctx.fill();
    } else if (b.kind === 'core') {
      drawCoreFace(s, h, hurt, sealed);
    } else {
      glowOn(base, 8);
      drawPlate(s, h, base, hurt);
      glowOff();
      if (b.kind === 'gun') drawGunFace(b, h, base);
      if (hurt > 0.12) drawCracks(b, h, hurt);
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  });

  // An exposed core gets a halo, so it reads as the target from across the arena.
  if (boss.core.alive && !boss.sealed) {
    const l = blockLocal(boss.core);
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 4.5);
    ctx.strokeStyle = `rgba(159,247,255,${0.3 + pulse * 0.45})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(l.x, l.y, boss.cell * (1.15 + pulse * 0.45), 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = `rgba(159,247,255,${0.12 + pulse * 0.16})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(l.x, l.y, boss.cell * (1.7 + pulse * 0.6), 0, Math.PI * 2); ctx.stroke();
  }

  ctx.restore();
}

// ---------- icons and panels ----------
CUR.white.text = '#eaf6ff';
CUR.red.text = '#ff8fb8';
CUR.blue.text = '#b0a6ff';

// Currency icon: a glowing diamond or orb. `cell` keeps the old sizing scale.
function currencyIcon(x, y, cur, cell) {
  const r = cell * 3.2, c = CUR[cur];
  ctx.save();
  glowOn(c.color, r * 1.2);
  ctx.fillStyle = c.color;
  ctx.beginPath();
  if (c.shape === 'diamond') {
    ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.72, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r * 0.72, y);
    ctx.closePath();
  } else {
    ctx.arc(x, y, r * 0.82, 0, Math.PI * 2);
  }
  ctx.fill();
  glowOff();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath(); ctx.arc(x - r * 0.2, y - r * 0.28, r * 0.18, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Translucent rounded panel with a thin neon edge, shared by HUD and menus.
function panel(x, y, w, h, border, fill) {
  roundRect(x, y, w, h, 8);
  ctx.fillStyle = fill || 'rgba(10,12,24,0.82)';
  ctx.fill();
  ctx.strokeStyle = border || 'rgba(127,216,255,0.45)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ---------- fight ----------
function drawWorld() {
  ctx.save();
  if (shake > 0) ctx.translate(rand(-shake, shake), rand(-shake, shake));
  drawBackdrop();

  // engine trail
  player.trail.forEach(p => {
    const a = 1 - p.age / p.life;
    ctx.fillStyle = `rgba(120,200,255,${a * 0.5})`;
    ctx.beginPath(); ctx.arc(p.x, p.y, 5 * a, 0, Math.PI * 2); ctx.fill();
  });

  if (pulseRing) {
    const a = 1 - pulseRing.age / pulseRing.life;
    ctx.strokeStyle = `rgba(159,247,255,${a * 0.9})`;
    ctx.lineWidth = 3 + a * 5;
    ctx.beginPath(); ctx.arc(player.x, player.y, pulseRing.r, 0, Math.PI * 2); ctx.stroke();
  }

  drawBoss();

  // beams: a thin telegraph while charging, a wide beam while firing
  beams.forEach(bm => {
    const ex = bm.x + Math.cos(bm.angle) * bm.len, ey = bm.y + Math.sin(bm.angle) * bm.len;
    glowOn('#ff4d6d', bm.firing ? 24 : 8);
    ctx.strokeStyle = bm.firing ? 'rgba(255,90,120,0.95)' : 'rgba(255,90,120,0.35)';
    ctx.lineWidth = bm.firing ? 14 : 2;
    ctx.beginPath(); ctx.moveTo(bm.x, bm.y); ctx.lineTo(ex, ey); ctx.stroke();
    glowOff();
  });

  particles.forEach(p => {
    ctx.globalAlpha = 1 - p.age / p.life;
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
  });
  ctx.globalAlpha = 1;

  orbs.forEach(o => currencyIcon(o.x, o.y, o.cur, 2));

  flak.forEach(f => {
    glowOn(f.color, 12);
    ctx.fillStyle = f.color;
    ctx.beginPath(); ctx.arc(f.x, f.y, f.r * 1.3 + 1, 0, Math.PI * 2); ctx.fill();
  });

  glowOn('#ffd166', 10);
  ctx.fillStyle = '#ffd166';
  shots.forEach(s => { ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill(); });

  glowOn('#7cffb2', 10);
  ctx.fillStyle = '#7cffb2';
  drones.forEach(d => { ctx.beginPath(); ctx.arc(d.x, d.y, 7, 0, Math.PI * 2); ctx.fill(); });

  // ship
  const hitWhite = player.invuln > 0;
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(player.angle);
  const r = player.radius;
  glowOn(hitWhite ? '#ffffff' : '#7fd8ff', 18);
  ctx.fillStyle = hitWhite ? '#ffffff' : '#7fd8ff';
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(-r * 0.8, r * 0.7);
  ctx.lineTo(-r * 0.4, 0);
  ctx.lineTo(-r * 0.8, -r * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  glowOff();

  if (player.shield > 0) {
    ctx.strokeStyle = `rgba(159,247,255,${0.25 + 0.4 * (player.shield / Math.max(1, S.maxShield))})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(player.x, player.y, player.radius + 8, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.restore();
}

function drawPopups() {
  ctx.textAlign = 'center';
  ctx.font = font(12);
  popups.forEach(p => {
    const a = 1 - p.age / p.life;
    const y = p.y - p.age * 45;
    ctx.globalAlpha = Math.min(1, a * 1.8);
    ctx.fillStyle = '#1a0d1e';
    ctx.fillText(p.text, p.x + 2, y + 2);
    ctx.fillStyle = p.crit ? '#ffd84a' : '#ffffff';
    ctx.fillText(p.crit ? p.text + '!' : p.text, p.x, y);
  });
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

function drawFight() {
  drawWorld();
  drawPopups();
  if (hitFlash > 0) {
    ctx.fillStyle = `rgba(255,60,60,${hitFlash * 0.3})`;
    ctx.fillRect(0, 0, W, H);
  }
  drawHUD();
  if (paused) drawPaused();
}

function bar(x, y, w, h, pct, color) {
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * clamp(pct, 0, 1), h);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
}

function drawHUD() {
  // ship panel, top left
  const rows = S.maxShield > 0 ? 3 : 2;
  panel(14, 14, 318, 22 + rows * 28);
  let y = 30;
  const row = (label, pct, color, text) => {
    ctx.textAlign = 'left';
    ctx.font = font(9);
    ctx.fillStyle = '#cfe9e4';
    ctx.fillText(label, 28, y + 13);
    bar(100, y, 218, 20, pct, color);
    if (text) {
      ctx.textAlign = 'center';
      ctx.font = font(8);
      ctx.fillStyle = '#1a0d1e';
      ctx.fillText(text, 210, y + 15);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, 209, y + 14);
    }
    y += 28;
  };
  row('HULL', player.hull / S.maxHull, '#4dff88', `${Math.ceil(player.hull)} / ${S.maxHull}`);
  if (S.maxShield > 0) row('SHLD', player.shield / S.maxShield, '#7fd8ff', `${Math.ceil(player.shield)} / ${S.maxShield}`);
  row('PULSE', player.pulse / player.maxPulse, '#9ff7ff', player.pulse >= player.maxPulse ? 'PRESS E' : null);

  // fight panel, top right: which fight, how sealed, and this run's haul
  const pw = 262, x0 = W - pw - 14;
  panel(x0, 14, pw, 116);
  ctx.textAlign = 'center';
  ctx.font = font(12);
  ctx.fillStyle = boss.guardian ? '#ff5a66' : '#ffffff';
  ctx.fillText(levelName(boss.level) + (boss.firstClear ? '' : ' - REPLAY'), x0 + pw / 2, 42);
  ctx.font = font(8);
  ctx.fillStyle = boss.sealed ? '#9d95ff' : '#ffd166';
  ctx.fillText(boss.sealed ? `ARMOUR ${Math.round((boss.armourLeft / boss.armourTotal) * 100)}%` : 'CORE EXPOSED!', x0 + pw / 2, 64);
  CUR_ORDER.forEach((k, i) => {
    const cx = x0 + 26 + i * 80;
    currencyIcon(cx, 96, k, 3);
    ctx.textAlign = 'left';
    ctx.font = font(9);
    ctx.fillStyle = CUR[k].text;
    ctx.fillText(`+${runWallet[k]}`, cx + 15, 101);
  });

  ctx.textAlign = 'left';
  ctx.font = font(7);
  ctx.fillStyle = 'rgba(207,233,228,0.55)';
  ctx.fillText('WASD MOVE   MOUSE AIM   CLICK FIRE   E PULSE   P PAUSE   F FULLSCREEN', 18, H - 16);
}

function drawPaused() {
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, W, H);
  panel(W / 2 - 170, H / 2 - 60, 340, 110);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = font(22);
  ctx.fillText('PAUSED', W / 2, H / 2 - 6);
  ctx.font = font(8);
  ctx.fillStyle = '#9fd3cc';
  ctx.fillText('P OR ESC TO RESUME', W / 2, H / 2 + 28);
  ctx.textAlign = 'left';
}

// A centred row of currency icons with amounts.
function walletRow(cy, wallet, prefix, cell) {
  cell = cell || 4;
  const colW = 150;
  const left = W / 2 - (colW * CUR_ORDER.length) / 2;
  CUR_ORDER.forEach((k, i) => {
    const x = left + i * colW + 24;
    currencyIcon(x, cy, k, cell);
    ctx.textAlign = 'left';
    ctx.font = font(12);
    ctx.fillStyle = CUR[k].text;
    ctx.fillText(`${prefix || ''}${wallet[k]}`, x + cell * 4 + 8, cy + 7);
  });
}

// ---------- hangar ----------
// The upgrade tree. Layout is computed once per frame and shared by the
// renderer and the click handler, so what you see is exactly what you can click.
function hangarLayout() {
  const top = 96, bottom = 34;
  const unit = Math.max(40, Math.min((W - 60) / 11.6, (H - top - bottom) / 9.4));
  const cx = W / 2;
  const cy = top + 5 * unit;
  const size = Math.round(unit * 0.66);
  const nodes = UPGRADES.map(up => {
    const level = lvlOf(up.id);
    const maxed = level >= up.max;
    const unlocked = isUnlocked(up);
    const cost = maxed ? {} : costOf(up, level);
    return {
      up, level, maxed, unlocked, cost,
      afford: unlocked && !maxed && canAfford(cost),
      x: cx + up.pos[0] * unit, y: cy + up.pos[1] * unit, size,
    };
  });
  const fight = { x: cx - unit * 0.95, y: cy - unit * 0.42, w: unit * 1.9, h: unit * 0.84 };
  const aw = unit * 0.34;
  fight.prev = { x: fight.x - aw - 8, y: cy - aw / 2, w: aw, h: aw };
  fight.next = { x: fight.x + fight.w + 8, y: cy - aw / 2, w: aw, h: aw };
  return { nodes, fight, cx, cy };
}

function nodeAt(nodes, mx, my) {
  return nodes.find(n => Math.abs(mx - n.x) <= n.size / 2 + 3 && Math.abs(my - n.y) <= n.size / 2 + 3) || null;
}

// Green means you can buy it right now. Gold is owned, teal is maxed, grey is
// available but out of reach, and near-black is still locked behind its parent.
function nodeStyle(n) {
  if (n.afford)    return { border: '#4dd06a', fill: 'rgba(22,72,36,0.96)', text: '#ffffff', link: '#4dd06a' };
  if (n.maxed)     return { border: '#8fd0c6', fill: 'rgba(20,40,44,0.96)', text: '#8fd0c6', link: '#8fd0c6' };
  if (!n.unlocked) return { border: '#2a3038', fill: 'rgba(12,14,18,0.96)', text: '#3a424c', link: '#232932' };
  if (n.level > 0) return { border: '#ffd84a', fill: 'rgba(42,38,18,0.96)', text: '#ffd84a', link: '#ffd84a' };
  return             { border: '#5d6875', fill: 'rgba(22,26,32,0.96)', text: '#9aa4b0', link: '#4a5462' };
}

function costRow(cost, rightX, baseY, dim) {
  let rx = rightX;
  Object.keys(cost).sort((a, b) => CUR_ORDER.indexOf(b) - CUR_ORDER.indexOf(a)).forEach(k => {
    const txt = String(cost[k]);
    ctx.font = font(8);
    ctx.textAlign = 'right';
    ctx.fillStyle = !dim && save.wallet[k] >= cost[k] ? CUR[k].text : '#5d6470';
    ctx.fillText(txt, rx, baseY);
    rx -= ctx.measureText(txt).width + 13;
    currencyIcon(rx + 4, baseY - 4, k, 2);
    rx -= 12;
  });
}

function drawTooltip(n) {
  const w = 320, h = 128;
  let x = n.x + n.size / 2 + 14;
  if (x + w > W - 10) x = n.x - n.size / 2 - 14 - w;
  const y = clamp(n.y - h / 2, 10, H - h - 10);
  const st = nodeStyle(n);
  panel(x, y, w, h, st.border, 'rgba(18,22,28,0.97)');

  ctx.textAlign = 'left';
  ctx.font = font(10);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(n.up.name.toUpperCase(), x + 16, y + 28);
  ctx.textAlign = 'right';
  ctx.font = font(8);
  ctx.fillStyle = '#9fd3cc';
  ctx.fillText(`LV ${n.level}/${n.up.max}`, x + w - 16, y + 28);

  ctx.textAlign = 'left';
  ctx.font = font(7);
  ctx.fillStyle = '#cfe9e4';
  const next = n.maxed ? n.level : n.level + 1;
  ctx.fillText((n.maxed ? 'NOW: ' : 'NEXT: ') + n.up.desc(next).toUpperCase(), x + 16, y + 56);

  ctx.font = font(8);
  if (!n.unlocked) {
    ctx.fillStyle = '#ff5a66';
    ctx.fillText(`LOCKED - NEEDS ${UP_BY_ID[n.up.parent].name.toUpperCase()}`, x + 16, y + 100);
  } else if (n.maxed) {
    ctx.fillStyle = '#8fd0c6';
    ctx.fillText('FULLY UPGRADED', x + 16, y + 100);
  } else {
    ctx.fillStyle = n.afford ? '#4dd06a' : '#8a93a0';
    ctx.fillText(n.afford ? 'CLICK TO BUY' : 'NOT ENOUGH', x + 16, y + 100);
    costRow(n.cost, x + w - 16, y + 100, false);
  }
}

function drawHangar() {
  drawBackdrop();
  ctx.fillStyle = 'rgba(5,5,12,0.5)';
  ctx.fillRect(0, 0, W, H);

  const { nodes, fight, cx, cy } = hangarLayout();
  const byId = Object.fromEntries(nodes.map(n => [n.up.id, n]));
  const blink = 0.5 + 0.5 * Math.sin(performance.now() / 180);

  // links first, so nodes sit on top of them
  nodes.forEach(n => {
    const from = n.up.parent ? byId[n.up.parent] : { x: cx, y: cy };
    const st = nodeStyle(n);
    ctx.strokeStyle = st.link;
    ctx.lineWidth = n.afford ? 4 : 3;
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(n.x, n.y); ctx.stroke();
  });

  // FIGHT sits at the root of every branch
  panel(fight.x, fight.y, fight.w, fight.h, '#7cf29a', '#2e8a45');
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = font(14);
  ctx.fillText('FIGHT', cx, cy + 2);
  ctx.font = font(7);
  ctx.fillStyle = '#c9ffd6';
  ctx.fillText(levelName(save.selected), cx, cy + 20);
  drawLevelPicker(fight, cx);

  const hover = nodeAt(nodes, mouse.x, mouse.y);
  nodes.forEach(n => {
    const st = nodeStyle(n);
    const s = n.size;
    if (n.afford) {
      // affordable nodes breathe, so they are easy to spot across the tree
      ctx.strokeStyle = `rgba(77,208,106,${0.25 + blink * 0.5})`;
      ctx.lineWidth = 3;
      ctx.strokeRect(n.x - s / 2 - 6, n.y - s / 2 - 6, s + 12, s + 12);
    }
    panel(n.x - s / 2, n.y - s / 2, s, s, n === hover ? '#ffffff' : st.border, st.fill);
    ctx.textAlign = 'center';
    ctx.font = font(n.up.code.length > 3 ? 7 : 8);
    ctx.fillStyle = st.text;
    ctx.fillText(n.up.code, n.x, n.y + 4);

    // level pips under the node
    const pw = 5, gap = 2, total = n.up.max * pw + (n.up.max - 1) * gap;
    for (let i = 0; i < n.up.max; i++) {
      ctx.fillStyle = i < n.level ? (n.maxed ? '#8fd0c6' : '#ffd84a') : '#2c333c';
      ctx.fillRect(n.x - total / 2 + i * (pw + gap), n.y + s / 2 + 5, pw, 4);
    }
  });

  // top bar: resources, title, player stats
  panel(14, 14, 330, 66);
  ctx.textAlign = 'left';
  ctx.font = font(7);
  ctx.fillStyle = '#9fd3cc';
  ctx.fillText('RESOURCES', 28, 34);
  CUR_ORDER.forEach((k, i) => {
    const x = 36 + i * 104;
    currencyIcon(x, 56, k, 3);
    ctx.font = font(10);
    ctx.textAlign = 'left';
    ctx.fillStyle = CUR[k].text;
    ctx.fillText(String(save.wallet[k]), x + 16, 62);
  });

  ctx.textAlign = 'center';
  ctx.font = font(22);
  glowOn('#7fd8ff', 22);
  ctx.fillStyle = '#eaf6ff';
  ctx.fillText('HANGAR', W / 2, 46);
  glowOff();
  ctx.font = font(7);
  ctx.fillStyle = '#9fd3cc';
  ctx.fillText(`BEST LEVEL ${save.bestLevel}`, W / 2, 70);

  const sx = W - 14 - 330;
  panel(sx, 14, 330, 66);
  ctx.textAlign = 'left';
  ctx.font = font(7);
  ctx.fillStyle = '#9fd3cc';
  ctx.fillText('PLAYER STATS', sx + 14, 34);
  ctx.font = font(9);
  [['DMG', S.damage, '#ff5a66'], ['HULL', S.maxHull, '#4dd06a'], ['SHLD', S.maxShield, '#3f9fd8']].forEach(([label, v, col], i) => {
    const x = sx + 14 + i * 106;
    ctx.fillStyle = '#8a93a0';
    ctx.font = font(7);
    ctx.fillText(label, x, 60);
    ctx.fillStyle = col;
    ctx.font = font(10);
    ctx.fillText(String(v), x + ctx.measureText(label).width + 12, 62);
  });

  ctx.textAlign = 'center';
  ctx.font = font(7);
  ctx.fillStyle = 'rgba(207,233,228,0.5)';
  ctx.fillText('GREEN = AFFORDABLE  -  CLICK TO BUY  -  ARROWS PICK LEVEL  -  ENTER FIGHTS  -  R RESETS SAVE',
               W / 2, H - 14);

  drawFsButton();
  if (hover) drawTooltip(hover);
  ctx.textAlign = 'left';
}

function hangarClick(mx, my) {
  const { nodes, fight } = hangarLayout();
  if (inRect(fight.prev, mx, my)) { pickLevel(-1); return; }
  if (inRect(fight.next, mx, my)) { pickLevel(1); return; }
  if (inRect(fight, mx, my)) {
    startFight(save.selected);
    return;
  }
  const n = nodeAt(nodes, mx, my);
  if (!n || !n.afford) return;
  for (const k in n.cost) save.wallet[k] -= n.cost[k];
  save.upgrades[n.up.id] = n.level + 1;
  computeStats();
  writeSave();
}

// ---------- other screens ----------
function centreText(lines, topY) {
  ctx.textAlign = 'center';
  let y = topY;
  lines.forEach(l => {
    ctx.font = l.font || font(10);
    if (l.glow) glowOn(l.glow, 24);
    ctx.fillStyle = l.color || '#eaf6ff';
    ctx.fillText(l.text, W / 2, y);
    glowOff();
    y += l.gap || 26;
  });
  ctx.textAlign = 'left';
  return y;
}

function drawTitle() {
  drawBackdrop();
  ctx.fillStyle = 'rgba(5,5,12,0.55)';
  ctx.fillRect(0, 0, W, H);
  const cy = H / 2;
  let y = centreText([
    { text: 'VOID SALVAGE', font: font(40), glow: '#7fd8ff', gap: 60 },
    { text: 'ONE SHIP AGAINST BOSSES BUILT FROM BLOCKS', color: '#cfe9e4', gap: 24 },
    { text: 'SHRED THE ARMOUR. EXPOSE THE CORE. BLOW IT.', color: '#cfe9e4', gap: 44 },
  ], cy - 110);
  if (save.bestLevel > 1 || CUR_ORDER.some(k => save.wallet[k] > 0)) {
    walletRow(y, save.wallet, '', 4);
    y += 44;
    y = centreText([{ text: `BEST LEVEL ${save.bestLevel}`, color: '#9fd3cc', font: font(8), gap: 40 }], y);
  } else {
    y = centreText([{ text: 'WASD MOVE - MOUSE AIM - CLICK FIRE - E PULSE', color: '#9fd3cc', font: font(8), gap: 40 }], y);
  }
  // hard on/off blink, like an attract-mode INSERT COIN
  if (Math.floor(titleTime * 2) % 2 === 0) {
    centreText([{ text: 'PRESS ANY KEY', color: '#ffd84a', font: font(14) }], y + 10);
  }
  drawFsButton();
}


// ---------- level picker ----------
function pickLevel(d) {
  save.selected = clamp(save.selected + d, 1, save.level);
  writeSave();
}

function drawLevelPicker(fight, cx) {
  const arrow = (r, glyph, enabled) => {
    const hot = enabled && inRect(r, mouse.x, mouse.y);
    panel(r.x, r.y, r.w, r.h, hot ? '#ffffff' : (enabled ? '#7cf29a' : '#2a3038'),
          enabled ? 'rgba(22,72,36,0.96)' : 'rgba(12,14,18,0.96)');
    ctx.textAlign = 'center';
    ctx.font = font(10);
    ctx.fillStyle = enabled ? '#ffffff' : '#3a424c';
    ctx.fillText(glyph, r.x + r.w / 2 + 1, r.y + r.h / 2 + 5);
  };
  arrow(fight.prev, '<', save.selected > 1);
  arrow(fight.next, '>', save.selected < save.level);

  // what this fight pays, above the button
  const first = save.selected === save.level;
  const tag = first ? 'NEW - FIRST CLEAR PAYS WHITE' : 'REPLAY - RED + BLUE ONLY';
  ctx.font = font(7);
  const tw = ctx.measureText(tag).width;
  ctx.fillStyle = 'rgba(5,5,12,0.9)';
  ctx.fillRect(cx - tw / 2 - 6, fight.y - 22, tw + 12, 16);
  ctx.textAlign = 'center';
  ctx.fillStyle = first ? '#ffd84a' : '#8a93a0';
  ctx.fillText(tag, cx, fight.y - 10);
}

// ---------- end screens ----------
// Nothing advances on a stray click: you pick where to go next.
function endButtons() {
  const L = boss ? boss.level : save.selected;
  const toHangar = () => { mode = 'hangar'; };
  const green = { fill: '#2e8a45', border: '#7cf29a' };
  const plain = { fill: 'rgba(26,32,38,0.95)', border: '#8fd0c6' };
  const defs = mode === 'cleared'
    ? [
        Object.assign({ label: 'NEXT LEVEL', key: 'n', act: () => startFight(Math.min(L + 1, save.level)) }, green),
        Object.assign({ label: 'REPLAY', key: 'r', act: () => startFight(L) }, plain),
        Object.assign({ label: 'HANGAR', key: 'h', act: toHangar }, plain),
      ]
    : [
        Object.assign({ label: 'RETRY', key: 'r', act: () => startFight(L) }, green),
        Object.assign({ label: 'HANGAR', key: 'h', act: toHangar }, plain),
      ];
  const bw = 168, bh = 50, gap = 16;
  const total = defs.length * bw + (defs.length - 1) * gap;
  return defs.map((d, i) => Object.assign(d, { x: W / 2 - total / 2 + i * (bw + gap), y: H / 2 + 50, w: bw, h: bh }));
}

function drawEndScreen(title, titleColor, subtitle, subtitleColor) {
  drawFightBackdropStill();
  const cy = H / 2;
  panel(W / 2 - 310, cy - 130, 620, 280);
  let y = centreText([
    { text: title, font: font(26), color: titleColor, glow: titleColor, gap: 44 },
    { text: subtitle, color: subtitleColor || '#cfe9e4', font: font(9), gap: 42 },
  ], cy - 70);
  walletRow(y, runWallet, '+', 4);

  const bs = endButtons();
  bs.forEach(b => {
    const hot = inRect(b, mouse.x, mouse.y);
    panel(b.x, b.y, b.w, b.h, hot ? '#ffffff' : b.border, b.fill);
    ctx.textAlign = 'center';
    ctx.font = font(10);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(b.label, b.x + b.w / 2, b.y + 31);
  });
  const hint = bs.map((b, i) => `${i === 0 ? 'ENTER' : b.key.toUpperCase()} ${b.label}`).join('   -   ');
  centreText([{ text: hint, color: 'rgba(207,233,228,0.5)', font: font(7) }], cy + 132);
  drawFsButton();
}

function drawCleared() {
  const L = boss.level;
  if (boss.firstClear) {
    drawEndScreen('CORE DESTROYED', '#ffd84a', `${levelName(L)} CLEARED - FIRST CLEAR!`, '#ffd84a');
  } else {
    drawEndScreen('CORE DESTROYED', '#ffd84a', `${levelName(L)} CLEARED - REPLAY, NO WHITE`);
  }
}

function drawDead() {
  drawEndScreen('SHIP LOST', '#ff5a66', `${levelName(boss.level)} - YOU KEEP WHAT YOU GRABBED`);
}

// End screens keep the arena behind them, held perfectly still.
function drawFightBackdropStill() {
  drawBackdrop();
  if (boss) drawBoss();
  particles.forEach(p => {
    ctx.globalAlpha = 1 - p.age / p.life;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size, p.y - p.size, p.size * 2, p.size * 2);
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(4,4,10,0.62)';
  ctx.fillRect(0, 0, W, H);
}

// ---------- loop ----------
let lastTime = 0;
function loop(timestamp) {
  const dt = Math.min(0.033, (timestamp - lastTime) / 1000 || 0);
  lastTime = timestamp;

  if (mode === 'fight' && !paused) update(dt);
  else if (mode === 'title') updateIdle(dt);
  else if (mode === 'cleared' || mode === 'dead') {
    particles.forEach(p => { p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; });
    particles = particles.filter(p => p.age < p.life);
  }

  if (mode === 'fight') drawFight();
  else if (mode === 'title') drawTitle();
  else if (mode === 'hangar') drawHangar();
  else if (mode === 'cleared') drawCleared();
  else if (mode === 'dead') drawDead();

  requestAnimationFrame(loop);
}

// ---------- flow ----------
window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (k === 'f') { toggleFullscreen(); return; }
  if (mode === 'title') { mode = 'hangar'; return; }
  if (mode === 'cleared' || mode === 'dead') {
    const bs = endButtons();
    const b = k === 'enter' ? bs[0] : bs.find(b => b.key === k);
    if (b) b.act();
    return;
  }
  if (mode === 'hangar') {
    if (k === 'enter') startFight(save.selected);
    if (k === 'arrowleft') pickLevel(-1);
    if (k === 'arrowright') pickLevel(1);
    if (k === 'r') { save = freshSave(); computeStats(); writeSave(); }
    return;
  }
  if (mode === 'fight' && (k === 'p' || k === 'escape')) paused = !paused;
});

window.addEventListener('click', e => {
  if (mode !== 'fight' && inRect(fsButton(), e.clientX, e.clientY)) { toggleFullscreen(); return; }
  if (mode === 'title') { mode = 'hangar'; return; }
  if (mode === 'cleared' || mode === 'dead') {
    const b = endButtons().find(b => inRect(b, e.clientX, e.clientY));
    if (b) b.act();
    return;
  }
  if (mode === 'hangar') hangarClick(e.clientX, e.clientY);
});

titleTime = 0;
elapsed = 0;
particles = [];
makePlayer();
requestAnimationFrame(loop);
