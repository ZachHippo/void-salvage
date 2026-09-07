// ---------- setup ----------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

// ---------- helpers ----------
function rand(a, b) { return a + Math.random() * (b - a); }
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------- game state ----------
let player, bullets, enemyBullets, enemies, orbs, particles, stars, nebulae;
let score, elapsed, spawnTimer, shake, gameOver, fireTimer, hitFlash;
let pulseRing = null;
let started = false;
let paused = false;
let titleTime = 0;

// ---------- best score ----------
const BEST_KEY = 'voidsalvage:best';
function loadBest() {
  try { return parseInt(localStorage.getItem(BEST_KEY), 10) || 0; } catch (e) { return 0; }
}
function saveBest(value) {
  // some browsers throw on localStorage over file://; the run still counts in memory
  try { localStorage.setItem(BEST_KEY, String(value)); } catch (e) {}
}
let best = loadBest();

// ---------- viewport ----------
// Size the field was last laid out against, so a resize can carry it across
// instead of leaving stars bunched up in the old bounds.
let fieldW = 0, fieldH = 0;

function reflowField() {
  if (!stars) return;
  const w = canvas.width;
  const h = canvas.height;

  if (!fieldW || !fieldH) {
    // The field was built against a zero-size canvas -- a hidden tab, a
    // minimised window, an iframe that starts collapsed. Scatter it properly
    // now that there is a real viewport to scatter it across.
    stars.forEach(s => { s.x = rand(0, w); s.y = rand(0, h); });
    nebulae.forEach(n => { n.x = rand(0, w); n.y = rand(0, h); });
    if (player) { player.x = w / 2; player.y = h / 2; }
  } else {
    const sx = w / fieldW;
    const sy = h / fieldH;
    stars.forEach(s => { s.x *= sx; s.y *= sy; });
    nebulae.forEach(n => { n.x *= sx; n.y *= sy; });
    if (player) { player.x *= sx; player.y *= sy; }
  }

  fieldW = w;
  fieldH = h;
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

// ---------- enemy archetypes ----------
// Each species owns its stats, steering and silhouette, so adding a new one is
// additive: describe it here, then give it a row in SPAWN_TABLE.
const ENEMY_TYPES = {
  drifter: {
    color: '#ff6b9f', radius: 14, points: 10, orbs: 1, damage: 15, spins: true,
    make: d => ({ speed: rand(70, 110) + d * 60, health: 2 + Math.floor(d * 2) }),
    steer: (en, dt) => {
      const a = Math.atan2(player.y - en.y, player.x - en.x);
      en.x += Math.cos(a) * en.speed * dt;
      en.y += Math.sin(a) * en.speed * dt;
    },
    draw: (g, en) => {
      g.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = (Math.PI / 2) * i;
        const r = i % 2 === 0 ? en.radius : en.radius * 0.5;
        g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.closePath();
      g.fill();
    },
  },

  darter: {
    color: '#7cffb2', radius: 10, points: 15, orbs: 1, damage: 12, spins: false,
    make: d => ({ speed: rand(185, 235) + d * 70, health: 1 + Math.floor(d) }),
    steer: (en, dt) => {
      // weaves in rather than running a straight intercept, so it is hard to lead
      en.phase += dt * 5.5;
      const a = Math.atan2(player.y - en.y, player.x - en.x) + Math.sin(en.phase) * 0.75;
      en.x += Math.cos(a) * en.speed * dt;
      en.y += Math.sin(a) * en.speed * dt;
      en.angle = a;
    },
    draw: (g, en) => {
      const r = en.radius;
      g.beginPath();
      g.moveTo(r * 1.5, 0);
      g.lineTo(-r * 0.8, r * 0.9);
      g.lineTo(-r * 0.2, 0);
      g.lineTo(-r * 0.8, -r * 0.9);
      g.closePath();
      g.fill();
    },
  },

  spitter: {
    color: '#ff9f43', radius: 13, points: 25, orbs: 2, damage: 14, spins: false,
    make: d => ({
      speed: 76 + d * 34,
      health: 3 + Math.floor(d * 2),
      range: rand(240, 330),
      reload: 2.2 - d * 0.8,
    }),
    steer: (en, dt) => {
      // holds a firing lane: closes when too far, backs off when crowded
      const d = dist(en.x, en.y, player.x, player.y);
      const a = Math.atan2(player.y - en.y, player.x - en.x);
      const drive = d > en.range + 40 ? 1 : (d < en.range - 40 ? -1 : 0);
      en.x += Math.cos(a) * en.speed * drive * dt;
      en.y += Math.sin(a) * en.speed * drive * dt;
      en.angle = a;
      en.fireTimer -= dt;
      if (en.fireTimer <= 0 && d < 640) {
        en.fireTimer = en.reload;
        fireEnemyBullet(en, a);
      }
    },
    draw: (g, en) => {
      const r = en.radius;
      const body = g.fillStyle;
      g.beginPath();
      g.arc(0, 0, r * 0.72, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = body;
      g.lineWidth = 2.5;
      g.beginPath();
      g.arc(0, 0, r, 0.5, Math.PI * 2 - 0.5);
      g.stroke();
      g.fillRect(r * 0.55, -2.5, r * 0.75, 5);
    },
  },

  brute: {
    color: '#b085ff', radius: 27, points: 40, orbs: 4, damage: 26, spins: true, heavy: true,
    make: d => ({ speed: rand(34, 52) + d * 24, health: 9 + Math.floor(d * 7) }),
    steer: (en, dt) => {
      const a = Math.atan2(player.y - en.y, player.x - en.x);
      en.x += Math.cos(a) * en.speed * dt;
      en.y += Math.sin(a) * en.speed * dt;
    },
    onDeath: en => {
      // cracks open into two drifters instead of simply vanishing
      for (let i = 0; i < 2; i++) {
        spawnEnemy('drifter', en.x + rand(-24, 24), en.y + rand(-24, 24));
      }
    },
    draw: (g, en) => {
      const r = en.radius;
      const body = g.fillStyle;
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.closePath();
      g.fill();
      g.fillStyle = '#0b0b18';
      g.beginPath();
      g.arc(0, 0, r * 0.42, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = body;
      g.beginPath();
      g.arc(0, 0, r * 0.2, 0, Math.PI * 2);
      g.fill();
    },
  },
};

// Species unlock as the run gets older; weight sets how common each one stays.
const SPAWN_TABLE = [
  { type: 'drifter', after: 0,  weight: 10 },
  { type: 'darter',  after: 15, weight: 7 },
  { type: 'spitter', after: 35, weight: 5 },
  { type: 'brute',   after: 55, weight: 4 },
];

function pickEnemyType() {
  const open = SPAWN_TABLE.filter(row => elapsed >= row.after);
  let total = 0;
  open.forEach(row => (total += row.weight));
  let roll = Math.random() * total;
  for (const row of open) {
    roll -= row.weight;
    if (roll <= 0) return row.type;
  }
  return 'drifter';
}

function threatLevel() { return 1 + Math.floor(elapsed / 20); }

// ---------- lifecycle ----------
function initGame() {
  player = {
    x: canvas.width / 2,
    y: canvas.height / 2,
    vx: 0,
    vy: 0,
    angle: 0,
    radius: 15,
    health: 100,
    maxHealth: 100,
    charge: 0,
    maxCharge: 100,
    invuln: 0,
    trail: [],
  };
  bullets = [];
  enemyBullets = [];
  enemies = [];
  orbs = [];
  particles = [];
  pulseRing = null;

  stars = [];
  for (let i = 0; i < 220; i++) {
    stars.push({
      x: rand(0, canvas.width),
      y: rand(0, canvas.height),
      layer: rand(0.2, 1),
      size: rand(0.5, 2),
    });
  }

  nebulae = [];
  const nebulaColors = ['#3a1f6b', '#0f4c5c', '#5c1f4c'];
  for (let i = 0; i < 4; i++) {
    nebulae.push({
      x: rand(0, canvas.width),
      y: rand(0, canvas.height),
      r: rand(150, 320),
      color: nebulaColors[i % nebulaColors.length],
      dx: rand(-4, 4),
      dy: rand(-4, 4),
    });
  }

  fieldW = canvas.width;
  fieldH = canvas.height;

  score = 0;
  elapsed = 0;
  spawnTimer = 0;
  fireTimer = 0;
  shake = 0;
  hitFlash = 0;
  paused = false;
  gameOver = false;
}

function spawnParticles(x, y, color, count, speed = 120) {
  for (let i = 0; i < count; i++) {
    const a = rand(0, Math.PI * 2);
    const s = rand(speed * 0.2, speed);
    particles.push({
      x, y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: rand(0.3, 0.7),
      age: 0,
      color,
      size: rand(1.5, 3.5),
    });
  }
}

function edgePoint() {
  const edge = Math.floor(rand(0, 4));
  if (edge === 0) return { x: rand(0, canvas.width), y: -30 };
  if (edge === 1) return { x: canvas.width + 30, y: rand(0, canvas.height) };
  if (edge === 2) return { x: rand(0, canvas.width), y: canvas.height + 30 };
  return { x: -30, y: rand(0, canvas.height) };
}

function spawnEnemy(type, x, y) {
  const spec = ENEMY_TYPES[type];
  const difficulty = clamp(elapsed / 60, 0, 1); // ramps over first minute
  if (x === undefined) {
    const p = edgePoint();
    x = p.x;
    y = p.y;
  }
  const en = Object.assign({
    type, x, y,
    radius: spec.radius,
    angle: rand(0, Math.PI * 2),
    spin: rand(-3, 3),
    phase: rand(0, Math.PI * 2),
    fireTimer: rand(0.5, 1.6),
    flash: 0,
    rammed: false,
  }, spec.make(difficulty));
  en.maxHealth = en.health;
  enemies.push(en);
}

function fireEnemyBullet(en, angle) {
  enemyBullets.push({
    x: en.x + Math.cos(angle) * en.radius,
    y: en.y + Math.sin(angle) * en.radius,
    vx: Math.cos(angle) * 265,
    vy: Math.sin(angle) * 265,
    radius: 5,
  });
}

// Clears out anything at zero health and pays for it. Rammed enemies are removed
// without a reward: that collision already cost the player hull.
function reapEnemies() {
  const dead = enemies.filter(en => en.health <= 0);
  if (!dead.length) return;
  enemies = enemies.filter(en => en.health > 0);
  dead.forEach(en => {
    const spec = ENEMY_TYPES[en.type];
    spawnParticles(en.x, en.y, spec.color, 12 + Math.floor(spec.radius * 0.6), 110 + spec.radius * 3);
    if (en.rammed) return;
    for (let i = 0; i < spec.orbs; i++) {
      orbs.push({
        x: en.x + rand(-10, 10),
        y: en.y + rand(-10, 10),
        radius: 6,
        vx: rand(-50, 50),
        vy: rand(-50, 50),
      });
    }
    score += spec.points;
    if (spec.onDeath) spec.onDeath(en);
  });
}

// ---------- update ----------
function driftField(dt, vx, vy) {
  stars.forEach(s => {
    s.x -= vx * s.layer * 0.25 * dt;
    s.y -= vy * s.layer * 0.25 * dt;
    if (s.x < 0) s.x += canvas.width; else if (s.x > canvas.width) s.x -= canvas.width;
    if (s.y < 0) s.y += canvas.height; else if (s.y > canvas.height) s.y -= canvas.height;
  });

  nebulae.forEach(n => {
    n.x += n.dx * dt;
    n.y += n.dy * dt;
    if (n.x < -n.r) n.x = canvas.width + n.r;
    if (n.x > canvas.width + n.r) n.x = -n.r;
    if (n.y < -n.r) n.y = canvas.height + n.r;
    if (n.y > canvas.height + n.r) n.y = -n.r;
  });
}

function update(dt) {
  elapsed += dt;

  // difficulty ramp for spawn rate
  const minInterval = 0.35;
  const startInterval = 1.3;
  const t = clamp(elapsed / 90, 0, 1);
  const spawnInterval = startInterval - (startInterval - minInterval) * t;
  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawnEnemy(pickEnemyType());
    spawnTimer = spawnInterval;
  }

  // --- player movement ---
  let ax = 0, ay = 0;
  if (keys['w'] || keys['arrowup']) ay -= 1;
  if (keys['s'] || keys['arrowdown']) ay += 1;
  if (keys['a'] || keys['arrowleft']) ax -= 1;
  if (keys['d'] || keys['arrowright']) ax += 1;
  const mag = Math.hypot(ax, ay);
  if (mag > 0) { ax /= mag; ay /= mag; }

  const accel = 1800;
  const maxSpeed = 340;
  const friction = 6;

  player.vx += ax * accel * dt;
  player.vy += ay * accel * dt;
  const speed = Math.hypot(player.vx, player.vy);
  if (speed > maxSpeed) {
    player.vx = (player.vx / speed) * maxSpeed;
    player.vy = (player.vy / speed) * maxSpeed;
  }
  player.vx -= player.vx * friction * dt;
  player.vy -= player.vy * friction * dt;

  player.x += player.vx * dt;
  player.y += player.vy * dt;
  player.x = clamp(player.x, player.radius, canvas.width - player.radius);
  player.y = clamp(player.y, player.radius, canvas.height - player.radius);

  player.angle = Math.atan2(mouse.y - player.y, mouse.x - player.x);

  // engine trail
  if (mag > 0) {
    player.trail.push({ x: player.x, y: player.y, age: 0, life: 0.35 });
  }
  player.trail.forEach(p => (p.age += dt));
  player.trail = player.trail.filter(p => p.age < p.life);

  if (player.invuln > 0) player.invuln -= dt;

  // --- firing ---
  fireTimer -= dt;
  if (mouse.down && fireTimer <= 0) {
    fireTimer = 0.14;
    const nose = { x: player.x + Math.cos(player.angle) * player.radius, y: player.y + Math.sin(player.angle) * player.radius };
    bullets.push({
      x: nose.x, y: nose.y,
      vx: Math.cos(player.angle) * 700 + player.vx * 0.3,
      vy: Math.sin(player.angle) * 700 + player.vy * 0.3,
      radius: 4,
    });
  }

  // --- gravity pulse ability ---
  if (keys['e'] && player.charge >= player.maxCharge) {
    player.charge = 0;
    shake = Math.max(shake, 18);
    const pulseRadius = 240;
    pulseRing = { r: 0, max: pulseRadius, age: 0, life: 0.45 };
    spawnParticles(player.x, player.y, '#9ff7ff', 40, 260);
    enemies.forEach(en => {
      if (dist(en.x, en.y, player.x, player.y) < pulseRadius) {
        // brutes are too dense to vaporise outright, but it hurts them badly
        en.health -= ENEMY_TYPES[en.type].heavy ? 8 : 999;
        en.flash = 0.12;
      }
    });
    reapEnemies();
    enemyBullets = enemyBullets.filter(b => dist(b.x, b.y, player.x, player.y) >= pulseRadius);
  }

  // --- bullets ---
  bullets.forEach(b => { b.x += b.vx * dt; b.y += b.vy * dt; });
  bullets = bullets.filter(b => b.x > -20 && b.x < canvas.width + 20 && b.y > -20 && b.y < canvas.height + 20);

  enemyBullets.forEach(b => { b.x += b.vx * dt; b.y += b.vy * dt; });
  enemyBullets = enemyBullets.filter(b => b.x > -20 && b.x < canvas.width + 20 && b.y > -20 && b.y < canvas.height + 20);

  // --- enemies ---
  enemies.forEach(en => {
    const spec = ENEMY_TYPES[en.type];
    spec.steer(en, dt);
    if (spec.spins) en.angle += en.spin * dt;
    if (en.flash > 0) en.flash -= dt;
  });

  // bullet vs enemy -- a round stops at the first thing it hits
  for (const b of bullets) {
    for (const en of enemies) {
      if (en.health > 0 && dist(b.x, b.y, en.x, en.y) < en.radius + b.radius) {
        en.health -= 1;
        en.flash = 0.08;
        b.hit = true;
        spawnParticles(b.x, b.y, '#ffd166', 6, 90);
        break;
      }
    }
  }
  bullets = bullets.filter(b => !b.hit);
  reapEnemies();

  // enemy vs player
  if (player.invuln <= 0) {
    for (const en of enemies) {
      if (dist(en.x, en.y, player.x, player.y) < en.radius + player.radius) {
        const spec = ENEMY_TYPES[en.type];
        player.health -= spec.damage;
        player.invuln = 0.9;
        shake = Math.max(shake, spec.heavy ? 20 : 12);
        hitFlash = 0.2;
        spawnParticles(player.x, player.y, '#ff4d4d', 14);
        if (spec.heavy) {
          // brutes shrug off the impact and shove you clear instead of dying
          const a = Math.atan2(player.y - en.y, player.x - en.x);
          player.vx = Math.cos(a) * 420;
          player.vy = Math.sin(a) * 420;
        } else {
          en.health = 0;
          en.rammed = true;
        }
        break;
      }
    }
    reapEnemies();
  }

  // enemy fire vs player
  if (player.invuln <= 0) {
    for (const b of enemyBullets) {
      if (dist(b.x, b.y, player.x, player.y) < player.radius + b.radius) {
        player.health -= 10;
        player.invuln = 0.6;
        shake = Math.max(shake, 9);
        hitFlash = 0.18;
        spawnParticles(b.x, b.y, '#ff5470', 12);
        b.hit = true;
        break;
      }
    }
    enemyBullets = enemyBullets.filter(b => !b.hit);
  }

  // --- orbs ---
  orbs.forEach(o => {
    const d = dist(o.x, o.y, player.x, player.y);
    if (d < 140) {
      const a = Math.atan2(player.y - o.y, player.x - o.x);
      o.vx = Math.cos(a) * 260;
      o.vy = Math.sin(a) * 260;
    }
    o.x += o.vx * dt;
    o.y += o.vy * dt;
  });
  orbs = orbs.filter(o => {
    if (dist(o.x, o.y, player.x, player.y) < 18) {
      player.charge = Math.min(player.maxCharge, player.charge + 12);
      return false;
    }
    return true;
  });

  // --- particles ---
  particles.forEach(p => {
    p.age += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx -= p.vx * 3 * dt;
    p.vy -= p.vy * 3 * dt;
  });
  particles = particles.filter(p => p.age < p.life);

  // --- starfield parallax, driven by how the ship is moving ---
  driftField(dt, player.vx, player.vy);

  if (pulseRing) {
    pulseRing.age += dt;
    pulseRing.r = pulseRing.max * (pulseRing.age / pulseRing.life);
    if (pulseRing.age >= pulseRing.life) pulseRing = null;
  }

  if (shake > 0) shake = Math.max(0, shake - dt * 40);
  if (hitFlash > 0) hitFlash -= dt;

  if (player.health <= 0) {
    player.health = 0;
    gameOver = true;
    // hold the frame steady under the SHIP LOST overlay -- this also clears any
    // shake the killing blow left decaying
    shake = 0;
    spawnParticles(player.x, player.y, '#7fd8ff', 46, 320);
    if (score > best) {
      best = score;
      saveBest(best);
    }
  }
}

// keeps the title screen from being a still image
function updateIdle(dt) {
  titleTime += dt;
  driftField(dt, 40, 14);
}

// ---------- draw ----------
function draw() {
  ctx.save();

  if (shake > 0) {
    ctx.translate(rand(-shake, shake), rand(-shake, shake));
  }

  // background
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, '#07070f');
  grad.addColorStop(1, '#0c0c1a');
  ctx.fillStyle = grad;
  ctx.fillRect(-40, -40, canvas.width + 80, canvas.height + 80);

  // nebulae
  nebulae.forEach(n => {
    const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r);
    g.addColorStop(0, n.color + '33');
    g.addColorStop(1, n.color + '00');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fill();
  });

  // stars (parallax based on layer)
  stars.forEach(s => {
    ctx.fillStyle = `rgba(255,255,255,${0.4 + s.layer * 0.6})`;
    ctx.fillRect(s.x, s.y, s.size, s.size);
  });

  // engine trail
  player.trail.forEach(p => {
    const a = 1 - p.age / p.life;
    ctx.fillStyle = `rgba(120,200,255,${a * 0.5})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4 * a, 0, Math.PI * 2);
    ctx.fill();
  });

  // pulse shockwave
  if (pulseRing) {
    const a = 1 - pulseRing.age / pulseRing.life;
    ctx.strokeStyle = `rgba(159,247,255,${a * 0.9})`;
    ctx.lineWidth = 3 + a * 5;
    ctx.beginPath();
    ctx.arc(player.x, player.y, pulseRing.r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // particles
  particles.forEach(p => {
    const a = 1 - p.age / p.life;
    ctx.fillStyle = p.color;
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  // orbs
  orbs.forEach(o => {
    ctx.save();
    ctx.shadowColor = '#9ff7ff';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#9ff7ff';
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  // bullets
  bullets.forEach(b => {
    ctx.save();
    ctx.shadowColor = '#ffd166';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  // enemies
  enemies.forEach(en => {
    const spec = ENEMY_TYPES[en.type];
    ctx.save();
    ctx.translate(en.x, en.y);
    ctx.rotate(en.angle);
    ctx.shadowColor = spec.color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = en.flash > 0 ? '#ffffff' : spec.color;
    spec.draw(ctx, en);
    ctx.restore();

    // tanky species show how much is left in them
    if (en.maxHealth > 4 && en.health < en.maxHealth) {
      const w = en.radius * 2;
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(en.x - w / 2, en.y - en.radius - 12, w, 4);
      ctx.fillStyle = spec.color;
      ctx.fillRect(en.x - w / 2, en.y - en.radius - 12, w * (en.health / en.maxHealth), 4);
    }
  });

  // enemy fire
  enemyBullets.forEach(b => {
    ctx.save();
    ctx.shadowColor = '#ff5470';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#ff5470';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  // player
  if (!gameOver) {
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.angle);
    ctx.shadowColor = player.invuln > 0 ? '#ffffff' : '#7fd8ff';
    ctx.shadowBlur = 18;
    ctx.fillStyle = player.invuln > 0 ? '#ffffff' : '#7fd8ff';
    ctx.beginPath();
    ctx.moveTo(player.radius, 0);
    ctx.lineTo(-player.radius * 0.8, player.radius * 0.7);
    ctx.lineTo(-player.radius * 0.4, 0);
    ctx.lineTo(-player.radius * 0.8, -player.radius * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  ctx.restore(); // end shake transform

  // hit flash overlay
  if (hitFlash > 0) {
    ctx.fillStyle = `rgba(255,60,60,${hitFlash * 0.3})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (!started) {
    drawTitle();
    return;
  }

  drawHUD();

  if (paused) drawPaused();
  if (gameOver) drawGameOver();
}

function drawBar(x, y, w, h, pct, color, bgColor) {
  ctx.fillStyle = bgColor;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * clamp(pct, 0, 1), h);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.strokeRect(x, y, w, h);
}

function drawHUD() {
  ctx.font = '14px monospace';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';

  ctx.fillText('HULL', 20, 28);
  drawBar(70, 16, 160, 16, player.health / player.maxHealth, '#4dff88', 'rgba(255,255,255,0.1)');

  ctx.fillText('PULSE', 20, 52);
  drawBar(70, 40, 160, 16, player.charge / player.maxCharge, '#9ff7ff', 'rgba(255,255,255,0.1)');
  if (player.charge >= player.maxCharge) {
    ctx.fillStyle = '#9ff7ff';
    ctx.fillText('[E] READY', 240, 52);
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`SCORE ${score}`, canvas.width - 20, 28);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText(`BEST ${best}`, canvas.width - 20, 48);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`TIME ${elapsed.toFixed(0)}s`, canvas.width - 20, 68);
  ctx.fillStyle = '#ff9f43';
  ctx.fillText(`THREAT ${threatLevel()}`, canvas.width - 20, 88);

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '13px monospace';
  ctx.fillText('WASD move   mouse aim + click to shoot   E = pulse blast when charged   P = pause', 20, canvas.height - 18);
}

