/* Mini Motorway X — UI: input, HUD, modals, sound, main loop */
(function () {
  'use strict';
  const MM = window.MM;
  const $ = (id) => document.getElementById(id);
  const canvas = $('cv');
  const renderer = new MM.Renderer(canvas);

  const DAYS = ['一', '二', '三', '四', '五', '六', '日'];
  const BEST_KEY = 'mmx_best_v1';
  const MUTE_KEY = 'mmx_mute_v1';

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ }
    },
  };

  const ui = {
    game: null,
    mode: 'start', // start | play | pause
    speed: 1,
    tool: 'road',
    best: parseInt(store.get(BEST_KEY) || '0', 10) || 0,
    muted: store.get(MUTE_KEY) === '1',
    overShown: false,
    overTimer: 0,
  };
  window.MMUI = ui; // handy for debugging / tests
  ui.renderer = renderer;

  // ---------------------------------------------------------------- sound
  const sfx = (function () {
    let ac = null;
    function ctx() {
      if (!ac) {
        try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; }
      }
      if (ac && ac.state === 'suspended') ac.resume();
      return ac;
    }
    function tone(freq, dur, type, vol, delay, slideTo) {
      if (ui.muted) return;
      const a = ctx();
      if (!a) return;
      const t0 = a.currentTime + (delay || 0);
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.05, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(a.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    }
    let lastDeliver = 0;
    return {
      unlock() { ctx(); },
      deliver(color) {
        const now = performance.now();
        if (now - lastDeliver < 45) return;
        lastDeliver = now;
        tone(520 + color * 62, 0.16, 'triangle', 0.045);
      },
      road() { tone(180, 0.05, 'square', 0.012); },
      erase() { tone(240, 0.09, 'sawtooth', 0.02, 0, 120); },
      place() { tone(660, 0.08, 'triangle', 0.05); tone(880, 0.1, 'triangle', 0.045, 0.07); },
      spawn() { tone(330, 0.14, 'sine', 0.04, 0, 440); },
      week() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.28, 'triangle', 0.05, i * 0.09)); },
      over() { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.35, 'sawtooth', 0.04, i * 0.16)); },
      deny() { tone(150, 0.14, 'square', 0.03); },
      click() { tone(500, 0.05, 'triangle', 0.04); },
    };
  })();

  // ---------------------------------------------------------------- toast
  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1700);
  }

  // ---------------------------------------------------------------- layout
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    const hud = $('hud').getBoundingClientRect();
    const tb = $('toolbar').getBoundingClientRect();
    renderer.insets.top = hud.bottom + 10;
    renderer.insets.bottom = h - tb.top + 10;
    renderer.insets.side = w < 640 ? 8 : 16;
    renderer.resize(w, h, dpr);
  }

  // ---------------------------------------------------------------- game lifecycle
  function newGame() {
    resize();
    const grid = renderer.suggestGrid();
    ui.game = new MM.Game({ cols: grid.cols, rows: grid.rows });
    ui.overShown = false;
    ui.overTimer = 0;
    renderer.setGame(ui.game);
    renderer.tool = ui.tool;
    stroke = null;
  }

  // ---------------------------------------------------------------- modals
  const modal = $('modal'), card = $('card');
  function showModal(html) {
    card.innerHTML = html;
    modal.classList.remove('hidden');
  }
  function hideModal() { modal.classList.add('hidden'); }

  const UP_ICONS = {
    light: '<svg viewBox="0 0 32 32"><rect x="10" y="3" width="12" height="26" rx="6" fill="#2b3340"/><circle cx="16" cy="9.5" r="2.8" fill="#ff5a5a"/><circle cx="16" cy="16" r="2.8" fill="#ffd24d"/><circle cx="16" cy="22.5" r="2.8" fill="#58e08a"/></svg>',
    round: '<svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="9.5" stroke="#8e9bb0" stroke-width="6"/><circle cx="16" cy="16" r="3" fill="#9fd3a8"/></svg>',
    bridge: '<svg viewBox="0 0 32 32" fill="none" stroke="#2f3a4b" stroke-width="2.4" stroke-linecap="round"><rect x="0" y="22" width="32" height="8" fill="#b7dcec" stroke="none"/><path d="M3 20h26M7 20v-6M25 20v-6M7 14c4 0 5 4 9 4s5-4 9-4"/></svg>',
    hw: '<svg viewBox="0 0 32 32" fill="none" stroke-linecap="round"><path d="M5 26C5 14 14 20 16 14S22 6 27 6" stroke="#f4ab45" stroke-width="6"/><path d="M5 26C5 14 14 20 16 14S22 6 27 6" stroke="#fff" stroke-width="1.4" stroke-dasharray="2.5 3"/></svg>',
  };

  function colorDots(n) {
    let h = '<div class="dots">';
    for (let i = 0; i < n; i++) h += `<i style="background:${MM.COLORS[i].main}"></i>`;
    return h + '</div>';
  }

  function showStart() {
    ui.mode = 'start';
    showModal(`
      <h1>Mini Motorway X</h1>
      <p>用道路連接房子與同色的目的地,讓城市保持暢通。</p>
      ${colorDots(6)}
      <ol class="tips">
        <li><b>拖曳</b>畫出道路,把房子連到<b>同顏色</b>的目的地。</li>
        <li>目的地旁的<b>圓點</b>是等待中的車輛需求,太多就會被紅圈倒數,填滿即<b>遊戲結束</b>。</li>
        <li>每週結束可挑選一項升級:紅綠燈、圓環、橋樑、高速公路。</li>
        <li>選擇橡皮擦(電腦可用右鍵拖曳)來拆除道路。</li>
      </ol>
      <button class="btn" id="mStart">開始遊戲</button>`);
    $('mStart').onclick = () => { sfx.unlock(); sfx.click(); hideModal(); ui.mode = 'play'; };
  }

  function showPause() {
    ui.mode = 'pause';
    $('pauseIcon').setAttribute('d', 'M8 5l11 7-11 7z');
    showModal(`<h2>已暫停</h2><p>喘口氣,規劃一下路網吧。</p><button class="btn" id="mResume">繼續</button><button class="btn alt" id="mNew">重新開始</button>`);
    $('mResume').onclick = resume;
    $('mNew').onclick = () => { restart(); };
  }

  function resume() {
    if (ui.mode !== 'pause') return;
    hideModal();
    ui.mode = 'play';
    $('pauseIcon').setAttribute('d', 'M8 5v14M16 5v14');
  }

  function showUpgrade(g, ev) {
    ui.mode = 'pause';
    sfx.week();
    const nc = ev && ev.newColor >= 0 ? ev.newColor : -1;
    let html = `<h2>第 ${g.week - 1} 週結束</h2>`;
    if (nc >= 0) html += `<p>新的顏色出現了:<b style="color:${MM.COLORS[nc].dark}">${MM.COLORS[nc].name}色</b>的房子與目的地!</p>`;
    else html += '<p>城市持續成長中,新的目的地出現了。</p>';
    html += '<p>挑選一項升級:</p><div class="choices">';
    g.choices.forEach((u, i) => {
      html += `<button class="choice" data-i="${i}"><div class="ico">${UP_ICONS[u.id]}</div><b>${u.title}</b><span class="amt">+${u.amount}</span><small>${u.desc}</small></button>`;
    });
    html += '</div>';
    showModal(html);
    card.querySelectorAll('.choice').forEach((el) => {
      el.onclick = () => {
        const u = g.choices[+el.dataset.i];
        g.chooseUpgrade(+el.dataset.i);
        sfx.place();
        hideModal();
        ui.mode = 'play';
        toast(`獲得 ${u.title} ×${u.amount}`);
      };
    });
  }

  function showOver(g) {
    sfx.over();
    const newBest = g.score > ui.best;
    if (newBest) { ui.best = g.score; store.set(BEST_KEY, String(ui.best)); }
    showModal(`
      <h2>交通癱瘓了!</h2>
      <p>${MM.COLORS[g.over.dest.color].name}色目的地的車輛擠爆了。</p>
      <div class="big">${g.score}</div>
      <p>輛車成功送達 · 撐到第 ${g.week} 週${newBest ? ' · <b style="color:#e8590c">新紀錄!</b>' : ` · 最高 ${ui.best}`}</p>
      <button class="btn" id="mAgain">再玩一次</button>`);
    $('mAgain').onclick = () => { restart(); };
  }

  function restart() {
    hideModal();
    $('pauseIcon').setAttribute('d', 'M8 5v14M16 5v14');
    newGame();
    ui.mode = 'play';
  }

  // ---------------------------------------------------------------- tools & input
  function setTool(t) {
    ui.tool = t;
    renderer.tool = t;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  }
  document.querySelectorAll('.tool').forEach((b) => {
    b.addEventListener('click', () => { sfx.unlock(); sfx.click(); setTool(b.dataset.tool); });
  });

  let stroke = null;
  let lastDeny = 0;
  function deny(msg) {
    const now = performance.now();
    if (now - lastDeny < 900) return;
    lastDeny = now;
    toast(msg);
    sfx.deny();
    if (/橋/.test(msg)) {
      const chip = $('bridgeChip');
      chip.classList.remove('flash');
      void chip.offsetWidth;
      chip.classList.add('flash');
    }
  }

  function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function stepToward(g, cur, to) {
    const w = g.world;
    const dc = w.col(to) - w.col(cur), dr = w.row(to) - w.row(cur);
    if (Math.abs(dc) >= Math.abs(dr)) return cur + Math.sign(dc);
    return cur + Math.sign(dr) * w.cols;
  }

  function applyStep(g, cur, next) {
    const w = g.world;
    if (stroke.tool === 'erase') {
      if (g.removeEdge(cur, next).ok) sfx.erase();
      return;
    }
    // a stroke never continues *through* a building: it can only start or end on one
    if (w.bld[cur] && cur !== stroke.start) return;
    const kind = stroke.tool === 'hw' ? 2 : 1;
    const r = g.addEdge(cur, next, kind);
    if (r.ok) sfx.road();
    else if (r.reason === 'nobridge') deny('橋樑不足!下週的升級可以獲得更多');
    else if (r.reason === 'nohw') deny('高速公路數量不足');
    else if (r.reason === 'hw-water') deny('高速公路不能建在水上');
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    sfx.unlock();
    const g = ui.game;
    if (ui.mode !== 'play' || g.state !== 'running') return;
    canvas.setPointerCapture(e.pointerId);
    const [px, py] = localPoint(e);
    const n = renderer.pickNode(px, py);
    renderer.hover = n;
    const tool = e.button === 2 ? 'erase' : ui.tool;
    stroke = { tool, last: n, start: n, id: e.pointerId };
    if (n < 0) return;
    if (tool === 'light' || tool === 'round') {
      const r = g.placeFeature(n, tool);
      if (r.ok) sfx.place();
      else if (r.reason === 'need3') deny('要放在三岔以上的路口');
      else if (r.reason === 'none') deny('已經用完了,下週再挑選升級');
      else if (r.reason === 'occupied') deny('這裡不能放置');
      stroke = null;
    } else if (tool === 'erase') {
      if (g.removeFeature(n)) { sfx.erase(); }
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const g = ui.game;
    const [px, py] = localPoint(e);
    const n = renderer.pickNode(px, py);
    renderer.hover = e.pointerType === 'touch' && !stroke ? -1 : n;
    if (!stroke || e.pointerId !== stroke.id || ui.mode !== 'play' || g.state !== 'running') return;
    if (n < 0 || n === stroke.last) return;
    if (stroke.last < 0) { stroke.last = n; stroke.start = n; return; }
    if (stroke.tool === 'light' || stroke.tool === 'round') return;
    let cur = stroke.last;
    let guard = g.cols + g.rows + 4;
    while (cur !== n && guard-- > 0) {
      const next = stepToward(g, cur, n);
      applyStep(g, cur, next);
      cur = next;
    }
    stroke.last = n;
  });

  const endStroke = (e) => {
    if (stroke && e.pointerId === stroke.id) stroke = null;
    if (e.pointerType === 'touch') renderer.hover = -1;
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', () => { renderer.hover = -1; });

  // ---------------------------------------------------------------- buttons / keys
  function togglePause() {
    if (ui.mode === 'play') showPause();
    else if (ui.mode === 'pause' && ui.game.state === 'running') resume();
  }
  $('btnPause').onclick = () => { sfx.unlock(); sfx.click(); togglePause(); };
  $('btnSpeed').onclick = () => {
    ui.speed = ui.speed === 1 ? 2 : ui.speed === 2 ? 3 : 1;
    $('btnSpeed').textContent = ui.speed + '×';
    sfx.click();
  };
  function refreshSoundIcon() {
    $('btnSound').classList.toggle('off', ui.muted);
    $('soundWaves').style.display = ui.muted ? 'none' : '';
  }
  $('btnSound').onclick = () => {
    ui.muted = !ui.muted;
    store.set(MUTE_KEY, ui.muted ? '1' : '0');
    refreshSoundIcon();
    sfx.click();
  };
  $('btnRestart').onclick = () => {
    if (ui.game.state === 'over' || ui.game.score < 5 || window.confirm('確定要重新開始嗎?')) restart();
  };
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const map = { 1: 'road', 2: 'hw', 3: 'light', 4: 'round', 5: 'erase' };
    if (map[e.key] && ui.mode === 'play') setTool(map[e.key]);
    else if (e.key === ' ' || e.key === 'p' || e.key === 'P') { e.preventDefault(); togglePause(); }
  });
  window.addEventListener('resize', () => { resize(); });
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));

  // ---------------------------------------------------------------- HUD
  const hud = { score: -1, week: -1, day: -1, fill: -1, inv: '' };
  function updateHud(g) {
    if (hud.score !== g.score) { hud.score = g.score; $('score').textContent = g.score; }
    const best = Math.max(ui.best, g.score);
    $('best').textContent = '最高 ' + best;
    if (hud.week !== g.week) { hud.week = g.week; $('weekName').textContent = `第 ${g.week} 週`; }
    const d = g.dayIndex();
    if (hud.day !== d) { hud.day = d; $('dayName').textContent = '週' + DAYS[d]; }
    const f = Math.round((g.weekTime / MM.CFG.WEEK_SECONDS) * 1000) / 10;
    if (hud.fill !== f) { hud.fill = f; $('weekFill').style.width = f + '%'; }
    const sig = `${g.inv.hw}|${g.inv.light}|${g.inv.round}|${g.inv.bridge}`;
    if (sig !== hud.inv) {
      hud.inv = sig;
      $('cntHw').textContent = g.inv.hw;
      $('cntLight').textContent = g.inv.light;
      $('cntRound').textContent = g.inv.round;
      $('cntBridge').textContent = g.inv.bridge;
      document.querySelector('[data-tool="hw"]').classList.toggle('empty', g.inv.hw <= 0);
      document.querySelector('[data-tool="light"]').classList.toggle('empty', g.inv.light <= 0);
      document.querySelector('[data-tool="round"]').classList.toggle('empty', g.inv.round <= 0);
    }
  }

  // ---------------------------------------------------------------- events
  function handleEvents(g) {
    if (!g.events.length) return;
    const evs = g.events.splice(0);
    renderer.addEvents(evs);
    for (const e of evs) {
      if (e.type === 'deliver') sfx.deliver(e.color);
      else if (e.type === 'spawn' && g.time > 1) sfx.spawn();
      else if (e.type === 'week') { /* modal handled below */ ui.pendingWeek = e; }
    }
  }

  // ---------------------------------------------------------------- main loop
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const g = ui.game;
    if (g) {
      if (ui.mode === 'play' && g.state === 'running') g.update(dt * ui.speed);
      handleEvents(g);
      if (ui.mode === 'play' && g.state === 'upgrade') showUpgrade(g, ui.pendingWeek);
      if (g.state === 'over' && !ui.overShown) {
        ui.overTimer += dt;
        if (ui.overTimer > 1.1) { ui.overShown = true; ui.mode = 'pause'; showOver(g); }
      }
      updateHud(g);
      renderer.render(now);
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- boot
  refreshSoundIcon();
  newGame();
  showStart();
  requestAnimationFrame(frame);
})();
