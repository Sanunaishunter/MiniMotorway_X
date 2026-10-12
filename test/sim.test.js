// Headless simulation tests: node test/sim.test.js
'use strict';
const path = require('path');
require(path.join(__dirname, '../js/core.js'));
require(path.join(__dirname, '../js/sim.js'));
const MM = globalThis.MM;

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error('  FAIL: ' + msg); } else console.log('  ok:   ' + msg);
}

// BFS over land nodes (no water) from a building to the nearest road-connected node / target
function bfsPath(g, from, to) {
  const w = g.world;
  const prev = new Map([[from, -1]]);
  const q = [from];
  while (q.length) {
    const u = q.shift();
    if (u === to) break;
    for (let d = 0; d < 4; d++) {
      const v = w.nb(u, d);
      if (v < 0 || prev.has(v) || w.water[v]) continue;
      if (w.bld[v] && v !== to) continue;
      prev.set(v, u);
      q.push(v);
    }
  }
  if (!prev.has(to)) return null;
  const p = [];
  for (let x = to; x !== -1; x = prev.get(x)) p.push(x);
  return p.reverse();
}

function connect(g, a, b) {
  const p = bfsPath(g, a, b);
  if (!p) return false;
  for (let i = 0; i + 1 < p.length; i++) g.addEdge(p[i], p[i + 1], 1);
  return true;
}

function autoConnect(g) {
  for (const h of g.houses) {
    const ds = g.dests.filter((d) => d.color === h.color);
    if (ds.length && !h._wired) { if (connect(g, h.node, ds[0].node)) h._wired = true; }
  }
}

function sanity(g) {
  for (const c of g.cars) {
    if (!(c.s >= 0 && c.s <= 1.0001) || Number.isNaN(c.s)) return 'bad s ' + c.s;
    const a = c.path[c.i], b = c.path[c.i + 1];
    if (!g.world.edgeBetween(a, b)) return 'car on missing edge';
    if (c.lane !== a * 4 + g.world.dirOf(a, b)) return 'lane mismatch';
  }
  for (let i = 0; i < g.holders.length; i++) if (g.holders[i] < 0) return 'negative holders at ' + i;
  for (let i = 0; i < g.reserved.length; i++) if (g.reserved[i] < 0) return 'negative reservation at ' + i;
  return null;
}

console.log('1. world generation');
for (let seed = 1; seed <= 40; seed++) {
  const g = new MM.Game({ seed });
  if (g.dests.length !== 1 || g.houses.length < 2) { failures++; console.error('  FAIL: seed ' + seed + ' setup'); }
}
console.log('  ok:   40 seeds produce a valid starting layout');

console.log('2. basic delivery with auto-wired roads');
{
  const g = new MM.Game({ seed: 7 });
  let err = null;
  for (let t = 0; t < 25 * 360 && g.state !== 'over'; t++) {
    if (g.state === 'upgrade') g.chooseUpgrade(0);
    if (t % 25 === 0) autoConnect(g);
    g.update(0.04);
    err = err || sanity(g);
  }
  console.log(`  score=${g.score} week=${g.week} cars=${g.cars.length} houses=${g.houses.length} state=${g.state}`);
  check(!err, 'invariants hold (' + err + ')');
  check(g.score > 20, 'cars get delivered');
}

console.log('3. unconnected houses eventually cause game over');
{
  const g = new MM.Game({ seed: 3 });
  for (let t = 0; t < 60 * 60 * 5 && g.state === 'running'; t++) g.update(0.04);
  check(g.state === 'over', 'game over without roads');
}

console.log('4. random road editing stress (no crashes, invariants hold)');
{
  const g = new MM.Game({ seed: 11 });
  g.inv.light = 99; g.inv.round = 99; g.inv.hw = 99; g.inv.bridge = 99;
  const rnd = MM.mulberry32(5);
  let err = null;
  for (let t = 0; t < 60 * 20 && g.state !== 'over'; t++) {
    if (g.state === 'upgrade') g.chooseUpgrade(0);
    if (t % 20 === 0) autoConnect(g);
    const n = Math.floor(rnd() * g.world.n);
    const d = Math.floor(rnd() * 4);
    const m = g.world.nb(n, d);
    const r = rnd();
    if (m >= 0) {
      if (r < 0.45) g.addEdge(n, m, 1);
      else if (r < 0.55) g.addEdge(n, m, 2);
      else if (r < 0.75) g.removeEdge(n, m);
      else if (r < 0.85) g.placeFeature(n, 'light');
      else if (r < 0.92) g.placeFeature(n, 'round');
      else g.removeFeature(n);
    }
    g.update(0.04);
    err = err || sanity(g);
  }
  console.log(`  score=${g.score} cars=${g.cars.length} state=${g.state}`);
  check(!err, 'invariants hold under random edits (' + err + ')');
}

