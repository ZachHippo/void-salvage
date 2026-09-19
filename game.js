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
  white: { color: '#eaf6ff', shape: 'star' },
  red:   { color: '#ff4a4a', shape: 'diamond' },
  blue:  { color: '#3f8cff', shape: 'hex' },
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
  { id: 'rocket',      name: 'Rocket Pod',      code: 'RKT', parent: 'multi',     pos: [-4.6, -2.2],
    max: 6, base: 160, step: 1.7,  price: { red: 1, white: 0.03 },
    desc: l => `${l} rocket${l > 1 ? 's' : ''} per fight - right-click or Q` },
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
    magnet:      150 * (1 + 0.40 * L('magnet')),   // pickup range during the fight
    yield:       { red: 1 + 0.2 * L('redYield'), blue: 1 + 0.2 * L('blueYield'), white: 1 },
    whiteBonus:  L('whiteYield'),
    rockets:     L('rocket'),
  };
}
computeStats();

// ---------- world state ----------
// Declared before resize() runs: these are `let` bindings, so touching them
// earlier would throw on the temporal dead zone rather than read as undefined.
let mode = 'title';           // title | hangar | fight | cleared | dead
let player, boss, shots, flak, orbs, particles, drones, stars, nebulae, beams;
let rockets = [];
let victory = null, debris = [];
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
// Letters are tracked by physical key (e.code), so a held D stays the same key
// whatever Shift or the keyboard layout does between keydown and keyup.
function keyName(e) { return e.code && e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.key.toLowerCase(); }
window.addEventListener('keydown', e => { keys[keyName(e)] = true; });
window.addEventListener('keyup', e => { keys[keyName(e)] = false; });

// If the page loses focus mid-press -- alt-tab, entering or leaving fullscreen,
// a screenshot tool -- the browser never sends the keyup, and the ship would
// keep thrusting that way forever. Drop every held input instead.
function releaseAll() { for (const k in keys) keys[k] = false; mouse.down = false; }
window.addEventListener('blur', releaseAll);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
document.addEventListener('fullscreenchange', releaseAll);

const mouse = { x: W / 2, y: H / 2, down: false };
window.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
let rocketQueued = false;
window.addEventListener('mousedown', e => {
  if (e.button === 2) rocketQueued = true;
  else if (e.button === 0) mouse.down = true;
});
window.addEventListener('mouseup', e => { if (e.button === 0) mouse.down = false; });
// right-click is the rocket button, not the browser menu
window.addEventListener('contextmenu', e => e.preventDefault());

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
    rockets: S.rockets, rocketCd: 0,
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
  // No randomness: guns of a type fire together on a fixed beat, each type
  // offset from the others, so a boss's barrage repeats and can be learned.
  const offset = { aimed: 0, spread: 0.45, spiral: 0, seeker: 0.9, laser: 1.35 }[type];
  const g = { type, timer: 1.2 + offset, phase: 0, volley: 0, state: 'idle', charge: 0 };
  // Reloads run about 12% faster than they used to.
  if (type === 'aimed')  g.reload = Math.max(0.5, 1.32 - level * 0.035);
  if (type === 'spread') g.reload = Math.max(1.15, 2.3 - level * 0.045);
  if (type === 'spiral') g.reload = 0.16;   // wider spacing between spiral rounds
  if (type === 'seeker') g.reload = Math.max(1.6, 2.8 - level * 0.055);
  if (type === 'laser')  g.reload = Math.max(2.1, 3.7 - level * 0.06);
  return g;
}

// Small seeded PRNG (mulberry32). Each level builds its boss from the same seed,
// so a level is always the same machine with the same guns and patterns --
// something you can learn and come back to beat.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBoss(level) {
  const rng = seededRandom(level * 7919 + 17);
  const rr = (a, b) => a + rng() * (b - a);
  const guardian = level % 5 === 0;
  const cols = oddClamp(5 + 2 * Math.floor((level - 1) / 3) + (guardian ? 2 : 0), 5, 13);
  const rows = oddClamp(5 + 2 * Math.floor((level - 1) / 4), 5, 11);
  const cell = cellSize();
  const midC = (cols - 1) / 2, midR = (rows - 1) / 2;
  const density = 0.58 + Math.min(0.28, level * 0.015);
  // Blocks and core both grow faster per level than they used to, so each
  // level is a longer fight than the one before.
  const armourHp = 10 * (4 + Math.floor(level * 1.25) + (guardian ? 3 : 0));

  const grid = [];
  for (let r = 0; r < rows; r++) { grid[r] = []; for (let c = 0; c < cols; c++) grid[r][c] = null; }
  const blocks = [];

  function put(r, c, kind, hp) {
    if (grid[r][c]) return null;
    const b = { r, c, kind, hp, maxHp: hp, alive: true, flash: 0, gun: null, seed: rng() };
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
  const coreHp = 10 * (34 + level * 13) * (guardian ? 2.2 : 1);
  const core = put(midR, midC, 'core', Math.round(coreHp));

  // Mirrored silhouette, so every boss reads as a built machine rather than noise.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c <= Math.floor(cols / 2); c++) {
      const nx = (c - midC) / (cols / 2), ny = (r - midR) / (rows / 2);
      const d = Math.hypot(nx, ny);
      if (!(d < 0.5 || rng() < density * (1 - d * 0.55))) continue;
      put(r, c, 'armour', armourHp);
      const mc = cols - 1 - c;
      if (mc !== c) put(r, mc, 'armour', armourHp);
    }
  }

  // Guns replace armour blocks, preferring the outside where you can reach them.
  const gunCount = Math.min(11, 2 + Math.floor(level / 2) + (guardian ? 3 : 0));
  const pool = blocks
    .filter(b => b.kind === 'armour')
    .sort((a, b) => (Math.hypot(b.c - midC, b.r - midR) - Math.hypot(a.c - midC, a.r - midR)) + rr(-0.9, 0.9));
  const open = GUN_UNLOCK.filter(u => level >= u.from);
  for (let i = 0; i < Math.min(gunCount, pool.length); i++) {
    const b = pool[i];
    b.kind = 'gun';
    b.hp = b.maxHp = Math.max(20, Math.round(armourHp * 0.7));
    b.gun = makeGun(open[i % open.length].type, level);
  }

  const armourTotal = blocks.filter(b => b.kind !== 'core').length;
  return {
    x: W / 2, y: H * 0.34, angle: Math.PI / 2,   // local +x is the boss's front: it starts facing down at you
    spin: 0, vx: 0, vy: 0,
    turn: 1.1 + level * 0.03,
    dashSpeed: Math.min(900, 520 + level * 14 + (guardian ? 100 : 0)),   // faster than the ship: a real lunge
    sitTime: Math.max(1.1, 2.4 - level * 0.05),
    ai: { state: 'sit', t: 2.2 },
    t: 0, cols, rows, cell, grid, blocks, core, level, guardian,
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
  releaseAll();
  makePlayer();
  const L = clamp(level || save.selected, 1, save.level);
  boss = makeBoss(L);
  boss.firstClear = L === save.level;
  shots = []; flak = []; orbs = []; particles = []; beams = []; rockets = [];
  victory = null; debris = [];
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

// Rewards climb steeply with the level: each level is worth 15% more than the
// one before on top of the linear growth, so a level-20 boss pays roughly 80x
// a level-1 boss and replaying hard levels is the way to farm.
function rewardScale(L) { return Math.pow(1.15, L - 1); }

// What a block pays when it breaks: a list of { cur, n orbs, value each }.
function blockPayout(b) {
  const L = boss.level, k = rewardScale(L);
  const val = (cur, v) => Math.max(1, Math.round(v * k * (S.yield[cur] || 1)));
  if (b.kind === 'armour') return [{ cur: 'blue', n: 2, value: val('blue', (2 + L * 0.8) / 2) }];
  if (b.kind === 'gun')    return [{ cur: 'red', n: 3, value: val('red', (6 + L * 2.4) / 3) }];
  const g = boss.guardian ? 2 : 1;
  const out = [
    { cur: 'red', n: 6, value: val('red', (20 + L * 6) * g / 6) },
    { cur: 'blue', n: 6, value: val('blue', (20 + L * 6) * g / 6) },
  ];
  // White crystals are the first-clear reward, and they scale with the level too.
  if (boss.firstClear) out.push({ cur: 'white', n: 3 + L * g + S.whiteBonus, value: 1 });
  return out;
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
  spawnDebris(w, b);
  shake = Math.max(shake, isCore ? 30 : 5);

  // Every block pays out, in its own colour.
  blockPayout(b).forEach(p => {
    for (let i = 0; i < p.n; i++) {
      orbs.push({ x: w.x + rand(-8, 8), y: w.y + rand(-8, 8), vx: rand(-80, 80), vy: rand(-80, 80),
                  r: 5, cur: p.cur, value: p.value });
    }
  });

  if (isCore) {
    beginVictory();
    return;
  }
  boss.armourLeft--;
}

// `direct` is true for a round that physically struck the block. A round that
// reaches the core has, by definition, found a way in, so it always does damage;
// splash and the pulse only hurt the core once a neighbouring block is gone.
// The core is exposed once any of its four neighbouring cells is empty -- there
// is a way in. Until then it is shielded, drawn dimmed, and immune to splash.
function coreExposed() {
  const { r, c } = boss.core;
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => {
    const rr = r + dr, cc = c + dc;
    return rr < 0 || cc < 0 || rr >= boss.rows || cc >= boss.cols || !boss.grid[rr][cc];
  });
}

