/* Mini Motorway X — scenery: forest ground, swaying trees, flowing water, drifting clouds and petals.
 * Purely decorative: it only reads the game's seed and terrain, never changes game state. */
(function (root) {
  'use strict';
  const MM = root.MM;
  const C = MM.CFG.CELL;
  const TAU = Math.PI * 2;

  const PAL = {
    sand: { board: '#e0e7b0', light: 'rgba(249,250,222,0.65)', dark: 'rgba(140,178,106,0.26)', grain: 'rgba(104,128,66,0.30)', ripple: 'rgba(112,142,74,0.5)', tuft: 'rgba(92,124,62,0.7)' }, // 浮世繪: a pale sage-green plain on paper, bokashi patches
    sea: { deep: '#2a5a8a', mid: '#3b78a8', line: '#dcecf2', ink: '#1b3a5e', damp: 'rgba(96,104,56,0.22)' }, // Prussian-blue sea
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
  const SIZE = { round: [34, 40], sakura: [36, 40], conifer: [28, 44], bush: [26, 20], birch: [30, 46], pine: [40, 46], rock: [28, 18], torii: [36, 34] };
  const smooth = (t) => t * t * (3 - 2 * t);
  const mod = (a, b) => ((a % b) + b) % b;

  class Scenery {
    /** theme: 'forest' (green forest with a few snowfields), 'snow' (a white Hokkaido-style snow country)
     *  or 'beach' (an ukiyo-e sea shore: waves washing onto the sand). */
    constructor(game, theme) {
      this.game = game;
      this.theme = theme === 'forest' || theme === 'beach' ? theme : 'snow';
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
      this.snowTh = this.theme === 'snow' ? -1 : this.theme === 'beach' ? Infinity : sv[Math.floor(sv.length * 0.7)]; // the snow country is snow everywhere, the beach has none
      this.snowAt = (x, y) => snowF(x / C - 0.5, y / C - 0.5); // noise value at a world position
      this.isSnowAt = (x, y) => this.snowAt(x, y) > this.snowTh;
      // water test that also works one cell outside the board (the ground and the water run off-screen)
      const isWater = (c, r) => w.water[Math.max(0, Math.min(rows - 1, r)) * cols + Math.max(0, Math.min(cols - 1, c))] === 1;
      this.isWaterAt = (x, y) => isWater(Math.floor(x / C), Math.floor(y / C));

      // ---- Edo shore (beach map): flagstone paving (石畳) in patches on land away from the water, and Mt. Fuji on the horizon
      const slabCells = new Set();
      this.slabs = null; this.fuji = null; const toriiAt = [];
      if (this.theme === 'beach') {
        const flag = field(5);
        const near = (c, r) => { for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (isWater(c + dc, r + dr)) return true; return false; };
        const gaps = new Path2D(), tones = [new Path2D(), new Path2D(), new Path2D()];
        const box = (path, X, Y, W, H) => { if (path.roundRect) path.roundRect(X, Y, W, H, 2.2); else path.rect(X, Y, W, H); };
        for (let r = 1; r < rows - 1; r++) {
          for (let c = 1; c < cols - 1; c++) {
            if (flag(c, r) < 0.74 || near(c, r)) continue;
            slabCells.add(r * cols + c);
            if (toriiAt.length < 3 && rnd() < 0.05) toriiAt.push([c, r]);
            gaps.rect(c * C, r * C, C, C);
            // three courses of stone, every other course shifted by half a slab
            for (let k = 0; k < 3; k++) {
              const y = r * C + (k * C) / 3, h = C / 3;
              const cuts = k % 2 ? [0, 0.25, 0.75, 1] : [0, 0.5, 1];
              for (let i = 0; i + 1 < cuts.length; i++) box(tones[Math.floor(rnd() * 3)], c * C + cuts[i] * C + 0.9, y + 0.9, (cuts[i + 1] - cuts[i]) * C - 1.8, h - 1.8);
            }
          }
        }
        if (slabCells.size) this.slabs = { gaps, tones };
        // Mt. Fuji: a big backdrop on dry land near the top edge, clear of the water
        const clear = (c, r) => { for (let dr = -2; dr <= 2; dr++) for (let dc = -3; dc <= 3; dc++) if (isWater(c + dc, r + dr)) return false; return true; };
        const cs = [];
        for (let c = Math.floor(cols * 0.25); c <= Math.floor(cols * 0.75); c++) for (let r = 5; r <= Math.min(8, rows - 3); r++) if (clear(c, r)) cs.push([c, r]);
        if (cs.length) { const [c, r] = cs[Math.floor(rnd() * cs.length)]; this.fuji = { x: (c + 0.5) * C, y: (r + 0.5) * C, w: 6.4 * C, h: 3.8 * C }; }
      }
      this.slabCells = slabCells;

      // ---- trees: up to one per quarter of every land cell (so they never sit on a road centre line)
      this.trees = [];
      for (let r = -1; r <= rows; r++) {
        for (let c = -1; c <= cols; c++) {
          if (isWater(c, r)) continue;
          if (slabCells.has(r * cols + c)) continue; // nothing grows through the paving
          const inBoard = c >= 0 && r >= 0 && c < cols && r < rows;
          const dd = sample(dens, c, r);
          const beach = this.theme === 'beach';
          const p = beach ? Math.max(0.02, Math.min(0.34, (dd - 0.45) * 1.1)) : Math.max(0.04, Math.min(0.95, (dd - 0.3) * 2.2));
          for (let sy = -1; sy <= 1; sy += 2) {
            for (let sx = -1; sx <= 1; sx += 2) {
              if (isWater(c + sx, r) || isWater(c, r + sy) || isWater(c + sx, r + sy)) continue; // keep a shore strip
              if (rnd() > p) continue;
              const kindRoll = rnd();
              const tx = (c + 0.5) * C + sx * (13 + rnd() * 6), ty = (r + 0.5) * C + sy * (13 + rnd() * 6);
              const snowy = this.isSnowAt(tx, ty);
              const grove = sample(sak, c, r) > 0.68;
              let kind = 'round', variant = Math.floor(rnd() * PAL.round.length), size = 0.85 + rnd() * 0.3;
              if (beach) { // black pines (黒松), shrubs and sea-worn rocks
                if (kindRoll < 0.62) { kind = 'pine'; size = 0.9 + rnd() * 0.3; }
                else if (kindRoll < 0.8) { kind = 'bush'; size = 0.8 + rnd() * 0.3; }
                else if (kindRoll < 0.985) { kind = 'rock'; size = 0.8 + rnd() * 0.5; }
                else { kind = 'torii'; size = 0.95 + rnd() * 0.25; } // a shrine gate
              } else if (snowy) { // snowfield: mostly snow-laden evergreens, a few bare-ish round trees and snow mounds
                if (kindRoll < 0.6) { kind = 'conifer'; variant = Math.floor(rnd() * PAL.conifer.length); }
                else if (kindRoll < 0.74) kind = 'round';
                else if (kindRoll < 0.87) { kind = 'birch'; size = 0.9 + rnd() * 0.3; } // white birches, bare in winter
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
      for (const [c, r] of toriiAt) this.trees.push({ x: (c + 0.5) * C, y: (r + 0.5) * C + 14, kind: 'torii', variant: 0, s: 1.05, ph: 0, snow: false, cell: -1 });
      if (this.fuji) { // the mountain's foot is bare: no trees on the lower slopes
        const f = this.fuji;
        this.trees = this.trees.filter((t) => !(t.y > f.y - f.h && t.y < f.y + f.h * 0.12 && Math.abs(t.x - f.x) < f.w * (0.08 + 0.42 * Math.min(1, (t.y - (f.y - f.h)) / f.h)) + 8));
      }
      this.trees.sort((a, b) => a.y - b.y);

      // ---- ground decoration (patches of lighter / darker grass, tufts, flowers), also beyond the board edge
      this.patches = []; this.tufts = []; this.flowers = [];
      const area = cols * rows;
      const rx = () => -C + rnd() * (cols + 2) * C, ry = () => -C + rnd() * (rows + 2) * C;
      for (let i = 0; i < area / 14; i++) this.patches.push({ x: rx(), y: ry(), r: 26 + rnd() * 50, light: rnd() < 0.55 });
      const beachGround = this.theme === 'beach';
      for (let i = 0; i < area * (beachGround ? 0.35 : 1.1); i++) { const x = rx(), y = ry(); if (!this.isWaterAt(x, y)) this.tufts.push({ x, y, a: (rnd() - 0.5) * 0.9, l: 3 + rnd() * 3 }); }
      for (let i = 0; i < area / 5; i++) { const x = rx(), y = ry(); if (!this.isWaterAt(x, y)) this.flowers.push({ x, y, c: beachGround ? ['#f7cdbd', '#fff6e0', '#f3df8a'][Math.floor(rnd() * 3)] : PAL.flowers[Math.floor(rnd() * PAL.flowers.length)], r: beachGround ? 1.3 + rnd() * 1.1 : 1 + rnd() * 0.9 }); } // (beach: little shells)
      this.grain = []; this.ripples = [];
      if (beachGround) {
        for (let i = 0; i < area * 2.2; i++) { const x = rx(), y = ry(); if (!this.isWaterAt(x, y)) this.grain.push(x, y); } // paper / sand grain
        for (let i = 0; i < area * 0.28; i++) { const x = rx(), y = ry(); if (!this.isWaterAt(x, y)) this.ripples.push({ x, y, l: 12 + rnd() * 16, n: 2 + Math.floor(rnd() * 2) }); } // wind ripples in the sand
      }

      // ---- snowfields: soft blobs on a coarse grid (cells well inside a field get big ones, the rim gets small ones), sparkles, drifts
      this.snowBlobs = []; this.snowSpark = []; this.snowDrift = [];
      for (let r = -3; r <= rows + 2; r++) {
        for (let c = -3; c <= cols + 2; c++) {
          const v = snowF(Math.max(-0.5, Math.min(cols - 0.5, c)), Math.max(-0.5, Math.min(rows - 0.5, r)));
          if (v <= this.snowTh) continue;
          const k = Math.min(1, (v - this.snowTh) * 3.2);
          const whole = this.theme === 'snow'; // the whole board is white already: no blobs, just more drifts and glints
          const x = (c + 0.5) * C, y = (r + 0.5) * C;
          if (!whole) this.snowBlobs.push({ x: x + (rnd() - 0.5) * 10, y: y + (rnd() - 0.5) * 10, r: C * (0.5 + 0.3 * k) + rnd() * 4 });
          if (rnd() < 0.8) this.snowSpark.push({ x: x + (rnd() - 0.5) * C, y: y + (rnd() - 0.5) * C, r: 0.8 + rnd() * 0.9 });
          if (rnd() < (whole ? 0.6 : 0.35)) this.snowDrift.push({ x: x + (rnd() - 0.5) * C, y: y + (rnd() - 0.5) * C, l: 8 + rnd() * 12 });
        }
      }
      this.flakes = [];
      for (let i = 0; i < (this.theme === 'snow' ? 120 : 70); i++) this.flakes.push({ u: rnd(), v: rnd(), sp: 6 + rnd() * 10, fall: 22 + rnd() * 22, ph: rnd() * TAU, r: 1 + rnd() * 1.4 });

      // ---- water (now ice): the "core" of every water cell (cracks and frost are clipped to it), plus glints
      const h = C / 2 - C * 0.3, EXT = 5000;
      this.core = new Path2D();
      this.cracks = [];
      this.frost = [];
      this.sparkles = [];
      this.sea = new Path2D(); this.foam = []; this.crests = []; this.seaPat = null; this.birds = [];
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
        if (this.theme === 'beach') { // the sea: Minkowski-inflated twin of the core (so the sea edge sits where the static shore pass puts it), foam points on land-facing edges, crest curls
          const R = C * 0.3;
          const rect = (X, Y, W, H) => { if (this.sea.roundRect) this.sea.roundRect(X - R, Y - R, W + 2 * R, H + 2 * R, R); else this.sea.rect(X - R, Y - R, W + 2 * R, H + 2 * R); };
          rect(x0, y0, x1 - x0, y1 - y0);
          if (e >= 0 && w.water[e]) rect(x - h, y0, C + 2 * h, y1 - y0);
          if (s >= 0 && w.water[s]) rect(x0, y - h, x1 - x0, C + 2 * h);
          if (e >= 0 && s >= 0 && w.water[e] && w.water[s] && w.water[s + 1]) rect(x + h, y + h, C - 2 * h, C - 2 * h);
          const ph = rnd() * TAU;
          const land = (dc, dr) => !isWater(c + dc, r + dr);
          for (const [dc, dr] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
            if (!land(dc, dr)) continue;
            const tx = -dr, ty = dc; // tangent along the edge
            for (const f of [-0.4, -0.2, 0, 0.2, 0.4]) {
              if (Math.abs(f) > 0.3 && !(isWater(c + tx * Math.sign(f), r + ty * Math.sign(f)) && land(dc + tx * Math.sign(f), dr + ty * Math.sign(f)))) continue; // only along a straight shore
              this.foam.push({ x: x + dc * C / 2 + tx * f * C, y: y + dr * C / 2 + ty * f * C, nx: dc, ny: dr, tx, ty, ph: ph + f * 5, r: 3.4 + rnd() * 1.8 });
            }
          }
          if (rnd() < 0.5) this.crests.push({ x: x + (rnd() - 0.5) * 26, y: y + (rnd() - 0.5) * 26, ph: rnd() * TAU, s: 0.8 + rnd() * 0.6 });
          continue;
        }
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
      if (this.theme === 'beach') for (let i = 0; i < 6; i++) this.birds.push({ u: rnd(), v: 0.1 + rnd() * 0.8, sp: 22 + rnd() * 16, ph: rnd() * TAU, s: 0.8 + rnd() * 0.5 });
      this.petals = [];
      for (let i = 0; i < 16; i++) this.petals.push({ u: rnd(), v: rnd(), sp: 7 + rnd() * 9, fall: 10 + rnd() * 8, ph: rnd() * TAU, s: 0.8 + rnd() * 0.7 });
    }

    // ------------------------------------------------------------ ground (drawn into the static layer, world coordinates)
    drawGround(ctx) {
      const whole = this.theme === 'snow';
      const beach = this.theme === 'beach';
      for (const p of this.patches) {
        ctx.fillStyle = beach ? (p.light ? PAL.sand.light : PAL.sand.dark) : whole ? (p.light ? 'rgba(255,255,255,0.85)' : 'rgba(176,201,228,0.32)') : (p.light ? PAL.patchLight : PAL.patchDark); // snow: gentle white rises and blue-grey hollows
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.r, p.r * 0.72, 0, 0, TAU);
        ctx.fill();
      }
      if (beach) { // sand grain, wind ripples (3 parallel wavy lines) like the printed texture of a woodblock
        ctx.fillStyle = PAL.sand.grain;
        ctx.beginPath();
        for (let i = 0; i < this.grain.length; i += 2) ctx.rect(this.grain[i], this.grain[i + 1], 1.3, 1.3);
        ctx.fill();
        ctx.strokeStyle = PAL.sand.ripple; ctx.lineWidth = 0.9; ctx.lineCap = 'round';
        ctx.beginPath();
        for (const rp of this.ripples) for (let k = 0; k < rp.n; k++) { const y = rp.y + k * 3.2, x = rp.x + k * 2; ctx.moveTo(x, y); ctx.bezierCurveTo(x + rp.l * 0.3, y - 2.2, x + rp.l * 0.65, y + 2.2, x + rp.l, y); }
        ctx.stroke();
      }
      if (beach && this.slabs) { // flagstones: grey-beige slabs of three tones over dark joints
        ctx.fillStyle = '#8f8873'; ctx.fill(this.slabs.gaps);
        ['#cfc8b6', '#c2baa6', '#d9d3c3'].forEach((col, i) => { ctx.fillStyle = col; ctx.fill(this.slabs.tones[i]); });
      }
      ctx.strokeStyle = beach ? PAL.sand.tuft : whole ? 'rgba(120,150,185,0.45)' : PAL.tuft; // (tufts of grass poking out of the snow / dune grass)
      ctx.lineWidth = 1.1;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const t of this.tufts) {
        ctx.moveTo(t.x, t.y); ctx.lineTo(t.x + Math.sin(t.a) * t.l, t.y - Math.cos(t.a) * t.l);
        ctx.moveTo(t.x + 2, t.y + 0.5); ctx.lineTo(t.x + 2 + Math.sin(t.a + 0.5) * t.l * 0.8, t.y + 0.5 - Math.cos(t.a + 0.5) * t.l * 0.8);
      }
      ctx.stroke();
      for (const f of whole ? [] : this.flowers) { // (the beach has little shells instead of flowers)
        ctx.fillStyle = f.c;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, TAU);
        ctx.fill();
      }
      // snowfields over the grass: a bluish rim first, then the white (the snow country is white all over: only drifts and glints)
      if (this.snowBlobs.length) {
        ctx.fillStyle = PAL.snowShade;
        ctx.beginPath();
        for (const b of this.snowBlobs) { ctx.moveTo(b.x + b.r + 3, b.y + 1.5); ctx.arc(b.x, b.y + 1.5, b.r + 3, 0, TAU); }
        ctx.fill();
        ctx.fillStyle = PAL.snow;
        ctx.beginPath();
        for (const b of this.snowBlobs) { ctx.moveTo(b.x + b.r, b.y); ctx.arc(b.x, b.y, b.r, 0, TAU); }
        ctx.fill();
      }
      if (this.snowDrift.length) {
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
      } else if (kind === 'pine') { // 黒松: a twisted trunk and flat, cloud-like tufts of needles, with a woodblock keyline
        const ink = '#22372f';
        c.lineJoin = 'round';
        c.strokeStyle = ink; c.lineWidth = 4.6; c.lineCap = 'round';
        const trunk = () => { c.beginPath(); c.moveTo(bx - 1, by + 1); c.bezierCurveTo(bx - 6, by - 8, bx + 5, by - 14, bx - 1, by - 25); };
        trunk(); c.stroke();
        c.strokeStyle = '#8a5f3e'; c.lineWidth = 2.6; trunk(); c.stroke();
        const tuft = (cx, cy, rx, ry) => {
          c.beginPath();
          c.moveTo(cx - rx, cy);
          c.bezierCurveTo(cx - rx * 1.05, cy - ry * 1.5, cx - rx * 0.4, cy - ry * 1.5, cx - rx * 0.28, cy - ry * 1.1);
          c.bezierCurveTo(cx - rx * 0.1, cy - ry * 1.9, cx + rx * 0.55, cy - ry * 1.7, cx + rx * 0.55, cy - ry * 1.05);
          c.bezierCurveTo(cx + rx * 1.1, cy - ry * 1.3, cx + rx * 1.1, cy - ry * 0.1, cx + rx, cy);
          c.quadraticCurveTo(cx, cy + ry * 0.6, cx - rx, cy);
          c.closePath();
          c.fillStyle = '#2f6046'; c.fill();
          c.save(); c.clip();
          c.fillStyle = '#4f8f62'; c.beginPath(); c.ellipse(cx - rx * 0.1, cy - ry * 1.4, rx * 0.8, ry * 0.7, 0, 0, TAU); c.fill(); // lit top
          c.fillStyle = '#244a3a'; c.beginPath(); c.ellipse(cx, cy + ry * 0.45, rx * 1.1, ry * 0.55, 0, 0, TAU); c.fill(); // shaded belly
          c.restore();
          c.strokeStyle = ink; c.lineWidth = 1; c.stroke();
        };
        tuft(bx - 9, by - 12, 8.5, 4.4); tuft(bx + 9, by - 17, 8.5, 4.4); tuft(bx, by - 25, 11.5, 5.4);
      } else if (kind === 'torii') { // 鳥居: vermilion pillars, a black-capped lintel and a tie beam
        c.lineJoin = 'round'; c.strokeStyle = '#3a1f1a'; c.lineWidth = 1;
        const blk = (x, y, w, h, col) => { c.fillStyle = col; c.fillRect(bx + x, by + y, w, h); c.strokeRect(bx + x, by + y, w, h); };
        blk(-12, -28, 3.6, 29, '#d8432e'); blk(8.4, -28, 3.6, 29, '#d8432e'); // pillars
        blk(-10, -21, 20, 2.8, '#d8432e'); // nuki
        c.beginPath(); c.moveTo(bx - 16, by - 33); c.lineTo(bx + 16, by - 33); c.lineTo(bx + 13, by - 28.5); c.lineTo(bx - 13, by - 28.5); c.closePath(); c.fillStyle = '#d8432e'; c.fill(); c.stroke();
        c.fillStyle = '#2b2a2c'; c.beginPath(); c.moveTo(bx - 17, by - 34); c.lineTo(bx + 17, by - 34); c.lineTo(bx + 16, by - 31.5); c.lineTo(bx - 16, by - 31.5); c.closePath(); c.fill(); // black cap on the lintel
      } else if (kind === 'rock') { // a sea-worn rock: blue-grey with a keyline and a pale highlight
        const poly = [[-11, 5], [-9, -3], [-3, -8], [4, -7], [10, -1], [12, 5]];
        c.beginPath(); poly.forEach(([dx, dy], i) => (i ? c.lineTo(bx + dx, by + dy) : c.moveTo(bx + dx, by + dy))); c.closePath();
        c.fillStyle = '#7b8a98'; c.fill();
        c.fillStyle = '#9fb0bd'; c.beginPath(); c.moveTo(bx - 9, by - 3); c.lineTo(bx - 3, by - 8); c.lineTo(bx + 4, by - 7); c.lineTo(bx - 1, by - 2); c.closePath(); c.fill();
        c.strokeStyle = '#2a3a4c'; c.lineWidth = 1.1; c.lineJoin = 'round'; c.beginPath(); poly.forEach(([dx, dy], i) => (i ? c.lineTo(bx + dx, by + dy) : c.moveTo(bx + dx, by + dy))); c.closePath(); c.stroke();
      } else if (kind === 'birch') { // a white birch (白樺): pale trunk with dark bark marks, thin bare branches with snow on them
        c.fillStyle = '#f3f3ef'; c.fillRect(bx - 1.6, by - 26, 3.2, 26);
        c.fillStyle = '#4b4641';
        for (const y of [5, 10, 15, 20]) c.fillRect(bx - 1.6, by - y, 1.6 + (y % 2), 1.1);
        c.strokeStyle = '#5c4f46'; c.lineWidth = 0.9; c.lineCap = 'round';
        const br = [[-9, -33], [9, -35], [-5, -41], [5, -42], [0, -45], [-12, -25], [11, -27]];
        c.beginPath();
        for (const [dx, dy] of br) { c.moveTo(bx, by + Math.max(-30, dy + 12)); c.lineTo(bx + dx, by + dy); }
        c.stroke();
        for (const [dx, dy] of br) dot(bx + dx, by + dy + 0.5, 1.9, PAL.snow);
        dot(bx, by - 26.5, 2.2, PAL.snow);
      } else {
        const pal = this.theme === 'beach' ? { dark: '#5f7d4a', mid: '#86a463', light: '#b3c984' } : PAL.round[variant];
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

      ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.ox, dpr * v.oy);
      const x0 = -v.ox / v.scale - 40, x1 = (v.w - v.ox) / v.scale + 40, y0 = -v.oy / v.scale - 40, y1 = (v.h - v.oy) / v.scale + 40;
      if (this.theme === 'beach') this.drawSea(ctx, v, t, x0, x1, y0, y1);
      else this.drawIce(ctx, t, x0, x1, y0, y1);

      if (this.fuji) this.drawFuji(ctx, t, x0, x1, y0, y1);
      // ---- trees (sorted by y, drawn back to front); the wind only moves them when zoomed in (fully from 1.5x)
      this.drawTrees(ctx, v, t, world, zoom, x0, x1, y0, y1);
    }

    /** Mt. Fuji (富士山) as a woodblock print: a blue cone shading to pink at the foot, a white cap with a jagged edge, mist bands across the base. */
    drawFuji(ctx, t, x0, x1, y0, y1) {
      const f = this.fuji;
      if (f.x + f.w / 2 < x0 || f.x - f.w / 2 > x1 || f.y + f.h * 0.2 < y0 || f.y - f.h > y1) return;
      const L = f.x - f.w / 2, R = f.x + f.w / 2, top = f.y - f.h, base = f.y;
      const cone = () => { // a gently concave silhouette, flat summit
        ctx.beginPath();
        ctx.moveTo(L, base);
        ctx.bezierCurveTo(L + f.w * 0.22, base - f.h * 0.12, f.x - f.w * 0.2, top + f.h * 0.28, f.x - f.w * 0.07, top);
        ctx.lineTo(f.x + f.w * 0.07, top);
        ctx.bezierCurveTo(f.x + f.w * 0.2, top + f.h * 0.28, R - f.w * 0.22, base - f.h * 0.12, R, base);
        ctx.closePath();
      };
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.fillStyle = 'rgba(70,50,40,0.16)'; // a soft shadow on the sand
      ctx.beginPath(); ctx.ellipse(f.x + f.w * 0.06, base + 2, f.w * 0.52, f.h * 0.07, 0, 0, TAU); ctx.fill();
      const g = ctx.createLinearGradient(0, top, 0, base);
      g.addColorStop(0, '#4a6f9c'); g.addColorStop(0.55, '#7d9cc2'); g.addColorStop(1, '#e6c3b4'); // indigo summit, pink bokashi at the foot
      cone(); ctx.fillStyle = g; ctx.fill();
      ctx.save(); cone(); ctx.clip();
      ctx.strokeStyle = 'rgba(40,70,115,0.35)'; ctx.lineWidth = 1.1; ctx.lineCap = 'round'; // ravines running down the slope
      ctx.beginPath();
      for (const [a, b] of [[-0.05, -0.2], [0.03, 0.12], [0.08, 0.3], [-0.1, -0.32], [0.0, -0.08]]) { ctx.moveTo(f.x + f.w * a, top + f.h * 0.22); ctx.quadraticCurveTo(f.x + f.w * (a + b) * 0.6, top + f.h * 0.6, f.x + f.w * (a + b * 1.5), base - f.h * 0.06); }
      ctx.stroke();
      // the snow cap: white down to a zig-zag line
      ctx.fillStyle = '#fbfbf6';
      ctx.beginPath();
      ctx.moveTo(f.x - f.w * 0.2, top + f.h * 0.34);
      const zig = [[-0.17, 0.26], [-0.13, 0.36], [-0.09, 0.27], [-0.05, 0.4], [-0.01, 0.3], [0.03, 0.42], [0.07, 0.31], [0.11, 0.38], [0.15, 0.27], [0.19, 0.34]];
      for (const [zx, zy] of zig) ctx.lineTo(f.x + f.w * zx, top + f.h * zy);
      ctx.lineTo(f.x + f.w * 0.2, top + f.h * 0.34);
      ctx.lineTo(f.x + f.w * 0.3, top - 4); ctx.lineTo(f.x - f.w * 0.3, top - 4);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      cone(); ctx.strokeStyle = '#2d4a78'; ctx.lineWidth = 1.5; ctx.stroke(); // keyline
      // mist (霞) across the base, drifting slowly
      for (const [mx, my, mw, mh, sp] of [[-0.12, 0.02, 0.5, 0.06, 0.13], [0.2, -0.07, 0.42, 0.05, -0.1], [-0.28, -0.14, 0.34, 0.045, 0.08]]) {
        const cx = f.x + f.w * mx + Math.sin(t * sp) * f.w * 0.03, cy = base + f.h * my;
        ctx.fillStyle = 'rgba(255,246,228,0.88)'; ctx.strokeStyle = 'rgba(217,154,132,0.7)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(cx, cy, f.w * mw * 0.5, f.h * mh, 0, 0, TAU); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }

    /** The ice: frost patches, cracks and a few twinkling glints (nothing flows: the water is frozen over). */
    drawIce(ctx, t, x0, x1, y0, y1) {
      ctx.save();
      ctx.clip(this.core);
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
    }

    /** The seigaiha tile (concentric wave scales, 青海波): the pattern that fills the sea. */
    seaPattern(ctx) {
      const TW = 34, TH = 17, q = Math.max(1, this.q);
      if (this.seaPat && this.seaPat.q === q) return this.seaPat;
      const cw = Math.round(TW * q), ch = Math.round(TH * q);
      const cv = document.createElement('canvas');
      cv.width = cw; cv.height = ch;
      const c = cv.getContext('2d');
      c.scale(cw / TW, ch / TH);
      const R = TW / 2;
      for (let row = -2; row <= 3; row++) {
        for (let k = -1; k <= 2; k++) {
          const cx = k * TW + (row & 1 ? R : 0), cy = row * (TH / 2);
          const rings = [[R, PAL.sea.deep], [R * 0.78, PAL.sea.mid], [R * 0.56, PAL.sea.deep], [R * 0.34, PAL.sea.mid], [R * 0.14, PAL.sea.deep]];
          for (const [r, col] of rings) {
            c.beginPath(); c.arc(cx, cy, r, 0, TAU);
            c.fillStyle = col; c.fill();
            c.strokeStyle = PAL.sea.line; c.lineWidth = r === R ? 0.9 : 0.55; c.globalAlpha = r === R ? 0.8 : 0.55; c.stroke(); c.globalAlpha = 1;
          }
        }
      }
      this.seaPat = { q, TW, TH, cw, ch, pat: ctx.createPattern(cv, 'repeat') };
      return this.seaPat;
    }

    /** The beach sea (ukiyo-e): indigo seigaiha waves with white crest curls, and foam that washes up the sand and ebbs back. */
    drawSea(ctx, v, t, x0, x1, y0, y1) {
      const wash = 0.5 + 0.5 * Math.sin(t * 1.05); // 0 = ebb, 1 = high tide
      const R = C * 0.3;
      ctx.lineJoin = 'round';
      // damp sand left behind by the wave (a darker band that breathes in and out), then the dark keyline of the sea
      ctx.strokeStyle = PAL.sea.damp; ctx.lineWidth = 2 * (R + 3 + wash * 9);
      ctx.stroke(this.core);
      ctx.strokeStyle = PAL.sea.ink; ctx.lineWidth = 2 * (R + 1.6);
      ctx.stroke(this.core);
      ctx.fillStyle = PAL.sea.deep;
      ctx.fill(this.sea);
      // the sea itself: seigaiha scales drifting slowly, crest curls
      ctx.save();
      ctx.clip(this.sea);
      const sp = this.seaPattern(ctx);
      if (sp.pat && sp.pat.setTransform && typeof DOMMatrix !== 'undefined') sp.pat.setTransform(new DOMMatrix().translate(t * 2.2, Math.sin(t * 0.7) * 1.6).scale(sp.TW / sp.cw, sp.TH / sp.ch));
      ctx.fillStyle = sp.pat;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#ffffff'; ctx.fillStyle = '#ffffff';
      for (const cr of this.crests) { // a small Hokusai crest: a curl with claw-like foam fingers, rocking on the swell
        if (cr.x < x0 || cr.x > x1 || cr.y < y0 || cr.y > y1) continue;
        const b = Math.sin(t * 1.2 + cr.ph), s = cr.s;
        ctx.save();
        ctx.translate(cr.x + b * 2.5, cr.y + Math.cos(t * 1.2 + cr.ph) * 1.2);
        ctx.scale(s, s);
        ctx.globalAlpha = 0.55 + 0.35 * Math.max(0, b);
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(-9, 3); ctx.bezierCurveTo(-7, -5, 3, -7, 7, -2); ctx.bezierCurveTo(4, -4, 0, -2, -1, 2); ctx.stroke();
        for (const [fx, fy] of [[2, -6.2], [5, -4.4], [7.4, -1.6]]) { ctx.beginPath(); ctx.arc(fx, fy, 1.15, 0, TAU); ctx.fill(); }
        ctx.restore();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
      // foam claws sweeping onto the sand and sliding back
      ctx.lineWidth = 0.9;
      ctx.strokeStyle = '#8fb6cc';
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      for (const f of this.foam) {
        if (f.x < x0 || f.x > x1 || f.y < y0 || f.y > y1) continue;
        const a = 0.5 + 0.5 * Math.sin(t * 1.05 + f.ph * 0.12);
        const d = -1 + a * 10; // how far past the shoreline this claw has run
        const px = f.x + f.nx * d, py = f.y + f.ny * d;
        const rx = f.r * (0.8 + 0.5 * a), ry = 1.5 + 1.6 * a;
        ctx.moveTo(px + rx * Math.cos(Math.atan2(f.ty, f.tx)), py + rx * Math.sin(Math.atan2(f.ty, f.tx)));
        ctx.ellipse(px, py, rx, ry, Math.atan2(f.ty, f.tx), 0, TAU);
      }
      ctx.fill();
      ctx.stroke();
    }

    drawTrees(ctx, v, t, world, zoom, x0, x1, y0, y1) {
      const dpr = v.dpr;
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
        const sway = tr.kind === 'rock' ? 0 : windAmp * (Math.sin(t * 1.15 + tr.ph) * 0.045 + Math.sin(t * 0.35 + tr.x * 0.012) * 0.035);
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
        if (this.theme === 'beach') { // 霞: flat bands of mist with rounded ends, cream with a pink underside and a thin red-brown keyline
          const BANDS = [[[0.34, 0.5, 0.3, 0.075], [0.62, 0.62, 0.34, 0.07], [0.5, 0.76, 0.42, 0.065]], [[0.3, 0.55, 0.26, 0.08], [0.58, 0.45, 0.3, 0.075], [0.52, 0.72, 0.4, 0.07]], [[0.5, 0.5, 0.4, 0.08], [0.38, 0.68, 0.3, 0.07], [0.7, 0.74, 0.28, 0.06]]][variant];
          const bands = () => { c.beginPath(); for (const [fx, fy, frx, fry] of BANDS) { c.moveTo(fx * W + frx * W, fy * H); c.ellipse(fx * W, fy * H, frx * W, fry * H * 2, 0, 0, TAU); } };
          if (shadow) { c.fillStyle = 'rgb(60,40,30)'; bands(); c.fill(); return { cv, W, H }; }
          c.lineJoin = 'round'; c.strokeStyle = '#d99a84'; c.lineWidth = 3; bands(); c.stroke();
          c.fillStyle = '#fff7e8'; bands(); c.fill();
          c.save(); bands(); c.clip(); c.fillStyle = '#f8d2c0'; c.fillRect(0, H * 0.7, W, H); c.restore(); // bokashi: the underside shades to pink
          return { cv, W, H };
        }
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
      // petals drifting in the breeze (none on the beach: there plovers skim along the shore instead)
      ctx.globalAlpha = 0.85;
      for (const p of this.theme === 'beach' ? [] : this.petals) {
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
      if (this.birds.length) { // 千鳥: little sea birds flapping across the sky
        ctx.strokeStyle = '#27384e'; ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = 0.8;
        for (const b of this.birds) {
          const x = mod(b.u * (v.w + 80) + t * b.sp, v.w + 80) - 40, y = b.v * v.h + Math.sin(t * 0.8 + b.ph) * 8;
          const f = Math.sin(t * 7 + b.ph) * 3.2 * b.s, sc = b.s * 4;
          ctx.beginPath();
          ctx.moveTo(x - 2.2 * sc, y - f); ctx.quadraticCurveTo(x - sc, y - 1.4 * sc - f * 0.5, x, y);
          ctx.quadraticCurveTo(x + sc, y - 1.4 * sc - f * 0.5, x + 2.2 * sc, y - f);
          ctx.stroke();
        }
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
