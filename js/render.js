/* Mini Motorway X — canvas renderer */
(function (root) {
  'use strict';
  const MM = root.MM;
  const CFG = MM.CFG;
  const C = CFG.CELL;

  const THEME = {
    board: '#bcd98f', // forest-floor grass
    snowBoard: '#eef5fb', // snow country
    snowDot: 'rgba(110,140,180,0.16)',
    dot: 'rgba(255,255,255,0.28)',
    shore: '#f1f9ff', // frosty rim of the ice
    water: '#b9e1f1', // the ice of a frozen river / lake
    roadEdge: '#4f5766',
    road: '#767d89', // asphalt
    sidewalk: '#e2decd',
    hwEdge: '#3f8a63', // expressway verge (green)
    hw: '#59616d', // darker expressway asphalt
    ink: '#2f3a4b',
    beachBoard: '#e0e7b0', // ukiyo-e plain
    beachDot: 'rgba(104,128,66,0.2)',
    beachWet: '#c9d394', // damp bank along the water
    beachSea: '#2a5a8a',
  };
  const MAP_THEMES = ['snow', 'forest', 'beach'];

  const MAX_ZOOM = 3;
  const CAR_KINDS = ['sedan', 'sedan', 'kei', 'kei', 'van', 'truck', 'taxi']; // body styles, picked by car id
  const R_NARROW = 16; // asphalt width of an ordinary (two-lane) road
  const R_HW = 18; // ... of an expressway
  const R_WIDE = 32; // ... of a four-lane road
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
      this.handFirst = -1; // building picked up by the 天神之手 (its node), while the new spot is still to be chosen
      this.tpFirst = -1; // node of the portal entrance that has been picked while the exit is still to be chosen
      this.scn = null; // decorative scenery (trees, ice, clouds)
      this.mapTheme = 'snow'; // the map of the current game: 'snow' (all white, Hokkaido), 'forest' (green with a few snowfields) or 'beach' (ukiyo-e sea shore)
      this.mapMode = 'random'; // 'random' = every new game gets one of the three maps; otherwise the chosen map stays
      this.police = null; // decorative traffic police cars
      this.planes = null; // decorative aeroplanes crossing the sky
      this.showPlanes = false; // the flyovers are switched off (set true to bring the aircraft back)
      this.nukeAt = -1e9; // when the last 超級原子彈 went off (performance.now() ms)
      this.timeMode = 'cycle'; // 'day' | 'night' | 'cycle': the sky is always bright, always dark, or follows the day / night cycle
      this.dark = 0; // current darkness 0..1 (eased toward the target)
      this._lastNow = 0;
      this.sprites = {};
      this.cam = { zoom: 1, cx: 0, cy: 0 }; // camera: zoom >= 1 (1 = whole map fits), cx/cy = world point at the screen centre
      this.statics = null;
      this._pose = { x: 0, y: 0, a: 0 };
    }

    setGame(game) {
      this.game = game;
      if (this.mapMode === 'random') { // a different map from the last one
        const others = MAP_THEMES.filter((m) => m !== this.mapTheme);
        this.mapTheme = others[Math.floor(Math.random() * others.length)];
      }
      this.scn = new MM.Scenery(game, this.mapTheme);
      this.police = new MM.Police(game.world, (Math.random() * 1e9) | 0); // decorative patrol cars (not part of the simulation)
      this.planes = new MM.Planes((Math.random() * 1e9) | 0);
      this.fx = [];
      this.statics = null;
      this.resetCamera();
    }

    /** Map choice: 'random' (a new map every game) or one of snow / forest / beach (the map is redecorated, the game is untouched). */
    setMapMode(m) {
      this.mapMode = MAP_THEMES.includes(m) ? m : 'random';
      if (this.mapMode !== 'random' && this.mapMode !== this.mapTheme) {
        this.mapTheme = this.mapMode;
        if (this.game) { this.scn = new MM.Scenery(this.game, this.mapTheme); this.statics = null; }
      }
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
      const fit = this.viewFor(g.cols, g.rows).scale;
      const cam = this.cam;
      const scale = fit * cam.zoom;
      // keep the map covering the screen (or centred where it is smaller than the screen)
      const bw = g.cols * C, bh = g.rows * C;
      const hw = v.w / 2 / scale, hh = v.h / 2 / scale;
      cam.cx = bw * scale <= v.w ? bw / 2 : Math.max(hw, Math.min(bw - hw, cam.cx));
      cam.cy = bh * scale <= v.h ? bh / 2 : Math.max(hh, Math.min(bh - hh, cam.cy));
      v.scale = scale;
      v.ox = v.w / 2 - cam.cx * scale;
      v.oy = v.h / 2 - cam.cy * scale;
      this.statics = null;
    }

    resetCamera() {
      const g = this.game;
      this.cam.zoom = 1;
      if (g) { this.cam.cx = g.cols * C / 2; this.cam.cy = g.rows * C / 2; }
      this.layout();
    }

    isZoomed() { return this.cam.zoom > 1.001; }

    /** Pan by (dx, dy) screen pixels (the map follows the fingers). */
    panBy(dx, dy) {
      this.cam.cx -= dx / this.view.scale;
      this.cam.cy -= dy / this.view.scale;
      this.layout();
    }

    /** Zoom by `factor`, keeping the map point under screen position (px, py) fixed. */
    zoomAt(px, py, factor) {
      const v = this.view, cam = this.cam;
      const fit = v.scale / cam.zoom;
      const wx = (px - v.ox) / v.scale, wy = (py - v.oy) / v.scale;
      cam.zoom = Math.max(1, Math.min(MAX_ZOOM, cam.zoom * factor));
      const scale = fit * cam.zoom;
      // after zooming, the map point (wx, wy) must still sit under (px, py):  ox' = px - wx*scale = w/2 - cx'*scale
      cam.cx = wx + (v.w / 2 - px) / scale;
      cam.cy = wy + (v.h / 2 - py) / scale;
      this.layout();
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
      // reuse one canvas (allocating a screen-sized canvas every frame makes pinch-zooming stutter)
      const cv = this._staticCv || (this._staticCv = document.createElement('canvas'));
      const cw = Math.round(v.w * v.dpr), ch = Math.round(v.h * v.dpr);
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
      const ctx = cv.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.scale(v.dpr, v.dpr);
      const th = this.scn.theme;
      ctx.fillStyle = th === 'snow' ? THEME.snowBoard : th === 'beach' ? THEME.beachBoard : THEME.board;
      ctx.fillRect(0, 0, v.w, v.h);
      ctx.translate(v.ox, v.oy);
      ctx.scale(v.scale, v.scale);
      this.scn.drawGround(ctx); // grass patches, tufts and flowers
      // lattice dots
      ctx.fillStyle = th === 'snow' ? THEME.snowDot : th === 'beach' ? THEME.beachDot : THEME.dot;
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
      if (th === 'beach') { pass(C * 0.3 + 8, THEME.beachWet); pass(C * 0.3, THEME.beachSea); } // (the animated sea is painted over this by the scenery)
      else { pass(C * 0.3 + 3.5, THEME.shore); pass(C * 0.3, THEME.water); }
      this.statics = { cv };
    }

    // ------------------------------------------------------------ cars
    /** Distance of a lane's centre from the road's centre line: 4 on a two-lane road, 4 (inner) or 12 (outer) on a four-lane one. */
    laneOff(lane, slot) {
      const S = this.game.slotsOf(lane);
      return S > 2 ? [-12, -4, 4, 12][Math.min(3, slot | 0)] : S > 1 ? (slot ? 12 : 4) : OFF;
    }

    carPose(car) {
      const p = car.path, i = car.i, s = car.s;
      const len = this.game.lenOf(car.lane); // lane length in cells (tunnels are long)
      const zone = 0.25 / len; // the corner blend covers 0.25 cell on each side of a node
      const a = p[i], b = p[i + 1];
      const ax = this.nodeX(a), ay = this.nodeY(a), bx = this.nodeX(b), by = this.nodeY(b);
      const dx = Math.sign(bx - ax), dy = Math.sign(by - ay);
      const out = this._pose;
      const nx = -dy, ny = dx;
      const g = this.game, w = g.world;
      // a teleport hop in the path is not a drive: the car neither turns into nor out of it
      const c = w.tp.get(b) === p[i + 2] ? undefined : p[i + 2];
      const pr = w.tp.get(p[i - 1]) === a ? undefined : p[i - 1];
      // lateral offset of the lane the car is in / is about to enter / came from (a four-lane road has an inner and an outer lane)
      const offCur = this.laneOff(car.lane, car.slot);
      const nlane = c !== undefined ? b * 4 + w.dirOf(b, c) : -1;
      const offNext = nlane >= 0 ? this.laneOff(nlane, car.nslotFor === nlane ? car.nslot : 0) : offCur;
      const offPrev = pr !== undefined ? this.laneOff(pr * 4 + w.dirOf(pr, a), car.pslot | 0) : offCur;
      const corner = (nodeN, din, dout, t, offIn, offOut) => {
        const X = this.nodeX(nodeN), Y = this.nodeY(nodeN);
        const nix = -din[1], niy = din[0], nox = -dout[1], noy = dout[0];
        const dot = nix * nox + niy * noy;
        if (dot < -0.9) return false;
        const q = C * 0.25;
        const p0x = X - din[0] * q + nix * offIn, p0y = Y - din[1] * q + niy * offIn;
        const p2x = X + dout[0] * q + nox * offOut, p2y = Y + dout[1] * q + noy * offOut;
        // control point: where the two offset lines meet (a turn), or halfway between them (going straight on)
        const cx = dot > 0.99 ? X + (nix * offIn + nox * offOut) / 2 : X + nix * offIn + nox * offOut;
        const cy = dot > 0.99 ? Y + (niy * offIn + noy * offOut) / 2 : Y + niy * offIn + noy * offOut;
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
        if (corner(b, [dx, dy], [cx, cy], (s - (1 - zone)) * len * 2, offCur, offNext)) return out;
      } else if (s < zone && pr !== undefined) {
        const px = Math.sign(ax - this.nodeX(pr)), py = Math.sign(ay - this.nodeY(pr));
        if (corner(a, [px, py], [dx, dy], 0.5 + s * len * 2, offPrev, offCur)) return out;
      }
      out.x = lerp(ax, bx, s) + nx * offCur;
      out.y = lerp(ay, by, s) + ny * offCur;
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

    /** Size factor of a car: it shrinks into a portal entrance and grows back out of the exit. */
    carScale(car) {
      const g = this.game, p = car.path, i = car.i;
      let k = 1;
      if (car.hopAt !== undefined) k = Math.min(1, 0.25 + (g.time - car.hopAt) / 0.35);
      if (g.world.tp.get(p[i + 1]) === p[i + 2] && p[i + 2] !== undefined && car.s > 0.72) k = Math.min(k, Math.max(0.2, 1 - (car.s - 0.72) / 0.28 * 0.8));
      return k;
    }

    /** Cosmetic body style, picked from the car id (never affects the simulation). */
    carKind(car) {
      const h = Math.imul(car.id, 2654435761) >>> 0;
      if ((car.weight || 1) > 1) return (h >>> 9) & 1 ? 'p911' : 'm787b'; // the sports cars: Porsche 911 / Mazda 787B
      return CAR_KINDS[h % CAR_KINDS.length];
    }

    drawCar(ctx, car, elevated) {
      const pose = this.carPose(car);
      ctx.save();
      ctx.translate(pose.x, pose.y - (elevated ? 3 : 0));
      ctx.rotate(pose.a);
      if (elevated) ctx.scale(1.12, 1.12);
      const ks = this.carScale(car);
      if (ks < 1) ctx.scale(ks, ks);
      ctx.fillStyle = elevated ? 'rgba(20,30,50,0.28)' : 'rgba(0,0,0,0.18)';
      rr(ctx, -5.8, elevated ? 0.4 : -2.8, 12.4, 7, 2.2);
      ctx.fill();
      this.drawCarBody(ctx, car);
      ctx.restore();
      this.drawWeightBadge(ctx, car.weight, pose.x, pose.y - (elevated ? 3 : 0) - 8.5);
    }

    /** A gold badge over a sports car: this one is worth `weight` cars. */
    drawWeightBadge(ctx, weight, x, y) {
      if ((weight || 1) <= 1) return;
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = '#ffc21a'; ctx.strokeStyle = '#a8740a'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(0, 0, 3.3, 0, 6.2832); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#5a3a00'; ctx.font = 'bold 5.2px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(weight), 0, 0.3);
      ctx.restore();
    }

    /** The car's body, centred on the origin and facing +x (shared by driving and flying cars). */
    drawCarBody(ctx, car) {
      const col = MM.COLORS[car.color];
      const kind = this.carKind(car);
      ctx.fillStyle = col.main;
      ctx.strokeStyle = col.dark;
      ctx.lineWidth = 1;
      const glass = 'rgba(255,255,255,0.78)';
      if (kind === 'm787b') { // Mazda 787B (Le Mans 1991): a low, wide Group C prototype with covered wheels, a bubble canopy and a big rear wing
        ctx.fillStyle = '#1d2026'; // fat tyres poking out of the bodywork
        for (const [x, w] of [[2.6, 3.0], [-5.4, 3.4]]) { rr(ctx, x, -4.3, w, 1.3, 0.5); ctx.fill(); rr(ctx, x, 3.0, w, 1.3, 0.5); ctx.fill(); }
        ctx.fillStyle = col.main; ctx.strokeStyle = col.dark; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(7, 0); ctx.quadraticCurveTo(5.2, -2.8, 1.5, -3.4); ctx.lineTo(-3.2, -3.4); ctx.quadraticCurveTo(-5.6, -3.2, -6.4, -2.2);
        ctx.lineTo(-6.4, 2.2); ctx.quadraticCurveTo(-5.6, 3.2, -3.2, 3.4); ctx.lineTo(1.5, 3.4); ctx.quadraticCurveTo(5.2, 2.8, 7, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillRect(-5.8, -0.55, 12, 1.1); // the white stripe of the Renown livery
        ctx.fillStyle = '#18a85a'; ctx.fillRect(-6.3, -3.1, 2.2, 6.2); // green tail section
        ctx.fillStyle = '#18a85a'; ctx.fillRect(2.2, -3.2, 1.4, 1.5); ctx.fillRect(2.2, 1.7, 1.4, 1.5); // front fender flashes
        ctx.fillStyle = 'rgba(20,32,48,0.92)'; ctx.beginPath(); ctx.ellipse(-0.4, 0, 2.3, 1.7, 0, 0, 6.2832); ctx.fill(); // canopy
        ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(0.2, -0.5, 1, 0.5, 0, 0, 6.2832); ctx.fill();
        ctx.fillStyle = '#20242c'; ctx.fillRect(-7.4, -4.3, 1.5, 8.6); // rear wing
        ctx.fillStyle = '#18a85a'; ctx.fillRect(-7.5, -4.4, 1.7, 0.9); ctx.fillRect(-7.5, 3.5, 1.7, 0.9); // wing end plates
      } else if (kind === 'p911') { // Porsche 911: a rounded two-door coupe, round headlights, a long sloping roof, a duck-tail spoiler
        ctx.fillStyle = col.main; ctx.strokeStyle = col.dark; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(6.2, -1.3); ctx.quadraticCurveTo(6.5, -2.7, 4.6, -2.9); ctx.lineTo(1.6, -3.1); ctx.quadraticCurveTo(-2.6, -3.6, -5, -3.1); ctx.quadraticCurveTo(-6.4, -2.7, -6.4, -1.3);
        ctx.lineTo(-6.4, 1.3); ctx.quadraticCurveTo(-6.4, 2.7, -5, 3.1); ctx.quadraticCurveTo(-2.6, 3.6, 1.6, 3.1); ctx.lineTo(4.6, 2.9); ctx.quadraticCurveTo(6.5, 2.7, 6.2, 1.3); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.78)'; // windscreen
        ctx.beginPath(); ctx.moveTo(2.9, -2.2); ctx.lineTo(1.1, -2.6); ctx.lineTo(1.1, 2.6); ctx.lineTo(2.9, 2.2); ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.28)'; rr(ctx, -3.6, -2.5, 4.9, 5, 2); ctx.fill(); // roof
        ctx.fillStyle = 'rgba(40,60,85,0.55)'; rr(ctx, -4.6, -2.1, 1.5, 4.2, 0.7); ctx.fill(); // rear window
        ctx.fillStyle = '#fff6c8'; ctx.strokeStyle = '#2a2d33'; ctx.lineWidth = 0.6; // the round headlights
        for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(5, s * 2.05, 0.95, 0, 6.2832); ctx.fill(); ctx.stroke(); }
        ctx.strokeStyle = col.dark; ctx.lineWidth = 0.6; ctx.beginPath(); for (const y of [-1.1, 0, 1.1]) { ctx.moveTo(-5.7, y); ctx.lineTo(-4.9, y); } ctx.stroke(); // engine louvres
        ctx.fillStyle = col.dark; rr(ctx, -6.6, -2.4, 1, 4.8, 0.4); ctx.fill(); // ducktail
      } else if (kind === 'kei') { // 軽自動車: short, tall and boxy
        rr(ctx, -5.3, -3.65, 10.6, 7.3, 1.8); ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.28)'; rr(ctx, -3.7, -2.6, 6.6, 5.2, 1.4); ctx.fill();
        ctx.fillStyle = glass; rr(ctx, 1.5, -2.3, 2.1, 4.6, 0.8); ctx.fill();
      } else if (kind === 'van') { // ミニバン
        rr(ctx, -6.2, -3.7, 12.4, 7.4, 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.24)'; rr(ctx, -5, -2.8, 9, 5.6, 1.5); ctx.fill();
        ctx.fillStyle = glass; rr(ctx, 3.3, -2.4, 2.2, 4.8, 0.8); ctx.fill();
      } else if (kind === 'truck') { // 軽トラ: cab in front, open bed behind
        rr(ctx, 1.2, -3.5, 5, 7, 1.8); ctx.fill(); ctx.stroke();
        ctx.fillStyle = glass; rr(ctx, 3.8, -2.3, 1.8, 4.6, 0.6); ctx.fill();
        ctx.fillStyle = '#d3cbb4'; ctx.strokeStyle = '#8f866f'; ctx.lineWidth = 0.8;
        rr(ctx, -6.2, -3.3, 7.4, 6.6, 1); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = 'rgba(120,108,84,0.7)'; ctx.beginPath(); ctx.moveTo(-3.2, -2.5); ctx.lineTo(-3.2, 2.5); ctx.stroke();
      } else { // sedan, and the taxi (a sedan with the roof lantern 行燈)
        rr(ctx, -6.2, -3.5, 12.4, 7, 2.2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = glass; rr(ctx, 0.8, -2.4, 2.8, 4.8, 1); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.45)'; rr(ctx, -4.6, -2.2, 1.8, 4.4, 0.8); ctx.fill();
        if (kind === 'taxi') {
          ctx.fillStyle = '#fff3b8'; ctx.strokeStyle = '#e0a21c'; ctx.lineWidth = 0.7;
          rr(ctx, -2.2, -1.3, 2.6, 2.6, 0.8); ctx.fill(); ctx.stroke();
        }
      }
    }

    /** 起飛啦: a car with wings and a jet flame, rising off the road and flying straight to its destination. */
    drawFlyer(ctx, f, now) {
      const u = f.t * f.t * (3 - 2 * f.t); // ease in / out along the flight line
      const x = (f.x0 + (f.x1 - f.x0) * u + 0.5) * C, y = (f.y0 + (f.y1 - f.y0) * u + 0.5) * C;
      const a = Math.atan2(f.y1 - f.y0, f.x1 - f.x0);
      const lift = Math.sin(Math.PI * Math.min(1, f.t)); // 0 on the ground, 1 at the top of the flight
      const alt = 26 * lift, sc = 1 + 0.45 * lift;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.fillStyle = `rgba(0,0,0,${0.2 - 0.1 * lift})`; // shadow stays on the ground
      rr(ctx, -5.8, -2.8, 12.4, 7, 2.2);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.translate(x, y - alt);
      ctx.rotate(a);
      ctx.scale(sc, sc);
      const flap = 0.85 + 0.15 * Math.sin(now / 55 + f.id);
      ctx.fillStyle = '#f4f7fb'; ctx.strokeStyle = '#8e9bb0'; ctx.lineWidth = 0.8;
      for (const sgn of [-1, 1]) { // wings
        ctx.beginPath();
        ctx.moveTo(1.6, sgn * 3);
        ctx.lineTo(-2.4, sgn * 3);
        ctx.lineTo(-4.4, sgn * 10.5 * flap);
        ctx.lineTo(-1.2, sgn * 10.5 * flap);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      const flame = 3 + 2.4 * Math.sin(now / 38 + f.id) * lift + 2.4 * lift;
      ctx.fillStyle = '#ffb02e'; // jet flame out of the back
      ctx.beginPath(); ctx.moveTo(-6, -1.8); ctx.lineTo(-6 - flame - 2, 0); ctx.lineTo(-6, 1.8); ctx.closePath(); ctx.fill();
      this.drawCarBody(ctx, f);
      ctx.restore();
      this.drawWeightBadge(ctx, f.weight, x, y - alt - 8.5 * sc);
    }

    /** Japanese patrol car (パトカー): white body, black hood and trunk, a roof light bar flashing red then blue. Purely decorative. */
    drawPolice(ctx, cop, now) {
      const step = Math.floor(now / 85 + cop.id * 3) % 8; // R . R . B . B .
      const red = step === 0 || step === 2, blue = step === 4 || step === 6;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, cop.alpha));
      ctx.translate(cop.x, cop.y);
      ctx.rotate(cop.ang);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      rr(ctx, -6.2, -2.8, 12.8, 7.2, 2.2); ctx.fill();
      ctx.fillStyle = '#fbfbfb'; ctx.strokeStyle = '#3a4150'; ctx.lineWidth = 1;
      rr(ctx, -6.4, -3.6, 12.8, 7.2, 2.2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#2b303a'; // black hood and trunk
      rr(ctx, 3.6, -3.1, 2.5, 6.2, 1); ctx.fill();
      rr(ctx, -6, -3.1, 2.4, 6.2, 1); ctx.fill();
      ctx.fillStyle = 'rgba(150,200,235,0.9)'; // windscreen
      rr(ctx, 1.1, -2.5, 2.1, 5, 0.8); ctx.fill();
      // light bar: red on the left side of the car, blue on the right
      ctx.fillStyle = red ? '#ff2a2a' : '#7a2a2e';
      rr(ctx, -2.1, -3.1, 3.2, 3.1, 0.8); ctx.fill();
      ctx.fillStyle = blue ? '#2f7bff' : '#2a3a6e';
      rr(ctx, -2.1, 0, 3.2, 3.1, 0.8); ctx.fill();
      if (red || blue) { // glow
        ctx.globalCompositeOperation = 'lighter';
        const gy = red ? -1.6 : 1.6, col = red ? '255,40,40' : '60,130,255';
        const gr = ctx.createRadialGradient(-0.5, gy, 0, -0.5, gy, 15);
        gr.addColorStop(0, `rgba(${col},0.75)`);
        gr.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.arc(-0.5, gy, 15, 0, 6.2832); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore();
    }

    // ------------------------------------------------------------ night
    /** Target darkness for the current time mode: the cycle is a long day, dusk, a long night and dawn. */
    darkTarget() {
      if (this.timeMode === 'day') return 0;
      if (this.timeMode === 'night') return 1;
      const p = ((this.game.time / CFG.DAY_SECONDS) % 1 + 1) % 1;
      const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
      return ss(0.34, 0.5, p) - ss(0.86, 1.0, p);
    }

    /** Small cached light sprites (soft glow in a colour, headlight cone). */
    glowSprite(rgb) {
      const key = 'g' + rgb;
      let c = this.sprites[key];
      if (!c) {
        c = document.createElement('canvas');
        c.width = c.height = 64;
        const x = c.getContext('2d');
        const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
        gr.addColorStop(0, `rgba(${rgb},1)`);
        gr.addColorStop(0.35, `rgba(${rgb},0.45)`);
        gr.addColorStop(1, `rgba(${rgb},0)`);
        x.fillStyle = gr;
        x.fillRect(0, 0, 64, 64);
        this.sprites[key] = c;
      }
      return c;
    }

    coneSprite() {
      let c = this.sprites.cone;
      if (!c) {
        c = document.createElement('canvas');
        c.width = 96; c.height = 64;
        const x = c.getContext('2d');
        const gr = x.createLinearGradient(0, 0, 96, 0);
        gr.addColorStop(0, 'rgba(255,246,210,0.85)');
        gr.addColorStop(1, 'rgba(255,246,210,0)');
        x.fillStyle = gr;
        x.beginPath(); x.moveTo(0, 26); x.lineTo(96, 0); x.lineTo(96, 64); x.lineTo(0, 38); x.closePath(); x.fill();
        this.sprites.cone = c;
      }
      return c;
    }

    glow(ctx, rgb, x, y, r, a) {
      ctx.globalAlpha = Math.min(1, a);
      ctx.drawImage(this.glowSprite(rgb), x - r, y - r, r * 2, r * 2);
    }

    /** Headlights, tail lights, street lamps, lit windows: drawn over a night tint, in world coordinates. */
    drawNight(ctx, now) {
      const v = this.view, g = this.game, w = g.world, k = this.dark;
      // tint everything (screen space)
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgb(${Math.round(255 - 140 * k)},${Math.round(255 - 125 * k)},${Math.round(255 - 70 * k)})`;
      ctx.fillRect(0, 0, v.w, v.h);
      // lights (world space, additive)
      ctx.globalCompositeOperation = 'lighter';
      ctx.save();
      ctx.translate(v.ox, v.oy);
      ctx.scale(v.scale, v.scale);
      const cone = this.coneSprite();
      const carLights = (x, y, a, alpha) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        ctx.globalAlpha = 0.6 * k * alpha;
        ctx.drawImage(cone, 5, -13, 40, 26);
        ctx.globalAlpha = k * alpha;
        ctx.fillStyle = '#fff6d0';
        ctx.fillRect(5.2, -3.4, 1.7, 1.6); ctx.fillRect(5.2, 1.8, 1.7, 1.6);
        ctx.fillStyle = '#ff3b30';
        ctx.fillRect(-6.4, -3.4, 1.4, 1.5); ctx.fillRect(-6.4, 1.9, 1.4, 1.5);
        ctx.restore();
      };
      for (const car of g.cars) {
        if (car.dead || this.carLevel(car) === 2) continue;
        const p = this.carPose(car);
        carLights(p.x, p.y, p.a, 1);
      }
      for (const cop of this.police.cops) carLights(cop.x, cop.y, cop.ang, Math.max(0, cop.alpha));
      // street lamps (街灯) along the roads
      for (let n = 0; n < w.n; n++) {
        if (w.bld[n] || w.deg(n) < 2 || (((n * 2246822519) >>> 0) % 4) !== 0) continue;
        const hor = w.edge(n, 1) || w.edge(n, 3);
        const side = (((n * 40503) >>> 0) & 1) ? 1 : -1;
        const lx = this.nodeX(n) + (hor ? 0 : side * 16), ly = this.nodeY(n) + (hor ? side * 16 : 0);
        if (lx * v.scale + v.ox < -60 || lx * v.scale + v.ox > v.w + 60 || ly * v.scale + v.oy < -60 || ly * v.scale + v.oy > v.h + 60) continue;
        this.glow(ctx, '255,214,130', lx, ly, 34, 0.8 * k);
        ctx.globalAlpha = k;
        ctx.fillStyle = '#fff0b8';
        ctx.beginPath(); ctx.arc(lx, ly, 2, 0, 6.2832); ctx.fill();
      }
      // traffic light lamps, tunnel mouths
      for (let n = 0; n < w.n; n++) {
        if (w.feat[n] !== 1) continue;
        const L = g.lights.get(n);
        for (let d = 0; d < 4; d++) {
          if (!w.edge(n, d)) continue;
          const green = L && !L.pending && L.green === (d & 1);
          this.glow(ctx, green ? '88,224,138' : '255,90,90', this.nodeX(n) + MM.DX[d] * 12.5, this.nodeY(n) + MM.DY[d] * 12.5, 11, 0.8 * k);
        }
      }
      for (const [key] of w.tun) {
        const a = key >> 2, d = key & 3;
        this.glow(ctx, '255,174,58', this.nodeX(a) + MM.DX[d] * 9, this.nodeY(a) + MM.DY[d] * 9, 18, 0.9 * k);
      }
      for (const [n, pt] of w.portal) { // teleport portals glow in their own colour all the time, brighter in the dark
        const blue = pt.style === 'blue';
        this.glow(ctx, blue ? '70,160,255' : '255,150,190', this.nodeX(n), this.nodeY(n) - 5, 30, (0.35 + 0.65 * k) * (0.85 + 0.15 * Math.sin(now / 260 + n)));
      }
      // buildings: windows glow warm, destinations glow in their colour
      for (const b of g.buildings) {
        const x = this.nodeX(b.node), y = this.nodeY(b.node);
        const born = Math.min(1, Math.max(0, (g.time - b.born) / 0.5));
        const col = MM.COLORS[b.color].main;
        const rgb = [1, 3, 5].map((i) => parseInt(col.slice(i, i + 2), 16)).join(',');
        if (b.kind === 'house') { // the colour must stay readable: coloured glow with a warm window
          this.glow(ctx, rgb, x, y, 30, 0.7 * k * born);
          ctx.globalAlpha = 0.45 * k * born;
          ctx.fillStyle = '#ffd98a';
          rr(ctx, -6 + x, -6 + y, 12, 12, 3); ctx.fill();
        } else {
          this.glow(ctx, rgb, x, y, 46, 0.85 * k * born);
          ctx.globalAlpha = 0.28 * k * born;
          ctx.fillStyle = '#ffffff';
          rr(ctx, -9 + x, -9 + y, 18, 18, 5); ctx.fill();
        }
      }
      // police lights flash brighter in the dark
      for (const cop of this.police.cops) {
        const step = Math.floor(now / 85 + cop.id * 3) % 8;
        const red = step === 0 || step === 2, blue = step === 4 || step === 6;
        if (!red && !blue) continue;
        const ca = Math.cos(cop.ang), sa = Math.sin(cop.ang);
        const off = red ? -1.6 : 1.6;
        this.glow(ctx, red ? '255,40,40' : '60,130,255', cop.x - sa * off, cop.y + ca * off, 40, 1.0 * k * Math.max(0, cop.alpha));
      }
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
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
      // a cleared patch of ground in the forest (also keeps the building colours readable on the grass)
      const pr = b.kind === 'house' ? 20 : 28;
      ctx.fillStyle = 'rgba(214,200,150,0.55)';
      ctx.beginPath(); ctx.ellipse(0, 1.5, pr + 4, pr + 1, 0, 0, 6.2832); ctx.fill();
      ctx.fillStyle = 'rgba(247,240,214,0.96)';
      ctx.beginPath(); ctx.ellipse(0, 0.5, pr, pr - 2, 0, 0, 6.2832); ctx.fill();
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

    // ------------------------------------------------------------ teleport portals
    /** Diablo-style town portal: a blue vortex in a stone ring, swirling. */
    drawBluePortal(ctx, x, y, now) {
      const t = now / 1000;
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.ellipse(1, 12, 11, 3.6, 0, 0, 6.2832); ctx.fill();
      const cy = -4, rx = 9.5, ry = 15;
      ctx.fillStyle = '#4b5568'; // stone ring
      ctx.beginPath(); ctx.ellipse(0, cy, rx + 2.6, ry + 2.6, 0, 0, 6.2832); ctx.fill();
      ctx.fillStyle = '#6c778c';
      ctx.beginPath(); ctx.ellipse(0, cy - 0.8, rx + 1.6, ry + 1.6, 0, 0, 6.2832); ctx.fill();
      const gr = ctx.createRadialGradient(0, cy, 1, 0, cy, ry);
      gr.addColorStop(0, '#f2fcff');
      gr.addColorStop(0.35, '#8fe0ff');
      gr.addColorStop(0.75, '#2f7cf0');
      gr.addColorStop(1, '#173ea8');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.ellipse(0, cy, rx, ry, 0, 0, 6.2832); ctx.fill();
      ctx.save(); // the swirl: arcs spinning around the centre, clipped to the oval
      ctx.beginPath(); ctx.ellipse(0, cy, rx, ry, 0, 0, 6.2832); ctx.clip();
      ctx.translate(0, cy);
      ctx.scale(rx / ry, 1);
      ctx.lineCap = 'round';
      for (let k = 0; k < 3; k++) {
        const a0 = t * 2.4 + k * 2.0944;
        ctx.strokeStyle = `rgba(255,255,255,${0.75 - k * 0.12})`;
        ctx.lineWidth = 1.7;
        ctx.beginPath(); ctx.arc(0, 0, ry * (0.78 - k * 0.2), a0, a0 + 2.1); ctx.stroke();
      }
      ctx.restore();
      ctx.restore();
    }

    /** Doraemon's anywhere door (どこでもドア): a pink door standing by itself. */
    drawAnywhereDoor(ctx, x, y, now) {
      const t = now / 1000;
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.ellipse(1, 12.5, 10, 3.2, 0, 0, 6.2832); ctx.fill();
      ctx.fillStyle = '#d2457c'; // frame
      rr(ctx, -9.5, -19, 19, 31, 3.2); ctx.fill();
      ctx.fillStyle = '#ff9ec0'; // door leaf
      rr(ctx, -7.2, -16.7, 14.4, 26.4, 1.6); ctx.fill();
      ctx.fillStyle = '#ffc3d8'; // raised panel
      rr(ctx, -5, -14.4, 10, 9, 1.2); ctx.fill();
      rr(ctx, -5, -3.4, 10, 10.6, 1.2); ctx.fill();
      ctx.fillStyle = '#ffd23f'; // the round gold knob
      ctx.beginPath(); ctx.arc(4.2, -1.6, 1.7, 0, 6.2832); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,' + (0.18 + 0.18 * Math.sin(t * 4)) + ')'; // faint pulse: it is switched on
      rr(ctx, -7.2, -16.7, 14.4, 26.4, 1.6); ctx.fill();
      ctx.restore();
    }

    drawPortals(ctx, now) {
      const g = this.game, w = g.world;
      if (!w.portal.size) return;
      // dashed link between the two portals of a pair, marching both ways (the pair is two-way)
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.4;
      ctx.setLineDash([2, 8]);
      for (const [a, pt] of w.portal) {
        const b = pt.mate;
        if (a > b) continue;
        const ax = this.nodeX(a), ay = this.nodeY(a), bx = this.nodeX(b), by = this.nodeY(b);
        const mx = (ax + bx) / 2 - (by - ay) * 0.18, my = (ay + by) / 2 + (bx - ax) * 0.18;
        ctx.strokeStyle = pt.style === 'blue' ? 'rgba(46,120,235,0.4)' : 'rgba(225,80,135,0.4)';
        for (const dir of [1, -1]) {
          ctx.lineDashOffset = dir * (now / 55) % 10 + (dir < 0 ? 5 : 0);
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(mx, my, bx, by); ctx.stroke();
        }
      }
      ctx.restore();
      for (const [n, pt] of w.portal) {
        const x = this.nodeX(n), y = this.nodeY(n);
        if (pt.style === 'blue') this.drawBluePortal(ctx, x, y, now);
        else this.drawAnywhereDoor(ctx, x, y, now);
      }
    }

    // ------------------------------------------------------------ 超級原子彈
    /** White flash, a shockwave and a mushroom cloud over the whole screen after the bomb (about 2.4 seconds). */
    drawNuke(ctx, now) {
      const t = now - this.nukeAt;
      const DUR = 2400;
      if (t < 0 || t > DUR) return;
      const v = this.view;
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      const cx = v.w / 2, cy = v.h / 2, big = Math.max(v.w, v.h);
      const flash = t < 160 ? t / 160 : Math.max(0, 1 - (t - 160) / 900);
      // shockwave
      const sk = Math.min(1, t / 1300);
      ctx.lineWidth = 10 * (1 - sk) + 2;
      ctx.strokeStyle = `rgba(255,${Math.round(210 - 90 * sk)},90,${0.75 * (1 - sk)})`;
      ctx.beginPath(); ctx.arc(cx, cy, 20 + sk * big * 0.75, 0, 6.2832); ctx.stroke();
      // mushroom cloud
      if (t > 120) {
        const g = Math.min(1, (t - 120) / 1000), e = 1 - Math.pow(1 - g, 3);
        const fade = t > 1700 ? Math.max(0, 1 - (t - 1700) / 700) : 1;
        const u = Math.min(v.w, v.h) / 260 * e;
        ctx.save();
        ctx.translate(cx, cy + 40 * u);
        ctx.globalAlpha = fade * 0.95;
        const stem = ctx.createLinearGradient(0, 0, 0, -90 * u);
        stem.addColorStop(0, '#ffb347'); stem.addColorStop(1, '#8a5a3a');
        ctx.fillStyle = stem;
        ctx.beginPath(); ctx.moveTo(-16 * u, 0); ctx.quadraticCurveTo(-8 * u, -50 * u, -12 * u, -90 * u); ctx.lineTo(12 * u, -90 * u); ctx.quadraticCurveTo(8 * u, -50 * u, 16 * u, 0); ctx.closePath(); ctx.fill();
        const puff = [[0, -100, 34, '#7a4f3a'], [-30, -92, 24, '#8e5c3f'], [30, -92, 24, '#8e5c3f'], [-16, -118, 26, '#c9824a'], [16, -118, 26, '#c9824a'], [0, -130, 24, '#ffb347'], [0, -112, 16, '#ffe08a']];
        for (const [px, py, pr, col] of puff) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(px * u, py * u, pr * u, 0, 6.2832); ctx.fill(); }
        ctx.fillStyle = 'rgba(255,200,120,0.5)'; // fire glow at the base
        ctx.beginPath(); ctx.ellipse(0, 2 * u, 46 * u, 12 * u, 0, 0, 6.2832); ctx.fill();
        ctx.restore();
      }
      if (flash > 0) { ctx.globalAlpha = Math.min(1, flash); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, v.w, v.h); }
      ctx.globalAlpha = 1;
    }

    /** The mega roundabout's lawn (the inside of the ring) and the flow arrows on its four lanes. The lawn is drawn for a 240-unit square and scaled to fit. */
    drawMega(ctx, big) {
      const S = MM.CFG.MEGA_SIZE;
      const x0 = this.nodeX(big.center) + 20, y0 = this.nodeY(big.center) + 20, L = (S - 1) * C - 40; // inside the ring road's kerb
      const k = L / 240, pond = Math.max(1, 0.45 / k); // a small lawn gets a relatively bigger pond and fewer trees
      ctx.save();
      ctx.translate(x0 + L / 2, y0 + L / 2);
      ctx.scale(k, k);
      ctx.fillStyle = '#a9d9b1'; rr(ctx, -120, -120, 240, 240, 26); ctx.fill();
      ctx.fillStyle = '#8cc89d'; rr(ctx, -111, -111, 222, 222, 20); ctx.fill();
      ctx.fillStyle = '#6fb383';
      const trees = [[-70, -52, 16], [62, -66, 12], [-40, 58, 14], [76, 40, 17], [-92, 28, 11], [20, -20, 9], [-10, 84, 10], [98, -12, 9]];
      for (const [tx, ty, tr] of k < 0.5 ? trees.slice(0, 4) : trees) { ctx.beginPath(); ctx.arc(tx, ty, tr, 0, 6.2832); ctx.fill(); }
      ctx.fillStyle = '#9fd3a8'; // a round pond in the middle
      ctx.beginPath(); ctx.arc(0, 0, 34 * pond, 0, 6.2832); ctx.fill();
      ctx.fillStyle = '#b9e1f1'; ctx.beginPath(); ctx.arc(0, 0, 27 * pond, 0, 6.2832); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.arc(-8 * pond, -8 * pond, 6 * pond, 0, 6.2832); ctx.fill();
      ctx.restore();
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; // flow arrows on all four lanes
      const n = big.nodes.length;
      for (let i = 0; i < n; i++) {
        const a = big.nodes[i], b = big.nodes[(i + 1) % n];
        if (i % 2) continue;
        const mx = (this.nodeX(a) + this.nodeX(b)) / 2, my = (this.nodeY(a) + this.nodeY(b)) / 2;
        const dx = Math.sign(this.nodeX(b) - this.nodeX(a)), dy = Math.sign(this.nodeY(b) - this.nodeY(a));
        for (const o of [-12, -4, 4, 12]) {
          const px = mx - dy * o, py = my + dx * o; // (right-hand side of the heading is (-dy, dx))
          ctx.beginPath();
          ctx.moveTo(px + dx * 4, py + dy * 4);
          ctx.lineTo(px - dx * 2.6 - dy * 2.6, py - dy * 2.6 + dx * 2.6);
          ctx.lineTo(px - dx * 2.6 + dy * 2.6, py - dy * 2.6 - dx * 2.6);
          ctx.closePath();
          ctx.fill();
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
      const clock = now / 1000;
      this.scn.drawBehind(ctx, v, clock, g.world, this.cam.zoom); // flowing water, swaying trees

      ctx.save();
      ctx.translate(v.ox, v.oy);
      ctx.scale(v.scale, v.scale);
      const w = g.world;
      ctx.save();

      // ---- roads
      const edges = [];
      for (let n = 0; n < w.n; n++) {
        const e = w.eE[n];
        if (e) edges.push(n, n + 1, e & 3, e >> 2, w.eEw[n]);
        const s = w.eS[n];
        if (s) edges.push(n, n + w.cols, s & 3, s >> 2, w.eSw[n]);
      }
      const strokeEdges = (width, color, filter) => {
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let k = 0; k < edges.length; k += 5) {
          if (!filter(edges[k], edges[k + 1], edges[k + 2], edges[k + 4])) continue;
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
      if (edges.length) {
        // Layers are drawn for ALL roads before the next layer starts, so junctions merge cleanly:
        // sidewalk -> white edge line -> asphalt. (The white line is just a slightly wider stroke under the asphalt.)
        ctx.lineCap = 'round';
        strokeEdges(R_WIDE + 8, THEME.sidewalk, (a, b, t, wd) => t === 1 && wd);
        strokeEdges(R_NARROW + 8, THEME.sidewalk, (a, b, t, wd) => t === 1 && !wd);
        strokeEdges(R_HW + 8, THEME.hwEdge, (a, b, t) => t === 2);
        strokeEdges(R_WIDE + 2.6, '#ffffff', (a, b, t, wd) => t === 1 && wd);
        strokeEdges(R_NARROW + 2.6, '#ffffff', (a, b, t, wd) => t === 1 && !wd);
        strokeEdges(R_HW + 2.6, '#ffffff', (a, b, t) => t === 2);
        strokeEdges(R_WIDE, THEME.road, (a, b, t, wd) => t === 1 && wd);
        strokeEdges(R_NARROW, THEME.road, (a, b, t, wd) => t === 1 && !wd);
        strokeEdges(R_HW, THEME.hw, (a, b, t) => t === 2);

        // centre lines, stopped short of junctions (where the zebra crossings go) and buildings:
        // two-lane road = white dashes; four-lane road = solid yellow centre line + white dashes between the lanes
        const trimmed = (k, fn) => {
          const a = edges[k], b = edges[k + 1];
          const ax = this.nodeX(a), ay = this.nodeY(a), bx = this.nodeX(b), by = this.nodeY(b);
          const ta = w.isJunction(a) ? 17 : w.bld[a] ? 15 : 0, tb = w.isJunction(b) ? 17 : w.bld[b] ? 15 : 0;
          const ux = Math.sign(bx - ax), uy = Math.sign(by - ay), len = C - ta - tb;
          if (len < 7) return;
          fn(ax + ux * ta, ay + uy * ta, bx - ux * tb, by - uy * tb, -uy, ux);
        };
        ctx.lineCap = 'butt';
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        for (let k = 0; k < edges.length; k += 5) {
          if (edges[k + 4]) continue;
          trimmed(k, (x0, y0, x1, y1) => { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); });
        }
        ctx.stroke();
        ctx.beginPath(); // lane lines of four-lane roads (between the two lanes of each direction; a one-way one has three, all dashed)
        for (let k = 0; k < edges.length; k += 5) {
          if (!edges[k + 4]) continue;
          const ow = edges[k + 3] > 0;
          trimmed(k, (x0, y0, x1, y1, nx, ny) => {
            for (const o of ow ? [-8, 0, 8] : [-8, 8]) { ctx.moveTo(x0 + nx * o, y0 + ny * o); ctx.lineTo(x1 + nx * o, y1 + ny * o); }
          });
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#f0c52f';
        ctx.beginPath(); // solid yellow centre line (no overtaking)
        for (let k = 0; k < edges.length; k += 5) {
          if (!edges[k + 4] || edges[k + 3]) continue;
          trimmed(k, (x0, y0, x1, y1, nx, ny) => {
            for (const o of [-0.9, 0.9]) { ctx.moveTo(x0 + nx * o, y0 + ny * o); ctx.lineTo(x1 + nx * o, y1 + ny * o); }
          });
        }
        ctx.stroke();

        // junction details: zebra crossings + stop lines on every approach, "止まれ" signs at plain junctions
        const detail = v.scale >= 0.4;
        for (let n = 0; n < w.n; n++) {
          if (!w.isJunction(n)) continue;
          const x = this.nodeX(n), y = this.nodeY(n);
          const plain = !w.feat[n] && !w.ringId[n];
          for (let d = 0; d < 4; d++) {
            const t = w.rawE(n, d) & 3;
            if (!t || w.tun.has(n * 4 + d)) continue;
            ctx.save();
            ctx.translate(x + MM.DX[d] * 13.5, y + MM.DY[d] * 13.5);
            ctx.rotate(Math.atan2(MM.DY[d], MM.DX[d]));
            ctx.fillStyle = 'rgba(255,255,255,0.93)';
            const wd = w.isWideDir(n, d); // four-lane approach: longer crossing, wider stop line
            const bars = wd ? 9 : 5, pitch = wd ? 3.3 : 3.1;
            for (let i = 0; i < bars; i++) ctx.fillRect(-2.6, -((bars - 1) * pitch + 1.7) / 2 + i * pitch, 5.2, 1.7); // zebra bars run along the road
            ctx.fillRect(4.1, wd ? -15.6 : -7.4, 1.8, wd ? 14.8 : 6.6); // stop line, on the lanes that drive towards the junction
            if (detail && plain) {
              ctx.translate(4.6, wd ? -21.5 : -13.5); // 止まれ: red inverted triangle on the roadside
              ctx.fillStyle = '#ffffff';
              ctx.beginPath(); ctx.moveTo(-3.6, -3); ctx.lineTo(3.6, -3); ctx.lineTo(0, 3.6); ctx.closePath(); ctx.fill();
              ctx.fillStyle = '#e53a35';
              ctx.beginPath(); ctx.moveTo(-2.4, -2.1); ctx.lineTo(2.4, -2.1); ctx.lineTo(0, 2.1); ctx.closePath(); ctx.fill();
            }
            ctx.restore();
          }
        }

        // expressway entrances / exits carry a green sign board
        if (detail) {
          for (let k = 0; k < edges.length; k += 5) {
            if (edges[k + 2] !== 2) continue;
            for (const [n, m] of [[edges[k], edges[k + 1]], [edges[k + 1], edges[k]]]) {
              let other = false;
              for (let d = 0; d < 4; d++) { const t = w.rawE(n, d) & 3; if (t && t !== 2) other = true; }
              if (!other && !w.bld[n]) continue;
              const dx = Math.sign(this.nodeX(m) - this.nodeX(n)), dy = Math.sign(this.nodeY(m) - this.nodeY(n));
              ctx.save();
              ctx.translate(this.nodeX(n) + dx * 21, this.nodeY(n) + dy * 21);
              ctx.rotate(Math.atan2(dy, dx));
              ctx.fillStyle = '#2f7a55'; rr(ctx, -4.5, -17, 9, 5.4, 1.2); ctx.fill();
              ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 0.8; rr(ctx, -4.5, -17, 9, 5.4, 1.2); ctx.stroke();
              ctx.fillStyle = '#ffffff'; ctx.fillRect(-2.6, -14.5, 5.2, 0.9); ctx.fillRect(-2.6, -13.1, 3.4, 0.9);
              ctx.restore();
            }
          }
        }

        // utility poles (電柱) beside straight stretches
        if (detail) {
          for (let n = 0; n < w.n; n++) {
            const dg = w.deg(n);
            if (dg !== 2 || w.bld[n] || w.hasWide(n) || (((n * 2654435761) >>> 0) % 6) !== 0) continue;
            const hor = w.edge(n, 1) && w.edge(n, 3), ver = w.edge(n, 0) && w.edge(n, 2);
            if (!hor && !ver) continue;
            const side = (((n * 40503) >>> 0) & 1) ? 1 : -1;
            const px = this.nodeX(n) + (ver ? side * 15 : 0), py = this.nodeY(n) + (hor ? side * 15 : 0);
            ctx.fillStyle = 'rgba(20,40,30,0.22)';
            ctx.beginPath(); ctx.ellipse(px + 1.5, py + 2, 2.6, 1.6, 0, 0, 6.2832); ctx.fill();
            ctx.strokeStyle = '#4a3f35'; ctx.lineWidth = 1.1;
            ctx.beginPath();
            if (hor) { ctx.moveTo(px - 3, py); ctx.lineTo(px + 3, py); } else { ctx.moveTo(px, py - 3); ctx.lineTo(px, py + 3); }
            ctx.stroke();
            ctx.fillStyle = '#6b5a48';
            ctx.beginPath(); ctx.arc(px, py, 1.7, 0, 6.2832); ctx.fill();
          }
        }
      }

      // ---- big roundabouts: green island in the middle, arrows showing the (counter-clockwise) flow
      for (const big of g.bigs.values()) {
        if (big.kind === 'mega') { this.drawMega(ctx, big); continue; }
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
      for (const cop of this.police.cops) this.drawPolice(ctx, cop, now);
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
        ctx.fillStyle = '#ffae3a'; // the orange lamps along a Japanese tunnel mouth
        for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.arc(x - MM.DY[d] * i * 6.2 + MM.DX[d] * 9.2, y + MM.DX[d] * i * 6.2 + MM.DY[d] * 9.2, 1.5, 0, 6.2832); ctx.fill(); }
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

      // ---- teleport portals (over the cars, so cars seem to vanish into the entrance)
      this.drawPortals(ctx, now);

      // ---- buildings
      for (const b of g.buildings) this.drawBuilding(ctx, b, g.time);

      // ---- placement hints
      if ((this.tool === 'light' || this.tool === 'round' || this.tool === 'ovp') && g.canEdit()) {
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
      // 天神之手: the lifted building follows the pointer as a ghost (green = it can be put down there)
      if (this.tool === 'hand' && g.canEdit()) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 200);
        if (this.handFirst >= 0 && w.bld[this.handFirst]) {
          const b = w.bld[this.handFirst];
          const fx = this.nodeX(this.handFirst), fy = this.nodeY(this.handFirst);
          ctx.strokeStyle = '#d99a00'; ctx.lineWidth = 2.6; ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.arc(fx, fy, 20 + 3 * pulse, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
          if (this.hover >= 0 && this.hover !== this.handFirst) {
            const bad = w.bld[this.hover] ? null : g.checkMove(this.handFirst, this.hover);
            const x = this.nodeX(this.hover), y = this.nodeY(this.hover);
            const ok = !w.bld[this.hover] && !bad;
            ctx.globalAlpha = 0.75;
            ctx.fillStyle = ok ? MM.COLORS[b.color].main : '#b9bec8';
            rr(ctx, x - 13, y - 13, 26, 26, 7); ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = ok ? '#1e9a64' : '#e03c46'; ctx.lineWidth = 2.4;
            rr(ctx, x - 15, y - 15, 30, 30, 8); ctx.stroke();
            ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(217,154,0,0.8)'; ctx.lineWidth = 1.6;
            ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
          }
        } else {
          ctx.strokeStyle = `rgba(217,154,0,${0.35 + 0.4 * pulse})`; ctx.lineWidth = 2.2; ctx.setLineDash([4, 4]);
          for (const b of g.buildings) { ctx.beginPath(); ctx.arc(this.nodeX(b.node), this.nodeY(b.node), 20, 0, 6.2832); ctx.stroke(); }
          ctx.setLineDash([]);
        }
      }
      // portals: road ends that can take one (pulsing), and the entrance picked so far
      if (this.tool === 'tp' && g.canEdit()) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 220);
        ctx.lineWidth = 2.2;
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = `rgba(47,58,75,${0.35 + 0.35 * pulse})`;
        if (g.inv.tp > 0) {
          for (let n = 0; n < w.n; n++) {
            if (n === this.tpFirst || g.checkPortal(n)) continue;
            ctx.beginPath(); ctx.arc(this.nodeX(n), this.nodeY(n), 17, 0, 6.2832); ctx.stroke();
          }
        }
        ctx.setLineDash([]);
        if (this.tpFirst >= 0) {
          const x = this.nodeX(this.tpFirst), y = this.nodeY(this.tpFirst);
          ctx.strokeStyle = '#e8780c'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(x, y, 19 + 2 * pulse, 0, 6.2832); ctx.stroke();
          ctx.fillStyle = '#e8780c';
          ctx.font = 'bold 12px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('第一個門', x, y - 26);
        }
      }
      // mega roundabout: show the footprint under the pointer
      if (this.tool === 'mega' && this.hover >= 0 && g.canEdit()) {
        const tl = g.megaAnchor(this.hover), bad = g.checkMega(tl);
        const x = this.nodeX(tl) - C / 2, y = this.nodeY(tl) - C / 2, S = MM.CFG.MEGA_SIZE;
        const busy = !bad && !g.megaClear(tl); // something stands there: it will be moved out of the way (amber)
        ctx.fillStyle = bad ? 'rgba(235,60,70,0.16)' : busy ? 'rgba(240,170,40,0.18)' : 'rgba(53,196,140,0.18)';
        ctx.strokeStyle = bad ? 'rgba(235,60,70,0.7)' : busy ? 'rgba(214,138,0,0.85)' : 'rgba(30,150,100,0.8)';
        ctx.lineWidth = 2.4;
        ctx.setLineDash([8, 6]);
        rr(ctx, x, y, S * C, S * C, 26);
        ctx.fill(); ctx.stroke();
        ctx.setLineDash([]);
        if (busy) { ctx.fillStyle = '#9a6200'; ctx.font = '600 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('範圍內的東西會自動移開', x + S * C / 2, y - 6); }
      }
      // big roundabout: show the 3x3 footprint under the pointer (green = fits, red = blocked)
      if (this.tool === 'big' && this.hover >= 0 && g.canEdit()) {
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
      if (this.preview && g.canEdit()) {
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
      if (this.hover >= 0 && g.canEdit()) {
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
          ctx.fillText('+' + (f.n || 1), x, y - 22 - k * 20);
        } else if (f.kind === 'puff') {
          ctx.fillStyle = 'rgba(80,90,100,0.6)';
          ctx.beginPath();
          ctx.arc(x, y, 5 + k * 12, 0, 6.2832);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      for (const f of g.flyers) if (!f.dead) this.drawFlyer(ctx, f, now);
      ctx.restore();
      ctx.restore();
      if (this.showPlanes) { this.planes.update(clock, v); this.planes.drawShadows(ctx, v); }
      this.scn.drawSky(ctx, v, clock); // cloud shadows, clouds, drifting petals
      if (this.showPlanes) this.planes.draw(ctx, v, now);
      const dt = Math.min(0.25, Math.max(0, (now - this._lastNow) / 1000));
      this._lastNow = now;
      const target = this.darkTarget();
      this.dark += (target - this.dark) * Math.min(1, dt * 2.5);
      if (Math.abs(target - this.dark) < 0.002) this.dark = target;
      if (this.dark > 0.01) this.drawNight(ctx, now);
      this.drawNuke(ctx, now);
    }

    addEvents(events) {
      const g = this.game;
      for (const e of events) {
        if (e.type === 'deliver') {
          const col = MM.COLORS[e.color].main;
          this.fx.push({ kind: 'ring', node: e.node, color: col, t0: g.time, dur: 0.55, r: 26 });
          this.fx.push({ kind: 'plus', node: e.node, color: e.weight > 1 ? '#d99a00' : MM.COLORS[e.color].dark, n: e.weight, t0: g.time, dur: e.weight > 1 ? 1.1 : 0.7 });
          if (e.weight > 1) this.fx.push({ kind: 'ring', node: e.node, color: '#ffc21a', t0: g.time, dur: 0.9, r: 44 });
        } else if (e.type === 'spawn') {
          this.fx.push({ kind: 'ring', node: e.node, color: MM.COLORS[e.color].main, t0: g.time, dur: 0.9, r: 46 });
        } else if (e.type === 'lost') {
          this.fx.push({ kind: 'puff', node: e.node, t0: g.time, dur: 0.4 });
        } else if (e.type === 'place') {
          this.fx.push({ kind: 'ring', node: e.node, color: '#2f3a4b', t0: g.time, dur: 0.4, r: 18 });
        } else if (e.type === 'teleport') {
          const style = g.world.portal.get(e.from) ? g.world.portal.get(e.from).style : 'blue';
          const col = style === 'blue' ? '#4aa8ff' : '#ff8fb8';
          this.fx.push({ kind: 'ring', node: e.from, color: col, t0: g.time, dur: 0.35, r: 14 });
          this.fx.push({ kind: 'ring', node: e.to, color: col, t0: g.time, dur: 0.45, r: 20 });
        } else if (e.type === 'move') {
          this.fx.push({ kind: 'ring', node: e.from, color: '#ffd24d', t0: g.time, dur: 0.6, r: 34 });
          this.fx.push({ kind: 'ring', node: e.node, color: MM.COLORS[e.color].main, t0: g.time, dur: 0.9, r: 46 });
        } else if (e.type === 'nuke') {
          this.nukeAt = performance.now();
        } else if (e.type === 'kayray') {
          for (const b of g.buildings) this.fx.push({ kind: 'ring', node: b.node, color: '#ffd24d', t0: g.time, dur: 1.1, r: 60 });
        } else if (e.type === 'gameover') {
          this.fx.push({ kind: 'ring', node: e.node, color: '#eb323c', t0: g.time, dur: 1.2, r: 90 });
        }
      }
    }
  }

  MM.Renderer = Renderer;
  MM.THEME = THEME;
})(typeof window !== 'undefined' ? window : globalThis);
