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
    GAP: 0.3, // minimum following gap (in cells)
    STOP: 0.62, // stop line position before a controlled intersection
    RELEASE: 0.3, // a car frees the intersection lock once this far past the junction
    TOW_HOLDER: 20, // seconds a lock-holding car may be stuck before it is towed (deadlock breaker)
    TOW_ANY: 120, // seconds any car may be stuck before it is towed
    PIN_LIMIT: 7, // pins at a destination before the overflow timer starts
    OVERFLOW_TIME: 16, // seconds the overflow meter needs to fill
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
      this.eE = new Uint8Array(n); // edge  n -> n+1     (0 none, 1 road, 2 highway)
      this.eS = new Uint8Array(n); // edge  n -> n+cols
      this.feat = new Uint8Array(n); // 0 none, 1 traffic light, 2 roundabout
      this.bld = new Array(n).fill(null);
      this.comp = new Int16Array(n);
      this.mainComp = 0;
      this.genWater();
      this.labelComponents();
    }

    col(n) { return n % this.cols; }
    row(n) { return (n / this.cols) | 0; }

    nb(n, d) {
      const c = n % this.cols;
      const r = (n / this.cols) | 0;
      switch (d) {
        case 0: return r > 0 ? n - this.cols : -1;
        case 1: return c < this.cols - 1 ? n + 1 : -1;
        case 2: return r < this.rows - 1 ? n + this.cols : -1;
        default: return c > 0 ? n - 1 : -1;
      }
    }

    // direction from a to adjacent b (assumes they are adjacent)
    dirOf(a, b) {
      const d = b - a;
      if (d === 1) return 1;
      if (d === -1) return 3;
      if (d === this.cols) return 2;
      if (d === -this.cols) return 0;
      return -1;
    }

    adjacent(a, b) {
      if (a === b || a < 0 || b < 0 || a >= this.n || b >= this.n) return false;
      const d = this.dirOf(a, b);
      return d >= 0 && this.nb(a, d) === b;
    }

    edge(n, d) {
      switch (d) {
        case 1: return this.eE[n];
        case 2: return this.eS[n];
        case 3: return n % this.cols > 0 ? this.eE[n - 1] : 0;
        default: return n >= this.cols ? this.eS[n - this.cols] : 0;
      }
    }

    edgeBetween(a, b) {
      const d = this.dirOf(a, b);
      return d < 0 ? 0 : this.edge(a, d);
    }

    setEdge(a, b, v) {
      const d = this.dirOf(a, b);
      switch (d) {
        case 1: this.eE[a] = v; break;
        case 2: this.eS[a] = v; break;
        case 3: this.eE[b] = v; break;
        case 0: this.eS[b] = v; break;
      }
    }

    deg(n) {
      let k = 0;
      if (this.edge(n, 0)) k++;
      if (this.edge(n, 1)) k++;
      if (this.edge(n, 2)) k++;
      if (this.edge(n, 3)) k++;
      return k;
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
            const v = this.nb(u, d);
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