console.log('5. traffic lights: cars cross a four-way junction');
{
  const g = new MM.Game({ seed: 21 });
  const w = g.world;
  // find a land cross shape
  let centre = -1;
  for (let n = 0; n < w.n && centre < 0; n++) {
    const c = w.col(n), r = w.row(n);
    if (c < 4 || r < 4 || c > w.cols - 5 || r > w.rows - 5) continue;
    let ok = true;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      const m = (r + dy) * w.cols + c + dx;
      if (w.water[m] || w.bld[m]) ok = false;
    }
    if (ok) centre = n;
  }
  check(centre >= 0, 'found open land');
  g.inv.light = 1;
  for (let d = 0; d < 4; d++) {
    const n1 = w.nb(centre, d), n2 = w.nb(n1, d);
    g.addEdge(centre, n1, 1); g.addEdge(n1, n2, 1);
  }
  check(g.placeFeature(centre, 'light').ok, 'light placed on 4-way junction');
  let done = 0;
  const origDeliver = g.deliver.bind(g);
  g.deliver = (car) => { done++; origDeliver(car); };
  // spawn cars at the arm ends heading to the opposite end
  const arms = [3, 1, 0, 2].map((d) => { const n1 = w.nb(centre, d); return [w.nb(n1, d), n1, d]; });
  for (let rep = 0; rep < 5; rep++) for (const [end, n1, d] of arms) {
    const opp = (d + 2) % 4;
    const o1 = w.nb(centre, opp), o2 = w.nb(o1, opp);
    const car = { id: g.nextId++, color: 0, path: [end, n1, centre, o1, o2], i: 0, s: 0, lane: end * 4 + w.dirOf(end, n1), dest: { node: o2, pins: 9 }, house: { queue: [] }, held: -1, dead: false, stamp: -1 };
    g.cars.push(car);
  }
  let err = null;
  for (let t = 0; t < 60 * 30; t++) { g.update(0.04); err = err || sanity(g); }
  check(!err, 'invariants hold (' + err + ')');
  check(done === 20, 'all 20 crossing cars finished (got ' + done + ')');
  check(g.holders[centre] === 0, 'junction released');
}

console.log('6. no gridlock / towing in the first 8 minutes (regression for junction deadlocks)');
{
  let tows = 0, errs = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const g = new MM.Game({ seed });
    const rnd = MM.mulberry32(seed);
    for (let t = 0; t < 25 * 60 * 8 && g.state !== 'over'; t++) {
      if (g.state === 'upgrade') g.chooseUpgrade(Math.floor(rnd() * 3));
      if (t % 25 === 0) {
        autoConnect(g);
        for (let n = 0; n < g.world.n; n++) {
          if (g.world.deg(n) >= 3 && !g.world.bld[n] && !g.world.feat[n] && g.inv.light > 0 && rnd() < 0.5) g.placeFeature(n, 'light');
          else if (g.world.deg(n) >= 3 && !g.world.bld[n] && !g.world.feat[n] && g.inv.round > 0 && rnd() < 0.5) g.placeFeature(n, 'round');
        }
      }
      g.update(0.04);
      for (const e of g.events) if (e.type === 'lost') tows++;
      g.events.length = 0;
      if (sanity(g)) errs++;
    }
  }
  check(errs === 0, 'invariants hold across 10 seeds x 8 minutes');
  check(tows === 0, 'no stuck cars had to be towed (got ' + tows + ')');
}

