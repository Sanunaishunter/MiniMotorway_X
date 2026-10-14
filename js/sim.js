/* Mini Motorway X — simulation: buildings, demand, routing, cars, intersections, weekly upgrades */
(function (root) {
  'use strict';
  const MM = root.MM;
  const CFG = MM.CFG;

  MM.UPGRADES = [
    { id: 'light', amount: 3, title: '紅綠燈', desc: '放在三岔以上的路口,讓同方向的車連續通過。' },
    { id: 'round', amount: 4, title: '圓環', desc: '路口可同時容納兩輛車,減少停等。' },
    { id: 'hw', amount: 12, title: '高速公路', desc: '把一般道路升級成高速路段,車速加倍。' },
    { id: 'wide', amount: 20, title: '四線道', desc: '把道路拓寬成每個方向兩條車道,通行量約 1.7 倍(不能用在連到房子的路與高速公路)。' },
    { id: 'ovp', amount: 2, title: '高架', desc: '放在十字路口,兩條路立體交叉:直行不必停,但不能轉彎。' },
    { id: 'mega', amount: 1, title: '超大圓環', desc: '8×8 格的單向四線道圓環,中央是大片綠地:大量車流可以同時繞行。放下去會清掉範圍內原本的路。' },
    { id: 'tun', amount: 2, title: '隧道', desc: '從入口拖曳到同一直線 2–6 格外的出口,車子從地下穿過(可穿過水面與其他道路)。' },
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
      this.lastEntry = new Float64Array(n); // when a car last took the lock of each junction
      this.laneLoad = new Int16Array(n * 4);
      this.reserved = new Int16Array(n * 4); // exit-lane slots promised to cars that hold an intersection lock
      this.reservedSlot = new Int16Array(n * 16); // the same, split per lane slot (index lane*4 + slot)
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
      this.state = 'running'; // running | upgrade | collapse | mayor | over
      this.invincibleUntil = 0; // game time until which the mayor's order protects the city from collapsing
      this.mayorActive = false; // true from the moment the mayor's order is finished until its window has been judged
      this.mayorUses = 0;
      this.blessed = false; // Kayray's blessing: invincible for good (until the player restarts)
      this.portalsGiven = 0; // pairs of teleport portals handed out so far (one per CFG.PORTAL_EVERY delivered cars)
      this.portalSeq = 0;
      this.portalQueue = []; // styles ('blue' | 'door') of the pairs in stock, in the order they will be placed
      this.choices = null;
      this.over = null;
      this.colorsUnlocked = 0;
      this.inv = { hw: 0, wide: 0, light: 0, round: 0, ovp: 0, tun: 0, big: 0, mega: 0, tp: 0, nuke: 0, hand: 0 };
      this.bigs = new Map(); // big roundabouts: id -> {id, kind 'big' (3x3) | 'mega' (8x8, four lanes), center, nodes[] in circulation order, inner[] island nodes}
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
      if (!this.canEdit()) return { ok: false, reason: 'state' };
      if (!w.adjacent(a, b)) return { ok: false, reason: 'adj' };
      if (w.bld[a] && w.bld[b]) return { ok: false, reason: 'bld' };
      if (w.island[a] || w.island[b]) return { ok: false, reason: 'island' };
      if (w.portal.has(a) || w.portal.has(b)) return { ok: false, reason: 'tpend' }; // a portal sits at the very end of a road
      const dir = w.dirOf(a, b);
      if (w.tun.has(a * 4 + dir) || w.tun.has(b * 4 + ((dir + 2) & 3))) return { ok: false, reason: 'tunnel' };
      const cur = w.rawBetween(a, b) & 3;
      if (kind === 3) {
        if (w.bld[a] || w.bld[b]) return { ok: false, reason: 'wide-bld' };
        if (cur === 2) return { ok: false, reason: 'wide-hw' };
        if (w.rawBetween(a, b) >> 2) return { ok: false, reason: 'wide-ring' };
        if (cur === 1 && w.isWideBetween(a, b)) return { ok: false, reason: 'same' };
        if (this.inv.wide <= 0) return { ok: false, reason: 'nowide' };
        this.inv.wide--;
        w.setEdge(a, b, 1, false, true);
        this.events.push({ type: 'road', hw: true });
        return { ok: true };
      }
      if (kind === 2) {
        if (cur === 1 && w.isWideBetween(a, b)) return { ok: false, reason: 'hw-wide' };
        if (cur === 2) return { ok: false, reason: 'same' };
        if (this.inv.hw <= 0) return { ok: false, reason: 'nohw' };
        this.inv.hw--;
        w.setEdge(a, b, 2);
        this.events.push({ type: 'road', hw: true });
        return { ok: true };
      }
      if (cur > 0) return { ok: false, reason: 'exists' };
      w.setEdge(a, b, 1); // rivers and lakes are frozen over: a road can run straight across the ice
      this.events.push({ type: 'road' });
      return { ok: true };
    }

    removeEdge(a, b) {
      const w = this.world;
      if (!this.canEdit()) return { ok: false };
      const cur = w.rawBetween(a, b) & 3;
      if (!cur) return { ok: false };
      if (w.ringId[a] && w.ringId[a] === w.ringId[b]) return { ok: false, reason: 'ring' }; // part of a big roundabout
      if (cur === 2) this.inv.hw++;
      else if (w.isWideBetween(a, b)) this.inv.wide++;
      w.setEdge(a, b, 0);
      this.cleanFeatures([a, b]);
      this.cleanPortals([a, b]);
      this.validateCars();
      this.events.push({ type: 'erase' });
      return { ok: true };
    }

    placeFeature(n, kind) {
      const w = this.world;
      if (!this.canEdit()) return { ok: false, reason: 'state' };
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
        if (w.water[n] || w.bld[n] || w.ringId[n] || w.island[n] || w.feat[n] || w.portal.has(n) || [0, 1, 2, 3].some((d) => w.tun.has(n * 4 + d))) return 'blocked';
      }
      return null;
    }

    /** Why a mega roundabout whose 8x8 footprint has its top-left corner at `tl` cannot be built ('edge' / 'blocked'), or null. */
    checkMega(tl) {
      const w = this.world;
      if (tl < 0) return 'blocked';
      const col = w.col(tl), row = w.row(tl), S = CFG.MEGA_SIZE;
      if (col < 0 || row < 0 || col + S > w.cols || row + S > w.rows) return 'edge';
      for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
        const n = (row + dy) * w.cols + col + dx;
        if (w.water[n] || w.bld[n] || w.ringId[n] || w.island[n] || w.feat[n] || w.portal.has(n) || [0, 1, 2, 3].some((d) => w.tun.has(n * 4 + d))) return 'blocked';
      }
      return null;
    }

    /** Lay a one-way ring along `ring` (counter-clockwise order) round the nodes in `inner`, clearing whatever ran inside the footprint. */
    buildRing(kind, centre, ring, inner, wide) {
      const w = this.world;
      const all = [...ring, ...inner];
      const inside = new Set(all);
      for (const n of all) {
        for (const d of [1, 2]) { // each adjacent pair once
          const m = w.nbGrid(n, d);
          if (m < 0 || !inside.has(m)) continue;
          const raw = w.rawBetween(n, m);
          if (raw) { if ((raw & 3) === 2) this.inv.hw++; else if (w.isWideBetween(n, m)) this.inv.wide++; w.setEdge(n, m, 0); }
        }
      }
      const id = ++this.bigSeq;
      for (let i = 0; i < ring.length; i++) {
        w.setEdge(ring[i], ring[(i + 1) % ring.length], 1, true, wide);
        w.ringId[ring[i]] = id;
      }
      for (const n of inner) w.island[n] = id;
      this.bigs.set(id, { id, kind, center: centre, nodes: ring, inner });
      this.validateCars();
      this.events.push({ type: 'place', node: centre });
    }

    placeBig(c) {
      const w = this.world;
      if (!this.canEdit()) return { ok: false, reason: 'state' };
      const bad = this.checkBig(c);
      if (bad) return { ok: false, reason: bad };
      if (this.inv.big <= 0) return { ok: false, reason: 'none' };
      const col = w.col(c), row = w.row(c);
      const OFFS = [[1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0]]; // NE N NW W SW S SE E
      const ring = OFFS.map((o) => (row + o[1]) * w.cols + col + o[0]);
      this.inv.big--;
      this.buildRing('big', c, ring, [c], false);
      return { ok: true };
    }

    /** The 8x8 mega roundabout (超大四線道圓環): a one-way ring of four-lane road, 28 nodes, round a 6x6 lawn. `tl` = top-left node. */
    /** The top-left node of the 8x8 footprint for a click on `n` (nudged inward so it always fits on the board). */
    megaAnchor(n) {
      const w = this.world, S = CFG.MEGA_SIZE;
      const col = Math.max(0, Math.min(w.cols - S, w.col(n) - 3)), row = Math.max(0, Math.min(w.rows - S, w.row(n) - 3));
      return row * w.cols + col;
    }

    placeMega(tl) {
      const w = this.world;
      if (!this.canEdit()) return { ok: false, reason: 'state' };
      const bad = this.checkMega(tl);
      if (bad) return { ok: false, reason: bad };
      if (this.inv.mega <= 0) return { ok: false, reason: 'none' };
      const col = w.col(tl), row = w.row(tl), S = CFG.MEGA_SIZE, at = (dx, dy) => (row + dy) * w.cols + col + dx;
      const ring = [];
      for (let dx = S - 1; dx >= 0; dx--) ring.push(at(dx, 0)); // along the top, east to west (counter-clockwise seen from above)
      for (let dy = 1; dy < S; dy++) ring.push(at(0, dy)); // down the west side
      for (let dx = 1; dx < S; dx++) ring.push(at(dx, S - 1)); // along the bottom, west to east
      for (let dy = S - 2; dy >= 1; dy--) ring.push(at(S - 1, dy)); // up the east side
      const inner = [];
      for (let dy = 1; dy < S - 1; dy++) for (let dx = 1; dx < S - 1; dx++) inner.push(at(dx, dy));
      this.inv.mega--;
      this.buildRing('mega', tl, ring, inner, true);
      return { ok: true };
    }

    removeBig(id) {
      const w = this.world;
      const b = this.bigs.get(id);
      if (!b || !this.canEdit()) return false;
      for (let i = 0; i < b.nodes.length; i++) {
        w.setEdge(b.nodes[i], b.nodes[(i + 1) % b.nodes.length], 0);
        w.ringId[b.nodes[i]] = 0;
      }
      for (const n of b.inner) w.island[n] = 0;
      this.bigs.delete(id);
      this.inv[b.kind]++;
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
      for (const n of [a, b]) if (w.water[n] || w.bld[n] || w.ringId[n] || w.island[n] || w.portal.has(n)) return 'portal';
      if (w.incident(a, d) || w.incident(b, (d + 2) & 3)) return 'busy';
      return null;
    }

    addTunnel(a, b) {
      const w = this.world;
      if (!this.canEdit()) return { ok: false, reason: 'state' };
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
      if (!t || !this.canEdit()) return false;
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

    // ---- teleport portals: a two-way pair. Cars that drive into either portal (the end of a road) come out of the other one (the
    //      end of another road), wherever it is. Both sit on the dead end of a road; the pair is a free jump edge in the route graph.
    /** Why a portal cannot go on n ('node' / 'notend' / 'taken'), or null if it can. */
    checkPortal(n) {
      const w = this.world;
      if (n < 0 || n >= w.n || w.water[n] || w.bld[n] || w.feat[n] || w.ringId[n] || w.island[n]) return 'node';
      if (w.portal.has(n)) return 'taken';
      if (w.deg(n) !== 1 || [0, 1, 2, 3].some((d) => w.tun.has(n * 4 + d))) return 'notend';
      return null;
    }

    /** Style of the next pair that will be placed ('blue' = Diablo-style portal, 'door' = Doraemon's anywhere door), or null. */
    nextPortalStyle() { return this.portalQueue.length ? this.portalQueue[0] : null; }

    addPortal(a, b) {
      const w = this.world;
      if (!this.canEdit()) return { ok: false, reason: 'state' };
      if (a === b) return { ok: false, reason: 'same' };
      const bad = this.checkPortal(a) || this.checkPortal(b);
      if (bad) return { ok: false, reason: bad };
      if (this.inv.tp <= 0 || !this.portalQueue.length) return { ok: false, reason: 'none' };
      const style = this.portalQueue.shift();
      this.inv.tp--;
      const id = ++this.portalSeq;
      w.portal.set(a, { id, style, mate: b });
      w.portal.set(b, { id, style, mate: a });
      w.tp.set(a, b);
      w.tp.set(b, a);
      this.events.push({ type: 'place', node: a });
      this.events.push({ type: 'place', node: b });
      return { ok: true };
    }

    /** Remove the pair that has a portal at n (the pair goes back into stock). */
    removePortal(n) {
      const w = this.world;
      const p = w.portal.get(n);
      if (!p || !this.canEdit()) return false;
      w.tp.delete(n);
      w.tp.delete(p.mate);
      w.portal.delete(n);
      w.portal.delete(p.mate);
      this.portalQueue.unshift(p.style);
      this.inv.tp++;
      this.validateCars();
      this.events.push({ type: 'erase' });
      return true;
    }

    /** A portal needs the single road it sits at the end of: drop pairs whose end lost it (or got a second road). */
    cleanPortals(nodes) {
      const w = this.world;
      for (const n of nodes) if (w.portal.has(n) && w.deg(n) !== 1) this.removePortal(n);
    }

    /** Hand out the pairs earned so far: one per CFG.PORTAL_EVERY delivered cars, alternating the two looks. */
    grantPortals() {
      while (this.portalsGiven < Math.floor(this.score / CFG.PORTAL_EVERY)) {
        const style = this.portalsGiven % 2 === 0 ? 'blue' : 'door';
        this.portalsGiven++;
        this.portalQueue.push(style);
        this.inv.tp++;
        this.events.push({ type: 'portalgift', style });
      }
    }

    // ---- 天神之手: lift a house or destination and put it down somewhere else
    /** Why the building on `from` cannot be moved to `to` ('none' / 'nobld' / 'spot' / 'near'), or null if it can. */
    checkMove(from, to) {
      const w = this.world;
      if (this.inv.hand <= 0) return 'none';
      if (from < 0 || !w.bld[from]) return 'nobld';
      if (to < 0 || to >= w.n || to === from) return 'spot';
      if (w.water[to] || w.bld[to] || w.feat[to] || w.island[to] || w.ringId[to] || w.portal.has(to) || w.deg(to) > 0) return 'spot';
      const c = w.col(to), r = w.row(to);
      for (const b of this.buildings) {
        if (b.node === from) continue;
        if (Math.abs(w.col(b.node) - c) + Math.abs(w.row(b.node) - r) < 2) return 'near';
      }
      return null;
    }

    /** Move the building on `from` to the empty node `to` (roads stay where they are, so it has to be wired up again). */
    moveBuilding(from, to) {
      const w = this.world;
      if (!this.canEdit()) return { ok: false, reason: 'state' };
      const bad = this.checkMove(from, to);
      if (bad) return { ok: false, reason: bad };
      const b = w.bld[from];
      for (const car of this.cars) if (!car.dead && car.dest === b) this.killCar(car, true); // cars heading for a destination that just left
      w.bld[from] = null;
      b.node = to;
      w.bld[to] = b;
      this.cleanFeatures([from]);
      this.validateCars();
      this.events.push({ type: 'move', from, node: to, color: b.color });
      return { ok: true };
    }

    // ---- 超級原子彈: wipe every road off the map in one go
    /** True if there is any road, tunnel or big roundabout to erase. */
    hasRoads() {
      const w = this.world;
      if (w.tun.size || this.bigs.size) return true;
      for (let n = 0; n < w.n; n++) if (w.eE[n] || w.eS[n]) return true;
      return false;
    }

    /** Erase all roads (and everything that sits on them). Highways, four-lane roads, lights, tunnels and portals go back to stock. */
    nuke() {
      const w = this.world;
      if (!this.canEdit()) return { ok: false, reason: 'state' };
      if (this.inv.nuke <= 0) return { ok: false, reason: 'none' };
      if (!this.hasRoads()) return { ok: false, reason: 'empty' };
      this.inv.nuke--;
      for (const n of [...w.portal.keys()]) this.removePortal(n);
      while (w.tun.size) { const key = w.tun.keys().next().value; this.removeTunnel(key >> 2, key & 3); }
      for (const id of [...this.bigs.keys()]) this.removeBig(id);
      for (let n = 0; n < w.n; n++) if (w.feat[n]) this.removeFeature(n);
      let edges = 0;
      for (let n = 0; n < w.n; n++) {
        for (const d of [1, 2]) {
          const m = w.nbGrid(n, d);
          const raw = w.rawE(n, d);
          if (!raw || m < 0) continue;
          if ((raw & 3) === 2) this.inv.hw++;
          else if (w.isWideDir(n, d)) this.inv.wide++;
          w.setEdge(n, m, 0);
          edges++;
        }
      }
      this.validateCars(); // every car is now off the road network: its trip goes back to its house
      this.events.push({ type: 'nuke', edges });
      return { ok: true, edges };
    }

    // ------------------------------------------------------------ routing
    edgeCost(u, d, v) {
      const w = this.world;
      const t = w.edge(u, d);
      const len = t === 3 ? w.tun.get(u * 4 + d).len : 1;
      let c = len / (t === 2 ? CFG.HW_MULT : t === 3 ? CFG.TUN_MULT : 1);
      c += (0.3 * this.laneLoad[u * 4 + d]) / this.slotsOf(u * 4 + d);
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
        const x = w.tp.get(u); // a portal: jump to its other end (the car leaves it with no fixed heading)
        if (x !== undefined) {
          const ns = x * 5 + 4;
          const nd = du + CFG.PORTAL_COST;
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

    /** Number of lane slots (cars side by side) on a lane: 4 on a one-way four-lane road, 2 on a two-way one, else 1. */
    slotsOf(lane) {
      const w = this.world;
      if (!w.isWideDir(lane >> 2, lane & 3) || w.tun.has(lane)) return 1;
      return w.rawE(lane >> 2, lane & 3) >> 2 ? 4 : 2;
    }

    /** Following gap (cells) between two cars in the same slot of this lane. */
    gapOf(lane) { return CFG.GAP * (this.slotsOf(lane) > 1 ? CFG.WIDE_GAP : 1); }

    /** Distance (cells) past the junction at which a car on this lane frees the junction lock. */
    relOf(lane) { return CFG.RELEASE / (this.slotsOf(lane) > 1 ? CFG.WIDE_GAP : 1); }

    /** True if no car (in `slot`, or in any slot when omitted) is within `needCells` of the start of the lane. */
    laneClear(lane, needCells, slot) {
      const l = this.lanes.get(lane);
      if (!l) return true;
      const need = (needCells * (this.slotsOf(lane) > 1 ? CFG.WIDE_GAP : 1)) / this.lenOf(lane);
      for (const o of l) if (!o.dead && o.lane === lane && (slot == null || (o.slot | 0) === slot) && o.s < need) return false;
      return true;
    }

    /** The slot a car should take on lane `nl` (0 on ordinary roads): the emptier one, preferring the side it will turn to. */
    pickSlot(car, nl) {
      const S = this.slotsOf(nl);
      if (S < 2) return 0;
      const cnt = [];
      for (let k = 0; k < S; k++) cnt.push(this.reservedSlot[nl * 4 + k]);
      const l = this.lanes.get(nl);
      if (l) for (const o of l) if (!o.dead && o.lane === nl && (o.slot | 0) < S) cnt[o.slot | 0]++;
      const low = Math.min(...cnt);
      // the emptiest lanes are the candidates; among them take the one nearest to the side the car is going to turn to
      let want = Math.min(S - 1, car.slot | 0);
      const w = this.world, p = car.path;
      const b = nl >> 2, i = p.indexOf(b, car.i);
      if (i >= 0 && p[i + 2] !== undefined && w.tp.get(p[i + 1]) !== p[i + 2]) {
        const turn = (w.dirOf(p[i + 1], p[i + 2]) - w.dirOf(b, p[i + 1]) + 4) & 3; // 1 = right turn, 3 = left turn
        if (turn === 1) want = S - 1; // the outer (kerb) lane
        else if (turn === 3) want = 0; // the inner lane
      }
      let best = -1;
      for (let k = 0; k < S; k++) if (cnt[k] === low && (best < 0 || Math.abs(k - want) < Math.abs(best - want))) best = k;
      return best;
    }

    dispatch(h) {
      const w = this.world;
      if (!h.queue.length) return false;
      // a trip belongs to its destination: one that cannot be reached stays in the queue (its pins keep piling up there and
      // eventually overflow), while the house carries on with the trips that can be driven
      let trip = null, path = null, at = -1;
      const tried = new Set();
      for (let i = 0; i < h.queue.length && !path; i++) {
        const t = h.queue[i];
        if (tried.has(t)) continue;
        tried.add(t);
        const p = this.route(h.node, t.node, -1);
        if (p) { trip = t; path = p; at = h.queue.indexOf(t); }
      }
      if (!path) return false;
      const lane = h.node * 4 + w.dirOf(h.node, path[1]);
      if (!this.laneClear(lane, CFG.GAP * 1.4)) return false;
      h.queue.splice(at, 1);
      const id = this.nextId++;
      const car = { id, weight: this.isSport(id) ? CFG.SPORT_WEIGHT : 1, color: h.color, path, i: 0, s: 0, lane, dest: trip, house: h, held: -1, resLane: -1, resSlot: -1, slot: 0, nslot: 0, nslotFor: -1, pslot: 0, dead: false, stamp: -1, idle: 0, v: 0 };
      trip.inbound++;
      this.cars.push(car);
      let l = this.lanes.get(lane);
      if (!l) this.lanes.set(lane, (l = []));
      l.push(car);
      return true;
    }

    /** Whether the car with this id is a sports car. Picked from the id (not from the random stream), so it never disturbs anything else. */
    isSport(id) { return ((Math.imul(id, 2654435761) >>> 0) % 100) < CFG.SPORT_PERCENT; }

    /** A sports car counts for several cars: cancel up to `k` trips that are still waiting for this destination (own house first). */
    offsetTrips(dest, k) {
      let n = Math.min(k, Math.max(0, dest.pins - (dest.inbound || 0)));
      let done = 0;
      const same = this.houses.filter((h) => h.color === dest.color);
      for (const h of same) {
        for (let i = h.queue.length - 1; i >= 0 && n > 0; i--) if (h.queue[i] === dest) { h.queue.splice(i, 1); n--; done++; }
      }
      dest.pins = Math.max(0, dest.pins - done);
      return done;
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
      // Box-junction rule with reservations: the exit lane must have a free place for this car (cars already in it plus cars
      // that hold a lock and are about to enter). Each slot of the lane is checked on its own. A lane that ends in a
      // controlled junction queues at the stop line, so it has room for fewer cars if a lock holder is still to be able to
      // reach the release point.
      const nl = b * 4 + w.dirOf(b, c);
      const slots = this.slotsOf(nl);
      const controlled = car.path[car.i + 3] !== undefined && w.isJunction(c);
      // queue positions (cells from the lane start): the first car waits at p1, the next ones every gap behind it, and the
      // last car must still leave room for a lock holder to reach the release point
      const p1 = this.lenOf(nl) - (controlled ? 1 - CFG.STOP : 0);
      // m cars ahead wait at p1, p1-gap, ...; the entering car stops at p1 - m*gap and must still be past the release point
      const capSlot = Math.floor((p1 - this.relOf(nl)) / this.gapOf(nl) + 1e-9) + 1;
      const cnt = [];
      for (let k = 0; k < slots; k++) cnt.push(this.reservedSlot[nl * 4 + k]);
      const lst = this.lanes.get(nl);
      if (lst) for (const o of lst) if (!o.dead && o.lane === nl && (o.slot | 0) < slots) cnt[o.slot | 0]++;
      const first = this.pickSlot(car, nl);
      let slot = -1;
      for (let k = 0; k < slots && slot < 0; k++) { const s2 = (first + k) % slots; if (cnt[s2] + 1 <= capSlot) slot = s2; }
      if (slot < 0) return false;
      const f = w.feat[b];
      if (f === 1) {
        const L = this.lights.get(b);
        if (L && (L.pending || L.green !== (w.dirOf(a, b) & 1))) return false;
      } else if (f === 2 || w.ringId[b]) {
        if (this.holders[b] >= 2) return false;
      } else if (w.hasWide(b)) {
        // a junction with a four-lane road passes two cars at a time, but not closer together than WIDE_HEADWAY
        if (this.holders[b] >= 2 || (this.holders[b] >= 1 && this.time - this.lastEntry[b] < CFG.WIDE_HEADWAY)) return false;
      } else if (this.holders[b] >= 1) {
        return false;
      }
      this.lastEntry[b] = this.time;
      this.holders[b]++;
      this.reserved[nl]++;
      this.reservedSlot[nl * 4 + slot]++;
      car.resLane = nl;
      car.resSlot = slot;
      car.nslot = slot;
      car.nslotFor = nl;
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
      if (car.resLane >= 0) {
        this.reserved[car.resLane]--;
        this.reservedSlot[car.resLane * 4 + (car.resSlot | 0)]--;
        car.resLane = -1;
        car.resSlot = -1;
      }
    }

    stepCar(car, list, k, dt) {
      const w = this.world;
      car.stamp = this.tick;
      const p = car.path;
      const i = car.i;
      const a = p[i], b = p[i + 1];
      const last = i + 1 === p.length - 1;
      const hop = !last && p[i + 3] !== undefined && w.tp.get(b) === p[i + 2]; // the lane ends in a portal entrance
      const len = this.lenOf(car.lane); // lane length in cells; s runs 0..1 along it
      const wideLane = this.slotsOf(car.lane) > 1;
      const gapS = this.gapOf(car.lane) / len;
      let maxS = 1;
      for (let j = k - 1; j >= 0; j--) {
        const o = list[j];
        if (o.dead || o.lane !== car.lane) continue;
        if (wideLane && (o.slot | 0) !== (car.slot | 0)) continue; // cars in the other lane of a four-lane road do not block
        maxS = Math.min(maxS, o.s - gapS);
        break;
      }
      if (!last && !hop && car.nslotFor !== b * 4 + w.dirOf(b, p[i + 2])) { // choose the slot for the next lane (the junction may overrule it)
        const nl0 = b * 4 + w.dirOf(b, p[i + 2]);
        car.nslot = this.pickSlot(car, nl0);
        car.nslotFor = nl0;
      }
      if (!last && !hop && car.held !== b && w.isJunction(b)) {
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
      if (car.held >= 0 && car.held === a && car.s >= this.relOf(car.lane) / len) { this.holders[car.held]--; car.held = -1; }
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
        if (hop) { // through the portal: reappear at the start of the lane leaving the exit
          const x = p[i + 2], q = p[i + 3];
          const xl = x * 4 + w.dirOf(x, q);
          if (!this.laneClear(xl, CFG.GAP * 1.1)) { car.s = 1; return; }
          car.pslot = car.slot | 0;
          car.slot = 0;
          car.nslotFor = -1;
          car.i += 2;
          car.s = 0;
          car.lane = xl;
          car.hopAt = this.time;
          let l = this.lanes.get(xl);
          if (!l) this.lanes.set(xl, (l = []));
          l.push(car);
          this.events.push({ type: 'teleport', from: b, to: x });
          const nxt = car.path[car.i + 1];
          if (car.i + 1 < car.path.length - 1 && w.isJunction(nxt)) this.replan(car);
          return;
        }
        const c = p[i + 2];
        const nl = b * 4 + w.dirOf(b, c);
        let ns = car.nslotFor === nl ? car.nslot | 0 : 0;
        if (!this.laneClear(nl, CFG.GAP * 1.1, ns)) {
          // blocked in the chosen lane of a four-lane road: use the other one if it is free and nothing was promised to us
          let alt = -1;
          if (this.slotsOf(nl) > 1 && car.resLane !== nl) {
            for (let k = 0; k < this.slotsOf(nl); k++) if (k !== ns && this.laneClear(nl, CFG.GAP * 1.1, k) && (alt < 0 || Math.abs(k - ns) < Math.abs(alt - ns))) alt = k;
          }
          if (alt >= 0) ns = alt;
          else { car.s = 1; return; }
        }
        car.pslot = car.slot | 0;
        car.slot = ns;
        car.nslotFor = -1;
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
      const weight = car.weight || 1;
      if (weight > 1) this.offsetTrips(car.dest, weight - 1); // a sports car stands in for the other cars it is worth
      this.score += weight;
      this.grantPortals();
      this.events.push({ type: 'deliver', color: car.color, node: car.dest.node, weight });
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
      const shielded = this.blessed || this.time < this.invincibleUntil;
      // the mayor's order has run out: if some destination is still choked, the city is lost for good
      if (this.mayorActive && !shielded) {
        this.mayorActive = false;
        const d = this.dests.find((x) => x.overflow >= 1);
        if (d) { this.gameOver(d, true); return; }
        this.events.push({ type: 'mayorend' });
      }
      for (const d of this.dests) {
        if (d.pins - d.inbound >= CFG.PIN_LIMIT) d.overflow += dt / CFG.OVERFLOW_TIME;
        else d.overflow = Math.max(0, d.overflow - dt / 7);
        if (d.overflow >= 1) {
          d.overflow = 1;
          if (!shielded) { this.collapse(d); return; }
        }
      }

      // end of week
      if (this.weekTime >= CFG.WEEK_SECONDS) this.advanceWeek();
    }

    advanceWeek() {
      this.week++;
      this.weekTime -= CFG.WEEK_SECONDS;
      if (this.blessed && this.inv.nuke < 1) { // Kayray hands out the next 超級原子彈 once the last one is used up
        this.inv.nuke = 1;
        this.events.push({ type: 'nukegift' });
      }
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

    /** Editing roads is allowed while running and during the mayor's order (time is frozen then). */
    canEdit() { return this.state === 'running' || this.state === 'mayor'; }

    /** The roads are choked: the player may use the mayor's order (once per game) or give up. */
    collapse(dest) {
      // the mayor's order is a one-time second chance: once it has been used, the next collapse is the real end
      // (the player can still restart, or summon Kayray's blessing)
      if (this.mayorUses > 0) { this.gameOver(dest, true); return; }
      this.state = 'collapse';
      this.over = { dest, final: false };
      this.events.push({ type: 'gameover', node: dest.node });
    }

    /** 市長的命令: freeze the clock so the roads can be rebuilt. */
    mayorOrder() {
      if (this.state !== 'collapse') return false;
      this.state = 'mayor';
      this.mayorUses++;
      this.over = null;
      this.events.push({ type: 'mayor' });
      return true;
    }

    /** The rebuild is done: time runs again and the city cannot collapse for CFG.MAYOR_SECONDS. */
    finishMayor() {
      if (this.state !== 'mayor') return false;
      this.state = 'running';
      this.invincibleUntil = this.time + CFG.MAYOR_SECONDS;
      this.mayorActive = true;
      this.events.push({ type: 'mayorgo' });
      return true;
    }

    /** 召喚 Kayray 的祝福: after the final failure, the city becomes invincible until the player restarts. */
    kayrayBlessing() {
      if (this.state !== 'over' || !this.over || !this.over.final) return false;
      this.state = 'running';
      this.blessed = true;
      this.mayorActive = false;
      this.over = null;
      this.inv.nuke = 1; // the blessing comes with a 超級原子彈 (one at a time: see advanceWeek)
      this.inv.mega += 3; // ... three 超大圓環
      this.inv.hand = 1; // ... and the 天神之手 (not used up: 1 means "owned")
      this.events.push({ type: 'kayray' });
      return true;
    }

    /** Seconds of invincibility left (0 when not shielded). */
    shieldLeft() { return this.mayorActive ? Math.max(0, this.invincibleUntil - this.time) : 0; }

    /** Give up (or fail the mayor's window): the game is over. `final` = the mayor's second chance was not enough. */
    gameOver(dest, final) {
      this.state = 'over';
      this.over = { dest, final: !!final };
      this.events.push({ type: 'gameover', node: dest.node });
    }

    dayIndex() { return Math.min(6, Math.floor((this.weekTime / CFG.WEEK_SECONDS) * 7)); }
  }

  MM.Game = Game;
})(typeof window !== 'undefined' ? window : globalThis);
