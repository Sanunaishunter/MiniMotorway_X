/* Mini Motorway X — canvas renderer */
(function (root) {
  'use strict';
  const MM = root.MM;
  const CFG = MM.CFG;
  const C = CFG.CELL;

  const THEME = {
    board: '#f6f3ea',
    boardEdge: '#e4dfd0',
    dot: 'rgba(60,60,50,0.09)',
    shore: '#d5ecf5',
    water: '#b7dcec',
    roadEdge: '#56637a',
    road: '#8e9bb0',
    hwEdge: '#bd7414',
    hw: '#f4ab45',
    bridgeEdge: '#ffffff',
    ink: '#2f3a4b',
  };

  const OFF = 4.0; // lane offset from the road centre line
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.game = null;
      this.view = { scale: 1, ox: 0, oy: 0, w: 0, h: 0, dpr: 1 };
      this.fx = [];
      this.hover = -1;
      this.tool = 'road';
      this.preview = null; // {a, b, reason} while dragging a tunnel
      this.statics = null;
      this._pose = { x: 0, y: 0, a: 0 };
    }

    setGame(game) {
      this.game = game;
      this.fx = [];
      this.statics = null;
      this.layout();
    }

    resize(w, h, dpr) {
      this.view.w = w; this.view.h = h; this.view.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.layout();
    }

    /** Pick a grid that fills the whole screen at a comfortable zoom (smaller maps on small screens). */
    suggestGrid() {
      const v = this.view;
      const aw = Math.max(240, v.w), ah = Math.max(200, v.h);
      const s = Math.max(0.55, Math.sqrt((aw * ah) / (760 * C * C)));
      const cols = Math.max(16, Math.min(60, Math.floor(aw / (C * s))));
      const rows = Math.max(10, Math.min(40, Math.floor(ah / (C * s))));
      return { cols, rows };
    }

    /** Scale / offset that fit a cols x rows grid into the screen (the map is full-screen; leftover is plain land). */
    viewFor(cols, rows) {
      const v = this.view;
      const scale = Math.max(0.2, Math.min(v.w / (cols * C), v.h / (rows * C)));
      return { scale, ox: (v.w - cols * C * scale) / 2, oy: (v.h - rows * C * scale) / 2 };
    }

    layout() {
      const g = this.game, v = this.view;
      if (!g) return;
      const f = this.viewFor(g.cols, g.rows);
      v.scale = f.scale; v.ox = f.ox; v.oy = f.oy;
      this.statics = null;
    }

    nodeX(n) { return ((n % this.game.cols) + 0.5) * C; }
    nodeY(n) { return (((n / this.game.cols) | 0) + 0.5) * C; }

    /** client (CSS px, relative to canvas) -> node index or -1 */
    pickNode(px, py) {
      const g = this.game, v = this.view;
      const x = (px - v.ox) / v.scale, y = (py - v.oy) / v.scale;
      const c = Math.floor(x / C), r = Math.floor(y / C);
      if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return -1;
      return r * g.cols + c;
    }

    // ------------------------------------------------------------ static layer (land, water, lattice) — full screen
    buildStatics() {
      const g = this.game, v = this.view, w = g.world;
      const cv = document.createElement('canvas');
      cv.width = Math.round(v.w * v.dpr);
      cv.height = Math.round(v.h * v.dpr);
      const ctx = cv.getContext('2d');
      ctx.scale(v.dpr, v.dpr);
      ctx.fillStyle = THEME.board;
      ctx.fillRect(0, 0, v.w, v.h);
      ctx.translate(v.ox, v.oy);
      ctx.scale(v.scale, v.scale);
      // lattice dots
      ctx.fillStyle = THEME.dot;
      for (let n = 0; n < w.n; n++) {
        if (w.water[n]) continue;
        ctx.beginPath();
        ctx.arc(this.nodeX(n), this.nodeY(n), 1.7, 0, 6.2832);
        ctx.fill();
      }
      // water: rounded-square cells fused together (shore pass, then deep pass); water touching the
      // edge of the grid is extended past it so it runs off-screen instead of stopping at the grid.
      const EXT = Math.max(v.w, v.h) / v.scale;
      const pass = (rr, color) => {
        const h = C / 2 - C * 0.3; // half size of the cell core (same for both passes)
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineJoin = 'round';
        ctx.lineWidth = 2 * rr;
        ctx.beginPath();
        for (let n = 0; n < w.n; n++) {
          if (!w.water[n]) continue;
          const x = this.nodeX(n), y = this.nodeY(n);
          const c = n % g.cols, r = (n / g.cols) | 0;
          const x0 = c === 0 ? x - h - EXT : x - h, x1 = c === g.cols - 1 ? x + h + EXT : x + h;
          const y0 = r === 0 ? y - h - EXT : y - h, y1 = r === g.rows - 1 ? y + h + EXT : y + h;
          ctx.rect(x0, y0, x1 - x0, y1 - y0);
          const e = w.nb(n, 1), s = w.nb(n, 2);
          if (e >= 0 && w.water[e]) ctx.rect(x - h, y0, C + 2 * h, y1 - y0);
          if (s >= 0 && w.water[s]) ctx.rect(x0, y - h, x1 - x0, C + 2 * h);
          if (e >= 0 && s >= 0 && w.water[e] && w.water[s] && w.water[s + 1]) ctx.rect(x + h, y + h, C - 2 * h, C - 2 * h);
        }
        ctx.fill();
        ctx.stroke();
      };
      pass(C * 0.3 + 3.5, THEME.shore);
      pass(C * 0.3, THEME.water);
      this.statics = { cv };
    }

    // ------------------------------------------------------------ cars
    carPose(car) {
      const p = car.path, i = car.i, s = car.s;
      const len = this.game.lenOf(car.lane); // lane length in cells (tunnels are long)
      const zone = 0.25 / len; // the corner blend covers 0.25 cell on each side of a node
      const a = p[i], b = p[i + 1];
      const ax = this.nodeX(a), ay = this.nodeY(a), bx = this.nodeX(b), by = this.nodeY(b);
      const dx = Math.sign(bx - ax), dy = Math.sign(by - ay);
      const out = this._pose;
      const nx = -dy, ny = dx;
      const c = p[i + 2], pr = p[i - 1];
      const corner = (nodeN, din, dout, t) => {
        const X = this.nodeX(nodeN), Y = this.nodeY(nodeN);
        const nix = -din[1], niy = din[0], nox = -dout[1], noy = dout[0];
        const dot = nix * nox + niy * noy;
        if (dot < -0.9) return false;
        const q = C * 0.25;
        const p0x = X - din[0] * q + nix * OFF, p0y = Y - din[1] * q + niy * OFF;
        const p2x = X + dout[0] * q + nox * OFF, p2y = Y + dout[1] * q + noy * OFF;
        const k = OFF / (1 + dot);
        const cx = X + (nix + nox) * k, cy = Y + (niy + noy) * k;
        const u = 1 - t;
        out.x = u * u * p0x + 2 * u * t * cx + t * t * p2x;
        out.y = u * u * p0y + 2 * u * t * cy + t * t * p2y;
        const tx = 2 * u * (cx - p0x) + 2 * t * (p2x - cx);
        const ty = 2 * u * (cy - p0y) + 2 * t * (p2y - cy);
        out.a = Math.atan2(ty, tx);
        return true;
      };
      if (s > 1 - zone && c !== undefined) {
        const cx = Math.sign(this.nodeX(c) - bx), cy = Math.sign(this.nodeY(c) - by);
        if (corner(b, [dx, dy], [cx, cy], (s - (1 - zone)) * len * 2)) return out;
      } else if (s < zone && pr !== undefined) {
        const px = Math.sign(ax - this.nodeX(pr)), py = Math.sign(ay - this.nodeY(pr));
        if (corner(a, [px, py], [dx, dy], 0.5 + s * len * 2)) return out;
      }
      out.x = lerp(ax, bx, s) + nx * OFF;
      out.y = lerp(ay, by, s) + ny * OFF;
      out.a = Math.atan2(dy, dx);
      return out;
    }

    /** 0 = on the ground, 1 = on an overpass deck, 2 = hidden inside a tunnel. */
    carLevel(car) {
      const g = this.game, w = g.world;
      const len = g.lenOf(car.lane);
      const a = car.path[car.i], b = car.path[car.i + 1];
      const cells = car.s * len; // distance travelled along the lane, in cells
      if (len > 1 && cells > 0.35 && len - cells > 0.35) return 2;
      if (((car.lane & 3) & 1) === 0) { // vertical lanes go over a crossing road
        if (w.feat[b] === 3 && len - cells < 0.6) return 1;
        if (w.feat[a] === 3 && cells < 0.6) return 1;
      }
      return 0;
    }

    drawCar(ctx, car, elevated) {
      const pose = this.carPose(car);
      const col = MM.COLORS[car.color];
      ctx.save();
      ctx.translate(pose.x, pose.y - (elevated ? 3 : 0));
      ctx.rotate(pose.a);
      if (elevated) ctx.scale(1.12, 1.12);
      ctx.fillStyle = elevated ? 'rgba(20,30,50,0.28)' : 'rgba(0,0,0,0.18)';
      rr(ctx, -5.8, elevated ? 0.4 : -2.8, 12.4, 7, 2.2);
      ctx.fill();
      ctx.fillStyle = col.main;
      ctx.strokeStyle = col.dark;
      ctx.lineWidth = 1;
      rr(ctx, -6.2, -3.5, 12.4, 7, 2.2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      rr(ctx, 0.8, -2.4, 2.8, 4.8, 1);
      ctx.fill();
      ctx.restore();
    }

    // ------------------------------------------------------------ buildings
    drawBuilding(ctx, b, time) {
      const col = MM.COLORS[b.color];
      const x = this.nodeX(b.node), y = this.nodeY(b.node);
      const age = Math.max(0, time - b.born);
      const sc = age < 0.5 ? Math.max(0.01, easeOutBack(age / 0.5)) : 1;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(sc, sc);
      if (b.kind === 'house') {
        const sz = 24;
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        rr(ctx, -sz / 2 + 1, -sz / 2 + 4, sz, sz, 6);
        ctx.fill();
        ctx.fillStyle = col.dark;
        rr(ctx, -sz / 2, -sz / 2 + 3, sz, sz, 6);
        ctx.fill();
        ctx.fillStyle = col.main;
        rr(ctx, -sz / 2, -sz / 2, sz, sz, 6);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        rr(ctx, -sz / 2 + 5, -sz / 2 + 5, sz - 10, sz - 10, 3);
        ctx.fill();
      } else {
        const sz = 36;
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        rr(ctx, -sz / 2 + 1, -sz / 2 + 4, sz, sz, 9);
        ctx.fill();
        ctx.fillStyle = col.dark;
        rr(ctx, -sz / 2, -sz / 2 + 4, sz, sz, 9);
        ctx.fill();
        ctx.fillStyle = col.main;
        rr(ctx, -sz / 2, -sz / 2, sz, sz, 9);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(0, 0, 10, 0, 6.2832);
        ctx.fill();
        ctx.fillStyle = col.main;
        ctx.beginPath();
        ctx.arc(0, 0, 5, 0, 6.2832);
        ctx.fill();
      }
      ctx.restore();

      if (b.kind === 'dest') {
        // pins: solid = waiting for a car, faded = a car is already on its way
        const slots = Math.max(CFG.PIN_LIMIT, b.pins);
        const waiting = b.pins - b.inbound;
        for (let k = 0; k < b.pins; k++) {
          const ang = -Math.PI / 2 + (k / slots) * 6.2832;
          const px = x + Math.cos(ang) * 30, py = y + Math.sin(ang) * 30;
          const solid = k < waiting;
          ctx.beginPath();
          ctx.arc(px, py, solid ? 4.8 : 3.6, 0, 6.2832);
          ctx.globalAlpha = solid ? 1 : 0.4;
          ctx.fillStyle = col.main;
          ctx.fill();
          if (solid) {
            ctx.lineWidth = 1.6;
            ctx.strokeStyle = '#fff';
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        }
        if (b.overflow > 0.001) {
          const pulse = 0.6 + 0.4 * Math.sin(time * 9);
          ctx.lineWidth = 5;
          ctx.strokeStyle = 'rgba(0,0,0,0.08)';
          ctx.beginPath();
          ctx.arc(x, y, 38, 0, 6.2832);
          ctx.stroke();
          ctx.strokeStyle = `rgba(235,50,60,${0.65 + 0.35 * pulse})`;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(x, y, 38, -Math.PI / 2, -Math.PI / 2 + 6.2832 * Math.min(1, b.overflow));
          ctx.stroke();
        }
      } else if (b.queue.length > 1) {
        // waiting trips (cars that cannot leave yet)
        const k = Math.min(5, b.queue.length - 1);
        for (let j = 0; j < k; j++) {
          ctx.beginPath();
          ctx.arc(x - (k - 1) * 4 + j * 8, y - 21, 3.2, 0, 6.2832);
          ctx.fillStyle = col.main;
          ctx.fill();
          ctx.lineWidth = 1.3;
          ctx.strokeStyle = '#fff';
          ctx.stroke();
        }
      }
    }

    // ------------------------------------------------------------ frame
    render(now) {
      const ctx = this.ctx, v = this.view, g = this.game;
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      ctx.clearRect(0, 0, v.w, v.h);
      if (!g) return;
      if (!this.statics) this.buildStatics();
      const st = this.statics;
      ctx.drawImage(st.cv, 0, 0, v.w, v.h);

      ctx.save();
      ctx.translate(v.ox, v.oy);
      ctx.scale(v.scale, v.scale);
      const w = g.world;
      ctx.save();

      // ---- roads
      const edges = [];
      for (let n = 0; n < w.n; n++) {
        const e = w.eE[n];
        if (e) edges.push(n, n + 1, e & 3, e >> 2);
        const s = w.eS[n];
        if (s) edges.push(n, n + w.cols, s & 3, s >> 2);
      }
      const strokeEdges = (width, color, filter) => {
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let k = 0; k < edges.length; k += 4) {
          if (!filter(edges[k], edges[k + 1], edges[k + 2])) continue;
          ctx.moveTo(this.nodeX(edges[k]), this.nodeY(edges[k]));
          ctx.lineTo(this.nodeX(edges[k + 1]), this.nodeY(edges[k + 1]));
        }
        ctx.stroke();
      };
      // tunnels run underneath: dashed line below the roads
      if (w.tun.size) {
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineWidth = 7;
        ctx.strokeStyle = 'rgba(70,82,104,0.30)';
        ctx.setLineDash([3, 8]);
        ctx.beginPath();
        for (const [key, t] of w.tun) {
          const a = key >> 2;
          if (a > t.to) continue;
          ctx.moveTo(this.nodeX(a), this.nodeY(a));
          ctx.lineTo(this.nodeX(t.to), this.nodeY(t.to));
        }
        ctx.stroke();
        ctx.restore();
      }
      const isBridge = (a, b) => w.water[a] === 1 || w.water[b] === 1;
      if (edges.length) {
        ctx.lineCap = 'butt';
        strokeEdges(27, 'rgba(40,70,90,0.18)', isBridge);
        strokeEdges(24, 'rgba(255,255,255,0.97)', isBridge);
        strokeEdges(19.5, THEME.roadEdge, (a, b, t) => t === 1);
        strokeEdges(23.5, THEME.hwEdge, (a, b, t) => t === 2);
        strokeEdges(16, THEME.road, (a, b, t) => t === 1);
        strokeEdges(19.5, THEME.hw, (a, b, t) => t === 2);
        // highway centre dashes
        ctx.setLineDash([5, 6]);
        strokeEdges(1.6, 'rgba(255,255,255,0.9)', (a, b, t) => t === 2);
        ctx.setLineDash([]);
      }

      // ---- big roundabouts: green island in the middle, arrows showing the (counter-clockwise) flow
      for (const big of g.bigs.values()) {
        const x = this.nodeX(big.center), y = this.nodeY(big.center);
        // the whole 3x3 area inside the ring is a lawn island
        ctx.fillStyle = '#a9d9b1';
        rr(ctx, x - 30.5, y - 30.5, 61, 61, 15); ctx.fill();
        ctx.fillStyle = '#8cc89d';
        rr(ctx, x - 22, y - 22, 44, 44, 11); ctx.fill();
        ctx.fillStyle = '#6fb383';
        for (const [tx, ty, tr] of [[-9, -8, 6], [8, 5, 7], [-4, 11, 4.5], [11, -11, 4]]) { ctx.beginPath(); ctx.arc(x + tx, y + ty, tr, 0, 6.2832); ctx.fill(); }
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        for (let i = 0; i < 8; i++) {
          const a = big.nodes[i], b = big.nodes[(i + 1) % 8];
          const mx = (this.nodeX(a) + this.nodeX(b)) / 2, my = (this.nodeY(a) + this.nodeY(b)) / 2;
          const dx = Math.sign(this.nodeX(b) - this.nodeX(a)), dy = Math.sign(this.nodeY(b) - this.nodeY(a));
          ctx.beginPath();
          ctx.moveTo(mx + dx * 4.5, my + dy * 4.5);
          ctx.lineTo(mx - dx * 3 - dy * 3.5, my - dy * 3 + dx * 3.5);
          ctx.lineTo(mx - dx * 3 + dy * 3.5, my - dy * 3 - dx * 3.5);
          ctx.closePath();
          ctx.fill();
        }
      }

      // ---- features (roundabouts, traffic lights)
      for (let n = 0; n < w.n; n++) {
        const f = w.feat[n];
        if (!f || f === 3) continue;
        const x = this.nodeX(n), y = this.nodeY(n);
        if (f === 2) {
          ctx.fillStyle = THEME.roadEdge;
          ctx.beginPath(); ctx.arc(x, y, 17, 0, 6.2832); ctx.fill();
          ctx.fillStyle = THEME.road;
          ctx.beginPath(); ctx.arc(x, y, 14.5, 0, 6.2832); ctx.fill();
          ctx.fillStyle = THEME.roadEdge;
          ctx.beginPath(); ctx.arc(x, y, 8.2, 0, 6.2832); ctx.fill();
          ctx.fillStyle = '#9fd3a8';
          ctx.beginPath(); ctx.arc(x, y, 6.2, 0, 6.2832); ctx.fill();
        } else {
          const L = g.lights.get(n);
          ctx.fillStyle = '#2b3340';
          ctx.beginPath(); ctx.arc(x, y, 9.5, 0, 6.2832); ctx.fill();
          for (let d = 0; d < 4; d++) {
            if (!w.edge(n, d)) continue;
            const green = L && !L.pending && L.green === (d & 1);
            ctx.fillStyle = green ? '#58e08a' : '#ff5a5a';
            ctx.beginPath();
            ctx.arc(x + MM.DX[d] * 12.5, y + MM.DY[d] * 12.5, 3.3, 0, 6.2832);
            ctx.fill();
          }
        }
      }

      // ---- cars (under buildings so they appear to enter/leave them): ground level, then overpass decks, then
      //      the cars driving on top of them; cars inside a tunnel are not drawn
      const elevated = [];
      for (const car of g.cars) {
        if (car.dead) continue;
        const lv = this.carLevel(car);
        if (lv === 0) this.drawCar(ctx, car, false);
        else if (lv === 1) elevated.push(car);
      }
      for (let n = 0; n < w.n; n++) {
        if (w.feat[n] !== 3) continue;
        const x = this.nodeX(n), y = this.nodeY(n);
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = 'rgba(25,35,55,0.30)';
        rr(ctx, -9, -24, 28, 64, 7); ctx.fill();
        ctx.fillStyle = THEME.roadEdge;
        rr(ctx, -14, -32, 28, 64, 7); ctx.fill();
        ctx.fillStyle = '#c3cddd';
        rr(ctx, -11.5, -32, 23, 64, 5); ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(-9.5, -28); ctx.lineTo(-9.5, 28); ctx.moveTo(9.5, -28); ctx.lineTo(9.5, 28); ctx.stroke();
        ctx.strokeStyle = 'rgba(86,99,122,0.7)';
        ctx.setLineDash([4, 5]);
        ctx.beginPath(); ctx.moveTo(0, -28); ctx.lineTo(0, 28); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
      for (const car of elevated) this.drawCar(ctx, car, true);
      // tunnel mouths
      for (const [key, t] of w.tun) {
        const a = key >> 2, d = key & 3;
        const x = this.nodeX(a), y = this.nodeY(a);
        ctx.fillStyle = THEME.roadEdge;
        ctx.beginPath(); ctx.arc(x, y, 12.5, 0, 6.2832); ctx.fill();
        ctx.fillStyle = '#2f3643';
        ctx.beginPath(); ctx.arc(x, y, 9.5, 0, 6.2832); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        const dx = MM.DX[d], dy = MM.DY[d];
        ctx.beginPath();
        ctx.moveTo(x + dx * 5.5, y + dy * 5.5);
        ctx.lineTo(x - dx * 2 - dy * 4, y - dy * 2 + dx * 4);
        ctx.lineTo(x - dx * 2 + dy * 4, y - dy * 2 - dx * 4);
        ctx.closePath();
        ctx.fill();
        void t;
      }

      // ---- buildings
      for (const b of g.buildings) this.drawBuilding(ctx, b, g.time);

      // ---- placement hints
      if ((this.tool === 'light' || this.tool === 'round' || this.tool === 'ovp') && g.state === 'running') {
        const pulse = 0.5 + 0.5 * Math.sin(now / 220);
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = `rgba(47,58,75,${0.35 + 0.35 * pulse})`;
        ctx.setLineDash([4, 4]);
        const need = this.tool === 'ovp' ? 4 : 3;
        for (let n = 0; n < w.n; n++) {
          if (w.bld[n] || w.feat[n] || w.ringId[n] || w.deg(n) < need) continue;
          ctx.beginPath();
          ctx.arc(this.nodeX(n), this.nodeY(n), 17, 0, 6.2832);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      // big roundabout: show the 3x3 footprint under the pointer (green = fits, red = blocked)
      if (this.tool === 'big' && this.hover >= 0 && g.state === 'running') {
        const bad = g.checkBig(this.hover);
        const x = this.nodeX(this.hover), y = this.nodeY(this.hover);
        ctx.fillStyle = bad ? 'rgba(235,60,70,0.16)' : 'rgba(53,196,140,0.18)';
        ctx.strokeStyle = bad ? 'rgba(235,60,70,0.7)' : 'rgba(30,150,100,0.8)';
        ctx.lineWidth = 2.2;
        ctx.setLineDash([6, 5]);
        rr(ctx, x - 1.5 * C, y - 1.5 * C, 3 * C, 3 * C, 20);
        ctx.fill(); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(x, y, 17, 0, 6.2832); ctx.stroke();
      }
      // tunnel being dragged out
      if (this.preview && g.state === 'running') {
        const pv = this.preview;
        const ok = !pv.reason;
        const col = ok ? '#1e9a64' : '#e03c46';
        ctx.strokeStyle = col;
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.setLineDash([2, 9]);
        ctx.beginPath(); ctx.moveTo(this.nodeX(pv.a), this.nodeY(pv.a)); ctx.lineTo(this.nodeX(pv.b), this.nodeY(pv.b)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col;
        for (const n of [pv.a, pv.b]) { ctx.beginPath(); ctx.arc(this.nodeX(n), this.nodeY(n), 7, 0, 6.2832); ctx.fill(); }
        const len = Math.abs(g.world.col(pv.a) - g.world.col(pv.b)) + Math.abs(g.world.row(pv.a) - g.world.row(pv.b));
        ctx.font = 'bold 13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(len), (this.nodeX(pv.a) + this.nodeX(pv.b)) / 2, (this.nodeY(pv.a) + this.nodeY(pv.b)) / 2 - 12);
      }
      if (this.hover >= 0 && g.state === 'running') {
        const x = this.nodeX(this.hover), y = this.nodeY(this.hover);
        ctx.fillStyle = this.tool === 'erase' ? 'rgba(235,60,70,0.22)' : 'rgba(47,58,75,0.14)';
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, 6.2832);
        ctx.fill();
      }

      // ---- effects
      const t = g.time;
      this.fx = this.fx.filter((f) => t - f.t0 < f.dur);
      for (const f of this.fx) {
        const k = (t - f.t0) / f.dur;
        const x = this.nodeX(f.node), y = this.nodeY(f.node);
        ctx.globalAlpha = 1 - k;
        if (f.kind === 'ring') {
          ctx.strokeStyle = f.color;
          ctx.lineWidth = 3 * (1 - k) + 1;
          ctx.beginPath();
          ctx.arc(x, y, 14 + k * f.r, 0, 6.2832);
          ctx.stroke();
        } else if (f.kind === 'plus') {
          ctx.fillStyle = f.color;
          ctx.font = 'bold 15px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('+1', x, y - 22 - k * 20);
        } else if (f.kind === 'puff') {
          ctx.fillStyle = 'rgba(80,90,100,0.6)';
          ctx.beginPath();
          ctx.arc(x, y, 5 + k * 12, 0, 6.2832);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      ctx.restore();
    }

    addEvents(events) {
      const g = this.game;
      for (const e of events) {
        if (e.type === 'deliver') {
          const col = MM.COLORS[e.color].main;
          this.fx.push({ kind: 'ring', node: e.node, color: col, t0: g.time, dur: 0.55, r: 26 });
          this.fx.push({ kind: 'plus', node: e.node, color: MM.COLORS[e.color].dark, t0: g.time, dur: 0.7 });
        } else if (e.type === 'spawn') {
          this.fx.push({ kind: 'ring', node: e.node, color: MM.COLORS[e.color].main, t0: g.time, dur: 0.9, r: 46 });
        } else if (e.type === 'lost') {
          this.fx.push({ kind: 'puff', node: e.node, t0: g.time, dur: 0.4 });
        } else if (e.type === 'place') {
          this.fx.push({ kind: 'ring', node: e.node, color: '#2f3a4b', t0: g.time, dur: 0.4, r: 18 });
        } else if (e.type === 'gameover') {
          this.fx.push({ kind: 'ring', node: e.node, color: '#eb323c', t0: g.time, dur: 1.2, r: 90 });
        }
      }
    }
  }

  MM.Renderer = Renderer;
  MM.THEME = THEME;
})(typeof window !== 'undefined' ? window : globalThis);
