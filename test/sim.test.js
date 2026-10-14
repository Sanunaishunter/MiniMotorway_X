// Headless simulation tests: node test/sim.test.js
'use strict';
const path = require('path');
require(path.join(__dirname, '../js/core.js'));
require(path.join(__dirname, '../js/sim.js'));
require(path.join(__dirname, '../js/police.js'));
const MM = globalThis.MM;

let failures = 0;
// a collapse is where the old game ended: now it offers the mayor's order first
const ended = (g) => g.state === 'collapse' || g.state === 'over';
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
  {
    const h = new Int16Array(g.holders.length), r = new Int16Array(g.reserved.length);
    for (const c of g.cars) { if (c.held >= 0) h[c.held]++; if (c.resLane >= 0) r[c.resLane]++; }
    for (let i = 0; i < h.length; i++) if (h[i] !== g.holders[i]) return 'holder accounting off at ' + i;
    for (let i = 0; i < r.length; i++) if (r[i] !== g.reserved[i]) return 'reservation accounting off at ' + i;
    const rs = new Int16Array(g.reservedSlot.length);
    for (const c of g.cars) if (c.resLane >= 0) rs[c.resLane * 2 + (c.resSlot | 0)]++;
    for (let i = 0; i < rs.length; i++) if (rs[i] !== g.reservedSlot[i]) return 'slot reservation accounting off at ' + i;
    for (const c of g.cars) {
      const sl = c.slot | 0;
      if (sl < 0 || sl > 1 || (sl === 1 && g.slotsOf(c.lane) < 2)) return 'car in a lane slot that does not exist';
    }
  }
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
  for (let t = 0; t < 25 * 360 && !ended(g); t++) {
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
  check(g.state === 'collapse', 'traffic collapse without roads (offers the mayor\'s order)');
}