function damageBlock(b, dmg, crit, direct) {
  if (!b.alive) return;
  if (b.kind === 'core' && boss.sealed && !direct) { b.flash = 0.08; return; }
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

// ---------- victory ----------
// When the core blows the fight does not just cut to a menu. Time slows for a
// beat, shockwaves roll out from the core, and the rest of the boss comes apart
// block by block in a wave running outward from where the core was. Every
// drop -- including anything already floating around -- streams into the
// ship, and the win panel only appears once it has all arrived.
function beginVictory() {
  const c = blockWorld(boss.core);
  victory = { t: 0, x: c.x, y: c.y };
  // enemy fire fizzles out: nothing can hurt you now
  flak.forEach(f => spawnParticles(f.x, f.y, f.color, 3, 60));
  flak = [];
  beams = [];
  const cl = blockLocal(boss.core);
  boss.blocks.forEach(b => {
    if (!b.alive || b.kind === 'core') return;
    const l = blockLocal(b);
    b.dieAt = 0.22 + (Math.hypot(l.x - cl.x, l.y - cl.y) / boss.cell) * 0.1 + Math.random() * 0.05;
  });
  shake = Math.max(shake, 34);
  spawnParticles(c.x, c.y, '#ffffff', 40, 420);
}

function victoryTick(dt) {
  victory.t += dt;
  boss.blocks.forEach(b => {
    if (b.alive && b.dieAt !== undefined && victory.t >= b.dieAt) breakBlock(b);
  });
  const standing = boss.blocks.some(b => b.alive);
  if ((!standing && orbs.length === 0 && victory.t > 1.6) || victory.t > 8) finishVictory();
}

function spawnDebris(w, b) {
  const n = victory ? 7 : 4;
  const out = Math.atan2(w.y - boss.y, w.x - boss.x);
  for (let i = 0; i < n; i++) {
    const a = out + rand(-1.1, 1.1), sp = rand(90, victory ? 380 : 240);
    debris.push({
      x: w.x + rand(-6, 6), y: w.y + rand(-6, 6), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      rot: rand(0, Math.PI * 2), vr: rand(-9, 9), size: boss.cell * rand(0.16, 0.34),
      color: i % 3 === 0 ? shade(BLOCK_COLOR[b.kind], 0.25) : BLOCK_COLOR[b.kind],
      age: 0, life: rand(0.7, 1.3),
    });
  }
}

function finishVictory() {
  // anything that has not reached the ship yet is banked anyway
  orbs.forEach(o => { runWallet[o.cur] += o.value; });
  orbs = [];
  boss.blocks.forEach(b => {
    if (!b.alive || b.kind === 'core') return;
    blockPayout(b).forEach(p => { runWallet[p.cur] += p.n * p.value; });
    b.alive = false;
  });
  victory = null;
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
  flak.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, r, color: color || '#ff9a1f', homing: homing || 0, life: 9 });
}

// Heading that intercepts the ship if it keeps its current velocity (two quick
// refinements of the flight time are plenty at these speeds).
function leadAngle(x, y, speed) {
  let t = dist(x, y, player.x, player.y) / speed;
  for (let i = 0; i < 2; i++) {
    const px = player.x + player.vx * t, py = player.y + player.vy * t;
    t = dist(x, y, px, py) / speed;
  }
  return Math.atan2(player.y + player.vy * t - y, player.x + player.vx * t - x);
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
  // Fixed patterns in screen space (not tied to the boss's spin), so each
  // volley looks the same every time and always leaves a way through.
  g.volley++;
  if (g.type === 'aimed') {
    // a line of three down the same heading: sidestep it
    // aimed where the ship is heading, not where it is, so drifting will not dodge it
    [310, 370, 430].forEach(v => addFlak(w.x, w.y, leadAngle(w.x, w.y, v), v, 4));
  } else if (g.type === 'spread') {
    // a ring of 10 that alternates by half a gap each volley: stand in a gap
    const n = 8, base = (g.volley % 2) * (Math.PI / n);
    for (let i = 0; i < n; i++) addFlak(w.x, w.y, base + (Math.PI * 2 * i) / n, 245, 4);
  } else if (g.type === 'spiral') {
    // two arms turning at a steady rate: circle with them
    g.phase += 0.3;
    addFlak(w.x, w.y, g.phase, 255, 3.5);
    addFlak(w.x, w.y, g.phase + Math.PI, 255, 3.5);
  } else if (g.type === 'seeker') {
    // two slow missiles launched straight up and down, then turning in
    addFlak(w.x, w.y, -Math.PI / 2, 185, 5, '#ff7a1a', 3.1);
    addFlak(w.x, w.y, Math.PI / 2, 185, 5, '#ff7a1a', 3.1);
  }
}

// ---------- player fire ----------
// What a shot struck this frame, testing the whole path it travelled rather
// than only where it landed: a fast round at a low frame rate moves further
// than a block is wide, and would otherwise skip clean over it.
function shotHit(s) {
  const px = s.px === undefined ? s.x : s.px, py = s.py === undefined ? s.y : s.py;
  const dx = s.x - px, dy = s.y - py, len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len / (boss.cell * 0.3)));
  for (let i = 1; i <= steps; i++) {
    const b = blockAtWorld(px + (dx * i) / steps, py + (dy * i) / steps);
    if (b && b !== s.last) return b;
  }
  return null;
}

// Rockets: a limited number per fight (one per Rocket Pod level). Each flies
// out along your aim, then curves gently onto the nearest block and explodes:
// roughly one armour block's worth of damage on the block it hits, plus a
// small splash. Strong, but a handful will not strip a boss on their own.
function launchRocket() {
  player.rockets--;
  player.rocketCd = 0.35;
  const a = player.angle;
  rockets.push({
    x: player.x + Math.cos(a) * player.radius, y: player.y + Math.sin(a) * player.radius,
    vx: Math.cos(a) * 380, vy: Math.sin(a) * 380, r: 6, age: 0, last: null,
  });
  shake = Math.max(shake, 4);
}