console.log('7. adjacent junctions under heavy two-way turning traffic never deadlock (towing disabled)');
for (const variant of ['plain', 'lights', 'roundabouts', 'light+roundabout']) {
  console.log('  variant: ' + variant);
  const g = new MM.Game({ seed: 21 });
  const w = g.world;
  let c = -1;
  for (let n = 0; n < w.n && c < 0; n++) {
    const col = w.col(n), row = w.row(n);
    if (col < 4 || row < 4 || col > w.cols - 6 || row > w.rows - 5) continue;
    let ok = true;
    for (let dx = -2; dx <= 3; dx++) for (let dy = -2; dy <= 2; dy++) {
      const m = (row + dy) * w.cols + col + dx;
      if (w.water[m] || w.bld[m]) ok = false;
    }
    if (ok) c = n;
  }
  // "H" shape: junctions at c and c+1 joined by one edge, each with arms of length 2 in the other three directions
  const A = c, B = c + 1;
  const arm = (from, d) => { const n1 = w.nb(from, d), n2 = w.nb(n1, d); g.addEdge(from, n1, 1); g.addEdge(n1, n2, 1); return [n1, n2]; };
  g.addEdge(A, B, 1);
  const aN = arm(A, 0), aS = arm(A, 2), aW = arm(A, 3), bN = arm(B, 0), bS = arm(B, 2), bE = arm(B, 1);
  g.inv.light = 2; g.inv.round = 2;
  if (variant === 'lights') { g.placeFeature(A, 'light'); g.placeFeature(B, 'light'); }
  if (variant === 'roundabouts') { g.placeFeature(A, 'round'); g.placeFeature(B, 'round'); }
  if (variant === 'light+roundabout') { g.placeFeature(A, 'light'); g.placeFeature(B, 'round'); }
  const routes = [];
  const ends = { aN, aS, aW, bN, bS, bE };
  const entry = (arms, junction) => [arms[1], arms[0], junction]; // far end -> near -> junction
  const exit = (arms) => [arms[0], arms[1]];
  const fromA = { aN, aS, aW }, fromB = { bN, bS, bE };
  for (const [ka, ra] of Object.entries(fromA)) for (const [kb, rb] of Object.entries(fromB)) {
    routes.push([...entry(ra, A), B, ...exit(rb)]); // A side -> B side
    routes.push([...entry(rb, B), A, ...exit(ra)]); // B side -> A side
  }
  void ends;
  // isolate the traffic scenario from the rest of the game (no demand, no weekly events)
  g.houses.length = 0;
  g.dests.length = 0;
  g.houseTimer = 1e9;
  const saveWeek = MM.CFG.WEEK_SECONDS;
  MM.CFG.WEEK_SECONDS = 1e9;
  const saveTow = [MM.CFG.TOW_HOLDER, MM.CFG.TOW_ANY];
  MM.CFG.TOW_HOLDER = MM.CFG.TOW_ANY = 1e9;
  const rnd = MM.mulberry32(99);
  let spawned = 0, done = 0, tows = 0;
  const origDeliver = g.deliver.bind(g);
  g.deliver = (car) => { done++; origDeliver(car); };
  for (let t = 0; t < 25 * 200; t++) {
    if (t < 25 * 80 && t % 6 === 0) {
      const r = routes[Math.floor(rnd() * routes.length)];
      const lane = r[0] * 4 + w.dirOf(r[0], r[1]);
      if (g.laneClear(lane, 0.45)) {
        const car = { id: g.nextId++, color: 0, path: r.slice(), i: 0, s: 0, lane, dest: { node: r[r.length - 1], pins: 9, inbound: 1 }, house: { queue: [] }, held: -1, dead: false, stamp: -1, idle: 0 };
        g.cars.push(car); spawned++;
      }
    }
    g.update(0.04);
    for (const e of g.events) if (e.type === 'lost') tows++;
    g.events.length = 0;
  }
  [MM.CFG.TOW_HOLDER, MM.CFG.TOW_ANY] = saveTow;
  MM.CFG.WEEK_SECONDS = saveWeek;
  console.log(`  spawned ${spawned}, finished ${done}, still on road ${g.cars.length}, game state ${g.state}`);
  check(spawned > 100, 'generated heavy traffic');
  check(done === spawned && g.cars.length === 0, 'every car got through (no deadlock)');
  check(tows === 0, 'no towing needed');
  check(g.holders.every((x) => x === 0) && g.reserved.every((x) => x === 0), 'no leaked locks or reservations');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
