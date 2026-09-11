// Void Salvage -- a bullet-hell boss rush.
// One ship against bosses built from blocks. Shred the armour, expose the core,
// blow it, bank the salvage, and spend it in the hangar before the next fight.

// ---------- setup ----------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

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
const SAVE_KEY = 'voidsalvage:save:v2';
const EMPTY_SAVE = { salvage: 0, upgrades: {}, level: 1, bestLevel: 1, clears: 0 };

let save = loadSave();

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) return Object.assign({}, EMPTY_SAVE, JSON.parse(raw));
  } catch (e) { /* blocked storage: run in memory */ }
  return Object.assign({}, EMPTY_SAVE);
}

function writeSave() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) {}
}

// ---------- upgrades ----------
// Twelve lines, each stacking several levels -- the shop is the meta game.
const UPGRADES = [
  { id: 'damage',    name: 'Rail Slugs',      max: 8, base: 45,  step: 1.36,
    desc: l => `+${l * 25}% bullet damage` },
  { id: 'firerate',  name: 'Feed Servos',     max: 8, base: 45,  step: 1.36,
    desc: l => `+${Math.round(0.16 * l * 100)}% fire rate` },
  { id: 'multi',     name: 'Split Barrel',    max: 4, base: 130, step: 1.85,
    desc: l => `+${l} projectile${l > 1 ? 's' : ''} per shot` },
  { id: 'ricochet',  name: 'Ricochet Rounds', max: 3, base: 150, step: 1.9,
    desc: l => `rounds bounce ${l}x off the arena` },
  { id: 'explosive', name: 'Volatile Rounds', max: 4, base: 170, step: 1.85,
    desc: l => `hits splash ${28 + l * 12}px into the hull` },
  { id: 'homing',    name: 'Seeker Rounds',   max: 3, base: 165, step: 1.85,
    desc: l => `rounds curve toward armour` },
  { id: 'drone',     name: 'Turret Drone',    max: 4, base: 210, step: 1.9,
    desc: l => `${l} drone${l > 1 ? 's' : ''} orbit and fire for you` },
  { id: 'shield',    name: 'Deflector',       max: 6, base: 95,  step: 1.52,
    desc: l => `+${l * 20} shield, recharges out of fire` },
  { id: 'hull',      name: 'Plating',         max: 6, base: 85,  step: 1.48,
    desc: l => `+${l * 25} hull` },
  { id: 'speed',     name: 'Thrusters',       max: 5, base: 75,  step: 1.42,
    desc: l => `+${l * 10}% top speed` },
  { id: 'magnet',    name: 'Tractor Coil',    max: 5, base: 65,  step: 1.42,
    desc: l => `+${l * 40}% salvage pickup range` },
  { id: 'pulse',     name: 'Pulse Capacitor', max: 5, base: 115, step: 1.5,
    desc: l => `pulse charges ${l * 20}% faster` },
];

function lvlOf(id) { return save.upgrades[id] || 0; }
function costOf(up, level) { return Math.round(up.base * Math.pow(up.step, level)); }

let S = {};
function computeStats() {
  S = {
    damage:    1 + 0.25 * lvlOf('damage'),
    fireDelay: 0.15 / (1 + 0.16 * lvlOf('firerate')),
    shots:     1 + lvlOf('multi'),
    ricochet:  lvlOf('ricochet'),
    splash:    lvlOf('explosive') ? 28 + lvlOf('explosive') * 12 : 0,
    homing:    lvlOf('homing'),
    drones:    lvlOf('drone'),
    maxShield: lvlOf('shield') * 20,
    maxHull:   100 + lvlOf('hull') * 25,
    topSpeed:  340 * (1 + 0.10 * lvlOf('speed')),
    magnet:    150 * (1 + 0.40 * lvlOf('magnet')),
    pulseRate: 1 + 0.20 * lvlOf('pulse'),
  };
}
computeStats();

