/* Mini Motorway X — scenery: forest ground, swaying trees, flowing water, drifting clouds and petals.
 * Purely decorative: it only reads the game's seed and terrain, never changes game state. */
(function (root) {
  'use strict';
  const MM = root.MM;
  const C = MM.CFG.CELL;
  const TAU = Math.PI * 2;

  const PAL = {
    patchLight: 'rgba(224,240,176,0.55)',
    patchDark: 'rgba(120,170,100,0.20)',
    tuft: 'rgba(96,150,84,0.55)',
    flowers: ['#ffffff', '#fff3a8', '#ffc9da', '#e6f0ff'],
    round: [
      { dark: '#4f9a5a', mid: '#6db366', light: '#93cc7b' },
      { dark: '#5aa35f', mid: '#7cbc6d', light: '#a2d683' },
      { dark: '#3f8f66', mid: '#58a877', light: '#82c796' },
    ],
    conifer: [
      { dark: '#2f7d5b', mid: '#3f9470', light: '#5bb08a' },
      { dark: '#38855f', mid: '#4aa078', light: '#69bb92' },
    ],
    sakura: [{ dark: '#e99ab4', mid: '#f3b5ca', light: '#fbd3e0' }],
    trunk: '#8a6a4a',
    shadow: 'rgba(38,78,52,0.28)',
  };

  // sprite sizes in world units; the anchor (trunk base) sits 6 units above the bottom
  const SIZE = { round: [34, 40], sakura: [36, 40], conifer: [28, 44], bush: [26, 20] };
  const smooth = (t) => t * t * (3 - 2 * t);
  const mod = (a, b) => ((a % b) + b) % b;

  class Scenery {
    constructor(game) {
      this.game = game;
      const w = game.world;
      const cols = game.cols, rows = game.rows;
      const rnd = MM.mulberry32((game.seed ^ 0x51ed270b) | 0);
      this.rnd = rnd;
      this.q = 0;
      this.sprites = null;
      this.cloudSprites = null;

      // two coarse noise lattices: where the forest is dense / where cherry trees grow
      const S = 5, gw = Math.ceil(cols / S) + 3, gh = Math.ceil(rows / S) + 3;
      const lattice = () => { const a = new Float32Array(gw * gh); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a; };
      const dens = lattice(), sak = lattice();
      const sample = (a, x, y) => {
        const fx = x / S + 1, fy = y / S + 1;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = smooth(fx - ix), ty = smooth(fy - iy);
        const g = (i, j) => a[Math.max(0, Math.min(gh - 1, j)) * gw + Math.max(0, Math.min(gw - 1, i))];
        return (g(ix, iy) * (1 - tx) + g(ix + 1, iy) * tx) * (1 - ty) + (g(ix, iy + 1) * (1 - tx) + g(ix + 1, iy + 1) * tx) * ty;
      };
      // water test that also works one cell outside the board (the ground and the water run off-screen)
      const isWater = (c, r) => w.water[Math.max(0, Math.min(rows - 1, r)) * cols + Math.max(0, Math.min(cols - 1, c))] === 1;
      this.isWaterAt = (x, y) => isWater(Math.floor(x / C), Math.floor(y / C));

      // ---- trees: up to one per quarter of every land cell (so they never sit on a road centre line)
      this.trees = [];
      for (let r = -1; r <= rows; r++) {
        for (let c = -1; c <= cols; c++) {
          if (isWater(c, r)) continue;
          const inBoard = c >= 0 && r >= 0 && c < cols && r < rows;
          const dd = sample(dens, c, r);
          const p = Math.max(0.04, Math.min(0.95, (dd - 0.3) * 2.2));
          for (let sy = -1; sy <= 1; sy += 2) {
            for (let sx = -1; sx <= 1; sx += 2) {
              if (isWater(c + sx, r) || isWater(c, r + sy) || isWater(c + sx, r + sy)) continue; // keep a shore strip
              if (rnd() > p) continue;
              const kindRoll = rnd();
              const grove = sample(sak, c, r) > 0.68;
              let kind = 'round', variant = Math.floor(rnd() * PAL.round.length), size = 0.85 + rnd() * 0.3;
              if (grove && kindRoll < 0.75) { kind = 'sakura'; variant = 0; }
              else if (kindRoll < 0.3) { kind = 'conifer'; variant = Math.floor(rnd() * PAL.conifer.length); }
              else if (kindRoll < 0.42) { kind = 'bush'; variant = Math.floor(rnd() * PAL.round.length); size = 0.8 + rnd() * 0.3; }
              this.trees.push({
                x: (c + 0.5) * C + sx * (13 + rnd() * 6),
                y: (r + 0.5) * C + sy * (13 + rnd() * 6),
                kind, variant, s: size, ph: rnd() * TAU,
                cell: inBoard ? r * cols + c : -1,
              });
            }
          }
        }
      }
      this.trees.sort((a, b) => a.y - b.y);

      // ---- ground decoration (patches of lighter / darker grass, tufts, flowers), also beyond the board edge
      this.patches = []; this.tufts = []; this.flowers = [];
      const area = cols * rows;
      const rx = () => -C + rnd() * (cols + 2) * C, ry = () => -C + rnd() * (rows + 2) * C;
      for (let i = 0; i < area / 14; i++) this.patches.push({ x: rx(), y: ry(), r: 26 + rnd() * 50, light: rnd() < 0.55 });
      for (let i = 0; i < area * 1.1; i++) { const x = rx(), y = ry(); if (!this.isWaterAt(x, y)) this.tufts.push({ x, y, a: (rnd() - 0.5) * 0.9, l: 3 + rnd() * 3 }); }
      for (let i = 0; i < area / 5; i++) { const x = rx(), y = ry(); if (!this.isWaterAt(x, y)) this.flowers.push({ x, y, c: PAL.flowers[Math.floor(rnd() * PAL.flowers.length)], r: 1 + rnd() * 0.9 }); }

      // ---- water: the "core" of every water cell (flow highlights are clipped to it), streaks and sparkles
      const h = C / 2 - C * 0.3, EXT = 5000;
      this.core = new Path2D();
      this.streaks = [];
      this.sparkles = [];
      for (let n = 0; n < w.n; n++) {
        if (!w.water[n]) continue;
        const c = n % cols, r = (n / cols) | 0;
        const x = (c + 0.5) * C, y = (r + 0.5) * C;
        const x0 = c === 0 ? x - h - EXT : x - h, x1 = c === cols - 1 ? x + h + EXT : x + h;
        const y0 = r === 0 ? y - h - EXT : y - h, y1 = r === rows - 1 ? y + h + EXT : y + h;
        this.core.rect(x0, y0, x1 - x0, y1 - y0);
        const e = w.nbGrid(n, 1), s = w.nbGrid(n, 2);
        if (e >= 0 && w.water[e]) this.core.rect(x - h, y0, C + 2 * h, y1 - y0);
        if (s >= 0 && w.water[s]) this.core.rect(x0, y - h, x1 - x0, C + 2 * h);
        if (e >= 0 && s >= 0 && w.water[e] && w.water[s] && w.water[s + 1]) this.core.rect(x + h, y + h, C - 2 * h, C - 2 * h);
        for (let k = 0; k < 2; k++) this.streaks.push({ x: x + (rnd() - 0.5) * 30, y: y + (rnd() - 0.5) * 30, ph: rnd(), sp: 0.07 + rnd() * 0.06, len: 9 + rnd() * 8, amp: 1.6 + rnd() * 1.6, w: 1.2 + rnd() * 0.8 });
        if (rnd() < 0.55) this.sparkles.push({ x: x + (rnd() - 0.5) * 30, y: y + (rnd() - 0.5) * 30, ph: rnd() * TAU, sp: 1.2 + rnd() * 1.6 });
      }

      // ---- sky: a few clouds (with shadows on the ground) and drifting petals; screen space, mild parallax
      this.clouds = [];
      for (let i = 0; i < 4; i++) this.clouds.push({ u: rnd(), v: 0.08 + rnd() * 0.84, sp: 5 + rnd() * 7, s: 0.8 + rnd() * 0.8, variant: i % 3 });
      this.petals = [];
      for (let i = 0; i < 16; i++) this.petals.push({ u: rnd(), v: rnd(), sp: 7 + rnd() * 9, fall: 10 + rnd() * 8, ph: rnd() * TAU, s: 0.8 + rnd() * 0.7 });
    }

    // ------------------------------------------------------------ ground (drawn into the static layer, world coordinates)
    drawGround(ctx) {
      for (const p of this.patches) {
        ctx.fillStyle = p.light ? PAL.patchLight : PAL.patchDark;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.r, p.r * 0.72, 0, 0, TAU);
        ctx.fill();
      }
      ctx.strokeStyle = PAL.tuft;
      ctx.lineWidth = 1.1;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const t of this.tufts) {
        ctx.moveTo(t.x, t.y); ctx.lineTo(t.x + Math.sin(t.a) * t.l, t.y - Math.cos(t.a) * t.l);
        ctx.moveTo(t.x + 2, t.y + 0.5); ctx.lineTo(t.x + 2 + Math.sin(t.a + 0.5) * t.l * 0.8, t.y + 0.5 - Math.cos(t.a + 0.5) * t.l * 0.8);
      }
      ctx.stroke();
      for (const f of this.flowers) {
        ctx.fillStyle = f.c;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, TAU);
        ctx.fill();
      }
    }

    // ------------------------------------------------------------ sprites
    setScale(k) {
      const q = Math.pow(2, Math.round(Math.log2(Math.max(0.2, k)) * 2) / 2); // quantised so zooming does not rebuild every frame
      if (q !== this.q) { this.q = q; this.sprites = null; }
    }

    makeSprite(kind, variant) {
      const [W, H] = SIZE[kind];
      const q = this.q;
      const cv = document.createElement('canvas');
      cv.width = Math.ceil(W * q); cv.height = Math.ceil(H * q);
      const c = cv.getContext('2d');
      c.scale(q, q);
      const bx = W / 2, by = H - 6;
      c.fillStyle = PAL.shadow;
      c.beginPath(); c.ellipse(bx + 2, by + 1, W * 0.3, 4, 0, 0, TAU); c.fill();
      const dot = (x, y, r, col, a) => { c.globalAlpha = a == null ? 1 : a; c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); c.globalAlpha = 1; };
      if (kind === 'round' || kind === 'sakura') {
        const pal = (kind === 'round' ? PAL.round : PAL.sakura)[variant];
        c.fillStyle = PAL.trunk; c.fillRect(bx - 1.6, by - 10, 3.2, 10);
        dot(bx - 7, by - 11, 6.5, pal.dark); dot(bx + 7.5, by - 11.5, 6.5, pal.dark); dot(bx, by - 14, 11.5, pal.dark);
        dot(bx - 1.5, by - 16, 9.8, pal.mid); dot(bx + 5, by - 14, 5.5, pal.mid);
        dot(bx - 4.5, by - 19.5, 5.2, pal.light, 0.9);
        if (kind === 'sakura') { dot(bx + 3, by - 19, 1.6, '#fff', 0.8); dot(bx - 8, by - 12, 1.4, '#fff', 0.7); dot(bx + 8, by - 9, 1.5, '#fff', 0.7); }
      } else if (kind === 'conifer') {
        const pal = PAL.conifer[variant];
        c.fillStyle = PAL.trunk; c.fillRect(bx - 1.4, by - 5, 2.8, 6);
        const tier = (y, hw, hh, col) => { c.fillStyle = col; c.beginPath(); c.moveTo(bx, y - hh); c.lineTo(bx + hw, y); c.lineTo(bx - hw, y); c.closePath(); c.fill(); };
        tier(by - 3, 11.5, 15, pal.dark); tier(by - 12, 9.5, 14, pal.mid); tier(by - 21, 7, 13, pal.mid);
        c.fillStyle = pal.light; c.globalAlpha = 0.55; c.beginPath(); c.moveTo(bx - 1, by - 33); c.lineTo(bx - 6.5, by - 21.5); c.lineTo(bx - 1, by - 21.5); c.closePath(); c.fill(); c.globalAlpha = 1;
      } else {
        const pal = PAL.round[variant];
        dot(bx - 4.5, by - 4, 5.8, pal.dark); dot(bx + 5, by - 4.5, 5.2, pal.dark); dot(bx, by - 7.5, 6.6, pal.mid); dot(bx - 2, by - 9, 3.2, pal.light, 0.85);
      }
      return { cv, W, H, ax: bx, ay: by };
    }

    sprite(kind, variant) {
      if (!this.sprites) this.sprites = {};
      const key = kind + variant;
      return this.sprites[key] || (this.sprites[key] = this.makeSprite(kind, variant));
    }

    // ------------------------------------------------------------ everything that sits between the ground and the roads
    drawBehind(ctx, v, t, world) {
      const dpr = v.dpr;
      this.setScale(dpr * v.scale);

      // ---- flowing water
      ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.ox, dpr * v.oy);
      ctx.save();
      ctx.clip(this.core);
      const x0 = -v.ox / v.scale - 40, x1 = (v.w - v.ox) / v.scale + 40, y0 = -v.oy / v.scale - 40, y1 = (v.h - v.oy) / v.scale + 40;
      ctx.globalAlpha = 0.10 + 0.07 * Math.sin(t * 0.9);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#ffffff';
      for (const s of this.streaks) {
        if (s.x < x0 || s.x > x1 || s.y < y0 || s.y > y1) continue;
        const ph = mod(t * s.sp + s.ph, 1); // 0..1 along its short run, fading in and out
        const x = s.x + (ph - 0.5) * 46;
        const y = s.y + Math.sin(x * 0.09 + t * 1.2 + s.ph * 6) * 1.6;
        ctx.globalAlpha = Math.sin(ph * Math.PI) * 0.5;
        ctx.lineWidth = s.w;
        ctx.beginPath();
        ctx.moveTo(x - s.len, y);
        ctx.quadraticCurveTo(x - s.len / 2, y - s.amp, x, y);
        ctx.quadraticCurveTo(x + s.len / 2, y + s.amp, x + s.len, y);
        ctx.stroke();
      }
      ctx.fillStyle = '#ffffff';
      for (const p of this.sparkles) {
        if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
        const a = Math.max(0, Math.sin(t * p.sp + p.ph));
        if (a < 0.6) continue;
        ctx.globalAlpha = (a - 0.6) * 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.5, 0, TAU); ctx.fill();
      }
      ctx.restore();
      ctx.globalAlpha = 1;

      // ---- trees (sorted by y, drawn back to front), swaying in the wind
      const trees = this.trees;
      const k = dpr * v.scale;
      let lo = 0, hi = trees.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (trees[m].y < y0 - 10) lo = m + 1; else hi = m; }
      for (let i = lo; i < trees.length; i++) {
        const tr = trees[i];
        if (tr.y > y1 + 46) break;
        if (tr.x < x0 || tr.x > x1) continue;
        if (tr.cell >= 0 && (world.bld[tr.cell] || world.island[tr.cell] || world.ringId[tr.cell])) continue; // cleared for a building
        const sp = this.sprite(tr.kind, tr.variant);
        const sway = Math.sin(t * 1.15 + tr.ph) * 0.045 + Math.sin(t * 0.35 + tr.x * 0.012) * 0.035;
        const sc = k * tr.s;
        ctx.setTransform(sc, 0, sc * sway, sc, (v.ox + tr.x * v.scale) * dpr, (v.oy + tr.y * v.scale) * dpr);
        ctx.drawImage(sp.cv, -sp.ax, -sp.ay, sp.W, sp.H);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ------------------------------------------------------------ the sky: cloud shadows, clouds, petals (screen space)
    makeClouds(dpr) {
      const mk = (shadow, variant) => {
        const W = 260, H = 130;
        const cv = document.createElement('canvas');
        cv.width = Math.ceil(W * dpr); cv.height = Math.ceil(H * dpr);
        const c = cv.getContext('2d');
        c.scale(dpr, dpr);
        const sets = [
          [[0.28, 0.62, 0.2], [0.44, 0.48, 0.26], [0.62, 0.56, 0.23], [0.78, 0.66, 0.16], [0.16, 0.72, 0.13]],
          [[0.22, 0.6, 0.18], [0.4, 0.5, 0.22], [0.55, 0.42, 0.2], [0.7, 0.55, 0.24], [0.86, 0.68, 0.14]],
          [[0.3, 0.66, 0.2], [0.5, 0.5, 0.3], [0.72, 0.64, 0.2]],
        ][variant];
        for (const [fx, fy, fr] of sets) {
          const x = fx * W, y = fy * H, r = fr * W;
          const g = c.createRadialGradient(x, y, r * 0.15, x, y, r);
          const col = shadow ? '28,70,48' : '255,255,255';
          g.addColorStop(0, `rgba(${col},0.95)`);
          g.addColorStop(0.55, `rgba(${col},0.65)`);
          g.addColorStop(1, `rgba(${col},0)`);
          c.fillStyle = g;
          c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
        }
        return { cv, W, H };
      };
      return { cloud: [0, 1, 2].map((i) => mk(false, i)), shadow: [0, 1, 2].map((i) => mk(true, i)) };
    }

    drawSky(ctx, v, t) {
      const dpr = v.dpr;
      if (!this.cloudSprites || this.cloudDpr !== dpr) { this.cloudSprites = this.makeClouds(dpr); this.cloudDpr = dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const par = (n) => n * 0.22; // the sky drifts slower than the ground when you pan
      for (const cl of this.clouds) {
        const sh = this.cloudSprites.shadow[cl.variant], cd = this.cloudSprites.cloud[cl.variant];
        const w = sh.W * cl.s, h = sh.H * cl.s, span = v.w + 2 * w;
        const x = mod(cl.u * span + t * cl.sp - par(v.ox), span) - w;
        const y = cl.v * v.h - par(v.oy) - h / 2;
        ctx.globalAlpha = 0.11; // kept faint: a cloud must never hide a house or a pin
        ctx.drawImage(sh.cv, x + w * 0.16, y + 34 * cl.s, w, h);
        ctx.globalAlpha = 0.27;
        ctx.drawImage(cd.cv, x, y, w, h);
      }
      // petals drifting in the breeze
      ctx.globalAlpha = 0.85;
      for (const p of this.petals) {
        const x = mod(p.u * v.w + t * p.sp + Math.sin(t * 0.7 + p.ph) * 12, v.w + 20) - 10;
        const y = mod(p.v * v.h + t * p.fall, v.h + 20) - 10;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(t * 1.3 + p.ph);
        ctx.scale(p.s, p.s * (0.55 + 0.45 * Math.abs(Math.sin(t * 1.9 + p.ph))));
        ctx.fillStyle = '#f9c3d4';
        ctx.beginPath(); ctx.ellipse(0, 0, 3.4, 2.1, 0, 0, TAU); ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  }

  MM.Scenery = Scenery;
})(typeof window !== 'undefined' ? window : globalThis);
