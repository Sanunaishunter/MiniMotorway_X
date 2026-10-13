/* Mini Motorway X — simulation: buildings, demand, routing, cars, intersections, weekly upgrades */
(function (root) {
  'use strict';
  const MM = root.MM;
  const CFG = MM.CFG;

  MM.UPGRADES = [
    { id: 'light', amount: 3, title: '紅綠燈', desc: '放在三岔以上的路口,讓同方向的車連續通過。' },
    { id: 'round', amount: 2, title: '圓環', desc: '路口可同時容納兩輛車,減少停等。' },
    { id: 'bridge', amount: 6, title: '橋樑', desc: '讓道路可以跨越河流與湖泊(每段 1 個)。' },
    { id: 'hw', amount: 12, title: '高速公路', desc: '把一般道路升級成高速路段,車速加倍。' },
    { id: 'ovp', amount: 2, title: '高架', desc: '放在十字路口,兩條路立體交叉:直行不必停,但不能轉彎。' },
    { id: 'tun', amount: 2, title: '隧道', desc: '從入口拖曳到同一直線 2–6 格外的出口,車子從地下穿過(可穿過水面與其他道路)。' },
    { id: 'big', amount: 1, title: '大圓環', desc: '3×3 格的逆時針單向環島(約為圓環的 3 倍大),可同時容納很多車。' },
  ];

  const HOUSES_PER_DEST = 4;

  class Game {
    constructor(opts) {
      opts = opts || {};
      this.cols = opts.cols || 34;
      this.rows = opts.rows || 22;
      this.seed = opts.seed != null ? opts.seed : (Math.random() * 2147483647) | 0;
      this.rand = MM.mulberry32(this.seed);
      this.world = new MM.World(this.cols, this.rows, this.rand);
      const n = this.world.n;

      this.holders = new Int16Array(n); // cars currently inside each controlled intersection
      this.laneLoad = new Int16Array(n * 4);
      this.reserved = new Int16Array(n * 4); // exit-lane slots promised to cars that hold an intersection lock
      this.lights = new Map(); // node -> {green, timer, pending, waiting:[bool,bool]}
      this.lanes = new Map(); // laneId -> cars (rebuilt every step)
      this.cars = [];
      this.buildings = [];
      this.houses = [];
      this.dests = [];
      this.events = []; // consumed by the UI (sounds / effects)

      this.time = 0;
      this.weekTime = 0;
      this.week = 1;
      this.score = 0;
      this.tick = 0;
      this.state = 'running'; // running | upgrade | over
      this.choices = null;
      this.over = null;
      this.colorsUnlocked = 0;
      this.inv = { bridge: 4, hw: 0, light: 0, round: 0, ovp: 0, tun: 0, big: 0 };
      this.bigs = new Map(); // big roundabouts: id -> {id, center, nodes[8] in circulation order}
      this.bigSeq = 0;
      this.nextId = 1;
      this.houseTimer = 14;

      // routing works on (node, arrival direction) states: 5 per node (4 = no direction yet)
      this._dist = new Float64Array(n * 5);
      this._prev = new Int32Array(n * 5);
      this._hk = new Float64Array(n * 5 * 5);
      this._hv = new Int32Array(n * 5 * 5);
      this._hs = 0;

      this.setup();
    }

    // ------------------------------------------------------------ setup / buildings
    setup() {
      this.colorsUnlocked = 1;
      const cx0 = Math.floor(this.cols * 0.3), cx1 = Math.ceil(this.cols * 0.7);
      const cy0 = Math.floor(this.rows * 0.3), cy1 = Math.ceil(this.rows * 0.7);
      const d = this.findSpot('dest', 0, { mainOnly: true, c0: cx0, c1: cx1, r0: cy0, r1: cy1 });
      if (d >= 0) this.addBuilding('dest', 0, d);
      for (let i = 0; i < 2; i++) {
        const h = this.findSpot('house', 0, { mainOnly: true });
        if (h >= 0) this.addBuilding('house', 0, h, 6 + i * 4);
      }
      if (!this.dests.length || !this.houses.length) throw new Error('map generation failed');
    }

    spotOK(n, mainOnly) {
      const w = this.world;
      if (w.water[n] || w.bld[n] || w.deg(n) > 0 || w.feat[n] || w.island[n] || w.ringId[n]) return false;
      if (mainOnly && w.comp[n] !== w.mainComp) return false;
      if (w.compSize[w.comp[n]] < 8) return false;
      const c = w.col(n), r = w.row(n);
      for (const b of this.buildings) {
        if (Math.abs(w.col(b.node) - c) + Math.abs(w.row(b.node) - r) < 3) return false;
      }
      let free = 0;
      for (let d = 0; d < 4; d++) {
        const v = w.nbGrid(n, d);
        if (v >= 0 && !w.water[v] && !w.bld[v]) free++;
      }
      return free >= 3;
    }

    findSpot(kind, color, opts) {
      const w = this.world;
      const c0 = opts.c0 != null ? opts.c0 : 1;
      const c1 = opts.c1 != null ? opts.c1 : this.cols - 2;
      const r0 = opts.r0 != null ? opts.r0 : 1;
      const r1 = opts.r1 != null ? opts.r1 : this.rows - 2;
      const others = kind === 'dest' ? this.houses.filter((h) => h.color === color) : this.dests.filter((d) => d.color === color);
      let best = -1, bestScore = -1e9;
      for (let t = 0; t < 160; t++) {
        const c = c0 + Math.floor(this.rand() * (c1 - c0 + 1));
        const r = r0 + Math.floor(this.rand() * (r1 - r0 + 1));
        const n = r * this.cols + c;
        if (!this.spotOK(n, opts.mainOnly)) continue;
        let md = Infinity;
        for (const o of others) md = Math.min(md, Math.abs(w.col(o.node) - c) + Math.abs(w.row(o.node) - r));
        let score = 0;
        if (md !== Infinity) {
          score = -Math.abs(md - 10);
          if (md < 5) score -= 20;
        }
        score += this.rand() * 2;
        if (score > bestScore) { bestScore = score; best = n; }
      }
      return best;
    }

    addBuilding(kind, color, node, firstTripDelay) {
      const b = {
        id: this.nextId++, kind, color, node, born: this.time,
        pins: 0, inbound: 0, overflow: 0, // destinations (pins = unmet demand, inbound = those with a car already on the way)
        queue: [], tripTimer: 0, cd: 0, // houses
      };
      if (kind === 'house') b.tripTimer = firstTripDelay != null ? firstTripDelay : 10 + this.rand() * 4;
      this.world.bld[node] = b;
      this.buildings.push(b);
      (kind === 'house' ? this.houses : this.dests).push(b);
      this.events.push({ type: 'spawn', kind, color, node });
      return b;
    }

    /** Timed growth: add a house where a destination has spare capacity, otherwise add another destination. */
    grow() {
      if (this.houses.length >= 46) return;
      const order = [];
      for (let c = 0; c < this.colorsUnlocked; c++) order.push(c);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(this.rand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const count = (list, c) => list.filter((b) => b.color === c).length;
      for (const c of order) {
        if (count(this.houses, c) < HOUSES_PER_DEST * count(this.dests, c)) { this.spawnRandom('house', c); return; }
      }
      for (const c of order) {
        if (count(this.dests, c) < 3) { this.spawnRandom('dest', c); return; }
      }
    }

    spawnRandom(kind, color) {
      const mainOnly = this.week <= 3 || this.rand() < 0.65;
      const n = this.findSpot(kind, color, { mainOnly });
      if (n < 0) return null;
      return this.addBuilding(kind, color, n);
    }

    // ------------------------------------------------------------ editing API
    addEdge(a, b, kind) {
      const w = this.world;
      kind = kind || 1;
      if (this.state !== 'running') return { ok: false, reason: 'state' };
      if (!w.adjacent(a, b)) return { ok: false, reason: 'adj' };
      if (w.bld[a] && w.bld[b]) return { ok: false, reason: 'bld' };
      if (w.island[a] || w.island[b]) return { ok: false, reason: 'island' };
      const dir = w.dirOf(a, b);
      if (w.tun.has(a * 4 + dir) || w.tun.has(b * 4 + ((dir + 2) & 3))) return { ok: false, reason: 'tunnel' };
      const cur = w.rawBetween(a, b) & 3;
      const wet = w.isBridgeEdge(a, b);
      if (kind === 2) {
        if (wet) return { ok: false, reason: 'hw-water' };
        if (cur === 2) return { ok: false, reason: 'same' };
        if (this.inv.hw <= 0) return { ok: false, reason: 'nohw' };
        this.inv.hw--;
        w.setEdge(a, b, 2);
        this.events.push({ type: 'road', hw: true });
        return { ok: true };
      }
      if (cur > 0) return { ok: false, reason: 'exists' };
      if (wet) {
        if (this.inv.bridge <= 0) return { ok: false, reason: 'nobridge' };
        this.inv.bridge--;
      }
      w.setEdge(a, b, 1);
      this.events.push({ type: 'road' });
      return { ok: true };
    }

    removeEdge(a, b) {
      const w = this.world;
      if (this.state !== 'running') return { ok: false };
      const cur = w.rawBetween(a, b) & 3;
      if (!cur) return { ok: false };
      if (w.ringId[a] && w.ringId[a] === w.ringId[b]) return { ok: false, reason: 'ring' }; // part of a big roundabout
      if (cur === 2) this.inv.hw++;
      else if (w.isBridgeEdge(a, b)) this.inv.bridge++;
      w.setEdge(a, b, 0);
      this.cleanFeatures([a, b]);
      this.validateCars();
      this.events.push({ type: 'erase' });
      return { ok: true };
    }

    placeFeature(n, kind) {
      const w = this.world;
      if (this.state !== 'running') return { ok: false, reason: 'state' };
      if (n < 0 || w.bld[n] || w.feat[n] || w.ringId[n] || w.island[n]) return { ok: false, reason: 'occupied' };
      if (kind === 'ovp') {
        if (w.deg(n) < 4 || [0, 1, 2, 3].some((d) => w.tun.has(n * 4 + d))) return { ok: false, reason: 'need4' };
      } else if (w.deg(n) < 3) return { ok: false, reason: 'need3' };
      if (this.inv[kind] <= 0) return { ok: false, reason: 'none' };
      this.inv[kind]--;
      if (kind === 'light') {
        w.feat[n] = 1;
        this.lights.set(n, { green: 0, timer: 0, pending: false, waiting: [false, false] });
      } else if (kind === 'ovp') {
        w.feat[n] = 3;
      } else {
        w.feat[n] = 2;
      }
      this.events.push({ type: 'place', node: n });
      return { ok: true };
    }

    removeFeature(n) {
      const w = this.world;
      const f = w.feat[n];
      if (!f) return false;
      this.inv[f === 1 ? 'light' : f === 3 ? 'ovp' : 'round']++;
      w.feat[n] = 0;
      this.lights.delete(n);
      return true;
    }

    /** Drop features that no longer make sense after edges around `nodes` changed. */
    cleanFeatures(nodes) {
      const w = this.world;
      for (const n of nodes) {
        const f = w.feat[n];
        if (f && w.deg(n) < (f === 3 ? 4 : 3)) this.removeFeature(n);
      }
    }

    // ---- big roundabout: a 3x3 one-way ring (counter-clockwise seen from above) around an empty centre island
    /** Why a big roundabout cannot be centred on c ('edge' / 'blocked'), or null if the 3x3 area is usable. */
    checkBig(c) {
      const w = this.world;
      if (c < 0) return 'blocked';
      const col = w.col(c), row = w.row(c);
      if (col < 1 || row < 1 || col > w.cols - 2 || row > w.rows - 2) return 'edge';
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const n = (row + dy) * w.cols + col + dx;
        if (w.water[n] || w.bld[n] || w.ringId[n] || w.island[n] || w.feat[n] || [0, 1, 2, 3].some((d) => w.tun.has(n * 4 + d))) return 'blocked';
      }
      return null;
    }

    placeBig(c) {
      const w = this.world;
      if (this.state !== 'running') return { ok: false, reason: 'state' };
      const bad = this.checkBig(c);
      if (bad) return { ok: false, reason: bad };
      if (this.inv.big <= 0) return { ok: false, reason: 'none' };
      const col = w.col(c), row = w.row(c);
      const OFFS = [[1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0]]; // NE N NW W SW S SE E
      const ring = OFFS.map((o) => (row + o[1]) * w.cols + col + o[0]);
      const all = [c, ...ring];
      const inside = new Set(all);
      for (const n of all) {
        for (const d of [1, 2]) { // each adjacent pair once
          const m = w.nbGrid(n, d);
          if (m < 0 || !inside.has(m)) continue;
          const raw = w.rawBetween(n, m);
          if (raw) { if ((raw & 3) === 2) this.inv.hw++; w.setEdge(n, m, 0); }
        }
      }
      const id = ++this.bigSeq;
      for (let i = 0; i < 8; i++) {
        w.setEdge(ring[i], ring[(i + 1) % 8], 1, true);
        w.ringId[ring[i]] = id;
      }
      w.island[c] = id;
      this.bigs.set(id, { id, center: c, nodes: ring });
      this.inv.big--;
      this.validateCars();
      this.events.push({ type: 'place', node: c });
      return { ok: true };
    }

    removeBig(id) {
      const w = this.world;
      const b = this.bigs.get(id);
      if (!b || this.state !== 'running') return false;
      for (let i = 0; i < 8; i++) {
        w.setEdge(b.nodes[i], b.nodes[(i + 1) % 8], 0);
        w.ringId[b.nodes[i]] = 0;
      }
      w.island[b.center] = 0;
      this.bigs.delete(id);
      this.inv.big++;
      this.cleanFeatures(b.nodes);
      this.validateCars();
      this.events.push({ type: 'erase' });
      return true;
    }

    removeBigAt(n) {
      const w = this.world;
      const id = w.ringId[n] || w.island[n];
      return id ? this.removeBig(id) : false;
    }

    // ---- tunnels: a long edge between two portals on one row / column that skips the cells in between
    /** Why a tunnel from a to b is not possible ('line' / 'short' / 'long' / 'portal' / 'busy'), or null if it is. */
    checkTunnel(a, b) {
      const w = this.world;
      if (a < 0 || b < 0 || a === b) return 'line';
      const d = w.dirOf(a, b);
      if (d < 0) return 'line';
      const len = Math.abs(w.col(a) - w.col(b)) + Math.abs(w.row(a) - w.row(b));
      if (len < CFG.TUNNEL_MIN) return 'short';
      if (len > CFG.TUNNEL_MAX) return 'long';
      for (const n of [a, b]) if (w.water[n] || w.bld[n] || w.ringId[n] || w.island[n]) return 'portal';
      if (w.incident(a, d) || w.incident(b, (d + 2) & 3)) return 'busy';
      return null;
    }

    addTunnel(a, b) {
      const w = this.world;
      if (this.state !== 'running') return { ok: false, reason: 'state' };
      const bad = this.checkTunnel(a, b);
      if (bad) return { ok: false, reason: bad };
      const d = w.dirOf(a, b), od = (d + 2) & 3;
      const len = Math.abs(w.col(a) - w.col(b)) + Math.abs(w.row(a) - w.row(b));
      if (this.inv.tun <= 0) return { ok: false, reason: 'none' };
      this.inv.tun--;
      w.tun.set(a * 4 + d, { to: b, len });
      w.tun.set(b * 4 + od, { to: a, len });
      this.events.push({ type: 'place', node: a });
      this.events.push({ type: 'place', node: b });
      return { ok: true };
    }

    removeTunnel(a, d) {
      const w = this.world;
      const t = w.tun.get(a * 4 + d);
      if (!t || this.state !== 'running') return false;
      w.tun.delete(a * 4 + d);
      w.tun.delete(t.to * 4 + ((d + 2) & 3));
      this.inv.tun++;
      this.cleanFeatures([a, t.to]);
      this.validateCars();
      this.events.push({ type: 'erase' });
      return true;
    }

    /** Remove the tunnel that has node n as a portal (or, unless portalOnly, lies over it). */
    removeTunnelAt(n, portalOnly) {
      const w = this.world;
      const step = [-w.cols, 1, w.cols, -1];
      for (const [key, t] of w.tun) {
        const a = key >> 2, d = key & 3;
        if (a > t.to) continue;
        if (portalOnly) { if (n === a || n === t.to) return this.removeTunnel(a, d); continue; }
        for (let k = 0; k <= t.len; k++) if (a + k * step[d] === n) return this.removeTunnel(a, d);
      }
      return false;
    }

    // ------------------------------------------------------------ routing
    edgeCost(u, d, v) {
      const w = this.world;
      const t = w.edge(u, d);
      const len = t === 3 ? w.tun.get(u * 4 + d).len : 1;
      let c = len / (t === 2 ? CFG.HW_MULT : t === 3 ? CFG.TUN_MULT : 1);
      c += 0.3 * this.laneLoad[u * 4 + d];
      if (w.isJunction(v)) {
        const f = w.feat[v];
        c += f === 1 ? 0.7 : f === 2 || w.ringId[v] ? 0.25 : 0.55;
      }
      return c;
    }

    _hpush(k, v) {
      const hk = this._hk, hv = this._hv;
      let i = this._hs++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hk[p] <= k) break;
        hk[i] = hk[p]; hv[i] = hv[p];
        i = p;
      }
      hk[i] = k; hv[i] = v;
    }

    _hpop() {
      const hk = this._hk, hv = this._hv;
      const top = hv[0], topK = hk[0];
      const size = --this._hs;
      if (size > 0) {
        const k = hk[size], v = hv[size];
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= size) break;
          if (c + 1 < size && hk[c + 1] < hk[c]) c++;
          if (hk[c] >= k) break;
          hk[i] = hk[c]; hv[i] = hv[c];
          i = c;
        }
        hk[i] = k; hv[i] = v;
      }
      this._popK = topK;
      return top;
    }

    /**
     * Dijkstra over (node, arrival direction) states. `targets` is a node index or a Set of nodes; buildings other than the
     * target are impassable. `inDir` is the direction the car is travelling when it arrives at `start` (-1 = none, e.g. a
     * house): U-turns are never allowed, and an overpass can only be crossed straight on.
     */
    route(start, targets, inDir) {
      const w = this.world;
      const dist = this._dist, prev = this._prev;
      dist.fill(Infinity);
      prev.fill(-1);
      const single = typeof targets === 'number';
      this._hs = 0;
      const s0 = start * 5 + (inDir >= 0 ? inDir : 4);
      dist[s0] = 0;
      this._hpush(0, s0);
      while (this._hs > 0) {
        const st = this._hpop();
        const du = this._popK;
        if (du > dist[st]) continue;
        const u = (st / 5) | 0;
        const din = st % 5;
        if (st !== s0 && (single ? u === targets : targets.has(u))) {
          const path = [];
          for (let x = st; x !== -1; x = prev[x]) path.push((x / 5) | 0);
          path.reverse();
          return path;
        }
        if (st !== s0 && w.bld[u]) continue;
        for (let d = 0; d < 4; d++) {
          if (!w.edge(u, d)) continue;
          if (din < 4 && (d === ((din + 2) & 3) || (w.feat[u] === 3 && d !== din))) continue;
          const v = w.nb(u, d);
          const ns = v * 5 + d;
          const nd = du + this.edgeCost(u, d, v);
          if (nd < dist[ns]) {
            dist[ns] = nd;
            prev[ns] = st;
            this._hpush(nd, ns);
          }
        }
      }
      return null;
    }

    // ------------------------------------------------------------ cars
    /** Length of a lane in cells (1, or the tunnel length). */
    lenOf(lane) {
      const t = this.world.tun.get(lane);
      return t ? t.len : 1;
    }

    /** Speed along a lane in lane-lengths per second. */
    speedOf(lane) {
      const t = this.world.edge(lane >> 2, lane & 3);
      return (CFG.SPEED * (t === 2 ? CFG.HW_MULT : t === 3 ? CFG.TUN_MULT : 1)) / this.lenOf(lane);
    }

    /** True if no car is within `needCells` of the start of the lane. */
    laneClear(lane, needCells) {
      const l = this.lanes.get(lane);
      if (!l) return true;
      const need = needCells / this.lenOf(lane);
      for (const o of l) if (!o.dead && o.lane === lane && o.s < need) return false;
      return true;
    }

    dispatch(h) {
      const w = this.world;
      if (!h.queue.length) return false;
      let trip = h.queue[0];
      let path = this.route(h.node, trip.node, -1);
      if (!path) {
        const set = new Set();
        for (const d of this.dests) if (d.color === h.color) set.add(d.node);
        path = this.route(h.node, set, -1);
        if (path) {
          const nd = w.bld[path[path.length - 1]];
          trip.pins--;
          nd.pins++;
          h.queue[0] = nd;
          trip = nd;
        }
      }
      if (!path) return false;
      const lane = h.node * 4 + w.dirOf(h.node, path[1]);
      if (!this.laneClear(lane, CFG.GAP * 1.4)) return false;
      h.queue.shift();
      const car = { id: this.nextId++, color: h.color, path, i: 0, s: 0, lane, dest: trip, house: h, held: -1, resLane: -1, dead: false, stamp: -1, idle: 0, v: 0 };
      trip.inbound++;
      this.cars.push(car);
      let l = this.lanes.get(lane);
      if (!l) this.lanes.set(lane, (l = []));
      l.push(car);
      return true;
    }

    killCar(car, requeue) {
      if (car.dead) return;
      car.dead = true;
      if (car.held >= 0) { this.holders[car.held]--; car.held = -1; }
      this.dropReservation(car);
      if (requeue) {
        car.dest.inbound = Math.max(0, (car.dest.inbound || 0) - 1);
        car.house.queue.unshift(car.dest);
        this.events.push({ type: 'lost', node: car.path[car.i], color: car.color });
      }
    }

    validateCars() {
      const w = this.world;
      for (const car of this.cars) {
        if (car.dead) continue;
        const p = car.path;
        const a = p[car.i], b = p[car.i + 1];
        if (!w.edgeBetween(a, b)) { this.killCar(car, true); continue; }
        let ok = true;
        for (let k = car.i + 1; k < p.length - 1; k++) {
          if (!w.edgeBetween(p[k], p[k + 1])) { ok = false; break; }
        }
        if (!ok) {
          const np = b === car.dest.node ? null : this.route(b, car.dest.node, w.dirOf(a, b));
          if (np) { car.path = p.slice(0, car.i + 1).concat(np); this.dropReservation(car); }
          else this.killCar(car, true);
        }
      }
      this.cars = this.cars.filter((c) => !c.dead);
    }

    tryAcquire(car, b) {
      const w = this.world;
      const a = car.path[car.i];
      const c = car.path[car.i + 2];
      if (c === undefined) return false;
      // Box-junction rule with reservations: the exit lane must have a free slot for this car (cars already in it plus cars
      // that hold a lock and are about to enter). A lane that ends in a controlled junction queues at the stop line, so it
      // only has room for 2 cars if a lock holder is still to be able to reach the release point; otherwise 3.
      const nl = b * 4 + w.dirOf(b, c);
      let used = this.reserved[nl];
      const lst = this.lanes.get(nl);
      if (lst) for (const o of lst) if (!o.dead && o.lane === nl) used++;
      const controlled = car.path[car.i + 3] !== undefined && w.isJunction(c);
      // queue positions (in cells from the lane start): the first car waits at p1, the next ones every GAP behind it, and the
      // last car must still leave room for a lock holder to reach the release point
      const p1 = this.lenOf(nl) - (controlled ? 1 - CFG.STOP : 0);
      const cap = Math.floor((p1 - 2 * CFG.RELEASE) / CFG.GAP + 1e-9) + 2;
      if (used + 1 > cap) return false;
      const f = w.feat[b];
      if (f === 1) {
        const L = this.lights.get(b);
        if (L && (L.pending || L.green !== (w.dirOf(a, b) & 1))) return false;
      } else if (f === 2 || w.ringId[b]) {
        if (this.holders[b] >= 2) return false;
      } else if (this.holders[b] >= 1) {
        return false;
      }
      this.holders[b]++;
      this.reserved[nl]++;
      car.resLane = nl;
      return true;
    }

    replan(car) {
      const i = car.i;
      const x = car.path[i], y = car.path[i + 1];
      const np = this.route(y, car.dest.node, this.world.dirOf(x, y));
      if (np) {
        car.path = car.path.slice(0, i + 1).concat(np);
        if (car.resLane >= 0 && car.resLane !== y * 4 + this.world.dirOf(y, car.path[i + 2])) this.dropReservation(car);
      }
    }

    dropReservation(car) {
      if (car.resLane >= 0) { this.reserved[car.resLane]--; car.resLane = -1; }
    }

    stepCar(car, list, k, dt) {
      const w = this.world;
      car.stamp = this.tick;
      const p = car.path;
      const i = car.i;
      const a = p[i], b = p[i + 1];
      const last = i + 1 === p.length - 1;
      const len = this.lenOf(car.lane); // lane length in cells; s runs 0..1 along it
      let maxS = 1;
      for (let j = k - 1; j >= 0; j--) {
        const o = list[j];
        if (o.dead || o.lane !== car.lane) continue;
        maxS = Math.min(maxS, o.s - CFG.GAP / len);
        break;
      }
      if (!last && car.held !== b && w.isJunction(b)) {
        const base = w.feat[b] === 2 || w.ringId[b] ? 0.72 : CFG.STOP;
        const stop = 1 - (1 - base) / len;
        if (car.s >= stop - 0.04 / len && this.tryAcquire(car, b)) car.held = b;
        if (car.held !== b) {
          maxS = Math.min(maxS, stop);
          if (w.feat[b] === 1 && car.s >= stop - 0.12 / len) {
            const L = this.lights.get(b);
            if (L) L.waiting[w.dirOf(a, b) & 1] = true;
          }
        }
      }
      // gentle acceleration; running into the car ahead or a stop line kills the speed
      car.v = Math.min(this.speedOf(car.lane), (car.v || 0) + (CFG.ACCEL / len) * dt);
      const ds = Math.min(car.v * dt, maxS - car.s);
      if (ds < car.v * dt - 1e-9) car.v = Math.max(0, ds / dt);
      if (ds > 0) car.s += ds;
      if (car.held >= 0 && car.held === a && car.s >= CFG.RELEASE / len) { this.holders[car.held]--; car.held = -1; }
      if (ds > 1e-6) car.idle = 0;
      else {
        car.idle += dt;
        if (car.idle > (car.held >= 0 ? CFG.TOW_HOLDER : CFG.TOW_ANY)) {
          this.events.push({ type: 'lost', node: a, color: car.color });
          this.killCar(car, true);
          return;
        }
      }

      if (car.s >= 0.9999) {
        if (last) {
          this.deliver(car);
          return;
        }
        const c = p[i + 2];
        const nl = b * 4 + w.dirOf(b, c);
        if (!this.laneClear(nl, CFG.GAP * 1.1)) { car.s = 1; return; }
        car.i++;
        car.s = 0;
        car.lane = nl;
        if (car.resLane === nl) this.dropReservation(car);
        let l = this.lanes.get(nl);
        if (!l) this.lanes.set(nl, (l = []));
        l.push(car);
        const nxt = car.path[car.i + 1];
        if (car.i + 1 < car.path.length - 1 && w.isJunction(nxt)) this.replan(car);
      }
    }

    deliver(car) {
      car.dead = true;
      car.dest.pins = Math.max(0, car.dest.pins - 1);
      car.dest.inbound = Math.max(0, (car.dest.inbound || 0) - 1);
      this.score++;
      this.events.push({ type: 'deliver', color: car.color, node: car.dest.node });
    }

    // ------------------------------------------------------------ main loop
    update(dt) {
      if (this.state !== 'running') return;
      let rem = dt;
      while (rem > 1e-6 && this.state === 'running') {
        const h = Math.min(0.04, rem);
        this.step(h);
        rem -= h;
      }
    }

    tripInterval() { return Math.max(4.2, 10.5 - 0.4 * (this.week - 1)); }

    step(dt) {
      this.tick++;
      this.time += dt;
      this.weekTime += dt;

      // timed house spawns
      this.houseTimer -= dt;
      if (this.houseTimer <= 0) {
        this.grow();
        this.houseTimer = Math.max(7, 15 - 0.8 * this.week) * (0.8 + 0.4 * this.rand());
      }

      // rebuild lanes
      this.lanes.clear();
      this.laneLoad.fill(0);
      for (const c of this.cars) {
        if (c.dead) continue;
        let l = this.lanes.get(c.lane);
        if (!l) this.lanes.set(c.lane, (l = []));
        l.push(c);
      }
      for (const [lane, l] of this.lanes) {
        this.laneLoad[lane] = l.length;
        if (l.length > 1) l.sort((x, y) => y.s - x.s);
      }

      // houses: request trips, dispatch cars
      for (const h of this.houses) {
        h.tripTimer -= dt;
        if (h.tripTimer <= 0) {
          const opts = this.dests.filter((d) => d.color === h.color);
          if (opts.length) {
            const d = opts[Math.floor(this.rand() * opts.length)];
            h.queue.push(d);
            d.pins++;
          }
          h.tripTimer = this.tripInterval() * (0.75 + 0.5 * this.rand());
        }
        h.cd -= dt;
        if (h.queue.length && h.cd <= 0) h.cd = this.dispatch(h) ? 0.6 : 0.3;
      }

      // cars
      for (const [lane, l] of this.lanes) {
        for (let k = 0; k < l.length; k++) {
          const car = l[k];
          if (car.dead || car.stamp === this.tick || car.lane !== lane) continue;
          this.stepCar(car, l, k, dt);
        }
      }
      this.cars = this.cars.filter((c) => !c.dead);

      // traffic lights
      for (const [node, L] of this.lights) {
        L.timer += dt;
        const g = L.green, o = 1 - g;
        if (!L.pending && L.waiting[o] && (L.timer >= CFG.LIGHT_PERIOD || (L.timer >= CFG.LIGHT_MIN_GREEN && !L.waiting[g]))) L.pending = true;
        if (L.pending && this.holders[node] <= 0) {
          L.green = o;
          L.timer = 0;
          L.pending = false;
        }
        L.waiting[0] = L.waiting[1] = false;
      }

      // overflow
      for (const d of this.dests) {
        if (d.pins - d.inbound >= CFG.PIN_LIMIT) d.overflow += dt / CFG.OVERFLOW_TIME;
        else d.overflow = Math.max(0, d.overflow - dt / 7);
        if (d.overflow >= 1) { this.gameOver(d); return; }
      }

      // end of week
      if (this.weekTime >= CFG.WEEK_SECONDS) this.advanceWeek();
    }

    advanceWeek() {
      this.week++;
      this.weekTime -= CFG.WEEK_SECONDS;
      let newColor = -1;
      if (this.colorsUnlocked < CFG.MAX_COLORS) {
        newColor = this.colorsUnlocked++;
        this.spawnRandom('dest', newColor);
        this.spawnRandom('house', newColor);
      } else {
        const cands = [];
        for (let c = 0; c < this.colorsUnlocked; c++) if (this.dests.filter((d) => d.color === c).length < 3) cands.push(c);
        if (cands.length) this.spawnRandom('dest', cands[Math.floor(this.rand() * cands.length)]);
      }
      const pool = MM.UPGRADES.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(this.rand() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      this.choices = pool.slice(0, 3);
      this.state = 'upgrade';
      this.events.push({ type: 'week', week: this.week, newColor });
    }

    chooseUpgrade(i) {
      if (this.state !== 'upgrade' || !this.choices || !this.choices[i]) return false;
      const u = this.choices[i];
      this.inv[u.id] += u.amount;
      this.choices = null;
      this.state = 'running';
      return true;
    }

    gameOver(dest) {
      this.state = 'over';
      this.over = { dest };
      this.events.push({ type: 'gameover', node: dest.node });
    }

    dayIndex() { return Math.min(6, Math.floor((this.weekTime / CFG.WEEK_SECONDS) * 7)); }
  }

  MM.Game = Game;
})(typeof window !== 'undefined' ? window : globalThis);
