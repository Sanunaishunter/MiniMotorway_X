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
      this.insets = { top: 70, bottom: 96, side: 12 };
      this.fx = [];
      this.hover = -1;
      this.tool = 'road';
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

    /** Pick a grid that fills the screen at a comfortable zoom (smaller maps on small screens). */
    suggestGrid() {
      const v = this.view;
      const aw = Math.max(240, v.w - this.insets.side * 2);
      const ah = Math.max(240, v.h - this.insets.top - this.insets.bottom);
      const s = Math.max(0.55, Math.sqrt((aw * ah) / (760 * C * C)));
      const cols = Math.max(16, Math.min(46, Math.floor(aw / (C * s))));
      const rows = Math.max(12, Math.min(34, Math.floor(ah / (C * s))));
      return { cols, rows };
    }

    layout() {
      const g = this.game, v = this.view;
      if (!g) return;
      const bw = g.cols * C, bh = g.rows * C;
      const aw = v.w - this.insets.side * 2;
      const ah = v.h - this.insets.top - this.insets.bottom;
      v.scale = Math.max(0.2, Math.min(aw / bw, ah / bh));
      v.ox = (v.w - bw * v.scale) / 2;
      v.oy = this.insets.top + (ah - bh * v.scale) / 2;
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

    // ------------------------------------------------------------ static layer (board, water, lattice)
    buildStatics() {
      const g = this.game, v = this.view, w = g.world;
      const pad = 40;
      const bw = g.cols * C, bh = g.rows * C;
      const cv = document.createElement('canvas');
      const sc = v.scale * v.dpr;
      cv.width = Math.ceil((bw + pad * 2) * sc);
      cv.height = Math.ceil((bh + pad * 2) * sc);
      const ctx = cv.getContext('2d');
      ctx.scale(sc, sc);
      ctx.translate(pad, pad);
      // shadow + board
      ctx.save();
      ctx.shadowColor = 'rgba(40,50,40,0.22)';
      ctx.shadowBlur = 26;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle = THEME.board;
      rr(ctx, 0, 0, bw, bh, 22);
      ctx.fill();
      ctx.restore();
      ctx.save();
      rr(ctx, 0, 0, bw, bh, 22);
      ctx.clip();
      // lattice dots
      ctx.fillStyle = THEME.dot;
      for (let n = 0; n < w.n; n++) {
        if (w.water[n]) continue;
        ctx.beginPath();
        ctx.arc(this.nodeX(n), this.nodeY(n), 1.7, 0, 6.2832);
        ctx.fill();
      }
      // water: rounded-square cells fused together (shore pass, then deep pass)
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
          ctx.rect(x - h, y - h, 2 * h, 2 * h);
          const e = w.nb(n, 1), s = w.nb(n, 2);
          if (e >= 0 && w.water[e]) ctx.rect(x - h, y - h, C + 2 * h, 2 * h);
          if (s >= 0 && w.water[s]) ctx.rect(x - h, y - h, 2 * h, C + 2 * h);
          if (e >= 0 && s >= 0 && w.water[e] && w.water[s] && w.water[s + 1]) ctx.rect(x + h, y + h, C - 2 * h, C - 2 * h);
        }
        ctx.fill();
        ctx.stroke();
      };
      pass(C * 0.3 + 3.5, THEME.shore);
      pass(C * 0.3, THEME.water);
      ctx.restore();
      this.statics = { cv, pad, sc };
    }

    // ------------------------------------------------------------ cars
    carPose(car) {
      const g = this.game, w = g.world;
      const p = car.path, i = car.i, s = car.s;
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
      if (s > 0.75 && c !== undefined) {
        const cx = Math.sign(this.nodeX(c) - bx), cy = Math.sign(this.nodeY(c) - by);
        if (corner(b, [dx, dy], [cx, cy], (s - 0.75) * 2)) return out;
      } else if (s < 0.25 && pr !== undefined) {
        const px = Math.sign(ax - this.nodeX(pr)), py = Math.sign(ay - this.nodeY(pr));
        if (corner(a, [px, py], [dx, dy], 0.5 + s * 2)) return out;
      }
      out.x = lerp(ax, bx, s) + nx * OFF;
      out.y = lerp(ay, by, s) + ny * OFF;
      out.a = Math.atan2(dy, dx);
      void w;
      return out;
    }

    drawCar(ctx, car) {
      const pose = this.carPose(car);
      const col = MM.COLORS[car.color];
      ctx.save();
      ctx.translate(pose.x, pose.y);
      ctx.rotate(pose.a);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      rr(ctx, -5.8, -2.8, 12.4, 7, 2.2);
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
        // pins
        const slots = Math.max(CFG.PIN_LIMIT, b.pins);
        for (let k = 0; k < b.pins; k++) {
          const ang = -Math.PI / 2 + (k / slots) * 6.2832;
          const px = x + Math.cos(ang) * 30, py = y + Math.sin(ang) * 30;
          ctx.beginPath();
          ctx.arc(px, py, 4.8, 0, 6.2832);
          ctx.fillStyle = col.main;
          ctx.fill();
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = '#fff';
          ctx.stroke();
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
      ctx.drawImage(st.cv, v.ox - st.pad * v.scale, v.oy - st.pad * v.scale, st.cv.width / st.sc * v.scale, st.cv.height / st.sc * v.scale);

      ctx.save();
      ctx.translate(v.ox, v.oy);
      ctx.scale(v.scale, v.scale);
      const w = g.world;
      const bw = g.cols * C, bh = g.rows * C;
      ctx.save();
      rr(ctx, 0, 0, bw, bh, 22);
      ctx.clip();

      // ---- roads
      const edges = [];
      for (let n = 0; n < w.n; n++) {
        const e = w.eE[n];
        if (e) edges.push(n, n + 1, e);
        const s = w.eS[n];
        if (s) edges.push(n, n + w.cols, s);
      }
      const strokeEdges = (width, color, filter) => {
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let k = 0; k < edges.length; k += 3) {
          if (!filter(edges[k], edges[k + 1], edges[k + 2])) continue;
          ctx.moveTo(this.nodeX(edges[k]), this.nodeY(edges[k]));
          ctx.lineTo(this.nodeX(edges[k + 1]), this.nodeY(edges[k + 1]));
        }
        ctx.stroke();
      };
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

      // ---- features (roundabouts, traffic lights)
      for (let n = 0; n < w.n; n++) {
        const f = w.feat[n];
        if (!f) continue;
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

      // ---- cars (under buildings so they appear to enter/leave them)
      for (const car of g.cars) if (!car.dead) this.drawCar(ctx, car);

      // ---- buildings
      for (const b of g.buildings) this.drawBuilding(ctx, b, g.time);

      // ---- placement hints
      if ((this.tool === 'light' || this.tool === 'round') && g.state === 'running') {
        const pulse = 0.5 + 0.5 * Math.sin(now / 220);
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = `rgba(47,58,75,${0.35 + 0.35 * pulse})`;
        ctx.setLineDash([4, 4]);
        for (let n = 0; n < w.n; n++) {
          if (w.bld[n] || w.feat[n] || w.deg(n) < 3) continue;
          ctx.beginPath();
          ctx.arc(this.nodeX(n), this.nodeY(n), 17, 0, 6.2832);
          ctx.stroke();
        }
        ctx.setLineDash([]);
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
      ctx.restore(); // clip
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