function rocketBlast(x, y, hit) {
  const L = boss.level;
  const direct = S.damage * (9 + L * 0.9);          // about one armour block
  if (hit) damageBlock(hit, direct * (hit.kind === 'core' ? S.coreMult : 1), false, true);
  splashDamage(x, y, boss.cell * 1.7, direct * 0.35);
  spawnParticles(x, y, '#7fe9ff', 30, 260);
  spawnParticles(x, y, '#ffffff', 12, 180);
  shake = Math.max(shake, 12);
}

function updateRockets(dt) {
  rockets = rockets.filter(k => {
    k.age += dt;
    // after a short straight launch, steer toward the nearest block
    if (k.age > 0.18) {
      const t = nearestBlock(k.x, k.y);
      if (t) {
        const want = Math.atan2(t.y - k.y, t.x - k.x), cur = Math.atan2(k.vy, k.vx);
        const diff = ((want - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        const na = cur + clamp(diff, -1, 1) * 3.2 * dt;
        const spd = Math.min(820, Math.hypot(k.vx, k.vy) + 900 * dt);
        k.vx = Math.cos(na) * spd; k.vy = Math.sin(na) * spd;
      }
    }
    k.px = k.x; k.py = k.y;
    k.x += k.vx * dt; k.y += k.vy * dt;
    if (Math.random() < 0.8) particles.push({ x: k.x - k.vx * 0.02, y: k.y - k.vy * 0.02, vx: rand(-30, 30), vy: rand(-30, 30), life: 0.35, age: 0, color: '#7fe9ff', size: rand(1.5, 3) });
    const hit = shotHit(k);
    if (hit) { rocketBlast(k.x, k.y, hit); return false; }
    return k.age < 4 && k.x > -60 && k.x < W + 60 && k.y > -60 && k.y < H + 60;
  });
}

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
  if (victory) return;
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

// ---------- boss hunting ----------
// The boss hunts you in a loop: it sits and tracks you, charges up while it
// locks on to you (a warning line and crosshair show the spot),
// then rams straight through that point and sits again. Its
// aim is always shown by the arrow over its core.
function bossAI(dt, ext) {
  const ai = boss.ai;
  ai.t -= dt;
  const turnTo = (x, y, rate) => {
    const want = Math.atan2(y - boss.y, x - boss.x);
    const d = ((want - boss.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    boss.angle += clamp(d, -rate * dt, rate * dt);
  };
  const settle = () => { const k = Math.pow(0.03, dt); boss.vx *= k; boss.vy *= k; };
  // the boss centre must stay where the whole boss fits on screen
  const mx = Math.min(ext + 8, W / 2), my = Math.min(ext + 8, H / 2);

  if (ai.state === 'sit') {
    turnTo(player.x, player.y, boss.turn * 0.6);
    settle();
    if (ai.t <= 0) { ai.state = 'charge'; ai.t = boss.guardian ? 0.75 : 0.95; }
  } else if (ai.state === 'charge') {
    // Lock straight onto the ship as it is right now; when the charge ends it
    // commits to that spot, so moving off it is how you dodge.
    ai.px = clamp(player.x, mx, W - mx);
    ai.py = clamp(player.y, my, H - my);
    ai.eta = dist(boss.x, boss.y, ai.px, ai.py) / (boss.dashSpeed * 0.8);
    turnTo(ai.px, ai.py, boss.turn * 2.6);
    settle();
    if (ai.t <= 0) { ai.state = 'dash'; ai.t = Math.min(2.5, ai.eta + 0.6); ai.tx = ai.px; ai.ty = ai.py; }
  } else {
    // Committed: no steering mid-dash. It drives its body straight through the
    // point it locked onto, so sitting still gets you rammed and moving dodges.
    const dx = ai.tx - boss.x, dy = ai.ty - boss.y, d = Math.hypot(dx, dy);
    const want = Math.min(boss.dashSpeed, d * 4 + 60);
    const a = Math.atan2(dy, dx), blend = Math.min(1, 7 * dt);
    boss.vx += (Math.cos(a) * want - boss.vx) * blend;
    boss.vy += (Math.sin(a) * want - boss.vy) * blend;
    if (ai.t <= 0 || d < 10) { ai.state = 'sit'; ai.t = boss.sitTime; }
  }

  boss.x = clamp(boss.x + boss.vx * dt, mx, W - mx);
  boss.y = clamp(boss.y + boss.vy * dt, my, H - my);
}

// ---------- the ring ----------
// The fight happens inside a ring. Outside it, poison eats the hull. It is a
// circle a little wider than the short side of the screen, so the corners and
// the far sides are poison while the middle stays roomy.
const POISON_DPS = 20;
function arena() {
  return { x: W / 2, y: H / 2, r: Math.min(W, H) * 0.48 + Math.abs(W - H) * 0.12 };
}

function drawArena() {
  const a = arena(), pulse = 0.5 + 0.5 * Math.sin(elapsed * 3);
  ctx.save();
  // everything outside the ring gets a green haze
  ctx.beginPath();
  ctx.rect(-60, -60, W + 120, H + 120);
  ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2, true);
  ctx.fillStyle = 'rgba(70,255,110,0.075)';
  ctx.fill('evenodd');
  // the edge: a slow dashed glow
  glowOn('#6dff8a', 14);
  ctx.strokeStyle = `rgba(109,255,138,${0.45 + pulse * 0.3})`;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([14, 10]);
  ctx.lineDashOffset = -elapsed * 30;
  ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2); ctx.stroke();
  glowOff();
  ctx.restore();
}

function drawPoisonWarning() {
  const k = 0.5 + 0.5 * Math.sin(elapsed * 10);
  ctx.fillStyle = `rgba(60,255,100,${0.06 + k * 0.05})`;
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  glowOn('#6dff8a', 16);
  ctx.fillStyle = '#9dffb0';
  ctx.font = font(11);
  ctx.fillText('POISON - GET BACK INSIDE THE RING', W / 2, H - 52);
  glowOff();
  ctx.textAlign = 'left';
}

function update(dt) {
  // the first moment after the core blows plays in slow motion
  if (victory && victory.t < 0.3) dt *= 0.35;
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

  // --- poison outside the ring: it eats the hull directly, straight past the shield ---
  const ring = arena();
  player.poisoned = !victory && dist(player.x, player.y, ring.x, ring.y) > ring.r;
  if (player.poisoned) {
    player.hull -= POISON_DPS * dt;
    if (Math.random() < 0.6) particles.push({ x: player.x + rand(-10, 10), y: player.y + rand(-10, 10), vx: rand(-20, 20), vy: rand(-60, -20), life: 0.5, age: 0, color: '#6dff8a', size: rand(1.5, 3) });
    if (player.hull <= 0) { player.hull = 0; failFight(); return; }
  }

  fireTimer -= dt;
  if (mouse.down && fireTimer <= 0) { fireTimer = S.fireDelay; firePlayer(); }

  // --- pulse ---
  // --- rockets ---
  if (player.rocketCd > 0) player.rocketCd -= dt;
  if ((rocketQueued || keys['q']) && player.rockets > 0 && player.rocketCd <= 0) launchRocket();
  rocketQueued = false;
  updateRockets(dt);
  if (mode !== 'fight') return;   // a rocket just blew the core

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
  if (!victory) bossAI(dt, ext);
  else boss.angle += 0.2 * dt;   // the wreck drifts round slowly as it comes apart
  if (boss.core.alive) boss.sealed = !coreExposed();
  boss.blocks.forEach(b => {
    if (!b.alive) return;
    if (b.flash > 0) b.flash -= dt;
    if (b.gun && !victory) runGun(b, dt);
  });
  if (victory) {
    victoryTick(dt);
    if (mode !== 'fight') return;
  }

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
    s.px = s.x; s.py = s.y;
    s.x += s.vx * dt; s.y += s.vy * dt;
    if (s.bounces > 0) {
      if (s.x < 0 || s.x > W) { s.vx *= -1; s.x = clamp(s.x, 0, W); s.bounces--; }
      if (s.y < 0 || s.y > H) { s.vy *= -1; s.y = clamp(s.y, 0, H); s.bounces--; }
    }
  });
  shots = shots.filter(s => {
    const hit = shotHit(s);
    if (hit && hit !== s.last) {
      let dmg = s.dmg * (hit.kind === 'gun' ? S.gunMult : hit.kind === 'core' ? S.coreMult : 1);
      const crit = Math.random() < S.crit;
      if (crit) dmg *= 2;
      damageBlock(hit, dmg, crit, true);
      if (S.splash) splashDamage(s.x, s.y, S.splash, s.dmg * 0.5);
      spawnParticles(s.x, s.y, '#7fe9ff', 5, 90);
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
    if (dist(f.x, f.y, player.x, player.y) < player.hitRadius + f.r) { hurtPlayer(24); return false; }
    return f.life > 0 && f.x > -40 && f.x < W + 40 && f.y > -40 && f.y < H + 40;
  });

  // --- beams ---
  beams.forEach(bm => {
    if (!bm.firing) return;
    const dx = Math.cos(bm.angle), dy = Math.sin(bm.angle);
    if (distToRay(player.x, player.y, bm.x, bm.y, dx, dy, bm.len) < player.hitRadius + 7) hurtPlayer(20);
  });

  // --- ramming the hull ---
  if (!victory && player.invuln <= 0 && blockAtWorld(player.x, player.y)) {
    const a = Math.atan2(player.y - boss.y, player.x - boss.x);
    player.vx = Math.cos(a) * 460; player.vy = Math.sin(a) * 460;
    hurtPlayer(16);
  }

  // --- salvage ---
  orbs.forEach(o => {
    // During the fight a drop only comes to you once you are within pickup
    // range (Tractor Coil widens it). Once the core is dead, every drop homes
    // in on the ship from anywhere on the field, faster and faster.
    o.age = (o.age || 0) + dt;
    if (victory && o.age > 0.22) {
      const a = Math.atan2(player.y - o.y, player.x - o.x), spd = Math.min(1500, 280 + o.age * 1100);
      const k = Math.min(1, 9 * dt);
      o.vx += (Math.cos(a) * spd - o.vx) * k;
      o.vy += (Math.sin(a) * spd - o.vy) * k;
    } else if (!victory && dist(o.x, o.y, player.x, player.y) < S.magnet) {
      const a = Math.atan2(player.y - o.y, player.x - o.x);
      o.vx = Math.cos(a) * 300; o.vy = Math.sin(a) * 300;
    } else {
      o.vx -= o.vx * 1.5 * dt; o.vy -= o.vy * 1.5 * dt;
    }
    o.x += o.vx * dt; o.y += o.vy * dt;
  });


  orbs = orbs.filter(o => {
    if (dist(o.x, o.y, player.x, player.y) < 20 + Math.hypot(o.vx, o.vy) * dt) {
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
  debris.forEach(d => {
    d.age += dt; d.x += d.vx * dt; d.y += d.vy * dt; d.rot += d.vr * dt;
    d.vx -= d.vx * 1.6 * dt; d.vy -= d.vy * 1.6 * dt;
  });
  debris = debris.filter(d => d.age < d.life);
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

const BLOCK_COLOR = { armour: '#3f8cff', gun: '#ff4a4a', core: '#9ff7ff' };

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

// The block is its own health bar. The lost share of its health is a dark,
// hollow shell; the rest stays lit, and the level drains like liquid toward
// the bottom of the screen whichever way the boss is turned.
function drawBlockFilled(b, s, h, base, sealed, frac) {
  const f = clamp(frac, 0, 1);
  const face = lit => {
    if (b.kind === 'core') {
      drawCoreFace(s, h, 0, sealed);
      // the core face is mostly dark, so its remaining health gets a cyan wash
      if (lit) { ctx.fillStyle = 'rgba(159,247,255,0.32)'; roundRect(-h, -h, s, s, 4); ctx.fill(); }
      return;
    }
    if (lit) glowOn(base, 8);
    drawPlate(s, h, base, 0);
    glowOff();
    if (b.kind === 'gun') drawGunFace(b, h, base);
  };

  // empty shell, plus an outline so a nearly drained block still reads
  const a0 = ctx.globalAlpha;
  ctx.globalAlpha = a0 * 0.22;
  face(false);
  ctx.globalAlpha = a0;
  ctx.strokeStyle = shade(base, 0.15);
  ctx.lineWidth = 1.2;
  roundRect(-h + 0.5, -h + 0.5, s - 1, s - 1, 4); ctx.stroke();
  if (f <= 0) return;

  // how far the turned tile reaches up and down the screen
  const ext = h * (Math.abs(Math.cos(boss.angle)) + Math.abs(Math.sin(boss.angle)));
  const level = ext - 2 * ext * f;
  ctx.save();
  ctx.rotate(-boss.angle);
  ctx.beginPath();
  ctx.rect(-ext, level, 2 * ext, 2 * ext * f);
  ctx.rotate(boss.angle);
  ctx.clip();
  face(true);
  ctx.restore();

  // the surface of the liquid
  if (f < 1) {
    ctx.save();
    roundRect(-h, -h, s, s, 4); ctx.clip();
    ctx.rotate(-boss.angle);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-ext, level); ctx.lineTo(ext, level); ctx.stroke();
    ctx.restore();
  }
}

// The aiming arrow, drawn over the core in the boss's rotated frame, so it
// always points where the boss is aimed (local +x). It runs past the core's
// own cell so it stays readable when the core is buried in armour. Calm white
// while the boss sits, flickering orange while it charges, red while it dashes.
function drawCoreArrow() {
  const c = boss.cell, l = blockLocal(boss.core);
  const st = boss.ai ? boss.ai.state : 'sit';
  const col = st === 'dash' ? '#ff3b3b' : st === 'charge' ? '#ff9a1f' : '#eaf6ff';
  const lit = st === 'charge' ? 0.55 + 0.45 * Math.sin(elapsed * 34) : 1;
  ctx.save();
  ctx.translate(l.x, l.y);
  ctx.globalAlpha = lit;
  glowOn(col, st === 'sit' ? 10 : 24);
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(c * 1.05, 0);                 // tip
  ctx.lineTo(c * 0.45, -c * 0.42);
  ctx.lineTo(c * 0.45, -c * 0.14);
  ctx.lineTo(-c * 0.42, -c * 0.14);        // tail
  ctx.lineTo(-c * 0.42, c * 0.14);
  ctx.lineTo(c * 0.45, c * 0.14);
  ctx.lineTo(c * 0.45, c * 0.42);
  ctx.closePath();
  ctx.fill();
  glowOff();
  ctx.strokeStyle = 'rgba(10,14,22,0.7)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

// While charging, a warning line runs from the core's arrow to the spot the
// boss is about to ram -- the ship itself -- and firms up
// as the dash gets closer.
function drawChargeLine() {
  if (!boss.ai || boss.ai.state !== 'charge' || victory) return;
  const core = blockWorld(boss.core);   // starts from the arrow's tip
  const hx = core.x + Math.cos(boss.angle) * boss.cell * 1.1, hy = core.y + Math.sin(boss.angle) * boss.cell * 1.1;
  const total = boss.guardian ? 0.75 : 0.95, k = 1 - boss.ai.t / total;
  ctx.save();
  ctx.setLineDash([10, 8]);
  ctx.lineDashOffset = -elapsed * 60;
  ctx.strokeStyle = `rgba(255,154,31,${0.2 + k * 0.6})`;
  ctx.lineWidth = 2 + k * 2;
  const tx = boss.ai.px === undefined ? player.x : boss.ai.px, ty = boss.ai.py === undefined ? player.y : boss.ai.py;
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); ctx.stroke();
  // crosshair on the spot it is going to ram
  ctx.setLineDash([]);
  const r = 14 + (1 - k) * 10;
  ctx.beginPath(); ctx.arc(tx, ty, r, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(tx - r - 6, ty); ctx.lineTo(tx - r + 6, ty); ctx.moveTo(tx + r - 6, ty); ctx.lineTo(tx + r + 6, ty);
  ctx.moveTo(tx, ty - r - 6); ctx.lineTo(tx, ty - r + 6); ctx.moveTo(tx, ty + r - 6); ctx.lineTo(tx, ty + r + 6);
  ctx.stroke();
  ctx.restore();
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
    } else {
      drawBlockFilled(b, s, h, base, sealed, 1 - hurt);
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  });

  if (boss.core.alive && !victory) drawCoreArrow();

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
CUR.red.text = '#ff7a7a';
CUR.blue.text = '#7fb2ff';

// Currency icon: a glowing diamond or orb. `cell` keeps the old sizing scale.
// Regular polygon path, centred on (x, y).
function polyPath(x, y, r, sides, rot) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
}

// Currency icons are hard geometric shapes: red diamond, blue hexagon, white
// four-point star. `cell` keeps the old sizing scale.
function currencyIcon(x, y, cur, cell) {
  const r = cell * 3.2, c = CUR[cur];
  ctx.save();
  glowOn(c.color, r * 1.2);
  ctx.fillStyle = c.color;
  if (c.shape === 'diamond') {
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.7, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r * 0.7, y);
    ctx.closePath();
  } else if (c.shape === 'hex') {
    polyPath(x, y, r * 0.88, 6, Math.PI / 6);
  } else {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI / 2 + (i / 8) * Math.PI * 2;
      const rr = i % 2 === 0 ? r : r * 0.36;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
  }
  ctx.fill();
  glowOff();
  // a single hard facet highlight
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(x - r * 0.35, y - r * 0.05); ctx.lineTo(x, y - r * 0.5); ctx.stroke();
  ctx.restore();
}

// Translucent rounded panel with a thin neon edge, shared by HUD and menus.
// Chamfered panel with a thin neon edge, shared by the HUD and menus.
function panel(x, y, w, h, border, fill) {
  const c = Math.min(10, w / 4, h / 4);
  ctx.beginPath();
  ctx.moveTo(x + c, y); ctx.lineTo(x + w - c, y); ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c); ctx.lineTo(x + w - c, y + h); ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c); ctx.lineTo(x, y + c);
  ctx.closePath();
  ctx.fillStyle = fill || 'rgba(10,12,24,0.82)';
  ctx.fill();
  ctx.strokeStyle = border || 'rgba(127,216,255,0.45)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ---------- fight ----------

// The ship: a faceted hull lit from the upper left, a cockpit canopy, twin
// engine nozzles that flare while thrusting, and blinking wingtip lights.
// Points are in units of the ship's radius, nose along +x.
const SHIP = {
  nose: [1, 0], wingL: [-0.78, -0.82], notchL: [-0.34, -0.3], tail: [-0.56, 0],
  notchR: [-0.34, 0.3], wingR: [-0.78, 0.82], spine: [0.1, 0],
};
function drawShip() {
  const r = player.radius;
  const P = k => [SHIP[k][0] * r, SHIP[k][1] * r];
  const tri = (a, b2, c, color) => {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(...P(a)); ctx.lineTo(...P(b2)); ctx.lineTo(...P(c)); ctx.closePath(); ctx.fill();
  };
  const hit = player.invuln > 0 && Math.floor(elapsed * 20) % 2 === 0;
  const thrusting = keys['w'] || keys['a'] || keys['s'] || keys['d'] ||
                    keys['arrowup'] || keys['arrowdown'] || keys['arrowleft'] || keys['arrowright'];

  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(player.angle);

  // engine flames behind the two nozzles
  if (thrusting) {
    for (const side of [-1, 1]) {
      const len = r * rand(0.55, 0.85);
      glowOn('#7fd8ff', 14);
      ctx.fillStyle = 'rgba(127,216,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(-0.62 * r, side * 0.14 * r - 0.08 * r);
      ctx.lineTo(-0.62 * r - len, side * 0.14 * r);
      ctx.lineTo(-0.62 * r, side * 0.14 * r + 0.08 * r);
      ctx.closePath(); ctx.fill();
      glowOff();
    }
  }

  // silhouette with the glow, then the facets on top of it
  glowOn(hit ? '#ffffff' : '#7fd8ff', 18);
  ctx.fillStyle = hit ? '#ffffff' : '#5fb8e8';
  ctx.beginPath();
  ['nose', 'wingL', 'notchL', 'tail', 'notchR', 'wingR'].forEach((k, i) => (i ? ctx.lineTo : ctx.moveTo).apply(ctx, P(k)));
  ctx.closePath(); ctx.fill();
  glowOff();

  if (!hit) {
    tri('nose', 'wingL', 'notchL', '#c4f1ff');     // upper wing, catching the light
    tri('nose', 'notchL', 'spine', '#8fdcff');
    tri('notchL', 'tail', 'spine', '#5fb8e8');
    tri('spine', 'tail', 'notchR', '#3f93c8');
    tri('nose', 'spine', 'notchR', '#4fa6d6');
    tri('nose', 'notchR', 'wingR', '#2d74a8');     // lower wing, in shadow

    // panel lines along the facet seams
    ctx.strokeStyle = 'rgba(220,247,255,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(...P('nose')); ctx.lineTo(...P('spine')); ctx.lineTo(...P('tail'));
    ctx.moveTo(...P('notchL')); ctx.lineTo(...P('spine')); ctx.lineTo(...P('notchR'));
    ctx.stroke();

    // cockpit canopy with a glint
    ctx.fillStyle = '#0b2438';
    ctx.beginPath();
    ctx.moveTo(0.52 * r, 0); ctx.lineTo(0.16 * r, 0.13 * r); ctx.lineTo(0.02 * r, 0); ctx.lineTo(0.16 * r, -0.13 * r);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(160,235,255,0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(0.4 * r, -0.03 * r); ctx.lineTo(0.2 * r, -0.09 * r); ctx.stroke();

    // twin nozzles
    ctx.fillStyle = '#16354f';
    ctx.fillRect(-0.7 * r, -0.24 * r, 0.16 * r, 0.16 * r);
    ctx.fillRect(-0.7 * r, 0.08 * r, 0.16 * r, 0.16 * r);
  }

  // outline and wingtip lights
  ctx.strokeStyle = 'rgba(223,247,255,0.8)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ['nose', 'wingL', 'notchL', 'tail', 'notchR', 'wingR'].forEach((k, i) => (i ? ctx.lineTo : ctx.moveTo).apply(ctx, P(k)));
  ctx.closePath(); ctx.stroke();
  if (Math.floor(elapsed * 2.5) % 2 === 0) {
    ctx.fillStyle = '#ff4a4a'; ctx.fillRect(...P('wingL'), 3, 3);
    ctx.fillStyle = '#4dff88'; ctx.fillRect(P('wingR')[0], P('wingR')[1] - 3, 3, 3);
  }
  ctx.restore();
}

// #rrggbb with an alpha, for gradients that fade a colour out.
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// A teardrop round: a glowing head, a tail that tapers and fades back along
// its flight, a hot inner core and a thin highlight streak for texture.
function drawDrop(x, y, vx, vy, r, color, hot) {
  const L = r * 3.4;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.atan2(vy, vx));

  const g = ctx.createLinearGradient(-L, 0, r, 0);
  g.addColorStop(0, hexA(color, 0));
  g.addColorStop(0.55, hexA(color, 0.85));
  g.addColorStop(1, color);
  glowOn(color, r * 2.2);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(-L, 0);
  ctx.quadraticCurveTo(-r * 0.9, -r * 1.05, 0, -r);
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
  ctx.quadraticCurveTo(-r * 0.9, r * 1.05, -L, 0);
  ctx.closePath();
  ctx.fill();
  glowOff();

  // hot core, set a little forward in the head
  ctx.fillStyle = hot;
  ctx.beginPath(); ctx.ellipse(r * 0.18, 0, r * 0.55, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();

  // highlight streak along the upper flank
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = Math.max(1, r * 0.2);
  ctx.beginPath();
  ctx.moveTo(-L * 0.55, -r * 0.3);
  ctx.quadraticCurveTo(-r * 0.35, -r * 0.62, r * 0.4, -r * 0.5);
  ctx.stroke();
  ctx.restore();
}

function drawRocket(k) {
  ctx.save();
  ctx.translate(k.x, k.y);
  ctx.rotate(Math.atan2(k.vy, k.vx));
  // exhaust
  glowOn('#7fe9ff', 16);
  ctx.fillStyle = 'rgba(127,233,255,0.85)';
  const fl = rand(10, 18);
  ctx.beginPath(); ctx.moveTo(-8, -3.5); ctx.lineTo(-8 - fl, 0); ctx.lineTo(-8, 3.5); ctx.closePath(); ctx.fill();
  // body, nose and fins
  ctx.fillStyle = '#bff4ff';
  ctx.fillRect(-9, -3.5, 14, 7);
  ctx.beginPath(); ctx.moveTo(5, -3.5); ctx.lineTo(12, 0); ctx.lineTo(5, 3.5); ctx.closePath(); ctx.fill();
  glowOff();
  ctx.fillStyle = '#3aa8d8';
  ctx.beginPath(); ctx.moveTo(-9, -3.5); ctx.lineTo(-13, -7.5); ctx.lineTo(-5, -3.5); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-9, 3.5); ctx.lineTo(-13, 7.5); ctx.lineTo(-5, 3.5); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-2, -1.2, 5, 2.4);
  ctx.restore();
}