// ---------- world state ----------
// Declared before resize() runs: these are `let` bindings, so touching them
// earlier would throw on the temporal dead zone rather than read as undefined.
let mode = 'title';           // title | hangar | fight | cleared | dead
let player, boss, shots, flak, orbs, particles, drones, stars, nebulae, beams;
let salvageRun, elapsed, shake, hitFlash, paused, fireTimer, pulseRing, titleTime;

// ---------- viewport ----------
let fieldW = 0, fieldH = 0;

function reflowField() {
  if (!stars) return;
  const w = canvas.width, h = canvas.height;
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
  fieldW = w; fieldH = h;
}

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  reflowField();
}
window.addEventListener('resize', resize);
resize();

// ---------- input ----------
const keys = {};
window.addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; });
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

const mouse = { x: canvas.width / 2, y: canvas.height / 2, down: false };
window.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
window.addEventListener('mousedown', () => { mouse.down = true; });
window.addEventListener('mouseup', () => { mouse.down = false; });

// ---------- world ----------
function makeField() {
  stars = [];
  for (let i = 0; i < 220; i++) {
    stars.push({ x: rand(0, canvas.width), y: rand(0, canvas.height), layer: rand(0.2, 1), size: rand(0.5, 2) });
  }
  nebulae = [];
  const colors = ['#3a1f6b', '#0f4c5c', '#5c1f4c'];
  for (let i = 0; i < 4; i++) {
    nebulae.push({
      x: rand(0, canvas.width), y: rand(0, canvas.height), r: rand(150, 320),
      color: colors[i % colors.length], dx: rand(-4, 4), dy: rand(-4, 4),
    });
  }
  fieldW = canvas.width; fieldH = canvas.height;
}
makeField();

function makePlayer() {
  computeStats();
  player = {
    x: canvas.width / 2, y: canvas.height * 0.75,
    vx: 0, vy: 0, angle: -Math.PI / 2,
    radius: 18,        // drawn size
    hitRadius: 12,     // The hitbox stays tighter than the hull, the way bullet
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
  const cell = 30;
  const midC = (cols - 1) / 2, midR = (rows - 1) / 2;
  const density = 0.58 + Math.min(0.28, level * 0.015);
  const armourHp = 3 + Math.floor(level * 0.9) + (guardian ? 2 : 0);

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
  const coreHp = (28 + level * 9) * (guardian ? 2.2 : 1);
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
    b.hp = b.maxHp = Math.max(2, Math.round(armourHp * 0.7));
    b.gun = makeGun(open[i % open.length].type, level);
  }

  const armourTotal = blocks.filter(b => b.kind !== 'core').length;
  return {
    x: canvas.width / 2, y: canvas.height * 0.34, angle: 0,
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
function startFight() {
  makePlayer();
  boss = makeBoss(save.level);
  shots = []; flak = []; orbs = []; particles = []; beams = [];
  drones = [];
  for (let i = 0; i < S.drones; i++) drones.push({ phase: (Math.PI * 2 * i) / S.drones, timer: rand(0, 0.5), x: 0, y: 0 });
  salvageRun = 0;
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
  spawnParticles(w.x, w.y, isCore ? '#9ff7ff' : (b.kind === 'gun' ? '#ff9f43' : '#b085ff'), isCore ? 60 : 14, isCore ? 340 : 130);
  shake = Math.max(shake, isCore ? 30 : 5);

  // Every block pays out.
  const worth = isCore ? 40 + boss.level * 12 : 2 + Math.floor(boss.level * 0.8);
  const drops = isCore ? 14 : (b.kind === 'gun' ? 3 : 2);
  for (let i = 0; i < drops; i++) {
    orbs.push({ x: w.x + rand(-8, 8), y: w.y + rand(-8, 8), vx: rand(-70, 70), vy: rand(-70, 70), r: 5, value: Math.max(1, Math.round(worth / drops)) });
  }

  if (isCore) {
    clearFight();
    return;
  }
  boss.armourLeft--;
  if (boss.armourLeft <= boss.armourTotal * 0.2) boss.sealed = false;
}

function damageBlock(b, dmg) {
  if (!b.alive) return;
  if (b.kind === 'core' && boss.sealed) { b.flash = 0.08; return; }
  b.hp -= dmg;
  b.flash = 0.1;
  if (b.hp <= 0) breakBlock(b);
}

function splashDamage(x, y, radius, dmg) {
  boss.blocks.forEach(b => {
    if (!b.alive) return;
    const w = blockWorld(b);
    if (dist(w.x, w.y, x, y) < radius) damageBlock(b, dmg);
  });
}

function clearFight() {
  // Killing the core ends the fight instantly, so anything still drifting --
  // including the core's own payout -- would be unreachable. The wreck is
  // salvaged for you. (Dying does not: uncollected orbs are the risk.)
  orbs.forEach(o => { salvageRun += o.value; });
  orbs = [];
  save.salvage += salvageRun;
  save.clears++;
  save.level++;
  if (save.level > save.bestLevel) save.bestLevel = save.level;
  writeSave();
  mode = 'cleared';
}

function failFight() {
  // You keep what you actually picked up -- cash out is the point of the loop.
  save.salvage += salvageRun;
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
      beams.push({ x: w.x, y: w.y, angle: g.aim, len: Math.hypot(canvas.width, canvas.height), firing: g.state === 'fire' });
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
      vx: Math.cos(a) * 760, vy: Math.sin(a) * 760,
      r: 4, dmg: S.damage, bounces: S.ricochet,
    });
  }
}

