/* Mini Motorway X — decorative aircraft that now and then fly across the sky: white airliners (747, A380, 787) with a stripe near
 * each wing tip and a black radome, a Zero fighter, an SR-71, a B-2 and an F-14 with its wings swept back.
 * Purely decorative: screen-space only, never reads or changes the simulation. */
(function (root) {
  'use strict';
  const MM = root.MM;
  const TAU = Math.PI * 2;

  const OUTLINE = '#9fb0c4';
  const SHADOW = '#1d3a2a';

  /** Draw a closed polygon (points in plane units, nose towards +x). */
  function poly(ctx, pts) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) { if (i) ctx.lineTo(pts[i][0], pts[i][1]); else ctx.moveTo(pts[i][0], pts[i][1]); }
    ctx.closePath();
  }
  const mir = (pts) => pts.map(([x, y]) => [x, -y]);

  // ---------------------------------------------------------------------------------------------------- models
  // Every model draws itself with ctx already scaled so that 1 unit = the plane's length, nose pointing to +x. `sh` = draw the
  // flat ground shadow only (no details). `px` converts screen pixels to plane units (for hairlines).

  /** Airliner: white, swept wings with a stripe near each tip, 2 / 4 engines, a black radome on the nose. */
  function airliner(P) {
    return {
      name: P.name, len: P.len, k: 1, tip: [(P.wing.tle + P.wing.tte) / 2, P.wing.ty],
      paint(ctx, p, sh, px, t) {
        const W = P.wing, F = (c) => (sh ? SHADOW : c);
        const xle = (y) => W.rle + (W.tle - W.rle) * (y / W.ty), xte = (y) => W.rte + (W.tte - W.rte) * (y / W.ty);
        ctx.lineJoin = 'round';
        ctx.lineWidth = px;
        ctx.strokeStyle = OUTLINE;
        for (const s of [1, -1]) { // wings
          const pts = [[W.rle, 0], [W.tle, W.ty * s], [W.tte, W.ty * s], [W.rte, 0]];
          poly(ctx, pts); ctx.fillStyle = F('#eef3f9'); ctx.fill(); if (!sh) ctx.stroke();
          if (P.raked) { poly(ctx, [[W.tle - 0.005, W.ty * s], [W.tte, W.ty * s], [W.tte - 0.06, (W.ty + 0.055) * s]]); ctx.fillStyle = F('#e3eaf3'); ctx.fill(); }
        }
        // tail plane
        const T = P.tail;
        for (const s of [1, -1]) { poly(ctx, [[T.x + 0.06, 0], [T.x - 0.08, T.span * s], [T.x - 0.15, T.span * s], [T.x - 0.06, 0]]); ctx.fillStyle = F('#eef3f9'); ctx.fill(); if (!sh) ctx.stroke(); }
        if (!sh) { // the livery: one stripe on each wing, near the tip
          ctx.fillStyle = p.c1;
          for (const s of [1, -1]) {
            const y0 = W.ty * 0.7, y1 = W.ty * 0.83;
            poly(ctx, [[xle(y0), y0 * s], [xle(y1), y1 * s], [xte(y1), y1 * s], [xte(y0), y0 * s]]); ctx.fill();
          }
        }
        // engines, in front of the wing's leading edge
        if (!sh) {
          for (const y of P.engs) for (const s of [1, -1]) {
            const x = xle(y) + 0.05;
            ctx.fillStyle = '#b5c3d4'; ctx.beginPath(); ctx.ellipse(x - 0.02, y * s, 0.075, 0.03, 0, 0, TAU); ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#5f6c7d'; ctx.beginPath(); ctx.ellipse(x + 0.045, y * s, 0.014, 0.024, 0, 0, TAU); ctx.fill();
          }
        }
        // fuselage
        ctx.beginPath(); ctx.ellipse(0, 0, 0.5, P.fus, 0, 0, TAU);
        ctx.fillStyle = F('#ffffff'); ctx.fill();
        if (!sh) {
          ctx.save();
          ctx.clip();
          ctx.fillStyle = '#161b22'; ctx.fillRect(0.425, -P.fus, 0.1, 2 * P.fus); // the black radome at the nose
          ctx.fillStyle = '#3a4f6b'; ctx.beginPath(); ctx.ellipse(0.36, 0, 0.03, P.fus * 0.5, 0, 0, TAU); ctx.fill(); // cockpit windows
          ctx.fillStyle = 'rgba(160,180,205,0.7)'; // a row of cabin windows
          for (let i = 0; i < 9; i++) ctx.fillRect(0.28 - i * 0.045, -P.fus * 0.18, 0.02, P.fus * 0.36);
          ctx.fillStyle = p.c2; ctx.fillRect(-0.5, -0.012, 0.13, 0.024); // the fin on the tail, seen from above
          ctx.restore();
          ctx.beginPath(); ctx.ellipse(0, 0, 0.5, P.fus, 0, 0, TAU); ctx.stroke();
        }
        void t;
      },
    };
  }

  /** Mitsubishi A6M Zero: pale grey-green, straight elliptical wings with red hinomaru, a dark engine cowling and a spinning propeller. */
  function zero() {
    const half = [];
    for (let i = 0; i <= 12; i++) { const u = i / 12, y = u * 0.66, c = 0.05 + 0.27 * Math.sqrt(1 - u * u); half.push([0.04 + c * 0.4, y, 0.04 - c * 0.6]); }
    const wing = (s) => half.map(([le, y]) => [le, y * s]).concat(half.slice().reverse().map(([, y, te]) => [te, y * s]));
    return {
      name: 'zero', len: [46, 58], k: 0.9, tip: [0.02, 0.66],
      paint(ctx, p, sh, px, t) {
        const F = (c) => (sh ? SHADOW : c);
        ctx.lineJoin = 'round'; ctx.lineWidth = px; ctx.strokeStyle = '#8a947a';
        for (const s of [1, -1]) { poly(ctx, wing(s)); ctx.fillStyle = F('#cbd3b8'); ctx.fill(); if (!sh) ctx.stroke(); }
        for (const s of [1, -1]) { poly(ctx, [[-0.36, 0], [-0.41, 0.2 * s], [-0.47, 0.19 * s], [-0.45, 0]]); ctx.fillStyle = F('#cbd3b8'); ctx.fill(); if (!sh) ctx.stroke(); }
        ctx.beginPath(); ctx.ellipse(-0.02, 0, 0.5, 0.062, 0, 0, TAU); ctx.fillStyle = F('#d7ddc6'); ctx.fill(); if (!sh) ctx.stroke();
        if (!sh) {
          for (const s of [1, -1]) { // hinomaru on the wings
            ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(0.04, 0.4 * s, 0.075, 0, TAU); ctx.fill();
            ctx.fillStyle = '#c4161c'; ctx.beginPath(); ctx.arc(0.04, 0.4 * s, 0.06, 0, TAU); ctx.fill();
          }
          ctx.fillStyle = '#7fa0b8'; ctx.beginPath(); ctx.ellipse(0.08, 0, 0.1, 0.038, 0, 0, TAU); ctx.fill(); // canopy
          ctx.strokeStyle = '#4b5a66'; ctx.beginPath(); ctx.moveTo(0.04, -0.036); ctx.lineTo(0.04, 0.036); ctx.moveTo(0.11, -0.03); ctx.lineTo(0.11, 0.03); ctx.stroke();
          ctx.fillStyle = '#1f2a37'; ctx.beginPath(); ctx.ellipse(0.4, 0, 0.1, 0.066, 0, 0, TAU); ctx.fill(); // engine cowling
          const a = t * 40; // propeller: a translucent blur with a pair of blades
          ctx.fillStyle = 'rgba(60,60,60,0.16)'; ctx.beginPath(); ctx.ellipse(0.51, 0, 0.012, 0.25, 0, 0, TAU); ctx.fill();
          ctx.strokeStyle = 'rgba(40,40,40,0.55)'; ctx.lineWidth = 0.014;
          ctx.beginPath(); ctx.moveTo(0.51, -0.24 * Math.cos(a)); ctx.lineTo(0.51, 0.24 * Math.cos(a)); ctx.stroke();
          ctx.fillStyle = '#c9c9c9'; ctx.beginPath(); ctx.arc(0.51, 0, 0.018, 0, TAU); ctx.fill();
        }
      },
    };
  }

  /** Lockheed SR-71: black needle fuselage, blended chines, a delta wing and two big engine nacelles. */
  function sr71() {
    const body = [[0.5, 0], [0.3, 0.02], [0.1, 0.034], [-0.35, 0.044], [-0.5, 0.03]];
    const outline = body.concat(mir(body).reverse());
    const wing = [[0.2, 0.04], [-0.31, 0.27], [-0.41, 0.27], [-0.41, 0.04]];
    return {
      name: 'sr71', len: [66, 84], k: 1, tip: [-0.36, 0.27],
      paint(ctx, p, sh, px) {
        const F = (c) => (sh ? SHADOW : c);
        ctx.lineJoin = 'round'; ctx.lineWidth = px; ctx.strokeStyle = '#3b4560';
        for (const s of [1, -1]) { poly(ctx, wing.map(([x, y]) => [x, y * s])); ctx.fillStyle = F('#1c2230'); ctx.fill(); if (!sh) ctx.stroke(); }
        poly(ctx, outline); ctx.fillStyle = F('#171c28'); ctx.fill(); if (!sh) ctx.stroke();
        for (const s of [1, -1]) { // chines
          poly(ctx, [[0.44, 0.006 * s], [0.18, 0.062 * s], [0.14, 0.04 * s], [0.4, 0 * s]]); ctx.fillStyle = F('#1c2230'); ctx.fill();
        }
        for (const s of [1, -1]) { // engine nacelles with an inlet cone at the front and a glowing nozzle at the back
          ctx.beginPath(); ctx.ellipse(-0.24, 0.115 * s, 0.24, 0.032, 0, 0, TAU); ctx.fillStyle = F('#10141d'); ctx.fill();
          if (!sh) {
            ctx.stroke();
            ctx.fillStyle = '#4a556e'; ctx.beginPath(); ctx.arc(-0.0, 0.115 * s, 0.015, 0, TAU); ctx.fill();
            ctx.fillStyle = '#ff9a3c'; ctx.beginPath(); ctx.arc(-0.47, 0.115 * s, 0.014, 0, TAU); ctx.fill();
            ctx.fillStyle = '#242c3e'; ctx.fillRect(-0.44, (0.115 - 0.004) * s - 0.002, 0.2, 0.004); // the twin tail fins seen from above
          }
        }
        if (!sh) { ctx.fillStyle = '#05070b'; ctx.beginPath(); ctx.ellipse(0.46, 0, 0.05, 0.013, 0, 0, TAU); ctx.fill(); ctx.fillStyle = '#5b6f8d'; ctx.beginPath(); ctx.ellipse(0.3, 0, 0.04, 0.012, 0, 0, TAU); ctx.fill(); }
      },
    };
  }

  /** Northrop B-2 Spirit: a flying wing with the double-W trailing edge. */
  function b2() {
    const half = [[0.5, 0], [-0.1, 1.22], [-0.16, 1.2], [-0.34, 0.74], [-0.27, 0.56], [-0.46, 0.22], [-0.4, 0.1], [-0.5, 0]];
    const outline = half.concat(mir(half.slice(1, -1)).reverse());
    return {
      name: 'b2', len: [66, 84], k: 0.55, tip: [-0.13, 1.21],
      paint(ctx, p, sh, px) {
        ctx.lineJoin = 'round'; ctx.lineWidth = px; ctx.strokeStyle = '#242a35';
        poly(ctx, outline); ctx.fillStyle = sh ? SHADOW : '#3c4452'; ctx.fill(); if (!sh) ctx.stroke();
        if (!sh) {
          ctx.fillStyle = '#4b5565'; poly(ctx, [[0.46, 0], [0.1, 0.4], [-0.1, 0.4], [-0.3, 0.1], [-0.3, -0.1], [-0.1, -0.4], [0.1, -0.4]]); ctx.fill(); // the lighter centre section
          ctx.strokeStyle = '#2a303b'; ctx.lineWidth = px * 1.6; // engine inlets along the leading edge
          for (const s of [1, -1]) { ctx.beginPath(); ctx.moveTo(0.3, 0.2 * s); ctx.lineTo(0.2, 0.34 * s); ctx.stroke(); }
          ctx.fillStyle = '#0c0f14'; for (const s of [1, -1]) { ctx.beginPath(); ctx.ellipse(0.38, 0.045 * s, 0.035, 0.012, 0.3 * s, 0, TAU); ctx.fill(); } // cockpit windows
        }
      },
    };
  }

  /** Grumman F-14 Tomcat with the wings swept fully back (the "oversweep" position), twin tails and twin nacelles. */
  function f14() {
    const wing = [[0.16, 0.07], [-0.2, 0.31], [-0.32, 0.31], [-0.3, 0.07]];
    return {
      name: 'f14', len: [50, 64], k: 1, tip: [-0.26, 0.31],
      paint(ctx, p, sh, px) {
        const F = (c) => (sh ? SHADOW : c);
        ctx.lineJoin = 'round'; ctx.lineWidth = px; ctx.strokeStyle = '#6d7787';
        for (const s of [1, -1]) { poly(ctx, wing.map(([x, y]) => [x, y * s])); ctx.fillStyle = F('#a7b0bd'); ctx.fill(); if (!sh) ctx.stroke(); }
        for (const s of [1, -1]) { poly(ctx, [[0.34, 0.04 * s], [0.12, 0.13 * s], [0.12, 0.07 * s]]); ctx.fillStyle = F('#a7b0bd'); ctx.fill(); } // glove vanes
        for (const s of [1, -1]) { poly(ctx, [[-0.38, 0.1 * s], [-0.52, 0.25 * s], [-0.57, 0.25 * s], [-0.5, 0.1 * s]]); ctx.fillStyle = F('#a7b0bd'); ctx.fill(); if (!sh) ctx.stroke(); } // tailplanes
        for (const s of [1, -1]) { ctx.beginPath(); ctx.ellipse(-0.2, 0.078 * s, 0.31, 0.058, 0, 0, TAU); ctx.fillStyle = F('#98a2b0'); ctx.fill(); if (!sh) ctx.stroke(); } // engine nacelles
        poly(ctx, [[0.5, 0], [0.3, 0.045], [0.1, 0.075], [-0.2, 0.08], [-0.2, -0.08], [0.1, -0.075], [0.3, -0.045]]); ctx.fillStyle = F('#aab3c0'); ctx.fill(); if (!sh) ctx.stroke(); // fuselage
        if (!sh) {
          ctx.fillStyle = '#161b22'; poly(ctx, [[0.5, 0], [0.4, 0.028], [0.4, -0.028]]); ctx.fill(); // radome
          ctx.fillStyle = '#33506b'; ctx.beginPath(); ctx.ellipse(0.2, 0, 0.1, 0.035, 0, 0, TAU); ctx.fill(); // canopy
          ctx.fillStyle = '#2a2f38'; for (const s of [1, -1]) { ctx.beginPath(); ctx.arc(-0.5, 0.078 * s, 0.034, 0, TAU); ctx.fill(); } // exhausts
          ctx.fillStyle = '#59647a'; for (const s of [1, -1]) ctx.fillRect(-0.5, 0.098 * s - 0.01, 0.13, 0.02); // twin tail fins from above
          ctx.fillStyle = '#d6dde8'; ctx.beginPath(); ctx.arc(-0.1, 0.22, 0.02, 0, TAU); ctx.arc(-0.1, -0.22, 0.02, 0, TAU); ctx.fill();
        }
      },
    };
  }

  const MODELS = [
    airliner({ name: '747', len: [70, 88], fus: 0.075, wing: { rle: 0.12, rte: -0.08, ty: 0.48, tle: -0.22, tte: -0.32 }, engs: [0.16, 0.31], tail: { x: -0.43, span: 0.22 } }),
    airliner({ name: 'a380', len: [74, 92], fus: 0.092, wing: { rle: 0.1, rte: -0.12, ty: 0.53, tle: -0.27, tte: -0.38 }, engs: [0.17, 0.34], tail: { x: -0.44, span: 0.27 } }),
    airliner({ name: '787', len: [64, 80], fus: 0.064, wing: { rle: 0.1, rte: -0.08, ty: 0.47, tle: -0.2, tte: -0.27 }, engs: [0.18], tail: { x: -0.44, span: 0.2 }, raked: true }),
    zero(), sr71(), b2(), f14(),
  ];

  class Planes {
    constructor(seed) {
      this.rnd = MM.mulberry32((seed ^ 0x3c6ef372) | 0);
      this.list = [];
      this.last = null; // clock of the previous update (seconds)
      this.nextIn = 2 + this.rnd() * 4; // seconds until the next plane appears
      this.nextId = 1;
    }

    /** A plane (a random model) enters from a random screen border and crosses to another one. */
    spawn(v, modelName) {
      const r = this.rnd;
      const m = 110; // starts / ends this far outside the screen
      const edge = (side, u) => (side === 0 ? [u * v.w, -m] : side === 1 ? [v.w + m, u * v.h] : side === 2 ? [u * v.w, v.h + m] : [-m, u * v.h]);
      const s0 = Math.floor(r() * 4);
      const s1 = (s0 + 1 + Math.floor(r() * 3)) % 4; // any other side
      const [x0, y0] = edge(s0, 0.1 + 0.8 * r());
      const [x1, y1] = edge(s1, 0.1 + 0.8 * r());
      const dx = x1 - x0, dy = y1 - y0, dist = Math.hypot(dx, dy) || 1;
      const k = Math.max(0.7, Math.min(1.5, Math.min(v.w, v.h) / 560)); // bigger on big screens
      const model = (modelName && MODELS.find((q) => q.name === modelName)) || MODELS[Math.floor(r() * MODELS.length)];
      const hue = Math.floor(r() * 360);
      const hue2 = (hue + 40 + Math.floor(r() * 200)) % 360; // a second livery colour
      const fast = model.name === 'sr71' || model.name === 'f14' || model.name === 'zero' || model.name === 'b2';
      const p = {
        id: this.nextId++, model,
        x: x0, y: y0, ux: dx / dist, uy: dy / dist, ang: Math.atan2(dy, dx),
        speed: (fast ? 130 + r() * 90 : 85 + r() * 60) * k,
        len: (model.len[0] + r() * (model.len[1] - model.len[0])) * k,
        c1: `hsl(${hue},${70 + Math.floor(r() * 25)}%,${42 + Math.floor(r() * 14)}%)`, // wing stripe colour
        c2: `hsl(${hue2},${70 + Math.floor(r() * 25)}%,${46 + Math.floor(r() * 14)}%)`, // tail fin colour
        ph: r() * TAU,
        left: dist, // distance still to fly
      };
      this.list.push(p);
      return p;
    }

    update(t, v) {
      const dt = this.last === null ? 0 : Math.min(0.25, Math.max(0, t - this.last));
      this.last = t;
      if (!v || !v.w) return;
      for (const p of this.list) {
        const step = p.speed * dt;
        p.x += p.ux * step;
        p.y += p.uy * step;
        p.left -= step;
      }
      this.list = this.list.filter((p) => p.left > 0);
      this.nextIn -= dt;
      if (this.nextIn <= 0) {
        if (this.list.length < 2) this.spawn(v);
        this.nextIn = 9 + this.rnd() * 16;
      }
    }

    /** Paint one plane with its model, in plane units (1 unit = its length). */
    paintModel(ctx, p, sh, now) {
      const L = p.len * p.model.k;
      ctx.scale(L, L);
      p.model.paint(ctx, p, sh, 1 / L, now / 1000);
    }

    /** Soft shadow on the ground (drawn under the clouds). */
    drawShadows(ctx, v) {
      if (!this.list.length) return;
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      for (const p of this.list) {
        ctx.save();
        ctx.translate(p.x + 16, p.y + 26);
        ctx.rotate(p.ang);
        ctx.globalAlpha = 0.16;
        this.paintModel(ctx, p, true, 0);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    /** The planes themselves, with a thin contrail (drawn above the clouds). */
    draw(ctx, v, now) {
      if (!this.list.length) return;
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      const t = now / 1000;
      for (const p of this.list) {
        const L = p.len * p.model.k;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.ang);
        // contrail: two faint white lines streaming back from the engines (the B-2 and SR-71 leave none)
        if (p.model.name !== 'b2' && p.model.name !== 'sr71') {
          const trail = Math.min(L * 3.2, 170);
          for (const side of [-1, 1]) {
            const gr = ctx.createLinearGradient(-L * 0.25, 0, -L * 0.25 - trail, 0);
            gr.addColorStop(0, 'rgba(255,255,255,0.5)');
            gr.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.strokeStyle = gr;
            ctx.lineWidth = Math.max(1.2, L * 0.03);
            ctx.beginPath(); ctx.moveTo(-L * 0.25, side * L * 0.2); ctx.lineTo(-L * 0.25 - trail, side * L * 0.2); ctx.stroke();
          }
        }
        ctx.save();
        this.paintModel(ctx, p, false, now);
        ctx.restore();
        // navigation lights: red on the left wing tip, green on the right, a white strobe at the tail
        const [tx, ty] = p.model.tip;
        ctx.fillStyle = '#ff3b30'; ctx.beginPath(); ctx.arc(tx * L, -ty * L, 1.8, 0, TAU); ctx.fill();
        ctx.fillStyle = '#34d17a'; ctx.beginPath(); ctx.arc(tx * L, ty * L, 1.8, 0, TAU); ctx.fill();
        if (Math.sin(t * 7 + p.ph) > 0.8) { ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(-L * 0.5, 0, 2.2, 0, TAU); ctx.fill(); }
        ctx.restore();
      }
    }
  }

  Planes.MODELS = MODELS;
  MM.Planes = Planes;
})(typeof window !== 'undefined' ? window : globalThis);