function drawTitle() {
  ctx.fillStyle = 'rgba(5,5,12,0.55)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  ctx.textAlign = 'center';

  ctx.save();
  ctx.shadowColor = '#7fd8ff';
  ctx.shadowBlur = 26;
  ctx.fillStyle = '#eaf6ff';
  ctx.font = 'bold 62px monospace';
  ctx.fillText('VOID SALVAGE', cx, cy - 50);
  ctx.restore();

  ctx.fillStyle = 'rgba(228,238,255,0.75)';
  ctx.font = '16px monospace';
  ctx.fillText('WASD to thrust    mouse to aim    click to fire', cx, cy);
  ctx.fillText('salvage the orbs your kills leave behind to charge the pulse', cx, cy + 26);
  ctx.fillText('E detonates it    P pauses', cx, cy + 52);

  if (best > 0) {
    ctx.fillStyle = 'rgba(159,247,255,0.8)';
    ctx.font = '15px monospace';
    ctx.fillText(`best run: ${best}`, cx, cy + 88);
  }

  ctx.fillStyle = `rgba(159,247,255,${0.55 + Math.sin(titleTime * 3) * 0.35})`;
  ctx.font = 'bold 18px monospace';
  ctx.fillText('click or press any key to launch', cx, cy + 128);

  ctx.textAlign = 'left';
}