function fireDrone(d) {
  const t = nearestBlock(d.x, d.y);
  if (!t) return;
  const a = Math.atan2(t.y - d.y, t.x - d.x);
  shots.push({ x: d.x, y: d.y, vx: Math.cos(a) * 700, vy: Math.sin(a) * 700, r: 3, dmg: S.damage * 0.6, bounces: 0 });
}

// ---------- update ----------
function driftField(dt, vx, vy) {
  stars.forEach(s => {
    s.x -= vx * s.layer * 0.25 * dt; s.y -= vy * s.layer * 0.25 * dt;
    if (s.x < 0) s.x += canvas.width; else if (s.x > canvas.width) s.x -= canvas.width;
    if (s.y < 0) s.y += canvas.height; else if (s.y > canvas.height) s.y -= canvas.height;
  });
  nebulae.forEach(n => {
    n.x += n.dx * dt; n.y += n.dy * dt;
    if (n.x < -n.r) n.x = canvas.width + n.r;
    if (n.x > canvas.width + n.r) n.x = -n.r;
    if (n.y < -n.r) n.y = canvas.height + n.r;
    if (n.y > canvas.height + n.r) n.y = -n.r;
  });
}

function hurtPlayer(amount) {
  if (player.invuln > 0) return;
  player.invuln = 0.55;
  player.shieldTimer = 2.5;
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
  player.x = clamp(player.x + player.vx * dt, player.radius, canvas.width - player.radius);
  player.y = clamp(player.y + player.vy * dt, player.radius, canvas.height - player.radius);
  player.angle = Math.atan2(mouse.y - player.y, mouse.x - player.x);

  if (mag > 0) player.trail.push({ x: player.x, y: player.y, age: 0, life: 0.32 });
  player.trail.forEach(p => (p.age += dt));
  player.trail = player.trail.filter(p => p.age < p.life);

  if (player.invuln > 0) player.invuln -= dt;
  if (player.shieldTimer > 0) player.shieldTimer -= dt;
  else if (player.shield < S.maxShield) player.shield = Math.min(S.maxShield, player.shield + 14 * dt);

  fireTimer -= dt;
  if (mouse.down && fireTimer <= 0) { fireTimer = S.fireDelay; firePlayer(); }

  // --- pulse ---
  if (keys['e'] && player.pulse >= player.maxPulse) {
    player.pulse = 0;
    shake = Math.max(shake, 16);
    pulseRing = { r: 0, max: 260, age: 0, life: 0.45 };
    spawnParticles(player.x, player.y, '#9ff7ff', 40, 260);
    flak = flak.filter(f => dist(f.x, f.y, player.x, player.y) >= 260);
    splashDamage(player.x, player.y, 260, 4 * S.damage);
  }

  // --- boss ---
  boss.t += dt;
  boss.x = canvas.width / 2 + Math.sin(boss.t * 0.33) * canvas.width * 0.2;
  boss.y = canvas.height * 0.34 + Math.sin(boss.t * 0.51) * canvas.height * 0.12;
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
    if (d.timer <= 0) { d.timer = 0.5; fireDrone(d); }
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
      if (s.x < 0 || s.x > canvas.width) { s.vx *= -1; s.x = clamp(s.x, 0, canvas.width); s.bounces--; }
      if (s.y < 0 || s.y > canvas.height) { s.vy *= -1; s.y = clamp(s.y, 0, canvas.height); s.bounces--; }
    }
  });
  shots = shots.filter(s => {
    const hit = blockAtWorld(s.x, s.y);
    if (hit) {
      damageBlock(hit, s.dmg);
      if (S.splash) splashDamage(s.x, s.y, S.splash, s.dmg * 0.5);
      spawnParticles(s.x, s.y, '#ffd166', 5, 90);
      return false;
    }
    return s.x > -30 && s.x < canvas.width + 30 && s.y > -30 && s.y < canvas.height + 30;
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
    return f.life > 0 && f.x > -40 && f.x < canvas.width + 40 && f.y > -40 && f.y < canvas.height + 40;
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
      salvageRun += o.value;
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
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, '#07070f'); g.addColorStop(1, '#0c0c1a');
  ctx.fillStyle = g;
  ctx.fillRect(-40, -40, canvas.width + 80, canvas.height + 80);
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

const BLOCK_COLOR = { armour: '#b085ff', gun: '#ff9f43', core: '#9ff7ff' };

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

  ctx.shadowColor = '#9ff7ff';
  ctx.shadowBlur = sealed ? 6 : 16 + pulse * 16;
  ctx.fillStyle = sealed ? '#3d6f7d' : `rgb(${170 + Math.round(pulse * 70)},255,255)`;
  ctx.beginPath(); ctx.arc(0, 0, h * 0.36 * (1 - hurt * 0.3), 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
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
      ctx.shadowColor = base;
      ctx.shadowBlur = 6;
      drawPlate(s, h, base, hurt);
      ctx.shadowBlur = 0;
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

function drawFight() {
  ctx.save();
  if (shake > 0) ctx.translate(rand(-shake, shake), rand(-shake, shake));
  drawBackdrop();

  player.trail.forEach(p => {
    const a = 1 - p.age / p.life;
    ctx.fillStyle = `rgba(120,200,255,${a * 0.5})`;
    ctx.beginPath(); ctx.arc(p.x, p.y, 4 * a, 0, Math.PI * 2); ctx.fill();
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
    ctx.save();
    ctx.shadowColor = '#ff4d6d'; ctx.shadowBlur = bm.firing ? 24 : 8;
    ctx.strokeStyle = bm.firing ? 'rgba(255,90,120,0.95)' : 'rgba(255,90,120,0.35)';
    ctx.lineWidth = bm.firing ? 14 : 2;
    ctx.beginPath(); ctx.moveTo(bm.x, bm.y); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.restore();
  });

  particles.forEach(p => {
    const a = 1 - p.age / p.life;
    ctx.globalAlpha = a; ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
  });
  ctx.globalAlpha = 1;

  orbs.forEach(o => {
    ctx.save(); ctx.shadowColor = '#9ff7ff'; ctx.shadowBlur = 12; ctx.fillStyle = '#9ff7ff';
    ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  });

  flak.forEach(f => {
    ctx.save(); ctx.shadowColor = f.color; ctx.shadowBlur = 12; ctx.fillStyle = f.color;
    ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  });

  shots.forEach(s => {
    ctx.save(); ctx.shadowColor = '#ffd166'; ctx.shadowBlur = 10; ctx.fillStyle = '#ffd166';
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  });

  drones.forEach(d => {
    ctx.save(); ctx.shadowColor = '#7cffb2'; ctx.shadowBlur = 10; ctx.fillStyle = '#7cffb2';
    ctx.beginPath(); ctx.arc(d.x, d.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  });

  ctx.save();
  ctx.translate(player.x, player.y); ctx.rotate(player.angle);
  ctx.shadowColor = player.invuln > 0 ? '#ffffff' : '#7fd8ff'; ctx.shadowBlur = 18;
  ctx.fillStyle = player.invuln > 0 ? '#ffffff' : '#7fd8ff';
  ctx.beginPath();
  ctx.moveTo(player.radius, 0);
  ctx.lineTo(-player.radius * 0.8, player.radius * 0.7);
  ctx.lineTo(-player.radius * 0.4, 0);
  ctx.lineTo(-player.radius * 0.8, -player.radius * 0.7);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  if (player.shield > 0) {
    ctx.strokeStyle = `rgba(159,247,255,${0.25 + 0.4 * (player.shield / Math.max(1, S.maxShield))})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(player.x, player.y, player.radius + 7, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.restore();

  if (hitFlash > 0) {
    ctx.fillStyle = `rgba(255,60,60,${hitFlash * 0.3})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
  ctx.strokeRect(x, y, w, h);
}

function drawHUD() {
  ctx.font = '14px monospace'; ctx.textAlign = 'left'; ctx.fillStyle = '#ffffff';
  ctx.fillText('HULL', 20, 28);
  bar(74, 16, 170, 15, player.hull / S.maxHull, '#4dff88');
  if (S.maxShield > 0) {
    ctx.fillText('SHLD', 20, 50);
    bar(74, 38, 170, 15, player.shield / S.maxShield, '#7fd8ff');
  }
  const py = S.maxShield > 0 ? 72 : 50;
  ctx.fillStyle = '#ffffff';
  ctx.fillText('PULSE', 20, py);
  bar(74, py - 12, 170, 15, player.pulse / player.maxPulse, '#9ff7ff');
  if (player.pulse >= player.maxPulse) { ctx.fillStyle = '#9ff7ff'; ctx.fillText('[E]', 252, py); }

  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`LEVEL ${boss.level}${boss.guardian ? '  — GUARDIAN' : ''}`, canvas.width - 20, 28);
  ctx.fillStyle = '#9ff7ff';
  ctx.fillText(`SALVAGE +${salvageRun}`, canvas.width - 20, 48);
  ctx.fillStyle = boss.sealed ? '#b085ff' : '#ff9f43';
  ctx.fillText(boss.sealed ? `ARMOUR ${Math.round((boss.armourLeft / boss.armourTotal) * 100)}%` : 'CORE EXPOSED', canvas.width - 20, 68);

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '13px monospace';
  ctx.fillText('WASD move   mouse aim + click to fire   E pulse   P pause', 20, canvas.height - 18);
}

function drawPaused() {
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.font = 'bold 40px monospace';
  ctx.fillText('PAUSED', canvas.width / 2, canvas.height / 2 - 6);
  ctx.font = '17px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText('P or Esc to resume', canvas.width / 2, canvas.height / 2 + 28);
  ctx.textAlign = 'left';
}

// ---------- hangar ----------
// Layout is computed once and shared by the renderer and the click handler, so
// what you see is exactly what you can click.
function hangarLayout() {
  const cols = canvas.width < 900 ? 2 : (canvas.width < 1250 ? 3 : 4);
  const cw = 250, ch = 92, gap = 14;
  const totalW = cols * cw + (cols - 1) * gap;
  const x0 = (canvas.width - totalW) / 2;
  const y0 = 168;
  const cards = UPGRADES.map((up, i) => {
    const level = lvlOf(up.id);
    const maxed = level >= up.max;
    const cost = maxed ? 0 : costOf(up, level);
    return {
      up, level, maxed, cost,
      afford: !maxed && save.salvage >= cost,
      x: x0 + (i % cols) * (cw + gap),
      y: y0 + Math.floor(i / cols) * (ch + gap),
      w: cw, h: ch,
    };
  });
  const rows = Math.ceil(UPGRADES.length / cols);
  const launch = { x: canvas.width / 2 - 130, y: y0 + rows * (ch + gap) + 16, w: 260, h: 52 };
  return { cards, launch };
}

function drawHangar() {
  drawBackdrop();
  ctx.fillStyle = 'rgba(5,5,12,0.72)'; ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#eaf6ff'; ctx.font = 'bold 40px monospace';
  ctx.fillText('HANGAR', canvas.width / 2, 62);
  ctx.font = '16px monospace'; ctx.fillStyle = '#9ff7ff';
  ctx.fillText(`SALVAGE ${save.salvage}`, canvas.width / 2, 92);
  ctx.fillStyle = 'rgba(228,238,255,0.65)';
  ctx.fillText(`next fight: level ${save.level}${save.level % 5 === 0 ? '  (GUARDIAN)' : ''}   ·   best ${save.bestLevel}`, canvas.width / 2, 116);

  const { cards, launch } = hangarLayout();
  cards.forEach(c => {
    ctx.fillStyle = c.maxed ? 'rgba(159,247,255,0.10)' : (c.afford ? 'rgba(159,247,255,0.16)' : 'rgba(255,255,255,0.05)');
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.strokeStyle = c.maxed ? 'rgba(159,247,255,0.5)' : (c.afford ? '#9ff7ff' : 'rgba(255,255,255,0.15)');
    ctx.lineWidth = 1.5;
    ctx.strokeRect(c.x, c.y, c.w, c.h);

    ctx.textAlign = 'left';
    ctx.fillStyle = c.afford || c.maxed ? '#eaf6ff' : 'rgba(234,246,255,0.5)';
    ctx.font = 'bold 15px monospace';
    ctx.fillText(c.up.name, c.x + 12, c.y + 24);

    ctx.font = '12px monospace';
    ctx.fillStyle = 'rgba(228,238,255,0.6)';
    ctx.fillText(c.up.desc(Math.max(1, c.level + (c.maxed ? 0 : 1))), c.x + 12, c.y + 45);

    // level pips
    for (let i = 0; i < c.up.max; i++) {
      ctx.fillStyle = i < c.level ? '#9ff7ff' : 'rgba(255,255,255,0.16)';
      ctx.fillRect(c.x + 12 + i * 12, c.y + 58, 8, 5);
    }

    ctx.textAlign = 'right';
    ctx.font = 'bold 13px monospace';
    ctx.fillStyle = c.maxed ? 'rgba(159,247,255,0.7)' : (c.afford ? '#9ff7ff' : 'rgba(255,255,255,0.35)');
    ctx.fillText(c.maxed ? 'MAX' : `${c.cost}`, c.x + c.w - 12, c.y + c.h - 12);
  });

  ctx.fillStyle = 'rgba(159,247,255,0.18)';
  ctx.fillRect(launch.x, launch.y, launch.w, launch.h);
  ctx.strokeStyle = '#9ff7ff'; ctx.lineWidth = 2;
  ctx.strokeRect(launch.x, launch.y, launch.w, launch.h);
  ctx.textAlign = 'center'; ctx.fillStyle = '#eaf6ff'; ctx.font = 'bold 20px monospace';
  ctx.fillText(`LAUNCH  —  LEVEL ${save.level}`, launch.x + launch.w / 2, launch.y + 34);

  ctx.font = '12px monospace'; ctx.fillStyle = 'rgba(228,238,255,0.4)';
  ctx.fillText('click an upgrade to buy   ·   Enter or click LAUNCH to fight   ·   R resets the save', canvas.width / 2, launch.y + launch.h + 26);
  ctx.textAlign = 'left';
}

function hangarClick(mx, my) {
  const { cards, launch } = hangarLayout();
  if (mx >= launch.x && mx <= launch.x + launch.w && my >= launch.y && my <= launch.y + launch.h) {
    startFight();
    return;
  }
  for (const c of cards) {
    if (mx < c.x || mx > c.x + c.w || my < c.y || my > c.y + c.h) continue;
    if (c.maxed || !c.afford) return;
    save.salvage -= c.cost;
    save.upgrades[c.up.id] = c.level + 1;
    computeStats();
    writeSave();
    return;
  }
}

// ---------- other screens ----------
function centreText(lines, topY) {
  ctx.textAlign = 'center';
  let y = topY;
  lines.forEach(l => {
    ctx.fillStyle = l.color || '#eaf6ff';
    ctx.font = l.font || '16px monospace';
    ctx.fillText(l.text, canvas.width / 2, y);
    y += l.gap || 26;
  });
  ctx.textAlign = 'left';
}

function drawTitle() {
  drawBackdrop();
  ctx.fillStyle = 'rgba(5,5,12,0.55)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const cy = canvas.height / 2;
  ctx.save();
  ctx.shadowColor = '#7fd8ff'; ctx.shadowBlur = 26;
  centreText([{ text: 'VOID SALVAGE', font: 'bold 62px monospace', gap: 44 }], cy - 90);
  ctx.restore();
  centreText([
    { text: 'One ship against bosses built from blocks.', color: 'rgba(228,238,255,0.8)' },
    { text: 'Shred the armour, expose the core, blow it.', color: 'rgba(228,238,255,0.8)' },
    { text: 'Every block you break pays out. Spend it in the hangar.', color: 'rgba(228,238,255,0.55)', gap: 40 },
    { text: save.bestLevel > 1 ? `best level reached: ${save.bestLevel}   ·   salvage banked: ${save.salvage}` : 'WASD move  ·  mouse aim  ·  click to fire  ·  E pulse', color: 'rgba(159,247,255,0.75)', gap: 46 },
    { text: 'click or press any key to enter the hangar', color: `rgba(159,247,255,${0.55 + Math.sin(titleTime * 3) * 0.35})`, font: 'bold 18px monospace' },
  ], cy - 34);
}

function drawCleared() {
  drawFightBackdropStill();
  centreText([
    { text: 'CORE DESTROYED', font: 'bold 44px monospace', color: '#9ff7ff', gap: 44 },
    { text: `level ${save.level - 1} cleared   ·   +${salvageRun} salvage`, gap: 30 },
    { text: `banked: ${save.salvage}`, color: 'rgba(228,238,255,0.65)', gap: 44 },
    { text: 'click or press any key for the hangar', color: '#9ff7ff', font: 'bold 18px monospace' },
  ], canvas.height / 2 - 70);
}

function drawDead() {
  drawFightBackdropStill();
  centreText([
    { text: 'SHIP LOST', font: 'bold 44px monospace', gap: 44 },
    { text: `level ${save.level}   ·   kept +${salvageRun} salvage`, gap: 30 },
    { text: `banked: ${save.salvage}`, color: 'rgba(228,238,255,0.65)', gap: 44 },
    { text: 'click or press any key to refit and retry', color: '#9ff7ff', font: 'bold 18px monospace' },
  ], canvas.height / 2 - 70);
}

// End screens keep the arena behind them, held perfectly still.
function drawFightBackdropStill() {
  drawBackdrop();
  if (boss) drawBoss();
  particles.forEach(p => {
    const a = 1 - p.age / p.life;
    ctx.globalAlpha = a; ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(4,4,10,0.66)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
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
  if (mode === 'title') { mode = 'hangar'; return; }
  if (mode === 'cleared' || mode === 'dead') { mode = 'hangar'; return; }
  if (mode === 'hangar') {
    if (k === 'enter') startFight();
    if (k === 'r') { save = Object.assign({}, EMPTY_SAVE, { upgrades: {} }); computeStats(); writeSave(); }
    return;
  }
  if (mode === 'fight' && (k === 'p' || k === 'escape')) paused = !paused;
});

window.addEventListener('click', e => {
  if (mode === 'title') { mode = 'hangar'; return; }
  if (mode === 'cleared' || mode === 'dead') { mode = 'hangar'; return; }
  if (mode === 'hangar') hangarClick(e.clientX, e.clientY);
});

titleTime = 0;
particles = [];
makePlayer();
requestAnimationFrame(loop);
