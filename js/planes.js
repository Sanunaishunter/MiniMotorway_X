/* Mini Motorway X — decorative aeroplanes that now and then fly across the sky, each in a random colour.
 * Purely decorative: screen-space only, never reads or changes the simulation. */
(function (root) {
  'use strict';
  const MM = root.MM;
  const TAU = Math.PI * 2;

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
      this.list.push({
        id: this.nextId++,
        x: x0, y: y0, ux: dx / dist, uy: dy / dist, ang: Math.atan2(dy, dx),
        speed: (85 + r() * 70) * k,
        len: (46 + r() * 26) * k,
        hue, sat: 62 + Math.floor(r() * 30), light: 50 + Math.floor(r() * 12),
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
        ctx.beginPath(); ctx.ellipse(0, 0, L * 0.5, L * 0.075, 0, 0, TAU); ctx.fill();
        this.shape(ctx, L, '#1d3a2a');
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
        const body = `hsl(${p.hue},${p.sat}%,${p.light}%)`;
        const wing = `hsl(${p.hue},${p.sat}%,${Math.max(28, p.light - 14)}%)`;
        this.shape(ctx, L, wing);
        ctx.fillStyle = body; // fuselage
        ctx.beginPath(); ctx.ellipse(0, 0, L * 0.5, L * 0.085, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = `hsl(${p.hue},${p.sat}%,${Math.max(20, p.light - 24)}%)`;
        ctx.lineWidth = 0.9;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.85)'; // cockpit
        ctx.beginPath(); ctx.ellipse(L * 0.3, 0, L * 0.06, L * 0.035, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.55)'; // row of windows
        for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.arc(L * 0.16 - i * L * 0.07, 0, L * 0.014, 0, TAU); ctx.fill(); }
        ctx.fillStyle = wing; // engines under the wings
        for (const side of [-1, 1]) { ctx.beginPath(); ctx.ellipse(-L * 0.12, side * L * 0.22, L * 0.07, L * 0.03, 0, 0, TAU); ctx.fill(); }
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
