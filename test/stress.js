// Long-run stress test with a naive bot: node test/stress.js [seeds] [minutes]
'use strict';
const path = require('path');
require(path.join(__dirname, '../js/core.js'));
require(path.join(__dirname, '../js/sim.js'));
const MM = globalThis.MM;

function wire(g) {
  const w = g.world;
  for (const h of g.houses) {
    if (h._wired) continue;
    const d = g.dests.find((x) => x.color === h.color);
    if (!d) continue;
    const dist = new Map([[h.node, 0]]), prev = new Map([[h.node, -1]]);
    const q = [h.node];
    while (q.length) {
      q.sort((a, b) => dist.get(a) - dist.get(b));
      const u = q.shift();
      if (u === d.node) break;
      for (let k = 0; k < 4; k++) {
        const x = w.nb(u, k);
        if (x < 0 || (w.bld[x] && x !== d.node)) continue;
        const nd = dist.get(u) + (w.water[x] || w.water[u] ? 5 : 1) + (w.edgeBetween(u, x) ? -0.6 : 0);
        if (!dist.has(x) || nd < dist.get(x)) { dist.set(x, nd); prev.set(x, u); q.push(x); }
      }
    }
    if (!prev.has(d.node)) continue;
    const p = [];
    for (let x = d.node; x !== -1; x = prev.get(x)) p.push(x);
    p.reverse();
    let ok = true;
    for (let i = 0; i + 1 < p.length; i++) {
      if (!w.edgeBetween(p[i], p[i + 1]) && !g.addEdge(p[i], p[i + 1], 1).ok) { ok = false; break; }
    }
    if (ok) h._wired = true;
  }
}

function useInventory(g, rnd) {
  const w = g.world;
  for (let n = 0; n < w.n; n++) {
    if (w.deg(n) < 3 || w.bld[n] || w.feat[n]) continue;
    if (g.inv.light > 0 && rnd() < 0.5) g.placeFeature(n, 'light');
    else if (g.inv.round > 0 && rnd() < 0.5) g.placeFeature(n, 'round');
  }
  // grade-separated toys: overpasses on any four-way crossing, a few tunnels / big roundabouts at random spots
  for (let n = 0; n < w.n && g.inv.ovp > 0; n++) if (w.deg(n) === 4 && !w.feat[n] && !w.bld[n] && rnd() < 0.5) g.placeFeature(n, 'ovp');
  for (let k = 0; k < 20 && g.inv.tun > 0; k++) {
    const n = Math.floor(rnd() * w.n), d = Math.floor(rnd() * 4);
    let m = n;
    const len = 2 + Math.floor(rnd() * 5);
    for (let j = 0; j < len && m >= 0; j++) m = w.nbGrid(m, d);
    if (m >= 0 && (w.deg(n) > 0 || w.deg(m) > 0)) g.addTunnel(n, m);
  }
  for (let k = 0; k < 40 && g.inv.big > 0; k++) {
    const n = Math.floor(rnd() * w.n);
    if (w.deg(n) > 0 || w.deg(w.nbGrid(n, 0) < 0 ? n : w.nbGrid(n, 0)) > 0) g.placeBig(n);
  }
  for (let n = 0; n < w.n && g.inv.hw > 0; n++) {
    const e = w.nb(n, 1);
    if (e >= 0 && w.eE[n] === 1 && !w.water[n] && !w.water[e] && rnd() < 0.3) g.addEdge(n, e, 2);
  }
}

const seeds = +(process.argv[2] || 12);
const minutes = +(process.argv[3] || 10);
let bad = 0;
const summary = [];
for (let seed = 1; seed <= seeds; seed++) {
  const g = new MM.Game({ seed, cols: 34, rows: 22 });
  const rnd = MM.mulberry32(seed * 7);
  const lastPos = new Map();
  let maxStuck = 0, err = null, tows = 0;
  for (let t = 0; t < 25 * 60 * minutes && g.state !== 'over'; t++) {
    if (g.state === 'upgrade') { g.chooseUpgrade(Math.floor(rnd() * 3)); }
    if (t % 25 === 0) { wire(g); useInventory(g, rnd); }
    try { g.update(0.04); } catch (e) { err = e; break; }
    for (const e of g.events) if (e.type === 'lost') tows++;
    g.events.length = 0;
    if (t % 25 === 0) {
      const seen = new Set();
      for (const c of g.cars) {
        seen.add(c.id);
        if (Number.isNaN(c.s) || c.s < 0 || c.s > 1.0001) err = err || new Error('bad s');
        const key = c.lane + ':' + c.s.toFixed(3);
        const prev = lastPos.get(c.id);
        if (prev && prev.key === key) { prev.n++; maxStuck = Math.max(maxStuck, prev.n); }
        else lastPos.set(c.id, { key, n: 0 });
      }
      for (const id of lastPos.keys()) if (!seen.has(id)) lastPos.delete(id);
    }
  }
  for (let i = 0; i < g.holders.length; i++) if (g.holders[i] < 0 || g.reserved[i * 4] < 0) err = err || new Error('neg holder');
  // every held lock / reservation must be accounted for by a live car
  {
    const h = new Int16Array(g.holders.length), r = new Int16Array(g.reserved.length);
    for (const c of g.cars) { if (c.held >= 0) h[c.held]++; if (c.resLane >= 0) r[c.resLane]++; }
    for (let i = 0; i < h.length; i++) if (h[i] !== g.holders[i]) err = err || new Error('holder leak at ' + i);
    for (let i = 0; i < r.length; i++) if (r[i] !== g.reserved[i]) err = err || new Error('reservation leak at ' + i);
  }
  if (err) { bad++; console.error('seed', seed, 'ERROR', err.stack); }
  summary.push(`seed ${String(seed).padStart(2)}: ${g.state.padEnd(7)} week ${g.week} score ${String(g.score).padStart(4)} houses ${g.houses.length} maxStuck ${maxStuck}s tows ${tows}` + (g.over ? ` | died: colour ${g.over.dest.color}, unwired houses ${g.houses.filter((h) => !h._wired).length}, queued trips ${g.houses.reduce((a, h) => a + h.queue.length, 0)}, cars ${g.cars.length}` : ''));
}
console.log(summary.join('\n'));
console.log(bad ? `${bad} seeds had errors` : 'no errors');
process.exit(bad ? 1 : 0);
