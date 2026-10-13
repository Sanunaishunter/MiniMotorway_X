/* Mini Motorway X — decorative traffic police patrol cars.
 * They only exist for show: they are NOT part of the simulation (no lanes, locks or routing), use their own random numbers and
 * never touch `Game`; they just wander along the existing roads with their red / blue lights flashing. */
(function (root) {
  'use strict';
  const MM = root.MM;
  const C = MM.CFG.CELL;
  const SPEED = 1.5; // cells per second
  const MAX_COPS = 3;

  class Police {
    constructor(world, seed) {
      this.world = world;
      this.rand = MM.mulberry32((seed | 0) ^ 0x5eed1e5);
      this.cops = [];
      this.nextId = 1;
      this.spawnTimer = 4 + this.rand() * 6; // the first patrol shows up a few seconds in
      this.edgeTimer = 0;
      this.edges = 0;
    }

    /** Patrol cars wanted for the current road network: none without roads, one per ~8 road segments, up to MAX_COPS. */
    wanted() { return Math.min(MAX_COPS, Math.floor(this.edges / 8)); }

    countEdges() {
      const w = this.world;
      let k = 0;
      for (let i = 0; i < w.n; i++) { if (w.eE[i]) k++; if (w.eS[i]) k++; }
      this.edges = k;
    }

    /** Directions a patrol car standing on node n may drive off in: plain surface roads (no tunnels), not into a building. */
    options(n, avoidBack, allowBuilding) {
      const w = this.world;
      const out = [];
      for (let d = 0; d < 4; d++) {
        if (d === avoidBack) continue;
        const e = w.edge(n, d);
        if (e !== 1 && e !== 2) continue; // 3 = tunnel
        const m = w.nbGrid(n, d);
        if (m < 0) continue;
        if (w.bld[m] && !allowBuilding) continue;
        out.push(d);
      }
      return out;
    }

    spawn() {
      const w = this.world;
      const spots = [];
      for (let n = 0; n < w.n; n++) {
        if (w.bld[n] || w.water[n]) continue;
        if (this.options(n, -1, false).length) spots.push(n);
      }
      if (!spots.length) return null;
      const n = spots[Math.floor(this.rand() * spots.length)];
      const opts = this.options(n, -1, false);
      const d = opts[Math.floor(this.rand() * opts.length)];
      const cop = {
        id: this.nextId++,
        a: n, d, s: 0, // on the edge from node a in direction d, s in [0, 1)
        life: 50 + this.rand() * 60,
        alpha: 0, dying: false,
        x: 0, y: 0, ang: 0,
      };
      this.place(cop, true);
      this.cops.push(cop);
      return cop;
    }

    /** Target pose of a cop (right-hand lane); `snap` also moves the displayed pose there at once. */
    place(cop, snap, dt) {
      const w = this.world, cols = w.cols;
      const ax = ((cop.a % cols) + 0.5) * C, ay = (((cop.a / cols) | 0) + 0.5) * C;
      const dx = MM.DX[cop.d], dy = MM.DY[cop.d];
      const off = w.isWideDir(cop.a, cop.d) ? 12 : 4;
      const tx = ax + dx * cop.s * C - dy * off;
      const ty = ay + dy * cop.s * C + dx * off;
      const ta = Math.atan2(dy, dx);
      if (snap) { cop.x = tx; cop.y = ty; cop.ang = ta; return; }
      // ease the displayed pose toward the target so turns and U-turns look smooth
      const k = 1 - Math.exp(-dt * 12);
      cop.x += (tx - cop.x) * k;
      cop.y += (ty - cop.y) * k;
      let da = ta - cop.ang;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      cop.ang += da * (1 - Math.exp(-dt * 9));
    }

    /** Pick where to go next when a cop arrives at node n having come in heading `d`. Returns a direction or -1 (nowhere to go). */
    choose(n, d) {
      const w = this.world;
      const back = (d + 2) & 3;
      if (w.feat[n] === 3) { // overpass: straight on only
        const e = w.edge(n, d);
        return (e === 1 || e === 2) ? d : -1;
      }
      const opts = this.options(n, back, false);
      if (opts.length) {
        if (opts.includes(d) && this.rand() < 0.62) return d;
        return opts[Math.floor(this.rand() * opts.length)];
      }
      const e = w.edge(n, back); // dead end (or a building): turn around if the road allows it
      return (e === 1 || e === 2) ? back : -1;
    }

    update(dt) {
      const w = this.world;
      this.edgeTimer -= dt;
      if (this.edgeTimer <= 0) { this.countEdges(); this.edgeTimer = 2; }

      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = 6 + this.rand() * 10;
        if (this.cops.filter((c) => !c.dying).length < this.wanted()) this.spawn();
      }

      for (const cop of this.cops) {
        cop.life -= dt;
        if (cop.life <= 0) cop.dying = true;
        if (cop.dying) cop.alpha -= dt * 1.4;
        else cop.alpha = Math.min(1, cop.alpha + dt * 1.4);
        // the road under the car was erased: fade out where it stands
        const e = w.edge(cop.a, cop.d);
        if (e !== 1 && e !== 2) { cop.dying = true; }
        else if (!cop.dying) {
          cop.s += SPEED * dt;
          let guard = 4;
          while (cop.s >= 1 && guard-- > 0) {
            const b = w.nbGrid(cop.a, cop.d);
            const nd = b < 0 ? -1 : this.choose(b, cop.d);
            if (nd < 0) { cop.dying = true; cop.s = 1; break; }
            cop.s -= 1;
            cop.a = b;
            cop.d = nd;
          }
        }
        this.place(cop, false, dt);
      }
      this.cops = this.cops.filter((c) => !(c.dying && c.alpha <= 0));
    }
  }

  MM.Police = Police;
})(typeof window !== 'undefined' ? window : globalThis);
