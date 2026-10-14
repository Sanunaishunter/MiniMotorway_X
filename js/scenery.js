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
    snowShadow: 'rgba(80,110,150,0.30)',
    snowTree: { dark: '#3f7567', mid: '#5a9484', light: '#79b0a0' }, // evergreens in the snow are a cold, bluish green
    snow: '#f7fbff',
    snowShade: '#dce8f4',
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

      // coarse value-noise fields: where the forest is dense / where cherry trees grow / where the snowfields lie
      const field = (S) => {
        const gw = Math.ceil(cols / S) + 3, gh = Math.ceil(rows / S) + 3;
        const a = new Float32Array(gw * gh);
        for (let i = 0; i < a.length; i++) a[i] = rnd();
        return (x, y) => {
          const fx = x / S + 1, fy = y / S + 1;
          const ix = Math.floor(fx), iy = Math.floor(fy);
          const tx = smooth(fx - ix), ty = smooth(fy - iy);
          const g = (i, j) => a[Math.max(0, Math.min(gh - 1, j)) * gw + Math.max(0, Math.min(gw - 1, i))];
          return (g(ix, iy) * (1 - tx) + g(ix + 1, iy) * tx) * (1 - ty) + (g(ix, iy + 1) * (1 - tx) + g(ix + 1, iy + 1) * tx) * ty;
        };
      };
      const dens = field(5), sak = field(5), snowF = field(7);
      const sample = (f, x, y) => f(x, y);
      // the snowfields: the coldest ~30% of the board
      const sv = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) sv.push(snowF(c, r));
      sv.sort((a, b) => a - b);
      this.snowTh = sv[Math.floor(sv.length * 0.7)];
      this.snowAt = (x, y) => snowF(x / C - 0.5, y / C - 0.5); // noise value at a world position
      this.isSnowAt = (x, y) => this.snowAt(x, y) > this.snowTh;
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
              const tx = (c + 0.5) * C + sx * (13 + rnd() * 6), ty = (r + 0.5) * C + sy * (13 + rnd() * 6);
              const snowy = this.isSnowAt(tx, ty);
              const grove = sample(sak, c, r) > 0.68;
              let kind = 'round', variant = Math.floor(rnd() * PAL.round.length), size = 0.85 + rnd() * 0.3;
              if (snowy) { // snowfield: mostly snow-laden evergreens, a few bare-ish round trees and snow mounds
                if (kindRoll < 0.7) { kind = 'conifer'; variant = Math.floor(rnd() * PAL.conifer.length); }
                else if (kindRoll < 0.86) kind = 'round';
                else { kind = 'bush'; size = 0.8 + rnd() * 0.3; }
              } else if (grove && kindRoll < 0.75) { kind = 'sakura'; variant = 0; }
              else if (kindRoll < 0.3) { kind = 'conifer'; variant = Math.floor(rnd() * PAL.conifer.length); }
              else if (kindRoll < 0.42) { kind = 'bush'; variant = Math.floor(rnd() * PAL.round.length); size = 0.8 + rnd() * 0.3; }
              this.trees.push({
                x: tx, y: ty,
                kind, variant, s: size, ph: rnd() * TAU, snow: snowy,
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

      // ---- snowfields: soft blobs on a coarse grid (cells well inside a field get big ones, the rim gets small ones), sparkles, drifts
      this.snowBlobs = []; this.snowSpark = []; this.snowDrift = [];
      for (let r = -3; r <= rows + 2; r++) {
        for (let c = -3; c <= cols + 2; c++) {
          const v = snowF(Math.max(-0.5, Math.min(cols - 0.5, c)), Math.max(-0.5, Math.min(rows - 0.5, r)));
          if (v <= this.snowTh) continue;
          const k = Math.min(1, (v - this.snowTh) * 3.2);
          const x = (c + 0.5) * C, y = (r + 0.5) * C;
          this.snowBlobs.push({ x: x + (rnd() - 0.5) * 10, y: y + (rnd() - 0.5) * 10, r: C * (0.5 + 0.3 * k) + rnd() * 4 });
          if (rnd() < 0.8) this.snowSpark.push({ x: x + (rnd() - 0.5) * C, y: y + (rnd() - 0.5) * C, r: 0.8 + rnd() * 0.9 });
          if (rnd() < 0.35) this.snowDrift.push({ x: x + (rnd() - 0.5) * C, y: y + (rnd() - 0.5) * C, l: 8 + rnd() * 12 });
        }
      }
      this.flakes = [];
      for (let i = 0; i < 70; i++) this.flakes.push({ u: rnd(), v: rnd(), sp: 6 + rnd() * 10, fall: 22 + rnd() * 22, ph: rnd() * TAU, r: 1 + rnd() * 1.4 });

      // ---- water (now ice): the "core" of every water cell (cracks and frost are clipped to it), plus glints
      const h = C / 2 - C * 0.3, EXT = 5000;
      this.core = new Path2D();
      this.cracks = [];
      this.frost = [];
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
        // the water is a sheet of ice: cracks (a jagged line, sometimes with a branch) and pale frost patches
        for (let k = 0; k < 2; k++) {
          let px = x + (rnd() - 0.5) * 30, py = y + (rnd() - 0.5) * 30, a = rnd() * TAU;
          const pts = [[px, py]];
          const n = 3 + Math.floor(rnd() * 3);
          for (let i = 0; i < n; i++) { a += (rnd() - 0.5) * 1.4; const l = 6 + rnd() * 8; px += Math.cos(a) * l; py += Math.sin(a) * l; pts.push([px, py]); }
          const branch = rnd() < 0.4 ? [pts[1 + Math.floor(rnd() * (pts.length - 2))], a + (rnd() < 0.5 ? 1 : -1) * (0.7 + rnd() * 0.5), 5 + rnd() * 6] : null;
          this.cracks.push({ pts, branch, x, y });
        }
        if (rnd() < 0.7) this.frost.push({ x: x + (rnd() - 0.5) * 24, y: y + (rnd() - 0.5) * 24, rx: 8 + rnd() * 10, ry: 4 + rnd() * 6, a: rnd() * Math.PI });
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
      // snowfields over the grass: a bluish rim first, then the white
      if (this.snowBlobs.length) {
        ctx.fillStyle = PAL.snowShade;
        ctx.beginPath();
        for (const b of this.snowBlobs) { ctx.moveTo(b.x + b.r + 3, b.y + 1.5); ctx.arc(b.x, b.y + 1.5, b.r + 3, 0, TAU); }
        ctx.fill();
        ctx.fillStyle = PAL.snow;
        ctx.beginPath();
        for (const b of this.snowBlobs) { ctx.moveTo(b.x + b.r, b.y); ctx.arc(b.x, b.y, b.r, 0, TAU); }
        ctx.fill();
        ctx.strokeStyle = 'rgba(150,185,220,0.55)'; // wind-blown drifts
        ctx.lineWidth = 1.2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (const d of this.snowDrift) { ctx.moveTo(d.x, d.y); ctx.quadraticCurveTo(d.x + d.l * 0.5, d.y - 2.5, d.x + d.l, d.y); }
        ctx.stroke();
        ctx.fillStyle = 'rgba(190,225,255,0.95)'; // glints
        ctx.beginPath();
        for (const p of this.snowSpark) { ctx.moveTo(p.x + p.r, p.y); ctx.arc(p.x, p.y, p.r, 0, TAU); }
        ctx.fill();
      }
    }

    // ------------------------------------------------------------ sprites
    setScale(k) {
      const q = Math.pow(2, Math.round(Math.log2(Math.max(0.2, k)) * 2) / 2); // quantised so zooming does not rebuild every frame
      if (q !== this.q) { this.q = q; this.sprites = null; }
    }

    makeSprite(kind, variant, snow) {
      const [W, H] = SIZE[kind];
      const q = this.q;
      const cv = document.createElement('canvas');
      cv.width = Math.ceil(W * q); cv.height = Math.ceil(H * q);
      const c = cv.getContext('2d');
      c.scale(q, q);
      const bx = W / 2, by = H - 6;
      c.fillStyle = snow ? PAL.snowShadow : PAL.shadow;
      c.beginPath(); c.ellipse(bx + 2, by + 1, W * 0.3, 4, 0, 0, TAU); c.fill();
      const dot = (x, y, r, col, a) => { c.globalAlpha = a == null ? 1 : a; c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); c.globalAlpha = 1; };
      if (kind === 'round' || kind === 'sakura') {
        const pal = snow ? PAL.snowTree : (kind === 'round' ? PAL.round : PAL.sakura)[variant];
        c.fillStyle = PAL.trunk; c.fillRect(bx - 1.6, by - 10, 3.2, 10);
        dot(bx - 7, by - 11, 6.5, pal.dark); dot(bx + 7.5, by - 11.5, 6.5, pal.dark); dot(bx, by - 14, 11.5, pal.dark);
        dot(bx - 1.5, by - 16, 9.8, pal.mid); dot(bx + 5, by - 14, 5.5, pal.mid);
        dot(bx - 4.5, by - 19.5, 5.2, pal.light, 0.9);
        if (kind === 'sakura') { dot(bx + 3, by - 19, 1.6, '#fff', 0.8); dot(bx - 8, by - 12, 1.4, '#fff', 0.7); dot(bx + 8, by - 9, 1.5, '#fff', 0.7); }
        if (snow) { dot(bx - 1.5, by - 21, 7.6, PAL.snow); dot(bx + 5.5, by - 17.5, 4, PAL.snow); dot(bx - 7.5, by - 16, 3.6, PAL.snow); dot(bx - 3, by - 22.5, 3.4, '#ffffff'); }
      } else if (kind === 'conifer') {
        const pal = PAL.conifer[variant];
        c.fillStyle = PAL.trunk; c.fillRect(bx - 1.4, by - 5, 2.8, 6);
        const tier = (y, hw, hh, col) => { c.fillStyle = col; c.beginPath(); c.moveTo(bx, y - hh); c.lineTo(bx + hw, y); c.lineTo(bx - hw, y); c.closePath(); c.fill(); };
        tier(by - 3, 11.5, 15, pal.dark); tier(by - 12, 9.5, 14, pal.mid); tier(by - 21, 7, 13, pal.mid);
        if (snow) { // a cap of snow on every tier
          const cap = (y, hw, hh) => {
            c.fillStyle = PAL.snow;
            c.beginPath(); c.moveTo(bx, y - hh); c.lineTo(bx + hw * 0.66, y - hh * 0.36); c.lineTo(bx + hw * 0.3, y - hh * 0.5); c.lineTo(bx + hw * 0.05, y - hh * 0.3);
            c.lineTo(bx - hw * 0.28, y - hh * 0.5); c.lineTo(bx - hw * 0.66, y - hh * 0.36); c.closePath(); c.fill();
            c.fillStyle = PAL.snowShade; c.beginPath(); c.moveTo(bx + hw * 0.05, y - hh * 0.3); c.lineTo(bx + hw * 0.3, y - hh * 0.5); c.lineTo(bx + hw * 0.66, y - hh * 0.36); c.lineTo(bx + hw * 0.4, y - hh * 0.3); c.closePath(); c.fill();
          };
          cap(by - 3, 11.5, 15); cap(by - 12, 9.5, 14); cap(by - 21, 7, 13);
        }
        c.fillStyle = pal.light; c.globalAlpha = snow ? 0 : 0.55; c.beginPath(); c.moveTo(bx - 1, by - 33); c.lineTo(bx - 6.5, by - 21.5); c.lineTo(bx - 1, by - 21.5); c.closePath(); c.fill(); c.globalAlpha = 1;
      } else {
        const pal = PAL.round[variant];
        if (snow) { // a snow-covered shrub: a white mound with a bit of green showing
          dot(bx - 4.5, by - 4, 5.8, PAL.snowShade); dot(bx + 5, by - 4.5, 5.2, PAL.snowShade); dot(bx, by - 7.5, 6.8, PAL.snow); dot(bx - 2, by - 9, 3.4, '#ffffff');
          dot(bx + 3.5, by - 2.5, 2.2, PAL.snowTree.dark);
        } else {
          dot(bx - 4.5, by - 4, 5.8, pal.dark); dot(bx + 5, by - 4.5, 5.2, pal.dark); dot(bx, by - 7.5, 6.6, pal.mid); dot(bx - 2, by - 9, 3.2, pal.light, 0.85);
        }
      }
      return { cv, W, H, ax: bx, ay: by };
    }

    sprite(kind, variant, snow) {
      if (!this.sprites) this.sprites = {};
      const key = kind + variant + (snow ? 's' : '');
      return this.sprites[key] || (this.sprites[key] = this.makeSprite(kind, variant, snow));
    }

    // ------------------------------------------------------------ everything that sits between the ground and the roads
    /** `zoom` = camera zoom (1 = whole map): the trees only sway once the player has zoomed in on them. */
    drawBehind(ctx, v, t, world, zoom) {
      const dpr = v.dpr;
      this.setScale(dpr * v.scale);

      // ---- the ice: frost patches, cracks and a few twinkling glints (nothing flows: the water is frozen over)
      ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.ox, dpr * v.oy);
      ctx.save();
      ctx.clip(this.core);
      const x0 = -v.ox / v.scale - 40, x1 = (v.w - v.ox) / v.scale + 40, y0 = -v.oy / v.scale - 40, y1 = (v.h - v.oy) / v.scale + 40;
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ffffff';
      for (const f of this.frost) {
        if (f.x < x0 || f.x > x1 || f.y < y0 || f.y > y1) continue;
        ctx.globalAlpha = 0.38;
        ctx.beginPath(); ctx.ellipse(f.x, f.y, f.rx, f.ry, f.a, 0, TAU); ctx.fill();
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass ? 'rgba(255,255,255,0.9)' : 'rgba(70,130,175,0.35)';
        ctx.lineWidth = pass ? 0.9 : 1.7;
        ctx.globalAlpha = 1;
        const oy = pass ? 0 : 1;
        ctx.beginPath();
        for (const c of this.cracks) {
          if (c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1) continue;
          ctx.moveTo(c.pts[0][0], c.pts[0][1] + oy);
          for (let i = 1; i < c.pts.length; i++) ctx.lineTo(c.pts[i][0], c.pts[i][1] + oy);
          if (c.branch) { const [[bx, by], ba, bl] = c.branch; ctx.moveTo(bx, by + oy); ctx.lineTo(bx + Math.cos(ba) * bl, by + Math.sin(ba) * bl + oy); }
        }
        ctx.stroke();
      }
      ctx.fillStyle = '#ffffff';
      for (const p of this.sparkles) {
        if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
        const a = Math.max(0, Math.sin(t * p.sp * 0.6 + p.ph));
        if (a < 0.6) continue;
        ctx.globalAlpha = (a - 0.6) * 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.5, 0, TAU); ctx.fill();
      }
      ctx.restore();
      ctx.globalAlpha = 1;

      // ---- trees (sorted by y, drawn back to front); the wind only moves them when zoomed in (fully from 1.5x)
      const windAmp = smooth(Math.max(0, Math.min(1, ((zoom || 1) - 1.1) / 0.4)));
      const trees = this.trees;
      const k = dpr * v.scale;
      let lo = 0, hi = trees.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (trees[m].y < y0 - 10) lo = m + 1; else hi = m; }
      for (let i = lo; i < trees.length; i++) {
        const tr = trees[i];
        if (tr.y > y1 + 46) break;
        if (tr.x < x0 || tr.x > x1) continue;
        if (tr.cell >= 0 && (world.bld[tr.cell] || world.island[tr.cell] || world.ringId[tr.cell])) continue; // cleared for a building
        const sp = this.sprite(tr.kind, tr.variant, tr.snow);
        const sway = windAmp * (Math.sin(t * 1.15 + tr.ph) * 0.045 + Math.sin(t * 0.35 + tr.x * 0.012) * 0.035);
        const sc = k * tr.s;
        ctx.setTransform(sc, 0, sc * sway, sc, (v.ox + tr.x * v.scale) * dpr, (v.oy + tr.y * v.scale) * dpr);
        ctx.drawImage(sp.cv, -sp.ax, -sp.ay, sp.W, sp.H);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ------------------------------------------------------------ the sky: cloud shadows, clouds, petals (screen space)
    makeClouds(dpr) {
      // cartoon clouds: round bumps sitting on a flat, rounded base, a soft outline and a pale-blue underside
      const SHAPES = [
        [[0.2, 0.11], [0.36, 0.17], [0.56, 0.21], [0.76, 0.14]],
        [[0.16, 0.1], [0.32, 0.15], [0.5, 0.2], [0.68, 0.15], [0.84, 0.1]],
        [[0.26, 0.15], [0.5, 0.23], [0.72, 0.15]],
      ];
      const mk = (shadow, variant) => {
        const W = 260, H = 130, base = H * 0.82;
        const cv = document.createElement('canvas');
        cv.width = Math.ceil(W * dpr); cv.height = Math.ceil(H * dpr);
        const c = cv.getContext('2d');
        c.scale(dpr, dpr);
        const bumps = SHAPES[variant].map(([fx, fr]) => [fx * W, base - fr * W * 0.9, fr * W]);
        const left = bumps[0][0] - bumps[0][2] * 0.9, right = bumps[bumps.length - 1][0] + bumps[bumps.length - 1][2] * 0.9;
        const outline = () => {
          c.beginPath();
          for (const [x, y, r] of bumps) { c.moveTo(x + r, y); c.arc(x, y, r, 0, TAU); }
          c.moveTo(left + 10, base - 22);
          c.arcTo(right, base - 22, right, base, 11); c.arcTo(right, base, left, base, 11); c.arcTo(left, base, left, base - 22, 11); c.arcTo(left, base - 22, right, base - 22, 11);
          c.closePath();
        };
        if (shadow) { c.fillStyle = 'rgb(28,70,48)'; outline(); c.fill(); return { cv, W, H }; }
        c.lineJoin = 'round';
        c.strokeStyle = '#9dbbdb'; c.lineWidth = 6; outline(); c.stroke(); // outline (only the outer edge survives the white fill)
        c.fillStyle = '#ffffff'; outline(); c.fill();
        c.save(); outline(); c.clip(); // pale blue underside
        c.fillStyle = '#d9e8f7';
        c.fillRect(0, base - 11, W, 14);
        c.restore();
        c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 3; c.lineCap = 'round'; // a little highlight on the biggest bump
        const [hx, hy, hr] = bumps.reduce((a, b) => (b[2] > a[2] ? b : a));
        c.beginPath(); c.arc(hx, hy, hr * 0.72, Math.PI * 1.1, Math.PI * 1.45); c.stroke();
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
        ctx.globalAlpha = 0.06; // kept faint: a cloud must never hide a house or a pin
        ctx.drawImage(sh.cv, x + w * 0.16, y + 34 * cl.s, w, h);
        ctx.globalAlpha = 0.21;
        ctx.drawImage(cd.cv, x, y, w, h);
      }
      // petals drifting in the breeze
      ctx.globalAlpha = 0.85;
      for (const p of this.petals) {
        const x = mod(p.u * v.w + t * p.sp + Math.sin(t * 0.7 + p.ph) * 12, v.w + 20) - 10;
        const y = mod(p.v * v.h + t * p.fall, v.h + 20) - 10;
        if (this.isSnowAt((x - v.ox) / v.scale, (y - v.oy) / v.scale)) continue; // no cherry blossom in the snow
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(t * 1.3 + p.ph);
        ctx.scale(p.s, p.s * (0.55 + 0.45 * Math.abs(Math.sin(t * 1.9 + p.ph))));
        ctx.fillStyle = '#f9c3d4';
        ctx.beginPath(); ctx.ellipse(0, 0, 3.4, 2.1, 0, 0, TAU); ctx.fill();
        ctx.restore();
      }
      // snowflakes, only over the snowfields
      ctx.fillStyle = '#ffffff';
      for (const f of this.flakes) {
        const x = mod(f.u * v.w + t * f.sp + Math.sin(t * 0.9 + f.ph) * 14, v.w + 20) - 10;
        const y = mod(f.v * v.h + t * f.fall, v.h + 20) - 10;
        if (!this.isSnowAt((x - v.ox) / v.scale, (y - v.oy) / v.scale)) continue;
        ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.arc(x, y, f.r, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  MM.Scenery = Scenery;
})(typeof window !== 'undefined' ? window : globalThis);
