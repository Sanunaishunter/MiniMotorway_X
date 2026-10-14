/* Mini Motorway X — decorative white airliners that now and then fly across the sky, each with its own random stripe livery.
 * Purely decorative: screen-space only, never reads or changes the simulation. */
(function (root) {
  'use strict';
  const MM = root.MM;
  const TAU = Math.PI * 2;

  // livery stripe styles (all seen from above, along / across the fuselage)
  const STYLES = ['line', 'double', 'bands', 'diag', 'caps', 'dashes', 'wave'];

  class Planes {
    constructor(seed) {
      this.rnd = MM.mulberry32((seed ^ 0x3c6ef372) | 0);
      this.list = [];
      this.last = null; // clock of the previous update (seconds)
      this.nextIn = 2 + this.rnd() * 4; // seconds until the next plane appears
      this.nextId = 1;
    }

    /** A plane enters from a random screen border and crosses to another one. */
    spawn(v) {
      const r = this.rnd;
      const m = 90; // starts / ends this far outside the screen
      const edge = (side, u) => (side === 0 ? [u * v.w, -m] : side === 1 ? [v.w + m, u * v.h] : side === 2 ? [u * v.w, v.h + m] : [-m, u * v.h]);
      const s0 = Math.floor(r() * 4);
      const s1 = (s0 + 1 + Math.floor(r() * 3)) % 4; // any other side
      const [x0, y0] = edge(s0, 0.1 + 0.8 * r());
      const [x1, y1] = edge(s1, 0.1 + 0.8 * r());
      const dx = x1 - x0, dy = y1 - y0, dist = Math.hypot(dx, dy) || 1;
      const k = Math.max(0.7, Math.min(1.5, Math.min(v.w, v.h) / 560)); // bigger on big screens
      const hue = Math.floor(r() * 360);
      const hue2 = (hue + 40 + Math.floor(r() * 200)) % 360; // a second livery colour
      this.list.push({
        id: this.nextId++,
        x: x0, y: y0, ux: dx / dist, uy: dy / dist, ang: Math.atan2(dy, dx),
        speed: (85 + r() * 70) * k,
        len: (46 + r() * 26) * k,
        style: STYLES[Math.floor(r() * STYLES.length)],
        c1: `hsl(${hue},${70 + Math.floor(r() * 25)}%,${42 + Math.floor(r() * 14)}%)`,
        c2: `hsl(${hue2},${70 + Math.floor(r() * 25)}%,${46 + Math.floor(r() * 14)}%)`,
        ph: r() * TAU,
        left: dist, // distance still to fly
      });
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

    /** The silhouette (nose to +x), in local units of the plane's length. */
    shape(ctx, L, wing) {
      ctx.beginPath(); // main wings, swept back
      ctx.moveTo(L * 0.08, 0);
      ctx.lineTo(-L * 0.16, -L * 0.5); ctx.lineTo(-L * 0.27, -L * 0.5); ctx.lineTo(-L * 0.12, 0);
      ctx.lineTo(-L * 0.27, L * 0.5); ctx.lineTo(-L * 0.16, L * 0.5);
      ctx.closePath();
      ctx.fillStyle = wing; ctx.fill();
      ctx.beginPath(); // tail plane
      ctx.moveTo(-L * 0.34, 0);
      ctx.lineTo(-L * 0.47, -L * 0.2); ctx.lineTo(-L * 0.53, -L * 0.2); ctx.lineTo(-L * 0.45, 0);
      ctx.lineTo(-L * 0.53, L * 0.2); ctx.lineTo(-L * 0.47, L * 0.2);
      ctx.closePath();
      ctx.fill();
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
        ctx.fillStyle = '#1d3a2a';
        const L = p.len;
        ctx.beginPath(); ctx.ellipse(0, 0, L * 0.5, L * 0.085, 0, 0, TAU); ctx.fill();
        this.shape(ctx, L, '#1d3a2a');
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    /** The livery stripes, drawn inside the fuselage (the caller has clipped to it). */
    stripes(ctx, p, L) {
      const w = L * 0.085; // fuselage half-width
      ctx.lineCap = 'butt';
      switch (p.style) {
        case 'line': // one stripe down the middle
          ctx.fillStyle = p.c1; ctx.fillRect(-L * 0.5, -w * 0.26, L, w * 0.52);
          break;
        case 'double': // two thin stripes in two colours
          ctx.fillStyle = p.c1; ctx.fillRect(-L * 0.5, -w * 0.62, L, w * 0.26);
          ctx.fillStyle = p.c2; ctx.fillRect(-L * 0.5, w * 0.36, L, w * 0.26);
          break;
        case 'bands': // bands across the fuselage
          for (let i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? p.c2 : p.c1; ctx.fillRect(L * 0.36 - i * L * 0.2, -w, L * 0.07, w * 2); }
          break;
        case 'diag': // diagonal slashes
          ctx.strokeStyle = p.c1; ctx.lineWidth = L * 0.04;
          for (let i = 0; i < 6; i++) { const x = L * 0.4 - i * L * 0.14; ctx.beginPath(); ctx.moveTo(x, -w); ctx.lineTo(x - w * 1.1, w); ctx.stroke(); }
          ctx.strokeStyle = p.c2; ctx.lineWidth = L * 0.012;
          for (let i = 0; i < 6; i++) { const x = L * 0.4 - i * L * 0.14 + L * 0.03; ctx.beginPath(); ctx.moveTo(x, -w); ctx.lineTo(x - w * 1.1, w); ctx.stroke(); }
          break;
        case 'caps': // coloured nose and tail, a thin line between them
          ctx.fillStyle = p.c1; ctx.fillRect(L * 0.3, -w, L * 0.25, w * 2);
          ctx.fillStyle = p.c2; ctx.fillRect(-L * 0.56, -w, L * 0.24, w * 2);
          ctx.fillStyle = p.c1; ctx.fillRect(-L * 0.32, -w * 0.12, L * 0.62, w * 0.24);
          break;
        case 'dashes': // a dashed line
          ctx.fillStyle = p.c1;
          for (let i = 0; i < 9; i++) ctx.fillRect(L * 0.44 - i * L * 0.11, -w * 0.2, L * 0.065, w * 0.4);
          ctx.fillStyle = p.c2; ctx.fillRect(L * 0.1, -w * 0.9, L * 0.4, w * 0.18); ctx.fillRect(L * 0.1, w * 0.72, L * 0.4, w * 0.18);
          break;
        default: { // a wave
          ctx.strokeStyle = p.c1; ctx.lineWidth = w * 0.42;
          ctx.beginPath();
          for (let i = 0; i <= 24; i++) { const x = L * 0.5 - (i / 24) * L; const y = Math.sin(i * 0.9) * w * 0.55; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
          ctx.stroke();
          ctx.strokeStyle = p.c2; ctx.lineWidth = w * 0.18;
          ctx.beginPath();
          for (let i = 0; i <= 24; i++) { const x = L * 0.5 - (i / 24) * L; const y = Math.sin(i * 0.9 + 1.4) * w * 0.55; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
          ctx.stroke();
        }
      }
    }

    /** The planes themselves: white airliners with a livery and a thin contrail (drawn above the clouds). */
    draw(ctx, v, now) {
      if (!this.list.length) return;
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      const t = now / 1000;
      for (const p of this.list) {
        const L = p.len;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.ang);
        // contrail: two faint white lines streaming back from the engines
        const trail = Math.min(L * 3.2, 170);
        for (const side of [-1, 1]) {
          const gr = ctx.createLinearGradient(-L * 0.25, 0, -L * 0.25 - trail, 0);
          gr.addColorStop(0, 'rgba(255,255,255,0.55)');
          gr.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.strokeStyle = gr;
          ctx.lineWidth = Math.max(1.2, L * 0.035);
          ctx.beginPath(); ctx.moveTo(-L * 0.25, side * L * 0.2); ctx.lineTo(-L * 0.25 - trail, side * L * 0.2); ctx.stroke();
        }
        ctx.lineJoin = 'round';
        // wings and tail plane: white-grey with a fine outline
        ctx.strokeStyle = '#9fb0c4'; ctx.lineWidth = 0.9;
        this.shape(ctx, L, '#eef3f9');
        ctx.save(); // (outline pass: redraw the same silhouette as strokes)
        ctx.beginPath();
        ctx.moveTo(L * 0.08, 0); ctx.lineTo(-L * 0.16, -L * 0.5); ctx.lineTo(-L * 0.27, -L * 0.5); ctx.lineTo(-L * 0.12, 0);
        ctx.lineTo(-L * 0.27, L * 0.5); ctx.lineTo(-L * 0.16, L * 0.5); ctx.closePath(); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = p.c1; // wing tips in the livery colour
        for (const side of [-1, 1]) {
          ctx.beginPath(); ctx.moveTo(-L * 0.16, side * L * 0.5); ctx.lineTo(-L * 0.27, side * L * 0.5); ctx.lineTo(-L * 0.235, side * L * 0.4); ctx.lineTo(-L * 0.17, side * L * 0.4); ctx.closePath(); ctx.fill();
        }
        // fuselage: white, with the stripes clipped inside it
        ctx.beginPath(); ctx.ellipse(0, 0, L * 0.5, L * 0.085, 0, 0, TAU);
        ctx.fillStyle = '#ffffff'; ctx.fill();
        ctx.save();
        ctx.clip();
        this.stripes(ctx, p, L);
        ctx.restore();
        ctx.strokeStyle = '#9fb0c4'; ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.ellipse(0, 0, L * 0.5, L * 0.085, 0, 0, TAU); ctx.stroke();
        ctx.fillStyle = p.c2; // the fin on the tail (seen from above: a short stripe)
        ctx.fillRect(-L * 0.5, -L * 0.012, L * 0.15, L * 0.024);
        ctx.fillStyle = 'rgba(60,90,130,0.85)'; // cockpit windows
        ctx.beginPath(); ctx.ellipse(L * 0.36, 0, L * 0.04, L * 0.04, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#b5c3d4'; // engines under the wings, with a coloured intake
        for (const side of [-1, 1]) {
          ctx.beginPath(); ctx.ellipse(-L * 0.12, side * L * 0.22, L * 0.07, L * 0.032, 0, 0, TAU); ctx.fill();
          ctx.fillStyle = p.c1; ctx.beginPath(); ctx.ellipse(-L * 0.065, side * L * 0.22, L * 0.016, L * 0.03, 0, 0, TAU); ctx.fill();
          ctx.fillStyle = '#b5c3d4';
        }
        // navigation lights: red on the left wing tip, green on the right, a white strobe on the tail
        ctx.fillStyle = '#ff3b30'; ctx.beginPath(); ctx.arc(-L * 0.22, -L * 0.5, 1.8, 0, TAU); ctx.fill();
        ctx.fillStyle = '#34d17a'; ctx.beginPath(); ctx.arc(-L * 0.22, L * 0.5, 1.8, 0, TAU); ctx.fill();
        if (Math.sin(t * 7 + p.ph) > 0.8) { ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(-L * 0.5, 0, 2.2, 0, TAU); ctx.fill(); }
        ctx.restore();
      }
    }
  }

  MM.Planes = Planes;
})(typeof window !== 'undefined' ? window : globalThis);
