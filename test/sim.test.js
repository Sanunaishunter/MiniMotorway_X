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
  {
    const h = new Int16Array(g.holders.length), r = new Int16Array(g.reserved.length);
    for (const c of g.cars) { if (c.held >= 0) h[c.held]++; if (c.resLane >= 0) r[c.resLane]++; }
    for (let i = 0; i < h.length; i++) if (h[i] !== g.holders[i]) return 'holder accounting off at ' + i;
    for (let i = 0; i < r.length; i++) if (r[i] !== g.reserved[i]) return 'reservation accounting off at ' + i;
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
  g.inv.light = 99; g.inv.round = 99; g.inv.hw = 99; g.inv.bridge = 99; g.inv.ovp = 99; g.inv.tun = 99; g.inv.big = 99;
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
  const car = { id: g.nextId++, color: 0, path: path.slice(), i: 0, s: 0, lane, dest: { node: path[path.length - 1], pins: 9, inbound: 1 }, house: { queue: [] }, held: -1, resLane: -1, dead: false, stamp: -1, idle: 0, v: 0 };
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

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
