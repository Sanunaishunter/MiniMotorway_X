/* Mini Motorway X — core: constants, seeded RNG, world grid (water / road edges / features) */
(function (root) {
  'use strict';
  const MM = (root.MM = root.MM || {});

  MM.CFG = {
    CELL: 40, // world units per grid cell (nodes sit at cell centres)
    WEEK_SECONDS: 75, // length of one "week"
    SPEED: 1.7, // cells per second on a normal road
    ACCEL: 6, // cells / s^2
    HW_MULT: 2.1, // highway speed multiplier
    TUN_MULT: 1.5, // tunnel speed multiplier
    FLY_SPEED: 5, // 起飛啦: cells per second of a flying car (straight line to its destination)
    FLY_MIN: 0.9, // shortest flight, in seconds (so a short hop is still visible)
    WIDE_GAP: 1.18, // following-gap multiplier on a four-lane road: 2 lanes / 1.18 = about 1.7x the flow of a two-lane road
    WIDE_HEADWAY: 0.28, // seconds between cars entering a junction that touches a four-lane road while another car is still inside
    TUNNEL_MIN: 2, // shortest / longest tunnel, in cells between its two portals
    TUNNEL_MAX: 6,
    GAP: 0.3, // minimum following gap (in cells)
    STOP: 0.62, // stop line position before a controlled intersection
    RELEASE: 0.3, // a car frees the intersection lock once this far past the junction
    TOW_HOLDER: 20, // seconds a lock-holding car may be stuck before it is towed (deadlock breaker)
    TOW_ANY: 120, // seconds any car may be stuck before it is towed
    PIN_LIMIT: 7, // pins at a destination before the overflow timer starts
    OVERFLOW_TIME: 16, // seconds the overflow meter needs to fill
    MAYOR_SECONDS: 300, // 市長的命令: how long (game seconds, 5 minutes) the city is invincible once the roads have been rebuilt
    DAY_SECONDS: 150, // length of one day / night cycle in the 晝夜交替 mode (game seconds, two weeks)
    LIGHT_PERIOD: 3.6,
    LIGHT_MIN_GREEN: 1.2,
    MAX_COLORS: 6,
  };

  // Directions: 0 = N, 1 = E, 2 = S, 3 = W
  MM.DX = [0, 1, 0, -1];
  MM.DY = [-1, 0, 1, 0];

  MM.COLORS = [
    { name: '藍', main: '#4c8dff', dark: '#2c5fc4' },
    { name: '紅', main: '#ff5f6d', dark: '#c23a49' },
    { name: '黃', main: '#ffc233', dark: '#c99410' },
    { name: '綠', main: '#35c48c', dark: '#1d9468' },
    { name: '紫', main: '#a273ff', dark: '#6f45cc' },
    { name: '橘', main: '#ff8a3d', dark: '#c85f18' },
  ];

  MM.mulberry32 = function (a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  class World {
    constructor(cols, rows, rand) {
      this.cols = cols;
      this.rows = rows;
      this.n = cols * rows;
      this.rand = rand;
      const n = this.n;
      this.water = new Uint8Array(n);
      // Surface road edges. Raw value = type | (oneWay << 2): type 0 none / 1 road / 2 highway;
      // oneWay 0 both directions, 1 only toward the higher node index, 2 only toward the lower.
      this.eE = new Uint8Array(n); // edge  n -> n+1
      this.eS = new Uint8Array(n); // edge  n -> n+cols
      this.eEw = new Uint8Array(n); // 1 = the road edge n -> n+1 has four lanes (two per direction)
      this.eSw = new Uint8Array(n); // 1 = the road edge n -> n+cols has four lanes
      this.tun = new Map(); // tunnels: lane id (node*4+dir) -> {to, len}; stored for both ends
      this.feat = new Uint8Array(n); // 0 none, 1 traffic light, 2 roundabout, 3 overpass
      this.ringId = new Int16Array(n); // big roundabout the node is part of (id+1), else 0
      this.island = new Int16Array(n); // big roundabout whose centre island this is (id+1), else 0
      this.bld = new Array(n).fill(null);
      this.comp = new Int16Array(n);
      this.mainComp = 0;
      this.genWater();
      this.labelComponents();
    }

    col(n) { return n % this.cols; }
    row(n) { return (n / this.cols) | 0; }

    /** Grid neighbour (ignores tunnels). */
    nbGrid(n, d) {
      const c = n % this.cols;
      const r = (n / this.cols) | 0;
      switch (d) {
        case 0: return r > 0 ? n - this.cols : -1;
        case 1: return c < this.cols - 1 ? n + 1 : -1;
        case 2: return r < this.rows - 1 ? n + this.cols : -1;
        default: return c > 0 ? n - 1 : -1;
      }
    }

    /** Graph neighbour: the far portal when a tunnel leaves `n` in direction `d`, else the grid neighbour. */
    nb(n, d) {
      const t = this.tun.get(n * 4 + d);
      return t ? t.to : this.nbGrid(n, d);
    }

    /** Direction from a to b when they share a row or column (any distance), else -1. */
    dirOf(a, b) {
      const ca = a % this.cols, cb = b % this.cols;
      const ra = (a / this.cols) | 0, rb = (b / this.cols) | 0;
      if (ra === rb && ca !== cb) return cb > ca ? 1 : 3;
      if (ca === cb && ra !== rb) return rb > ra ? 2 : 0;
      return -1;
    }

    adjacent(a, b) {
      if (a === b || a < 0 || b < 0 || a >= this.n || b >= this.n) return false;
      const d = this.dirOf(a, b);
      return d >= 0 && this.nbGrid(a, d) === b;
    }

    /** Raw surface edge value at n in direction d, ignoring one-way restrictions. */
    rawE(n, d) {
      switch (d) {
        case 1: return this.eE[n];
        case 2: return this.eS[n];
        case 3: return n % this.cols > 0 ? this.eE[n - 1] : 0;
        default: return n >= this.cols ? this.eS[n - this.cols] : 0;
      }
    }

    /** Type (1 road, 2 highway, 3 tunnel) of the edge a car can take leaving n in direction d, else 0. */
    edge(n, d) {
      if (this.tun.has(n * 4 + d)) return 3;
      const raw = this.rawE(n, d);
      if (!raw) return 0;
      const ow = raw >> 2;
      if (ow === 0) return raw & 3;
      const forward = d === 1 || d === 2;
      return (ow === 1) === forward ? raw & 3 : 0;
    }

    /** True if any road, tunnel or one-way edge touches n in direction d. */
    incident(n, d) {
      return this.tun.has(n * 4 + d) || this.rawE(n, d) > 0;
    }

    /** Traversable edge type from a to its graph neighbour b (a -> b), else 0. */
    edgeBetween(a, b) {
      const d = this.dirOf(a, b);
      if (d < 0 || this.nb(a, d) !== b) return 0;
      return this.edge(a, d);
    }

    /** Raw surface edge value between two adjacent nodes (either direction). */
    rawBetween(a, b) {
      if (!this.adjacent(a, b)) return 0;
      return this.rawE(a, this.dirOf(a, b));
    }

    /** Set (v > 0) or clear (v = 0) the surface edge between adjacent a and b; oneWay = only a -> b; wide = four lanes. */
    setEdge(a, b, v, oneWay, wide) {
      const d = this.dirOf(a, b);
      let raw = v;
      if (v && oneWay) raw |= ((d === 1 || d === 2) ? 1 : 2) << 2;
      const wf = v && wide ? 1 : 0;
      switch (d) {
        case 1: this.eE[a] = raw; this.eEw[a] = wf; break;
        case 2: this.eS[a] = raw; this.eSw[a] = wf; break;
        case 3: this.eE[b] = raw; this.eEw[b] = wf; break;
        case 0: this.eS[b] = raw; this.eSw[b] = wf; break;
      }
    }

    /** True if the surface edge leaving n in direction d is a four-lane road. */
    isWideDir(n, d) {
      switch (d) {
        case 1: return this.eEw[n] === 1;
        case 2: return this.eSw[n] === 1;
        case 3: return n % this.cols > 0 && this.eEw[n - 1] === 1;
        default: return n >= this.cols && this.eSw[n - this.cols] === 1;
      }
    }

    isWideBetween(a, b) { return this.adjacent(a, b) && this.isWideDir(a, this.dirOf(a, b)); }

    /** True if any four-lane road touches n (such a junction is bigger and lets two cars through at once). */
    hasWide(n) {
      return this.isWideDir(n, 0) || this.isWideDir(n, 1) || this.isWideDir(n, 2) || this.isWideDir(n, 3);
    }

    /** Number of road / tunnel edges touching n (either direction). */
    deg(n) {
      let k = 0;
      for (let d = 0; d < 4; d++) if (this.incident(n, d)) k++;
      return k;
    }

    /** A node where cars can turn between roads and have to take turns: 3+ edges, not a building, not an overpass. */
    isJunction(n) {
      return !this.bld[n] && this.feat[n] !== 3 && this.deg(n) >= 3;
    }

    isBridgeEdge(a, b) { return this.water[a] === 1 || this.water[b] === 1; }

    // ---------- terrain ----------
    genWater() {
      const { cols, rows, rand } = this;
      for (let attempt = 0; attempt < 6; attempt++) {
        this.water.fill(0);
        const set = (c, r) => {
          if (c >= 0 && c < cols && r >= 0 && r < rows) this.water[r * cols + c] = 1;
        };
        // a river crossing the map (random walk, always 4-connected)
        if (rand() < 0.9) {
          const horizontal = cols >= rows ? rand() < 0.75 : rand() < 0.25;
          const along = horizontal ? cols : rows;
          const across = horizontal ? rows : cols;
          let p = Math.floor(across * (0.28 + 0.44 * rand()));
          const wide = rand() < 0.22;
          for (let t = 0; t < along; t++) {
            const mark = (q) => (horizontal ? set(t, q) : set(q, t));
            mark(p);
            if (wide) mark(p + 1);
            if (rand() < 0.3) {
              const np = Math.max(2, Math.min(across - 3, p + (rand() < 0.5 ? -1 : 1)));
              p = np;
              mark(p);
              if (wide) mark(p + 1);
            }
          }
        }
        // a few lakes
        const lakes = 1 + Math.floor(rand() * 2);
        for (let k = 0; k < lakes; k++) {
          const cx = cols * (0.15 + 0.7 * rand());
          const cy = rows * (0.15 + 0.7 * rand());
          const rx = 1.3 + rand() * 1.9;
          const ry = 1.1 + rand() * 1.7;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const v = ((c - cx) / rx) ** 2 + ((r - cy) / ry) ** 2;
              if (v < 1 + (rand() * 0.3 - 0.15)) set(c, r);
            }
          }
        }
        let w = 0;
        for (let i = 0; i < this.n; i++) w += this.water[i];
        if (w / this.n < 0.2) break;
      }
    }

    labelComponents() {
      const { n } = this;
      this.comp.fill(-1);
      let id = 0;
      let best = -1;
      let bestSize = -1;
      const sizes = [];
      const stack = [];
      for (let s = 0; s < n; s++) {
        if (this.water[s] || this.comp[s] >= 0) continue;
        let size = 0;
        stack.push(s);
        this.comp[s] = id;
        while (stack.length) {
          const u = stack.pop();
          size++;
          for (let d = 0; d < 4; d++) {
            const v = this.nbGrid(u, d);
            if (v >= 0 && !this.water[v] && this.comp[v] < 0) {
              this.comp[v] = id;
              stack.push(v);
            }
          }
        }
        sizes.push(size);
        if (size > bestSize) { bestSize = size; best = id; }
        id++;
      }
      this.compSize = sizes;
      this.mainComp = best;
    }
  }

  MM.World = World;
})(typeof window !== 'undefined' ? window : globalThis);