console.log('4. random road editing stress (no crashes, invariants hold)');
{
  const g = new MM.Game({ seed: 11 });
  g.inv.light = 99; g.inv.round = 99; g.inv.hw = 99; g.inv.bridge = 99; g.inv.ovp = 99; g.inv.tun = 99; g.inv.big = 99; g.inv.wide = 99;
  const rnd = MM.mulberry32(5);
  let err = null;
  for (let t = 0; t < 60 * 20 && !ended(g); t++) {
    if (g.state === 'upgrade') g.chooseUpgrade(0);
    if (t % 20 === 0) autoConnect(g);
    const n = Math.floor(rnd() * g.world.n);
    const d = Math.floor(rnd() * 4);
    const m = g.world.nb(n, d);
    const r = rnd();
    if (m >= 0) {
      if (r < 0.40) g.addEdge(n, m, 1);
      else if (r < 0.46) g.addEdge(n, m, 3);
      else if (r < 0.55) g.addEdge(n, m, 2);
      else if (r < 0.75) g.removeEdge(n, m);
      else if (r < 0.85) g.placeFeature(n, 'light');
      else if (r < 0.90) g.placeFeature(n, 'round');
      else if (r < 0.92) g.placeFeature(n, 'ovp');
      else if (r < 0.94) g.placeBig(n);
      else if (r < 0.96) g.addTunnel(n, g.world.nb(g.world.nb(n, d), d) >= 0 ? g.world.nb(g.world.nb(g.world.nb(n, d), d), d) >= 0 ? g.world.nb(g.world.nb(g.world.nb(n, d), d), d) : -1 : -1);
      else if (r < 0.975) g.removeTunnelAt(n);
      else if (r < 0.985) g.removeBigAt(n);
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
    for (let t = 0; t < 25 * 60 * 8 && !ended(g); t++) {
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

// ---------------------------------------------------------------------------------------------
// helpers for the grade-separated features
function findOpen(g, cols, rows) {
  const w = g.world;
  for (let n = 0; n < w.n; n++) {
    const c0 = w.col(n), r0 = w.row(n);
    if (c0 < 2 || r0 < 2 || c0 + cols > w.cols - 2 || r0 + rows > w.rows - 2) continue;
    let ok = true;
    for (let dy = 0; dy < rows && ok; dy++) for (let dx = 0; dx < cols; dx++) {
      const m = (r0 + dy) * w.cols + c0 + dx;
      if (w.water[m] || w.bld[m]) { ok = false; break; }
    }
    if (ok) return n;
  }
  return -1;
}
// isolate a scenario from demand / weekly events so only the cars we inject exist
function isolate(g) {
  g.houses.length = 0; g.dests.length = 0; g.houseTimer = 1e9;
  MM.CFG.WEEK_SECONDS = 1e9;
}
function fakeCar(g, path) {
  const w = g.world;
  const lane = path[0] * 4 + w.dirOf(path[0], path[1]);
  const car = { id: g.nextId++, color: 0, path: path.slice(), i: 0, s: 0, lane, dest: { node: path[path.length - 1], pins: 9, inbound: 1 }, house: { queue: [] }, held: -1, resLane: -1, resSlot: -1, slot: 0, nslot: 0, nslotFor: -1, pslot: 0, dead: false, stamp: -1, idle: 0, v: 0 };
  car.slot = g.pickSlot(car, lane);
  g.cars.push(car);
  return car;
}
const WEEK = MM.CFG.WEEK_SECONDS;

console.log('8. overpass: straight through, no turns, no queueing across the axes');
{
  const mk = () => {
    const g = new MM.Game({ seed: 21 });
    isolate(g);
    const w = g.world;
    const o = findOpen(g, 5, 5);
    const c = o + 2 * w.cols + 2;
    for (let d = 0; d < 4; d++) { const n1 = w.nb(c, d), n2 = w.nb(n1, d); g.addEdge(c, n1, 1); g.addEdge(n1, n2, 1); }
    return { g, w, c };
  };
  const { g, w, c } = mk();
  check(!g.placeFeature(c, 'ovp').ok, 'overpass needs inventory');
  g.inv.ovp = 2;
  check(g.placeFeature(c, 'ovp').ok && w.feat[c] === 3, 'overpass placed on a four-way crossing');
  check(!w.isJunction(c), 'an overpass is not a junction (no lock, no stop)');
  const west = w.nb(w.nb(c, 3), 3), east = w.nb(w.nb(c, 1), 1), north = w.nb(w.nb(c, 0), 0), south = w.nb(w.nb(c, 2), 2);
  check(g.route(west, east, -1) && g.route(west, east, -1).includes(c), 'straight route over the overpass exists');
  check(g.route(west, north, -1) === null, 'turning at an overpass is impossible');
  check(g.route(south, north, -1) !== null, 'the other axis passes too');
  // removing one arm turns it back into a plain 3-way and refunds
  g.removeEdge(c, w.nb(c, 0));
  check(w.feat[c] === 0 && g.inv.ovp === 2, 'overpass is removed (and refunded) when the crossing is no longer four-way');
  check(!g.placeFeature(c, 'ovp').ok, 'cannot place an overpass on a three-way junction');
  // throughput: the same crossing traffic finishes sooner with an overpass than at a plain junction
  const run = (useOvp) => {
    const { g, w, c } = mk();
    if (useOvp) { g.inv.ovp = 1; g.placeFeature(c, 'ovp'); }
    const ends = [0, 1, 2, 3].map((d) => { const n1 = w.nb(c, d); return [w.nb(n1, d), n1, d]; });
    let done = 0;
    const orig = g.deliver.bind(g);
    g.deliver = (car) => { done++; orig(car); };
    const total = 48;
    // 12 cars per approach, released as fast as lane spacing allows, so a plain junction has to make them queue
    const queue = [];
    for (let rep = 0; rep < 12; rep++) for (const [end, n1, d] of ends) {
      const o1 = w.nb(c, (d + 2) & 3), o2 = w.nb(o1, (d + 2) & 3);
      queue.push([end, n1, c, o1, o2]);
    }
    let t = 0, err = null;
    while ((done < total) && t < 25 * 240) {
      for (let k = queue.length - 1; k >= 0; k--) {
        const pth = queue[k];
        if (g.laneClear(pth[0] * 4 + w.dirOf(pth[0], pth[1]), 0.45)) { fakeCar(g, pth); queue.splice(k, 1); }
      }
      g.update(0.04); t++;
      err = err || sanity(g);
    }
    return { time: t * 0.04, done, err };
  };
  const plain = run(false), over = run(true);
  console.log(`  plain junction: ${plain.time.toFixed(1)}s, overpass: ${over.time.toFixed(1)}s`);
  check(!plain.err && !over.err, 'invariants hold (' + (plain.err || over.err) + ')');
  check(plain.done === 48 && over.done === 48, 'all crossing cars arrive');
  check(over.time < plain.time, 'overpass is faster than a plain junction');
}

console.log('9. tunnels');
{
  const g = new MM.Game({ seed: 21 });
  isolate(g);
  const w = g.world;
  const o = findOpen(g, 12, 5);
  const row = o + 2 * w.cols; // middle row of the patch
  const A = row + 3, B = row + 8; // tunnel of length 5
  g.inv.tun = 2;
  check(!g.addTunnel(A, A + 1).ok && g.addTunnel(A, A + 1).reason === 'short', 'a one-cell tunnel is too short');
  check(g.addTunnel(A, A + 7).reason === 'long', 'a seven-cell tunnel is too long');
  check(g.addTunnel(A, A + w.cols + 1).reason === 'line', 'portals must share a row or column');
  g.inv.tun = 0;
  check(g.addTunnel(A, B).reason === 'none', 'needs inventory');
  g.inv.tun = 2;
  // a road already leaving the portal on the tunnel side blocks it
  g.addEdge(A, A + 1, 1);
  check(g.addTunnel(A, B).reason === 'busy', 'portal side must be free of surface road');
  g.removeEdge(A, A + 1);
  check(g.addTunnel(A, B).ok && g.inv.tun === 1, 'tunnel built');
  check(g.addEdge(A, A + 1, 1).reason === 'tunnel', 'cannot draw a surface road onto a portal on the tunnel side');
  check(w.edgeBetween(A, B) === 3 && w.edgeBetween(B, A) === 3, 'tunnel is a two-way edge of type 3');
  // surface roads on both ends, and a road crossing over the middle of the tunnel
  for (let k = -2; k < 0; k++) g.addEdge(A + k, A + k + 1, 1);
  for (let k = 0; k < 2; k++) g.addEdge(B + k, B + k + 1, 1);
  const mid = A + 2;
  g.addEdge(mid - w.cols, mid, 1); g.addEdge(mid, mid + w.cols, 1);
  check(w.deg(mid) === 2 && w.isJunction(mid) === false, 'a road above the tunnel is just a plain road (no junction)');
  const left = A - 2, right = B + 2;
  const p = g.route(left, right, -1);
  check(p && p.join() === [left, A - 1, A, B, B + 1, right].join(), 'routing takes the tunnel (path ' + (p && p.join('>')) + ')');
  // drive cars through it and across it at the same time
  let done = 0;
  const orig = g.deliver.bind(g);
  g.deliver = (car) => { done++; orig(car); };
  let sawTunnelLane = false, err = null, spawned = 0;
  for (let t = 0; t < 25 * 90; t++) {
    if (t < 25 * 30 && t % 15 === 0) {
      const lane1 = left * 4 + 1;
      if (g.laneClear(lane1, 0.45)) { fakeCar(g, [left, A - 1, A, B, B + 1, right]); spawned++; }
      const v = [mid - w.cols, mid, mid + w.cols];
      if (g.laneClear(v[0] * 4 + 2, 0.45)) { fakeCar(g, v); spawned++; }
    }
    g.update(0.04);
    for (const c of g.cars) if (c.lane === A * 4 + 1) { sawTunnelLane = true; if (c.s < 0 || c.s > 1.0001) err = 'bad s in tunnel'; }
    err = err || sanity(g);
  }
  check(!err, 'invariants hold (' + err + ')');
  check(sawTunnelLane, 'cars used the tunnel lane');
  check(done === spawned && g.cars.length === 0, 'everything arrived (' + done + '/' + spawned + ')');
  // a tunnel is quicker than driving the same distance on the surface
  const time = (useTunnel) => {
    const gg = new MM.Game({ seed: 21 }); isolate(gg);
    const ww = gg.world, r2 = findOpen(gg, 12, 5) + 2 * ww.cols;
    const a = r2 + 2, b = r2 + 8; // 6 cells apart
    gg.inv.tun = 1; gg.inv.hw = 0;
    if (useTunnel) { gg.addTunnel(a, b); } else { for (let k = a; k < b; k++) gg.addEdge(k, k + 1, 1); }
    // short surface stubs so the car has a node before and after
    const car = useTunnel ? fakeCar(gg, [a, b]) : fakeCar(gg, [a, a + 1, a + 2, a + 3, a + 4, a + 5, b]);
    let t = 0; while (!car.dead && t < 25 * 60) { gg.update(0.04); t++; }
    return t * 0.04;
  };
  const tTun = time(true), tRoad = time(false);
  console.log(`  6-cell trip: tunnel ${tTun.toFixed(1)}s vs road ${tRoad.toFixed(1)}s`);
  check(tTun < tRoad, 'the tunnel is faster than the surface road');
  // removing the tunnel (by clicking above its middle) refunds it and re-queues the cars inside it
  const h = { queue: [] };
  const inside = fakeCar(g, [left, A - 1, A, B, B + 1, right]); inside.house = h;
  for (let t = 0; t < 25 * 3; t++) g.update(0.04);
  const before = g.inv.tun;
  check(g.removeTunnelAt(mid) && g.inv.tun === before + 1 && !w.tun.size, 'removing the tunnel refunds it');
  check(sanity(g) === null, 'invariants hold after removal');
  check(!g.cars.includes(inside) || !inside.dead, 'cars cut off by the removal are dealt with');
}

console.log('10. big roundabout');
{
  const g = new MM.Game({ seed: 21 });
  isolate(g);
  const w = g.world;
  const o = findOpen(g, 9, 9);
  const c = o + 4 * w.cols + 4;
  // a cross of roads through the centre, 4 cells in each direction
  for (let k = -4; k < 4; k++) { g.addEdge(c + k, c + k + 1, 1); g.addEdge(c + k * w.cols, c + (k + 1) * w.cols, 1); }
  check(!g.placeBig(c).ok && g.placeBig(c).reason === 'none', 'big roundabout needs inventory');
  g.inv.big = 2;
  check(g.placeBig(c).ok && g.inv.big === 1, 'big roundabout placed');
  const N = c - w.cols, S = c + w.cols, E = c + 1, W = c - 1, NE = N + 1, NW = N - 1, SE = S + 1, SW = S - 1;
  check(w.edgeBetween(NE, N) > 0 && w.edgeBetween(N, NE) === 0, 'ring is one-way: NE -> N only');
  check(w.edgeBetween(N, NW) > 0 && w.edgeBetween(NW, W) > 0 && w.edgeBetween(W, SW) > 0 && w.edgeBetween(SW, S) > 0 &&
        w.edgeBetween(S, SE) > 0 && w.edgeBetween(SE, E) > 0 && w.edgeBetween(E, NE) > 0, 'circulation is counter-clockwise (N, NW, W, SW, S, SE, E, NE)');
  check(w.deg(c) === 0 && w.island[c] > 0, 'the centre is an empty island (inner roads removed)');
  check(w.edgeBetween(W - 1, W) > 0 && w.edgeBetween(W, W - 1) > 0, 'approach roads stay two-way');
  check(g.addEdge(c, E, 1).reason === 'island', 'cannot build onto the island');
  check(g.removeEdge(N, NE).reason === 'ring', 'cannot erase single ring segments');
  check(!g.spotOK(c, false) && !g.spotOK(NE, false), 'buildings never spawn on the roundabout');
  const wEnd = c - 4, eEnd = c + 4, nEnd = c - 4 * w.cols, sEnd = c + 4 * w.cols;
  const p1 = g.route(wEnd, eEnd, -1);
  check(p1 && p1.join() === [wEnd, wEnd + 1, wEnd + 2, W, SW, S, SE, E, E + 1, E + 2, eEnd].join(), 'west -> east goes round the south side (' + (p1 && p1.join('>')) + ')');
  const p2 = g.route(eEnd, wEnd, -1);
  check(p2 && p2.includes(NE) && p2.includes(N) && p2.includes(NW), 'east -> west goes round the north side');
  // heavy traffic from all four approaches to the other three
  const ends = [wEnd, eEnd, nEnd, sEnd];
  let spawned = 0, done = 0, tows = 0, err = null;
  const orig = g.deliver.bind(g);
  g.deliver = (car) => { done++; orig(car); };
  const saveTow = [MM.CFG.TOW_HOLDER, MM.CFG.TOW_ANY];
  MM.CFG.TOW_HOLDER = MM.CFG.TOW_ANY = 1e9;
  const rnd = MM.mulberry32(7);
  for (let t = 0; t < 25 * 220; t++) {
    if (t < 25 * 90 && t % 8 === 0) {
      const a = ends[Math.floor(rnd() * 4)];
      let b = ends[Math.floor(rnd() * 4)];
      if (b === a) b = ends[(ends.indexOf(a) + 1) % 4];
      const path = g.route(a, b, -1);
      const first = path && path[0] * 4 + w.dirOf(path[0], path[1]);
      if (path && g.laneClear(first, 0.45)) { fakeCar(g, path); spawned++; }
    }
    g.update(0.04);
    for (const e of g.events) if (e.type === 'lost') tows++;
    g.events.length = 0;
    err = err || sanity(g);
  }
  MM.CFG.TOW_HOLDER = saveTow[0]; MM.CFG.TOW_ANY = saveTow[1];
  console.log(`  spawned ${spawned}, finished ${done}, on road ${g.cars.length}`);
  check(!err, 'invariants hold (' + err + ')');
  check(spawned > 100 && done === spawned && g.cars.length === 0, 'every car got round the roundabout (no deadlock)');
  check(tows === 0, 'no towing needed');
  check(g.holders.every((x) => x === 0) && g.reserved.every((x) => x === 0), 'no leaked locks or reservations');
  check(g.removeBigAt(NE) && g.inv.big === 2 && !g.bigs.size && w.island[c] === 0, 'removing the roundabout refunds it');
  check(w.edgeBetween(NE, N) === 0 && w.edgeBetween(W - 1, W) > 0, 'ring gone, approach stubs remain');
}
MM.CFG.WEEK_SECONDS = WEEK;

console.log('11. four-lane roads: rules');
{
  const g = new MM.Game({ seed: 21 });
  isolate(g);
  const w = g.world;
  const o = findOpen(g, 8, 4);
  const A = o + w.cols, B = A + 1, C2 = A + 2, D = A + 3;
  check(g.addEdge(A, B, 3).reason === 'nowide', 'a four-lane road needs inventory');
  g.inv.wide = 5;
  check(g.addEdge(A, B, 3).ok && g.inv.wide === 4 && w.isWideBetween(A, B), 'new four-lane road built');
  check(g.addEdge(A, B, 3).reason === 'same', 'cannot widen what is already four-lane');
  check(g.slotsOf(A * 4 + 1) === 2 && g.slotsOf(B * 4 + 3) === 2, 'both directions have two lanes');
  g.addEdge(B, C2, 1);
  check(g.slotsOf(B * 4 + 1) === 1, 'an ordinary road still has one lane per direction');
  check(g.addEdge(B, C2, 3).ok && g.inv.wide === 3, 'an existing two-lane road can be widened');
  g.inv.hw = 3;
  check(g.addEdge(A, B, 2).reason === 'hw-wide', 'an expressway cannot replace a four-lane road');
  g.addEdge(C2, D, 2);
  check(g.addEdge(C2, D, 3).reason === 'wide-hw', 'a four-lane road cannot replace an expressway');
  g.removeEdge(A, B);
  check(!w.isWideBetween(A, B) && g.inv.wide === 4, 'erasing a four-lane road refunds it');
  // never next to a building, over water, or on a one-way ring
  const house = g.addBuilding('house', 0, A + 3 * w.cols);
  const nb = A + 2 * w.cols;
  check(g.addEdge(nb, house.node, 3).reason === 'wide-bld', 'roads touching a building stay two-lane');
  const wet = (() => { for (let n = 0; n < w.n; n++) { const e = w.nb(n, 1); if (w.water[n] && e >= 0 && !w.water[e]) return [e, n]; } return null; })();
  if (wet) { g.inv.bridge = 5; check(g.addEdge(wet[0], wet[1], 3).reason === 'wide-water', 'no four-lane bridges'); }
  check(g.slotsOf(A * 4 + 1) === 1, 'after the erase the lane is single again');
}

console.log('12. four-lane roads carry about 1.7x the traffic');
{
  const corridor = ({ wide, stubs, fast, seconds = 100, narrowTail = false }) => {
    let g, o = -1;
    for (let seed = 21; o < 0; seed++) { g = new MM.Game({ seed, cols: 40, rows: 20 }); o = findOpen(g, 20, 5); }
    isolate(g);
    const w = g.world;
    const row = o + 2 * w.cols, L = 18;
    g.inv.wide = 99;
    const nodes = [];
    for (let k = 0; k <= L; k++) nodes.push(row + k);
    for (let k = 0; k < L; k++) g.addEdge(nodes[k], nodes[k + 1], wide && !(narrowTail && k >= L / 2) ? 3 : 1);
    if (stubs) for (let k = 3; k < L; k += 4) g.addEdge(nodes[k], nodes[k] - w.cols, 1);
    let done = 0, err = null;
    const orig = g.deliver.bind(g);
    g.deliver = (car) => { if (g.time > 20) done++; orig(car); };
    const saveTow = [MM.CFG.TOW_HOLDER, MM.CFG.TOW_ANY];
    MM.CFG.TOW_HOLDER = MM.CFG.TOW_ANY = 1e9;
    for (let t = 0; t < 25 * seconds; t++) {
      for (let k = 0; k < 2; k++) {
        const car = fakeCar(g, nodes.slice());
        g.cars.pop(); // fakeCar already pushed it; only keep it if there is room
        car.v = fast ? g.speedOf(car.lane) : 0;
        if (g.laneClear(car.lane, MM.CFG.GAP * (fast ? 1.02 : 1.4), car.slot)) g.cars.push(car);
      }
      g.update(0.04);
      g.events.length = 0;
      err = err || sanity(g);
    }
    MM.CFG.TOW_HOLDER = saveTow[0]; MM.CFG.TOW_ANY = saveTow[1];
    return { rate: done / (seconds - 20), err };
  };
  const freeNarrow = corridor({ wide: false, fast: true }), freeWide = corridor({ wide: true, fast: true });
  const jNarrow = corridor({ wide: false, stubs: true }), jWide = corridor({ wide: true, stubs: true });
  const r1 = freeWide.rate / freeNarrow.rate, r2 = jWide.rate / jNarrow.rate;
  console.log(`  free-flowing road: x${r1.toFixed(2)}   road with junctions: x${r2.toFixed(2)}`);
  check(!freeNarrow.err && !freeWide.err && !jNarrow.err && !jWide.err, 'invariants hold (' + (freeNarrow.err || freeWide.err || jNarrow.err || jWide.err) + ')');
  check(r1 > 1.6 && r1 < 1.85, 'free-flowing four-lane road passes about 1.7x the cars');
  check(r2 > 1.55 && r2 < 1.85, 'a road with junctions passes about 1.7x the cars');
}

console.log('13. four-lane roads: merges and junctions do not deadlock (towing disabled)');
{
  for (const variant of ['four-lane into two-lane', 'four-lane crossing two-lane', 'two four-lane roads crossing', 'four-lane with a light']) {
    const g = new MM.Game({ seed: 21 });
    isolate(g);
    const w = g.world;
    g.inv.wide = 99; g.inv.light = 2;
    const o = findOpen(g, 11, 7);
    const at = (c, r) => o + r * w.cols + c;
    const roadH = (r, c0, c1, kind) => { for (let c = c0; c < c1; c++) g.addEdge(at(c, r), at(c + 1, r), kind); };
    const roadV = (c, r0, r1, kind) => { for (let r = r0; r < r1; r++) g.addEdge(at(c, r), at(c, r + 1), kind); };
    let routes = [];
    if (variant === 'four-lane into two-lane') {
      roadH(3, 0, 5, 3); roadH(3, 5, 10, 1);
      routes = [[at(0, 3), at(10, 3)]];
    } else {
      roadH(3, 0, 10, 3);
      roadV(5, 0, 6, variant === 'two four-lane roads crossing' ? 3 : 1);
      if (variant === 'four-lane with a light') g.placeFeature(at(5, 3), 'light');
      routes = [[at(0, 3), at(10, 3)], [at(10, 3), at(0, 3)], [at(5, 0), at(5, 6)], [at(5, 6), at(5, 0)], [at(0, 3), at(5, 6)], [at(10, 3), at(5, 0)], [at(5, 0), at(0, 3)], [at(5, 6), at(10, 3)]];
    }
    const saveTow = [MM.CFG.TOW_HOLDER, MM.CFG.TOW_ANY];
    MM.CFG.TOW_HOLDER = MM.CFG.TOW_ANY = 1e9;
    const rnd = MM.mulberry32(5);
    let spawned = 0, done = 0, err = null;
    const orig = g.deliver.bind(g);
    g.deliver = (car) => { done++; orig(car); };
    for (let t = 0; t < 25 * 260; t++) {
      if (t < 25 * 100 && t % 5 === 0) {
        const [a, b] = routes[Math.floor(rnd() * routes.length)];
        const path = g.route(a, b, -1);
        if (path) {
          const lane = path[0] * 4 + w.dirOf(path[0], path[1]);
          const car = fakeCar(g, path);
          g.cars.pop();
          if (g.laneClear(lane, 0.45, car.slot)) { g.cars.push(car); spawned++; }
        }
      }
      g.update(0.04);
      g.events.length = 0;
      err = err || sanity(g);
    }
    MM.CFG.TOW_HOLDER = saveTow[0]; MM.CFG.TOW_ANY = saveTow[1];
    console.log(`  ${variant}: spawned ${spawned}, finished ${done}, still on road ${g.cars.length}`);
    check(!err, variant + ': invariants hold (' + err + ')');
    check(spawned > 80 && done === spawned && g.cars.length === 0, variant + ': every car got through');
    check(g.holders.every((x) => x === 0) && g.reserved.every((x) => x === 0) && g.reservedSlot.every((x) => x === 0), variant + ': no leaked locks or reservations');
  }
}
MM.CFG.WEEK_SECONDS = WEEK;

console.log('14. a lock holder is never boxed in on a four-lane road (regression)');
{
  // J1 and J2 are adjacent junctions on a four-lane road. J2's light is red for the main road for ever, so the lane J1 -> J2 fills up. Whatever happens,
  // cars that took J1's lock must still be able to reach the release point, so cross traffic through J1 must keep flowing.
  const g = new MM.Game({ seed: 21 });
  isolate(g);
  const w = g.world;
  g.inv.wide = 99;
  const o = findOpen(g, 9, 6);
  const at = (c, r) => o + r * w.cols + c;
  for (let c = 0; c < 8; c++) g.addEdge(at(c, 3), at(c + 1, 3), 3);
  for (let r = 0; r < 5; r++) { g.addEdge(at(3, r), at(3, r + 1), 1); g.addEdge(at(4, r), at(4, r + 1), 1); }
  const J1 = at(3, 3), J2 = at(4, 3);
  g.inv.light = 1;
  g.placeFeature(J2, 'light');
  const L2 = g.lights.get(J2);
  L2.green = 0; // vertical axis green...
  L2.timer = -1e12; // ...and it never changes, so east-bound traffic waits at J2 forever
  let done = 0, err = null, stuckHolder = 0;
  const crossDone = [];
  const orig = g.deliver.bind(g);
  g.deliver = (car) => { done++; if (car.path.includes(at(3, 0))) crossDone.push(car.id); orig(car); };
  const saveTow = [MM.CFG.TOW_HOLDER, MM.CFG.TOW_ANY];
  MM.CFG.TOW_HOLDER = MM.CFG.TOW_ANY = 1e9;
  for (let t = 0; t < 25 * 120; t++) {
    if (t % 6 === 0) {
      const east = g.route(at(0, 3), at(8, 3), -1);
      if (east) { const car = fakeCar(g, east); g.cars.pop(); if (g.laneClear(car.lane, 0.45, car.slot)) g.cars.push(car); }
    }
    if (t % 50 === 0) {
      const cross = g.route(at(3, 0), at(3, 5), -1);
      if (cross) { const car = fakeCar(g, cross); g.cars.pop(); if (g.laneClear(car.lane, 0.45, car.slot)) g.cars.push(car); }
    }
    g.update(0.04);
    g.events.length = 0;
    err = err || sanity(g);
    for (const c of g.cars) if (c.held === J1 && c.idle > 3) stuckHolder++;
  }
  MM.CFG.TOW_HOLDER = saveTow[0]; MM.CFG.TOW_ANY = saveTow[1];
  console.log(`  cross cars through the jammed neighbour: ${crossDone.length}, holders stuck: ${stuckHolder}`);
  check(!err, 'invariants hold (' + err + ')');
  check(stuckHolder === 0, 'no car ever sits on J1 holding its lock without being able to leave');
  check(crossDone.length >= 20, 'cross traffic keeps flowing through J1 (' + crossDone.length + ' cars)');
}
MM.CFG.WEEK_SECONDS = WEEK;

console.log("15. 市長的命令: collapse -> mayor (time frozen, editable) -> invincible window -> recovery or final failure");
{
  const wireAll = (g) => {
    for (const h of g.houses) {
      if (h._wired) continue;
      const d = g.dests.find((x) => x.color === h.color);
      if (d && connect(g, h.node, d.node)) h._wired = true;
    }
  };
  const collapseGame = (seed) => {
    const g = new MM.Game({ seed });
    for (let t = 0; t < 60 * 60 * 5 && g.state === 'running'; t++) g.update(0.04);
    return g;
  };

  // a) the order is only available at a collapse; it freezes time but allows road editing
  {
    const g = new MM.Game({ seed: 3 });
    check(!g.mayorOrder() && !g.finishMayor(), 'the order cannot be used while the game is running');
    const g2 = collapseGame(3);
    check(g2.state === 'collapse' && g2.over && g2.over.final === false, 'a collapse waits for the player\'s decision');
    check(!g2.addEdge(g2.houses[0].node, g2.houses[0].node + 1, 1).ok, 'no editing while the collapse prompt is open');
    const t0 = g2.time;
    check(g2.mayorOrder() && g2.state === 'mayor', 'the mayor\'s order starts');
    g2.update(30);
    check(g2.time === t0, 'time is frozen during the mayor\'s order');
    const h = g2.houses[0], d = g2.dests.find((x) => x.color === h.color);
    const edgesBefore = g2.world.eE.reduce((a, b) => a + (b ? 1 : 0), 0) + g2.world.eS.reduce((a, b) => a + (b ? 1 : 0), 0);
    check(connect(g2, h.node, d.node), 'roads can be built during the order');
    const edgesAfter = g2.world.eE.reduce((a, b) => a + (b ? 1 : 0), 0) + g2.world.eS.reduce((a, b) => a + (b ? 1 : 0), 0);
    check(edgesAfter > edgesBefore, 'the new road exists');
    check(g2.finishMayor() && g2.state === 'running', 'finishing the order resumes the game');
    check(Math.abs(g2.shieldLeft() - MM.CFG.MAYOR_SECONDS) < 1e-6 && MM.CFG.MAYOR_SECONDS === 300, 'the shield lasts five minutes');
  }

  // b) fixing the roads inside the window: the choked destination drains, and a window that ends with nothing choked is survived
  {
    const g = collapseGame(3);
    const choked = g.over.dest;
    g.mayorOrder();
    wireAll(g);
    g.finishMayor();
    let err = null, maxO = 0;
    for (let t = 0; t < 25 * 60 && g.state !== 'over'; t++) {
      if (g.state === 'upgrade') g.chooseUpgrade(0);
      g.update(0.04);
      if (!err && t % 50 === 0) err = sanity(g);
    }
    check(!err, 'invariants hold (' + err + ')');
    check(g.state === 'running' && choked.overflow < 0.5, 'the repaired destination drains its overflow (' + choked.overflow.toFixed(2) + ')');
    // (the test bot cannot wire everything on this map, so clear the demand and shorten the window to judge the end of it)
    for (const d of g.dests) { d.pins = 0; d.inbound = 0; d.overflow = 0; }
    for (const h of g.houses) h.queue.length = 0;
    g.invincibleUntil = g.time + 1;
    g.events.length = 0;
    for (let t = 0; t < 25 * 3 && g.state === 'running'; t++) g.update(0.04);
    check(g.state === 'running' && !g.mayorActive && g.shieldLeft() === 0, 'a window that ends with nothing choked is survived');
    check(g.events.some((e) => e.type === 'mayorend'), 'the end of the window is announced');
  }

  // c) doing nothing: invincible for five minutes, then the final failure
  {
    const g = collapseGame(5);
    g.mayorOrder();
    g.finishMayor();
    let sawOver = -1;
    const t0 = g.time;
    for (let t = 0; t < 25 * (MM.CFG.MAYOR_SECONDS + 30) && g.state !== 'over'; t++) {
      if (g.state === 'upgrade') g.chooseUpgrade(0);
      g.update(0.04);
      if (g.state === 'collapse') { sawOver = -2; break; }
    }
    check(sawOver !== -2, 'no new collapse prompt appears while shielded');
    check(g.state === 'over' && g.over && g.over.final === true, 'unrepaired city fails for good after the window');
    check(Math.abs((g.time - t0) - MM.CFG.MAYOR_SECONDS) < 0.5, 'the final failure comes after five minutes (' + (g.time - t0).toFixed(1) + 's)');
  }

  // d) after recovering, a later collapse offers the order again
  {
    const g = collapseGame(3);
    g.mayorOrder(); wireAll(g); g.finishMayor();
    check(g.mayorUses === 1, 'mayorUses counts the orders');
  }

  // e) the order is a one-time chance: a window that was survived does not bring the order back, the next collapse is final
  {
    const g = collapseGame(3);
    g.mayorOrder(); wireAll(g); g.finishMayor();
    for (const d of g.dests) { d.pins = 0; d.inbound = 0; d.overflow = 0; }
    for (const h of g.houses) h.queue.length = 0;
    g.invincibleUntil = g.time + 1;
    for (let t = 0; t < 25 * 3 && g.state === 'running'; t++) g.update(0.04);
    check(g.state === 'running' && !g.mayorActive, 'the window was survived');
    for (const d of g.dests) d.pins = 30;
    for (const h of g.houses) h.tripTimer = 1e9;
    for (let t = 0; t < 25 * 60 && g.state === 'running'; t++) g.update(0.04);
    check(g.state === 'over' && g.over && g.over.final === true, 'the next collapse is final (no second mayor\'s order)');
    check(!g.mayorOrder(), 'the mayor\'s order cannot be used again');
    check(g.kayrayBlessing() && g.state === 'running' && g.blessed, 'Kayray\'s blessing is offered instead');
  }
}

console.log('16. decorative police patrol cars stay on the roads and never touch the simulation');
{
  const mk = () => {
    const g = new MM.Game({ seed: 8 });
    for (const h of g.houses) { const d = g.dests.find((x) => x.color === h.color); if (d) connect(g, h.node, d.node); }
    return g;
  };
  const run = (withPolice) => {
    const g = mk();
    const pol = new MM.Police(g.world, 1);
    let bad = 0, maxCops = 0, moved = 0, lastPos = new Map();
    for (let t = 0; t < 25 * 240; t++) {
      if (g.state === 'upgrade') g.chooseUpgrade(0);
      if (ended(g)) break;
      g.update(0.04);
      if (withPolice) {
        pol.update(0.04);
        maxCops = Math.max(maxCops, pol.cops.length);
        for (const c of pol.cops) {
          const e = g.world.edge(c.a, c.d);
          if (!c.dying && e !== 1 && e !== 2) bad++;
          const p = lastPos.get(c.id);
          if (p && (p[0] !== c.x || p[1] !== c.y)) moved++;
          lastPos.set(c.id, [c.x, c.y]);
        }
      }
    }
    return { g, bad, maxCops, moved };
  };
  const a = run(true), b = run(false);
  check(a.maxCops >= 1 && a.maxCops <= 3, 'between one and three patrol cars appear (' + a.maxCops + ')');
  check(a.bad === 0, 'a patrol car is always on an existing surface road');
  check(a.moved > 100, 'patrol cars actually drive around');
  check(a.g.score === b.g.score && a.g.cars.length === b.g.cars.length && a.g.time === b.g.time, 'the simulation is identical with and without police (' + a.g.score + ')');
  const empty = new MM.Game({ seed: 9 });
  const p2 = new MM.Police(empty.world, 2);
  for (let t = 0; t < 25 * 60; t++) p2.update(0.04);
  check(p2.cops.length === 0, 'no patrol cars without roads');
}

console.log('17. Kayray\'s blessing: after the final failure the city can become invincible for good');
{
  const failedFor = (seed) => {
    const g = new MM.Game({ seed });
    for (let t = 0; t < 60 * 60 * 5 && g.state === 'running'; t++) g.update(0.04);
    g.mayorOrder();
    g.finishMayor();
    for (let t = 0; t < 25 * (MM.CFG.MAYOR_SECONDS + 30) && g.state !== 'over'; t++) {
      if (g.state === 'upgrade') g.chooseUpgrade(0);
      g.update(0.04);
    }
    return g;
  };
  const fresh = new MM.Game({ seed: 5 });
  check(!fresh.kayrayBlessing(), 'the blessing cannot be summoned while the game is running');
  const early = new MM.Game({ seed: 5 });
  for (let t = 0; t < 60 * 60 * 5 && early.state === 'running'; t++) early.update(0.04);
  check(early.state === 'collapse' && !early.kayrayBlessing(), 'nor at the first collapse (only after the mayor\'s window has failed)');
  const g = failedFor(5);
  check(g.state === 'over' && g.over.final === true, 'the unrepaired city failed for good');
  const score0 = g.score, week0 = g.week;
  check(g.kayrayBlessing() && g.state === 'running' && g.blessed && g.over === null, 'summoning the blessing resumes the game');
  check(g.events.some((e) => e.type === 'kayray'), 'the blessing is announced');
  check(!g.kayrayBlessing(), 'it can only be summoned once');
  let err = null, sawEnd = false, peak = 0;
  for (let t = 0; t < 25 * 60 * 20; t++) { // twenty more minutes of the same choked city
    if (g.state === 'upgrade') g.chooseUpgrade(0);
    g.update(0.04);
    if (g.state === 'collapse' || g.state === 'over') { sawEnd = true; break; }
    for (const d of g.dests) peak = Math.max(peak, d.overflow);
    if (!err && t % 50 === 0) err = sanity(g);
  }
  check(!sawEnd && g.state !== 'over' && g.state !== 'collapse', 'the blessed city never collapses again (20 more minutes)');
  check(peak >= 1 - 1e-9, 'the overflow ring stays full but harmless');
  check(g.week > week0 + 10 && g.score >= score0, 'time keeps passing: weeks advance (' + week0 + ' -> ' + g.week + ')');
  check(g.shieldLeft() === 0 && !g.mayorActive, 'the blessing is separate from the mayor\'s timed shield');
  check(!err, 'invariants hold (' + err + ')');
}

console.log('18. teleport portals: one pair per 100 delivered cars, alternating the blue portal and the anywhere door');
{
  // a house-to-destination route cut into two roads with a gap in the middle: only a portal pair can join them
  const build = () => {
    for (let seed = 1; seed < 200; seed++) {
      const g = new MM.Game({ seed });
      const h = g.houses[0], d = g.dests.find((x) => x.color === h.color);
      const p = bfsPath(g, h.node, d.node);
      if (!p || p.length < 9 || p.length > 24) continue;
      const k = 3, m = p.length - 4; // entrance p[k], exit p[m]
      for (let i = 0; i < k; i++) g.addEdge(p[i], p[i + 1], 1);
      for (let i = m; i + 1 < p.length; i++) g.addEdge(p[i], p[i + 1], 1);
      return { g, h, d, p, E: p[k], X: p[m] };
    }
    throw new Error('no suitable map');
  };
  const run = (g, seconds) => {
    let err = null;
    for (let t = 0; t < 25 * seconds && g.state !== 'collapse' && g.state !== 'over'; t++) {
      if (g.state === 'upgrade') g.chooseUpgrade(0);
      g.update(0.04);
      if (!err && t % 25 === 0) err = sanity(g);
    }
    return err;
  };

  // a) the grant: one pair per 100 delivered cars, looks alternate
  {
    const { g } = build();
    check(g.inv.tp === 0 && g.nextPortalStyle() === null, 'no portals at the start');
    g.score = 99; g.grantPortals();
    check(g.inv.tp === 0, '99 deliveries earn nothing');
    g.score = 100; g.grantPortals(); g.grantPortals();
    check(g.inv.tp === 1 && g.nextPortalStyle() === 'blue', 'the 100th delivery earns one pair, the blue portal (and only once)');
    g.score = 200; g.grantPortals();
    check(g.inv.tp === 2 && g.portalQueue.join() === 'blue,door', 'the 200th delivery earns the anywhere door');
    g.score = 500; g.grantPortals();
    check(g.inv.tp === 5 && g.portalQueue.join() === 'blue,door,blue,door,blue', 'the looks keep alternating');
    check(g.events.filter((e) => e.type === 'portalgift').length === 5, 'every pair is announced');
    const g2 = new MM.Game({ seed: 2 });
    const car = { dest: g2.dests[0], dead: false, color: 0 };
    g2.score = 99; g2.dests[0].pins = 1; g2.dests[0].inbound = 1;
    g2.deliver(car);
    check(g2.score === 100 && g2.inv.tp === 1, 'a real delivery that reaches 100 hands out the pair');
  }

  // b) placement rules
  {
    const { g, E, X, p, h } = build();
    g.score = 100; g.grantPortals();
    check(g.checkPortal(E) === null && g.checkPortal(X) === null, 'the two road ends accept a portal');
    check(g.checkPortal(p[1]) === 'notend', 'a road tile in the middle of a road does not');
    check(g.checkPortal(h.node) === 'node', 'a house does not');
    check(g.checkPortal(p[5]) === 'notend', 'an empty tile does not');
    check(g.addPortal(E, E).reason === 'same', 'the entrance and the exit must differ');
    check(!g.addPortal(E, p[5]).ok && g.inv.tp === 1, 'a failed placement costs nothing');
    const noStock = new MM.Game({ seed: 1 });
    check(noStock.addPortal(0, 1).reason !== undefined && !noStock.addPortal(0, 1).ok, 'without a pair in stock nothing can be placed');
    check(g.addPortal(E, X).ok && g.inv.tp === 0 && g.world.tp.get(E) === X, 'a pair is placed: entrance -> exit');
    check(g.world.portal.get(E).style === 'blue' && g.world.portal.get(X).style === 'blue' && g.world.tp.get(E) === X && g.world.tp.get(X) === E, 'both ends look the same and the pair works in both directions');
    check(g.checkPortal(E) === 'taken', 'a node holds one portal only');
    // roads may not be attached to a portal: it sits at the very end of its road
    let rejected = 0, tried = 0;
    for (let d = 0; d < 4; d++) {
      const m = g.world.nbGrid(E, d);
      if (m < 0 || g.world.rawBetween(E, m)) continue;
      tried++;
      if (g.addEdge(E, m, 1).reason === 'tpend') rejected++;
    }
    check(tried > 0 && rejected === tried, 'no road can be attached to a portal (' + rejected + '/' + tried + ')');
  }

  // c) cars really use it
  {
    const none = build();
    const e0 = run(none.g, 120);
    check(!e0 && none.g.score === 0, 'without the portal the cut road delivers nothing');
    const { g, E, X } = build();
    g.score = 100; g.grantPortals();
    const base = g.score;
    check(g.addPortal(E, X).ok, 'portal pair placed');
    const err = run(g, 120);
    const tele = g.events.filter((e) => e.type === 'teleport');
    check(!err, 'invariants hold with cars teleporting (' + err + ')');
    check(g.score > base + 3, 'cars arrive through the portal (' + (g.score - base) + ' delivered)');
    check(tele.length > 3 && tele.every((e) => e.from === E && e.to === X), 'teleport events go from the entrance to the exit (' + tele.length + ')');
    check(g.cars.every((c) => !c.dead), 'no dead cars left in the list');
  }

  // d) it is two-way: the route from the destination side back to the house goes through the portals as well
  {
    const { g, E, X, p, h } = build();
    g.score = 100; g.grantPortals();
    g.addPortal(E, X);
    const there = g.route(h.node, g.dests.find((x) => x.color === h.color).node, -1);
    check(there && there.includes(E) && there.includes(X) && there.indexOf(E) < there.indexOf(X), 'house -> destination goes in at one portal and out of the other');
    const back = g.route(p[p.length - 3], h.node, -1);
    check(back && back.includes(E) && back.includes(X) && back.indexOf(X) < back.indexOf(E), 'destination side -> house goes through the same pair the other way round');
    // and a car really drives it backwards: from the destination side, through the pair, to the house
    for (const hh of g.houses) hh.tripTimer = 1e9;
    const start = p[p.length - 3];
    const path = back;
    const car = { id: g.nextId++, color: h.color, path, i: 0, s: 0, lane: start * 4 + g.world.dirOf(start, path[1]), dest: h, house: h, held: -1, resLane: -1, resSlot: -1, slot: 0, nslot: 0, nslotFor: -1, pslot: 0, dead: false, stamp: -1, idle: 0, v: 0 };
    g.cars.push(car);
    g.events.length = 0;
    const before = g.score;
    const err = run(g, 90);
    const tele = g.events.filter((e) => e.type === 'teleport');
    check(!err, 'invariants hold (' + err + ')');
    check(g.score === before + 1 && car.dead, 'the car arrived at the house through the portals');
    check(tele.length === 1 && tele[0].from === X && tele[0].to === E, 'it went in at the far portal and came out at the near one (' + tele.length + ' hops)');
  }

  // e) editing: erasing the road under a portal returns the pair; erasing a portal returns the pair; cars are not left stranded
  {
    const { g, E, X, p } = build();
    g.score = 100; g.grantPortals();
    g.addPortal(E, X);
    run(g, 30);
    check(g.removePortal(X) && g.inv.tp === 1 && g.world.tp.size === 0 && g.world.portal.size === 0, 'removing either end takes the pair back into stock');
    check(g.nextPortalStyle() === 'blue', 'the returned pair keeps its look');
    check(g.cars.every((c) => { const a = c.path[c.i], b = c.path[c.i + 1]; return g.world.edgeBetween(a, b); }), 'cars are re-routed or recalled');
    g.addPortal(E, X);
    check(g.inv.tp === 0, 'placed again');
    const k = p.indexOf(E);
    check(g.removeEdge(p[k - 1], E).ok, 'the road that feeds the entrance is erased');
    check(g.inv.tp === 1 && g.world.portal.size === 0 && g.world.tp.size === 0, 'a portal that lost its road goes back to stock together with its mate');
    const err = run(g, 20);
    check(!err, 'invariants hold afterwards (' + err + ')');
  }

  // f) the stress bot never breaks anything with portals around
  {
    const { g, E, X } = build();
    g.score = 300; g.grantPortals();
    check(g.addPortal(E, X).ok, 'first pair placed');
    const err = run(g, 600);
    check(!err, 'ten simulated minutes with a portal: no invariant violations (' + err + ')');
  }
}

console.log('19. 超級原子彈: given with Kayray\'s blessing (one at a time), erases every road and refunds the equipment');
{
  const failedFor = (seed) => {
    const g = new MM.Game({ seed });
    for (let t = 0; t < 60 * 60 * 5 && g.state === 'running'; t++) g.update(0.04);
    g.mayorOrder();
    g.finishMayor();
    for (let t = 0; t < 25 * (MM.CFG.MAYOR_SECONDS + 30) && g.state !== 'over'; t++) {
      if (g.state === 'upgrade') g.chooseUpgrade(0);
      g.update(0.04);
    }
    return g;
  };
  check(!MM.UPGRADES.some((u) => u.id === 'nuke'), 'the nuke is not one of the weekly upgrades');
  check(MM.UPGRADES.find((u) => u.id === 'wide').amount === 20, 'four-lane roads come 20 at a time (double)');
  const fresh = new MM.Game({ seed: 5 });
  check(fresh.inv.nuke === 0 && !fresh.nuke().ok, 'no nuke without the blessing');
  const g = failedFor(5);
  check(g.inv.nuke === 0, 'the failed city has no nuke yet');
  g.kayrayBlessing();
  check(g.inv.nuke === 1, 'summoning Kayray\'s blessing gives one nuke');

  // equipment everywhere, then the bomb
  const w = g.world;
  g.inv.bridge = 20; g.inv.hw = 20; g.inv.wide = 20; g.inv.light = 5; g.inv.round = 5; g.inv.ovp = 5; g.inv.tun = 5; g.inv.tp = 0;
  const bridges0 = g.inv.bridge;
  for (const h of g.houses) { const d = g.dests.find((x) => x.color === h.color); if (d) connect(g, h.node, d.node); }
  for (let n = 0; n < w.n; n++) { const e = w.nb(n, 1); if (e >= 0 && w.eE[n] === 1 && !w.water[n] && !w.water[e] && !w.bld[n] && !w.bld[e]) { g.addEdge(n, e, n % 3 === 0 ? 3 : 2); } }
  for (let n = 0; n < w.n; n++) if (w.deg(n) >= 3 && !w.bld[n]) g.placeFeature(n, n % 2 ? 'light' : 'round');
  for (let t = 0; t < 25 * 40; t++) g.update(0.04); // some traffic on the roads
  if (g.state === 'upgrade') g.chooseUpgrade(0); // (a week may have ended while the traffic ran)
  const roadsBefore = g.hasRoads();
  const inUse = { bridge: bridges0 - g.inv.bridge, hw: 20 - g.inv.hw, wide: 20 - g.inv.wide, light: 5 - g.inv.light, round: 5 - g.inv.round };
  const carsBefore = g.cars.length;
  const res = g.nuke();
  check(roadsBefore && res.ok && res.edges > 10, 'the nuke erases the roads (' + (res && res.edges) + ' road segments)');
  check(g.inv.nuke === 0, 'and uses up the nuke');
  let left = 0;
  for (let n = 0; n < w.n; n++) { if (w.eE[n] || w.eS[n]) left++; if (w.feat[n]) left++; }
  check(left === 0 && w.tun.size === 0 && g.bigs.size === 0 && w.portal.size === 0 && !g.hasRoads(), 'no road, light, roundabout, tunnel or portal is left');
  check(g.inv.hw === 20 && g.inv.wide === 20 && g.inv.bridge === bridges0 && g.inv.light === 5 && g.inv.round === 5, 'everything went back to stock (' + JSON.stringify(inUse) + ')');
  check(g.cars.length === 0 && (carsBefore === 0 || g.houses.reduce((a, h) => a + h.queue.length, 0) > 0), 'the cars are gone and their trips are back in the houses (' + carsBefore + ' cars)');
  check(g.buildings.length > 0 && g.state === 'running', 'buildings stay and the game goes on');
  check(!g.nuke().ok, 'no second nuke straight away');
  let err = null;
  for (let t = 0; t < 25 * 20; t++) { g.update(0.04); if (t % 50 === 0 && !err) err = sanity(g); }
  check(!err, 'invariants hold after the blast (' + err + ')');
  for (const h of g.houses) { const d = g.dests.find((x) => x.color === h.color); if (d) connect(g, h.node, d.node); }
  check(g.hasRoads(), 'roads can be built again');

  // one at a time: the next nuke arrives with a new week, never more than one in stock
  const week0 = g.week;
  let seen = false;
  for (let t = 0; t < 25 * 200 && !seen; t++) {
    if (g.state === 'upgrade') g.chooseUpgrade(0);
    g.update(0.04);
    if (g.inv.nuke > 0) seen = true;
  }
  check(seen && g.week > week0 && g.inv.nuke === 1 && g.events.some((e) => e.type === 'nukegift'), 'a new nuke arrives with the next week');
  for (let t = 0; t < 25 * 200; t++) { if (g.state === 'upgrade') g.chooseUpgrade(0); g.update(0.04); }
  check(g.inv.nuke === 1, 'it never piles up beyond one');

  // portals and tunnels go back into stock too
  const g3 = new MM.Game({ seed: 11 });
  g3.inv.nuke = 1; g3.inv.tun = 1;
  const h3 = g3.houses[0];
  const w3 = g3.world;
  let placedTun = false;
  for (let n = 0; n < w3.n && !placedTun; n++) {
    const m = w3.nbGrid(w3.nbGrid(n, 1) < 0 ? n : w3.nbGrid(n, 1), 1);
    if (m >= 0 && !w3.water[n] && !w3.water[m] && !w3.bld[n] && !w3.bld[m] && !w3.deg(n) && !w3.deg(m)) placedTun = g3.addTunnel(n, m).ok;
  }
  g3.score = 100; g3.grantPortals();
  void h3;
  check(placedTun && g3.nuke().ok && g3.inv.tun === 1 && w3.tun.size === 0, 'a tunnel is wiped and refunded as well');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