function drawWorld() {
  ctx.save();
  if (shake > 0) ctx.translate(rand(-shake, shake), rand(-shake, shake));
  drawBackdrop();
  drawArena();

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
  drawChargeLine();
  if (victory) drawVictoryRings();

  // beams: a thin telegraph while charging, a wide beam while firing
  beams.forEach(bm => {
    const ex = bm.x + Math.cos(bm.angle) * bm.len, ey = bm.y + Math.sin(bm.angle) * bm.len;
    glowOn('#ff9a1f', bm.firing ? 24 : 8);
    ctx.strokeStyle = bm.firing ? 'rgba(255,154,31,0.95)' : 'rgba(255,154,31,0.35)';
    ctx.lineWidth = bm.firing ? 14 : 2;
    ctx.beginPath(); ctx.moveTo(bm.x, bm.y); ctx.lineTo(ex, ey); ctx.stroke();
    glowOff();
  });

  particles.forEach(p => {
    ctx.globalAlpha = 1 - p.age / p.life;
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
  });
  debris.forEach(d => {
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(d.rot);
    ctx.globalAlpha = Math.max(0, 1 - d.age / d.life);
    ctx.fillStyle = d.color;
    ctx.fillRect(-d.size / 2, -d.size * 0.35, d.size, d.size * 0.7);
    ctx.restore();
  });
  ctx.globalAlpha = 1;

  orbs.forEach(o => currencyIcon(o.x, o.y, o.cur, 2));

  // enemy rounds: orange teardrops
  flak.forEach(f => drawDrop(f.x, f.y, f.vx, f.vy, f.r + 1.5, f.color, '#fff1c9'));

  // our rounds (drones included): light neon-blue teardrops
  shots.forEach(s => drawDrop(s.x, s.y, s.vx, s.vy, s.r, '#7fe9ff', '#f0ffff'));
  rockets.forEach(drawRocket);

  glowOn('#7cffb2', 10);
  ctx.fillStyle = '#7cffb2';
  drones.forEach(d => { ctx.beginPath(); ctx.arc(d.x, d.y, 7, 0, Math.PI * 2); ctx.fill(); });

  drawShip();

  if (player.shield > 0) {
    ctx.strokeStyle = `rgba(159,247,255,${0.25 + 0.4 * (player.shield / Math.max(1, S.maxShield))})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(player.x, player.y, player.radius + 9, 0, Math.PI * 2); ctx.stroke();
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

function drawVictoryRings() {
  [0, 0.12, 0.26].forEach((delay, i) => {
    const tt = victory.t - delay;
    if (tt <= 0 || tt > 0.9) return;
    const k = tt / 0.9, r = (1 - Math.pow(1 - k, 3)) * Math.max(W, H) * 0.55;
    glowOn('#9ff7ff', 20);
    ctx.strokeStyle = i === 0 ? `rgba(255,255,255,${1 - k})` : `rgba(159,247,255,${(1 - k) * 0.8})`;
    ctx.lineWidth = (i === 0 ? 10 : 5) * (1 - k) + 1;
    ctx.beginPath(); ctx.arc(victory.x, victory.y, r, 0, Math.PI * 2); ctx.stroke();
    glowOff();
  });
}

function drawVictoryOverlay() {
  if (victory.t < 0.3) {
    ctx.fillStyle = `rgba(255,255,255,${(0.3 - victory.t) * 1.8})`;
    ctx.fillRect(0, 0, W, H);
  }
  const a = clamp((victory.t - 0.15) * 3, 0, 1);
  ctx.globalAlpha = a;
  ctx.textAlign = 'center';
  glowOn('#ffd84a', 26);
  ctx.fillStyle = '#ffd84a';
  ctx.font = font(26);
  ctx.fillText('CORE DESTROYED', W / 2, H * 0.22);
  glowOff();
  ctx.font = font(9);
  ctx.fillStyle = '#cfe9e4';
  const salvaging = orbs.length > 0 || boss.blocks.some(b => b.alive);
  ctx.fillText(salvaging ? 'SALVAGING THE WRECK...' : 'ALL SALVAGE RECOVERED', W / 2, H * 0.22 + 34);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

function drawFight() {
  drawWorld();
  drawPopups();
  if (victory) drawVictoryOverlay();
  if (hitFlash > 0) {
    ctx.fillStyle = `rgba(255,60,60,${hitFlash * 0.3})`;
    ctx.fillRect(0, 0, W, H);
  }
  drawHUD();
  if (player.poisoned && !victory) drawPoisonWarning();
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
  const rows = 2 + (S.maxShield > 0 ? 1 : 0) + (S.rockets > 0 ? 1 : 0);
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
  if (S.rockets > 0) {
    ctx.textAlign = 'left';
    ctx.font = font(9);
    ctx.fillStyle = '#cfe9e4';
    ctx.fillText('RKTS', 28, y + 13);
    for (let i = 0; i < S.rockets; i++) {
      ctx.fillStyle = i < player.rockets ? '#7fe9ff' : 'rgba(127,233,255,0.18)';
      const rx = 100 + i * 24;
      ctx.fillRect(rx, y + 5, 14, 8);
      ctx.beginPath(); ctx.moveTo(rx + 14, y + 5); ctx.lineTo(rx + 20, y + 9); ctx.lineTo(rx + 14, y + 13); ctx.closePath(); ctx.fill();
    }
    y += 28;
  }

  // fight panel, top right: which fight, how sealed, and this run's haul
  const pw = 262, x0 = W - pw - 14;
  panel(x0, 14, pw, 116);
  ctx.textAlign = 'center';
  ctx.font = font(12);
  ctx.fillStyle = boss.guardian ? '#ff5a66' : '#ffffff';
  ctx.fillText(levelName(boss.level) + (boss.firstClear ? '' : ' - REPLAY'), x0 + pw / 2, 42);
  ctx.font = font(8);
  ctx.fillStyle = boss.sealed ? '#7fb2ff' : '#9ff7ff';
  ctx.fillText(victory ? 'CORE DESTROYED' : boss.sealed ? `ARMOUR ${Math.round((boss.armourLeft / boss.armourTotal) * 100)}% - CORE SHIELDED` : 'CORE EXPOSED - HIT IT!', x0 + pw / 2, 64);
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
  ctx.fillText('WASD MOVE   MOUSE AIM   CLICK FIRE   RIGHT-CLICK/Q ROCKET   E PULSE   P PAUSE   F FULLSCREEN', 18, H - 16);
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
  drawMapButton();

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
  if (inRect(mapButton(), mx, my)) { mode = 'levels'; levelsScroll = null; return; }
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

// ---------- level map ----------
// Levels come in sectors of five, the fifth of each a Guardian. Every level
// builds the same boss every time, so the map can show each one's actual
// shape, guns and rewards before you fight it.
let levelsScroll = null;          // first sector row shown; null = centre on the frontier
const previewCache = {};

function levelPreview(L) {
  const key = `${L}:${S.yield.red}:${S.yield.blue}:${S.whiteBonus}`;
  if (!previewCache[key]) {
    const b = makeBoss(L);
    const guns = {};
    b.blocks.forEach(x => { if (x.gun) guns[x.gun.type] = (guns[x.gun.type] || 0) + 1; });
    // blockPayout reads the live boss, so borrow the slot for the estimate
    const saved = boss;
    boss = b;
    b.firstClear = false;
    let red = 0, blue = 0;
    b.blocks.forEach(x => blockPayout(x).forEach(p => {
      if (p.cur === 'red') red += p.n * p.value;
      if (p.cur === 'blue') blue += p.n * p.value;
    }));
    b.firstClear = true;
    const white = blockPayout(b.core).filter(p => p.cur === 'white').reduce((t, p) => t + p.n * p.value, 0);
    boss = saved;
    previewCache[key] = {
      cols: b.cols, rows: b.rows, guardian: b.guardian, guns, red, blue, white,
      blocks: b.blocks.map(x => ({ r: x.r, c: x.c, kind: x.kind })), coreHp: b.core.maxHp, count: b.blocks.length,
    };
  }
  return previewCache[key];
}

function levelState(L) { return L < save.level ? 'beaten' : L === save.level ? 'next' : 'locked'; }

function levelsLayout() {
  const panelW = 330, pad = 24, gap = 14, labelH = 24, top = 112, rowsShown = 4;
  const areaW = W - panelW - pad * 3;
  const tile = Math.max(70, Math.floor(Math.min((areaW - 4 * gap) / 5, (H - top - 90 - rowsShown * (gap + labelH)) / rowsShown)));
  const frontierSector = Math.floor((save.level - 1) / 5);
  const maxSector = frontierSector + 1;   // one sector of locked levels is shown ahead
  if (levelsScroll === null) levelsScroll = Math.max(0, frontierSector - 2);
  levelsScroll = clamp(levelsScroll, 0, Math.max(0, maxSector - rowsShown + 1));
  const tiles = [];
  for (let row = 0; row < rowsShown; row++) {
    const sector = levelsScroll + row;
    if (sector > maxSector) break;
    for (let i = 0; i < 5; i++) {
      tiles.push({ L: sector * 5 + i + 1, sector, x: pad + i * (tile + gap), y: top + row * (tile + gap + labelH) + labelH, w: tile, h: tile });
    }
  }
  const info = { x: W - panelW - pad, y: top, w: panelW, h: H - top - 90 };
  return {
    tiles, info, tile, maxSector, rowsShown,
    back: { x: pad, y: H - 64, w: 170, h: 44 },
    fight: { x: info.x + 20, y: info.y + info.h - 64, w: info.w - 40, h: 46 },
  };
}

function drawMiniBoss(p, cx, cy, maxW, maxH, locked, dim) {
  const m = Math.max(2, Math.floor(Math.min(maxW / p.cols, maxH / p.rows)));
  const ox = cx - (p.cols * m) / 2, oy = cy - (p.rows * m) / 2;
  p.blocks.forEach(b => {
    ctx.fillStyle = locked ? '#252c38' : BLOCK_COLOR[b.kind];
    ctx.globalAlpha = dim ? 0.55 : 1;
    ctx.fillRect(ox + b.c * m + 0.5, oy + b.r * m + 0.5, m - 1, m - 1);
  });
  ctx.globalAlpha = 1;
}

function drawLevels() {
  drawBackdrop();
  ctx.fillStyle = 'rgba(5,5,12,0.55)';
  ctx.fillRect(0, 0, W, H);
  const lay = levelsLayout();
  const hover = lay.tiles.find(t => inRect(t, mouse.x, mouse.y));
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 200);

  // header
  ctx.textAlign = 'center';
  glowOn('#7fd8ff', 22);
  ctx.fillStyle = '#eaf6ff';
  ctx.font = font(22);
  ctx.fillText('LEVEL MAP', W / 2, 48);
  glowOff();
  ctx.font = font(8);
  ctx.fillStyle = '#9fd3cc';
  const beaten = save.level - 1, guards = Math.floor(beaten / 5);
  ctx.fillText(`CLEARED ${beaten} LEVEL${beaten === 1 ? '' : 'S'}   -   GUARDIANS BEATEN ${guards}   -   NEXT UP: ${levelName(save.level)}${save.level % 5 ? '' : ' (LV ' + save.level + ')'}`, W / 2, 76);
  if (lay.maxSector + 1 > lay.rowsShown) {
    ctx.fillStyle = 'rgba(207,233,228,0.45)';
    ctx.fillText('SCROLL OR UP/DOWN FOR MORE SECTORS', W / 2, 96);
  }

  // sector rows and tiles
  const seenSector = new Set();
  lay.tiles.forEach(t => {
    if (!seenSector.has(t.sector)) {
      seenSector.add(t.sector);
      ctx.textAlign = 'left';
      ctx.font = font(8);
      ctx.fillStyle = t.sector <= Math.floor((save.level - 1) / 5) ? '#9fd3cc' : '#4a5462';
      ctx.fillText(`SECTOR ${t.sector + 1}`, t.x, t.y - 8);
    }
    const st = levelState(t.L), p = levelPreview(t.L);
    const selected = t.L === save.selected && st !== 'locked';
    let border = st === 'beaten' ? '#ffd84a' : st === 'next' ? `rgba(127,233,255,${0.5 + pulse * 0.5})` : '#2a3038';
    if (selected) border = '#ffffff';
    if (t === hover && st !== 'locked') border = '#ffffff';
    panel(t.x, t.y, t.w, t.h, border, st === 'locked' ? 'rgba(10,12,18,0.9)' : 'rgba(12,16,28,0.9)');
    if (selected) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.strokeRect(t.x - 4, t.y - 4, t.w + 8, t.h + 8); }
    drawMiniBoss(p, t.x + t.w / 2, t.y + t.h / 2 - 8, t.w - 22, t.h - 42, st === 'locked', st === 'beaten');

    ctx.font = font(7);
    ctx.textAlign = 'left';
    ctx.fillStyle = p.guardian ? '#ff7a7a' : (st === 'locked' ? '#4a5462' : '#eaf6ff');
    ctx.fillText(p.guardian ? `GUARD ${t.L / 5}` : `LV ${t.L}`, t.x + 8, t.y + t.h - 9);
    ctx.textAlign = 'right';
    ctx.fillStyle = st === 'beaten' ? '#ffd84a' : st === 'next' ? '#7fe9ff' : '#4a5462';
    const narrow = t.w < 140;   // short marks when the tile is too small for words
    ctx.fillText(st === 'beaten' ? (narrow ? String.fromCharCode(10003) : 'CLEARED') : st === 'next' ? 'NEXT' : (narrow ? '-' : 'LOCKED'), t.x + t.w - 8, t.y + t.h - 9);
  });

  // info panel: the hovered level, or the selected one
  const L = hover ? hover.L : save.selected;
  const st = levelState(L), p = levelPreview(L);
  const inf = lay.info;
  panel(inf.x, inf.y, inf.w, inf.h);
  ctx.textAlign = 'left';
  let y = inf.y + 34;
  const line = (text, color, size, gapAfter) => {
    ctx.font = font(size || 8);
    ctx.fillStyle = color || '#cfe9e4';
    ctx.fillText(text, inf.x + 20, y);
    y += gapAfter || 22;
  };
  line(levelName(L) + (p.guardian ? `  (LV ${L})` : ''), p.guardian ? '#ff7a7a' : '#eaf6ff', 14, 26);
  line(st === 'beaten' ? 'CLEARED - REPLAY FOR RED AND BLUE' : st === 'next' ? 'NEXT UP - FIRST CLEAR' : `LOCKED - CLEAR ${levelName(save.level)} FIRST`,
       st === 'beaten' ? '#ffd84a' : st === 'next' ? '#7fe9ff' : '#8a93a0', 8, 30);
  drawMiniBoss(p, inf.x + inf.w / 2, y + 60, inf.w - 80, 110, st === 'locked', false);
  y += 136;
  if (st === 'locked') {
    line('BOSS DETAILS UNLOCK WHEN YOU REACH IT', '#6b7480');
  } else {
    line(`BOSS: ${p.count} BLOCKS, ${p.cols} x ${p.rows}`);
    // two gun types per line so long lists stay inside the panel
    const gunList = Object.keys(p.guns).map(k => `${k.toUpperCase()} x${p.guns[k]}`);
    if (!gunList.length) line('GUNS: NONE');
    for (let i = 0; i < gunList.length; i += 2) line((i ? '      ' : 'GUNS: ') + gunList.slice(i, i + 2).join('   '), undefined, 8, 18);
    y += 4;
    line(`CORE HP: ${p.coreHp}`, '#9ff7ff', 8, 30);
    ctx.font = font(8);
    ctx.fillStyle = '#9fd3cc';
    ctx.fillText(st === 'next' ? 'FIRST CLEAR PAYS ABOUT' : 'A REPLAY PAYS ABOUT', inf.x + 20, y);
    y += 26;
    const cols = [['red', p.red], ['blue', p.blue]];
    if (st === 'next') cols.unshift(['white', p.white]);
    cols.forEach(([k, v], i) => {
      const x = inf.x + 34 + i * 96;
      currencyIcon(x, y - 4, k, 3);
      ctx.font = font(9);
      ctx.fillStyle = CUR[k].text;
      ctx.textAlign = 'left';
      ctx.fillText(String(v), x + 16, y + 1);
    });
  }

  // buttons
  const fb = lay.fight, canFight = levelState(save.selected) !== 'locked';
  panel(fb.x, fb.y, fb.w, fb.h, inRect(fb, mouse.x, mouse.y) ? '#ffffff' : '#7cf29a', '#2e8a45');
  ctx.textAlign = 'center';
  ctx.font = font(11);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(canFight ? `FIGHT ${levelName(save.selected)}` : 'PICK A LEVEL', fb.x + fb.w / 2, fb.y + 29);
  const bb = lay.back;
  panel(bb.x, bb.y, bb.w, bb.h, inRect(bb, mouse.x, mouse.y) ? '#ffffff' : '#8fd0c6');
  ctx.font = font(9);
  ctx.fillStyle = '#cfe9e4';
  ctx.fillText('< HANGAR', bb.x + bb.w / 2, bb.y + 27);
  ctx.font = font(7);
  ctx.fillStyle = 'rgba(207,233,228,0.45)';
  ctx.fillText('CLICK A LEVEL TO SELECT IT   -   ENTER FIGHTS   -   ESC OR M BACK', W / 2, H - 16);
  ctx.textAlign = 'left';
  drawFsButton();
}

function levelsClick(mx, my) {
  const lay = levelsLayout();
  if (inRect(lay.back, mx, my)) { mode = 'hangar'; return; }
  if (inRect(lay.fight, mx, my)) { if (levelState(save.selected) !== 'locked') startFight(save.selected); return; }
  const t = lay.tiles.find(t => inRect(t, mx, my));
  if (t && levelState(t.L) !== 'locked') { save.selected = t.L; writeSave(); }
}

window.addEventListener('wheel', e => {
  if (mode === 'levels') levelsScroll = (levelsScroll || 0) + Math.sign(e.deltaY);
}, { passive: true });

// hangar button that opens the map
function mapButton() { return { x: W / 2 - 110, y: 58, w: 220, h: 28 }; }
function drawMapButton() {
  const b = mapButton();
  panel(b.x, b.y, b.w, b.h, inRect(b, mouse.x, mouse.y) ? '#ffffff' : '#8fd0c6');
  ctx.textAlign = 'center';
  ctx.font = font(8);
  ctx.fillStyle = '#cfe9e4';
  ctx.fillText('LEVEL MAP  [M]', W / 2, b.y + 19);
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
  else if (mode === 'title' || mode === 'levels') updateIdle(dt);
  else if (mode === 'cleared' || mode === 'dead') {
    particles.forEach(p => { p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; });
    particles = particles.filter(p => p.age < p.life);
  }

  if (mode === 'fight') drawFight();
  else if (mode === 'title') drawTitle();
  else if (mode === 'hangar') drawHangar();
  else if (mode === 'cleared') drawCleared();
  else if (mode === 'dead') drawDead();
  else if (mode === 'levels') drawLevels();

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
  if (mode === 'levels') {
    if (k === 'escape' || k === 'm' || k === 'b' || k === 'backspace') mode = 'hangar';
    if (k === 'enter' && levelState(save.selected) !== 'locked') startFight(save.selected);
    if (k === 'arrowup') levelsScroll = (levelsScroll || 0) - 1;
    if (k === 'arrowdown') levelsScroll = (levelsScroll || 0) + 1;
    return;
  }
  if (mode === 'hangar') {
    if (k === 'm') { mode = 'levels'; levelsScroll = null; return; }
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
  if (mode === 'levels') { levelsClick(e.clientX, e.clientY); return; }
  if (mode === 'hangar') hangarClick(e.clientX, e.clientY);
});

titleTime = 0;
elapsed = 0;
particles = [];
makePlayer();
requestAnimationFrame(loop);