function drawPaused() {
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 40px monospace';
  ctx.fillText('PAUSED', canvas.width / 2, canvas.height / 2 - 6);
  ctx.font = '17px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText('P or Esc to resume', canvas.width / 2, canvas.height / 2 + 28);
  ctx.textAlign = 'left';
}

function drawGameOver() {
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 42px monospace';
  ctx.fillText('SHIP LOST', canvas.width / 2, canvas.height / 2 - 20);
  ctx.font = '18px monospace';
  ctx.fillText(`Score: ${score}   Survived: ${elapsed.toFixed(0)}s   Threat: ${threatLevel()}`, canvas.width / 2, canvas.height / 2 + 16);

  if (score > 0 && score >= best) {
    ctx.fillStyle = '#9ff7ff';
    ctx.fillText('new best run', canvas.width / 2, canvas.height / 2 + 44);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText(`Best: ${best}`, canvas.width / 2, canvas.height / 2 + 44);
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillText('Click or press R to try again', canvas.width / 2, canvas.height / 2 + 76);
  ctx.textAlign = 'left';
}

// ---------- loop ----------
let lastTime = 0;
function loop(timestamp) {
  const dt = Math.min(0.033, (timestamp - lastTime) / 1000 || 0);
  lastTime = timestamp;

  if (!started) updateIdle(dt);
  else if (!gameOver && !paused) update(dt);

  draw();

  requestAnimationFrame(loop);
}

window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (!started) {
    started = true;
    return;
  }
  if (gameOver) {
    if (k === 'r') initGame();
    return;
  }
  if (k === 'p' || k === 'escape') paused = !paused;
});
window.addEventListener('mousedown', () => {
  if (!started) {
    started = true;
    return;
  }
  if (gameOver) initGame();
});

initGame();
requestAnimationFrame(loop);
