/* Mini Motorway X — UI: input, HUD, modals, sound, main loop */
(function () {
  'use strict';
  const MM = window.MM;
  const $ = (id) => document.getElementById(id);
  const canvas = $('cv');
  const stage = $('stage'); // the map area between the top bar and the toolbar
  const renderer = new MM.Renderer(canvas);

  const DAYS = ['一', '二', '三', '四', '五', '六', '日'];
  const BEST_KEY = 'mmx_best_v1';
  const MUTE_KEY = 'mmx_mute_v1';
  const TIME_KEY = 'mmx_time_v1';
  const MAP_KEY = 'mmx_map_v2';
  const C = MM.CFG.CELL;

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
    let lastDeliver = 0, lastTele = 0;
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
      mayor() { [660, 880, 660, 880].forEach((f, i) => tone(f, 0.16, 'triangle', 0.045, i * 0.14)); },
      click() { tone(500, 0.05, 'triangle', 0.04); },
      teleport() {
        const now = performance.now();
        if (now - lastTele < 90) return;
        lastTele = now;
        tone(420, 0.16, 'sine', 0.035, 0, 1300);
      },
      sport() { [659, 880, 1175].forEach((f, i) => tone(f, 0.18, 'square', 0.025, i * 0.06)); },
      gift() { [784, 988, 1319].forEach((f, i) => tone(f, 0.22, 'sine', 0.05, i * 0.08)); },
      sea() { tone(110, 1.3, 'sawtooth', 0.04, 0, 55); tone(330, 0.9, 'triangle', 0.03, 0.1, 660); tone(495, 0.7, 'triangle', 0.03, 0.5, 990); },
      nuke() {
        tone(140, 1.4, 'sawtooth', 0.07, 0, 28);
        tone(90, 1.8, 'square', 0.05, 0.05, 24);
        tone(1800, 0.25, 'triangle', 0.04, 0, 200);
      },
      kayray() { [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, 0.42, 'triangle', 0.05, i * 0.11)); },
      fuji(on) { if (on) { tone(1250, 0.4, 'sawtooth', 0.02, 0, 650); tone(160, 0.6, 'square', 0.02, 0.05, 420); tone(1100, 0.3, 'sawtooth', 0.015, 0.45, 600); } else tone(500, 0.4, 'triangle', 0.03, 0, 200); },
      fly(on) { if (on) { tone(260, 0.55, 'sawtooth', 0.03, 0, 1100); tone(520, 0.5, 'triangle', 0.035, 0.12, 1400); } else tone(900, 0.4, 'triangle', 0.035, 0, 300); },
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
    const r = stage.getBoundingClientRect();
    renderer.resize(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)), dpr);
  }

  /** Page coordinates of a node's centre (handy for tests / debugging). */
  ui.nodeToPage = (n) => {
    const r = canvas.getBoundingClientRect(), v = renderer.view, g = ui.game;
    return [r.left + v.ox + ((n % g.cols) + 0.5) * C * v.scale, r.top + v.oy + (((n / g.cols) | 0) + 0.5) * C * v.scale];
  };

  // ---------------------------------------------------------------- game lifecycle
  function newGame() {
    resize();
    const grid = renderer.suggestGrid();
    let game = null;
    for (let attempt = 0; attempt < 12 && !game; attempt++) {
      try { game = new MM.Game({ cols: grid.cols, rows: grid.rows }); } catch (e) { /* unlucky map, roll another */ }
    }
    ui.game = game || new MM.Game({ cols: 34, rows: 22 });
    ui.overShown = false;
    ui.overTimer = 0;
    mayorSig = '';
    mayorBar.classList.add('hidden'); // a banner left over from the previous game
    renderer.setGame(ui.game);
    if (ui.mapUi) { ui.mapUi(); if (renderer.mapMode === 'random') toast('地圖:' + ui.themeName(renderer.mapTheme)); }
    renderer.tool = ui.tool;
    stroke = null;
    renderer.preview = null;
    pointers.clear(); gesture = null; panning = null;
    unlockedTools.clear();
    setTpFirst(-1); setHandFirst(-1);
    hud.inv = '';
    if (ui.tool !== 'road') setTool('road');
  }

  // ---------------------------------------------------------------- modals
  const modal = $('modal'), card = $('card');
  function showModal(html) {
    pointers.clear(); gesture = null; panning = null; // a stray finger must not leave a half-finished gesture behind
    card.innerHTML = html;
    modal.classList.remove('hidden');
  }
  function hideModal() { modal.classList.add('hidden'); }

  const UP_ICONS = {
    light: '<svg viewBox="0 0 32 32"><rect x="10" y="3" width="12" height="26" rx="6" fill="#2b3340"/><circle cx="16" cy="9.5" r="2.8" fill="#ff5a5a"/><circle cx="16" cy="16" r="2.8" fill="#ffd24d"/><circle cx="16" cy="22.5" r="2.8" fill="#58e08a"/></svg>',
    round: '<svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="9.5" stroke="#8e9bb0" stroke-width="6"/><circle cx="16" cy="16" r="3" fill="#9fd3a8"/></svg>',
    hw: '<svg viewBox="0 0 32 32" fill="none" stroke-linecap="round"><path d="M5 26C5 14 14 20 16 14S22 6 27 6" stroke="#f4ab45" stroke-width="6"/><path d="M5 26C5 14 14 20 16 14S22 6 27 6" stroke="#fff" stroke-width="1.4" stroke-dasharray="2.5 3"/></svg>',
    wide: '<svg viewBox="0 0 32 32"><rect x="7" y="2" width="18" height="28" rx="3" fill="#767d89" stroke="#fff" stroke-width="1.6"/><path d="M15.2 3V29M16.8 3V29" stroke="#f0c52f" stroke-width="1.3"/><path d="M11.4 4V28M20.6 4V28" stroke="#fff" stroke-width="1.2" stroke-dasharray="3 3"/></svg>',
    ovp: '<svg viewBox="0 0 32 32" fill="none" stroke-linecap="round"><path d="M3 21H29" stroke="#8e9bb0" stroke-width="6"/><path d="M16 2V30" stroke="#56637a" stroke-width="10"/><path d="M16 2V30" stroke="#b4bfd1" stroke-width="6.5"/><path d="M16 5V27" stroke="#fff" stroke-width="1.3" stroke-dasharray="2.5 3"/></svg>',
    tun: '<svg viewBox="0 0 32 32"><path d="M4 28V16a12 12 0 0 1 24 0v12z" fill="#8e9bb0"/><path d="M11 28v-8a5 5 0 0 1 10 0v8z" fill="#2f3643"/></svg>',
    mega: '<svg viewBox="0 0 32 32" fill="none"><rect x="3" y="3" width="26" height="26" rx="10" stroke="#8e9bb0" stroke-width="7.5"/><rect x="3" y="3" width="26" height="26" rx="10" stroke="#fff" stroke-width="1.2" stroke-dasharray="2.5 3"/><rect x="10" y="10" width="12" height="12" rx="4" fill="#9fd3a8"/></svg>',
    sea: '<svg viewBox="0 0 32 32"><path d="M3 5c5 3 7 6 7 11s-2 8-7 11z" fill="#6cb8f0" stroke="#2f7cb8" stroke-width="1.4"/><path d="M29 5c-5 3-7 6-7 11s2 8 7 11z" fill="#6cb8f0" stroke="#2f7cb8" stroke-width="1.4"/><path d="M16 4v24" stroke="#d9c58c" stroke-width="6" stroke-dasharray="3 3" fill="none"/></svg>',
    big: '<svg viewBox="0 0 32 32" fill="none"><rect x="5" y="5" width="22" height="22" rx="9" stroke="#8e9bb0" stroke-width="6"/><circle cx="16" cy="16" r="4.5" fill="#9fd3a8"/></svg>',
  };

  const TP_ICONS = {
    blue: '<ellipse cx="16" cy="17" rx="10.5" ry="13.5" fill="#6c778c" stroke="none"/><ellipse cx="16" cy="17" rx="8" ry="11" fill="#2f7cf0" stroke="none"/><ellipse cx="16" cy="17" rx="4.2" ry="6.4" fill="#d6f4ff" stroke="none"/><path d="M9.5 14c3-5 11-4 12.5 1M22 20c-3 5-11 4-12.5-1" fill="none" stroke="#fff" stroke-width="1.7"/>',
    door: '<rect x="7" y="2.5" width="18" height="27" rx="3" fill="#d2457c" stroke="none"/><rect x="9.2" y="4.7" width="13.6" height="22.6" rx="1.8" fill="#ff9ec0" stroke="none"/><rect x="11.2" y="6.7" width="9.6" height="7.6" rx="1.2" fill="#ffc3d8" stroke="none"/><rect x="11.2" y="16" width="9.6" height="9" rx="1.2" fill="#ffc3d8" stroke="none"/><circle cx="20" cy="16" r="1.7" fill="#ffd23f" stroke="none"/>',
  };
  UP_ICONS.tp = '<svg viewBox="0 0 32 32">' + TP_ICONS.blue + '</svg>';

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
        <li>目的地旁的<b>實心圓點</b>是還沒有車出發的需求(半透明表示車已在路上)。累積太多會出現紅圈倒數,填滿就<b>交通癱瘓</b>——這時可以下<b>市長的命令</b>:時間暫停讓你改路,之後有 5 分鐘無敵時間。</li>
        <li>每週結束可挑選一項升級:紅綠燈、圓環、高速公路、四線道、高架、隧道。河流和湖面都結了冰,道路可以直接鋪過去。</li>
        <li>每送達 <b>100 輛</b>車會得到一對<b>傳送門</b>(藍色傳送門或任意門):依序點兩條路的盡頭,車子進其中一扇就從另一扇出來(雙向)。</li>
        <li>選擇橡皮擦(電腦可用右鍵拖曳)來拆除道路。</li>
        <li>建議<b>橫放手機</b>並按右上角的全螢幕。</li>
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

  function recordBest(g) {
    const newBest = g.score > ui.best;
    if (newBest) { ui.best = g.score; store.set(BEST_KEY, String(ui.best)); }
    return newBest;
  }

  /** The roads are choked: still "交通癱瘓了!", but the player can call the mayor's order instead of giving up. */
  function showCollapse(g) {
    sfx.over();
    showModal(`
      <h2>交通癱瘓了!</h2>
      <p>${MM.COLORS[g.over.dest.color].name}色目的地的車輛擠爆了。</p>
      <div class="big">${g.score}</div>
      <p>輛車成功送達 · 撐到第 ${g.week} 週</p>
      <p><b>市長的命令</b>:時間暫停,讓你重新規劃道路;改好之後有 <b>5 分鐘</b>的無敵時間。</p>
      <button class="btn" id="mMayor">市長的命令</button><button class="btn alt" id="mAgain">放棄,再玩一次</button>`);
    $('mMayor').onclick = () => {
      g.mayorOrder();
      sfx.mayor();
      hideModal();
      ui.mode = 'play';
      ui.overShown = false;
      ui.overTimer = 0;
      toast('時間暫停中:改好路線後,按下方的按鈕');
    };
    $('mAgain').onclick = () => { recordBest(g); restart(); };
  }

  function showOver(g) {
    sfx.over();
    const newBest = recordBest(g);
    const final = g.over && g.over.final;
    showModal(`
      <h2>${final ? '塞爆乃汽車常事,請市長重新再來' : '交通癱瘓了!'}</h2>
      <p>${final ? '市長的命令已經用過了,路還是塞住。' : ''}${MM.COLORS[g.over.dest.color].name}色目的地的車輛擠爆了。</p>
      <div class="big">${g.score}</div>
      <p>輛車成功送達 · 撐到第 ${g.week} 週${newBest ? ' · <b style="color:#e8590c">新紀錄!</b>' : ` · 最高 ${ui.best}`}</p>
      ${final ? '<p><b>Kayray 的祝福</b>:永久無敵,不會再癱瘓,直到你自己重新開始為止,還會送你一顆<b>超級原子彈</b>(把整張地圖的道路抹除重來)、<b>3 個超大圓環</b>,以及<b>天神之手</b>(能把房子與目的地搬到別的地方)。</p>' : ''}
      <button class="btn" id="mAgain">${final ? '重來' : '再玩一次'}</button>${final ? '<button class="btn gold" id="mKayray">召喚 Kayray 的祝福</button>' : ''}`);
    $('mAgain').onclick = () => { restart(); };
    if (final) {
      $('mKayray').onclick = () => {
        if (!g.kayrayBlessing()) return;
        sfx.kayray();
        hideModal();
        ui.mode = 'play';
        ui.overShown = false;
        ui.overTimer = 0;
        toast('Kayray 的祝福降臨:無限無敵,還送你超級原子彈、3 個超大圓環和天神之手!');
      };
    }
  }

  /** Banner in the map area: "finished?" button while the clock is frozen, then the invincibility countdown. */
  const mayorBar = $('mayorBar');
  let mayorSig = '';
  function updateMayorBar(g) {
    let sig = '', text = '';
    if (g.state === 'mayor') {
      sig = 'mayor';
      text = '市長的命令:時間暫停中,請重新規劃道路';
    } else if (g.blessed) {
      sig = 'blessed';
      text = 'Kayray 的祝福 · 無限無敵';
    } else if (g.shieldLeft() > 0) {
      const t = Math.ceil(g.shieldLeft());
      sig = 'shield' + t;
      text = `市長的命令 · 無敵 ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    }
    if (sig === mayorSig) return;
    mayorSig = sig;
    mayorBar.classList.toggle('hidden', !sig);
    mayorBar.classList.toggle('shield', sig.startsWith('shield') || sig === 'blessed');
    mayorBar.classList.toggle('blessed', sig === 'blessed');
    $('mayorText').textContent = text;
  }
  $('mayorDone').onclick = () => {
    const g = ui.game;
    if (g.finishMayor()) {
      sfx.place();
      toast('無敵 5 分鐘!趁現在把路網整理好');
    }
  };

  function restart() {
    hideModal();
    $('pauseIcon').setAttribute('d', 'M8 5v14M16 5v14');
    newGame();
    ui.mode = 'play';
  }

  // ---------------------------------------------------------------- tools & input
  function setTool(t) {
    if (t !== ui.tool) { setTpFirst(-1); setHandFirst(-1); }
    ui.tool = t;
    renderer.tool = t;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  }
  document.querySelectorAll('.tool').forEach((b) => {
    b.addEventListener('click', () => {
      sfx.unlock();
      if (b.dataset.tool === 'nuke') { detonate(); return; } // an action, not a tool
      if (b.dataset.tool === 'sea') { partSea(); return; } // ... and so is this
      sfx.click();
      setTool(b.dataset.tool);
    });
  });

  /** 超級原子彈: wipe every road off the map (asks first: it cannot be undone). */
  function detonate() {
    const g = ui.game;
    if (ui.mode !== 'play' || !g.canEdit()) return;
    if (g.inv.nuke <= 0) { deny('沒有原子彈了:Kayray 的祝福會每週補一顆'); return; }
    if (!g.hasRoads()) { deny('地圖上沒有道路可以抹除'); return; }
    if (!window.confirm('引爆超級原子彈?整張地圖的道路會全部消失(高速、四線道、號誌、隧道等會退回庫存),車子也會消失。')) return;
    if (g.nuke().ok) {
      sfx.nuke();
      setTpFirst(-1);
      toast('轟!道路全部被抹除了,重新規劃吧');
    }
  }
  /** 摩西分海: houses to the left, destinations to the right, colours together (asks first: the buildings move and the old roads no longer fit). */
  function partSea() {
    const g = ui.game;
    if (ui.mode !== 'play' || !g.canEdit()) return;
    const bad = g.checkSea();
    if (bad === 'none') { deny('沒有摩西分海了:每週升級選單有機會拿到'); return; }
    if (bad === 'full') { deny('放不下:左右兩邊的空地不夠排所有房子(水面、道路或太擠)'); return; }
    if (bad) return;
    if (!window.confirm('摩西分海?所有房子會搬到左邊、所有目的地搬到右邊,同顏色排在一起,之後新長出來的也是。道路不會跟著搬,要重新接;正開往搬走目的地的車會被召回。')) return;
    const r = g.partSea();
    if (r.ok) {
      sfx.sea();
      setTpFirst(-1); setHandFirst(-1);
      toast('摩西分海!房子在左、目的地在右,中間是大路');
    }
  }
  const CLICK_TOOLS = ['light', 'round', 'ovp', 'big', 'mega', 'tp', 'hand'];
  function setTpFirst(n) { ui.tpFirst = n; renderer.tpFirst = n; }
  function setHandFirst(n) { ui.handFirst = n; renderer.handFirst = n; }
  let stroke = null;
  let lastDeny = 0;
  const DENY_TEXT = {
    need3: '要放在三岔以上的路口',
    need4: '高架要放在十字路口(四個方向都有路)',
    none: '已經用完了,下週再挑選升級',
    occupied: '這裡不能放置',
    edge: '離地圖邊緣太近了',
    blocked: '這裡不能放',
    full: '地圖上已經沒有空地可以搬走範圍內的建築了',
    line: '入口和出口要在同一條直線上',
    short: '隧道至少要 2 格長',
    long: '隧道最長 6 格',
    portal: '隧道的入口與出口不能在水面、建築或傳送門上',
    notend: '傳送門要放在馬路的盡頭(只接一條路的路端)',
    taken: '這裡已經有傳送門了',
    same: '兩扇門要放在不同的地方',
    node: '這裡不能放傳送門',
    busy: '入口朝隧道的那一側不能已經有道路',
  };
  function denyFor(reason) { if (DENY_TEXT[reason]) deny(DENY_TEXT[reason]); }
  function deny(msg) {
    const now = performance.now();
    if (now - lastDeny < 900) return;
    lastDeny = now;
    toast(msg);
    sfx.deny();
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
      const r = g.removeEdge(cur, next);
      if (r.ok) sfx.erase();
      else if (r.reason === 'ring') deny('圓環的路段不能單獨拆除,請點中央綠地');
      return;
    }
    // a stroke never continues *through* a building: it can only start or end on one
    if (w.bld[cur] && cur !== stroke.start) return;
    const kind = stroke.tool === 'hw' ? 2 : stroke.tool === 'wide' ? 3 : 1;
    const r = g.addEdge(cur, next, kind);
    if (r.ok) sfx.road();
    else if (r.reason === 'nohw') deny('高速公路數量不足');
    else if (r.reason === 'nowide') deny('四線道數量不足');
    else if (r.reason === 'wide-bld') deny('連到房子的路不能拓寬');
    else if (r.reason === 'wide-hw') deny('高速公路不能改成四線道');
    else if (r.reason === 'hw-wide') deny('四線道不能改成高速公路');
    else if (r.reason === 'wide-ring') deny('這段路不能拓寬');
    else if (r.reason === 'island') deny('圓環中央是綠地,不能在這裡鋪路');
    else if (r.reason === 'tunnel') deny('隧道入口的這一側不能鋪路');
    else if (r.reason === 'tpend') deny('傳送門在路的盡頭,不能再接路(先用橡皮擦拆掉傳送門)');
  }

  /** 天神之手: tap a house / destination to lift it, then tap an empty spot to put it down. */
  function pickHand(g, n) {
    const w = g.world;
    if (g.inv.hand <= 0) { deny('天神之手要召喚 Kayray 的祝福才拿得到'); return; }
    if (ui.handFirst == null || ui.handFirst < 0) {
      if (!w.bld[n]) { deny('先點一棟房子或一個目的地把它拿起來'); return; }
      setHandFirst(n);
      sfx.click();
      toast('拿起來了,再點一塊空地放下(點自己取消)');
      return;
    }
    if (n === ui.handFirst) { setHandFirst(-1); toast('已取消'); return; }
    if (w.bld[n]) { setHandFirst(n); sfx.click(); return; } // picked another building instead
    const r = g.moveBuilding(ui.handFirst, n);
    if (r.ok) { setHandFirst(-1); sfx.place(); toast('搬好了!路沒有跟著動,記得重新接路'); }
    else if (r.reason === 'near') deny('離別的建築太近了,至少隔一格');
    else deny('這裡不能放:要是空地(不能是水面、道路、設施)');
  }

  /** Portal tool: tap a road end for the first door, another road end for the second. */
  function pickPortal(g, n) {
    if (g.inv.tp <= 0) { deny('傳送門用完了:每送達 100 輛車可獲得一對'); return; }
    if (ui.tpFirst == null || ui.tpFirst < 0) {
      const bad = g.checkPortal(n);
      if (bad) { denyFor(bad); return; }
      setTpFirst(n);
      sfx.click();
      toast('第一扇門已選好,再點另一條路的盡頭放第二扇');
      return;
    }
    if (n === ui.tpFirst) { setTpFirst(-1); toast('已取消'); return; }
    const r = g.addPortal(ui.tpFirst, n);
    if (r.ok) { setTpFirst(-1); sfx.place(); toast('傳送門完成:車子進任何一扇門,就從另一扇出來(雙向)'); }
    else denyFor(r.reason);
  }

  // ---- camera: two fingers pan + pinch-zoom (touch), wheel zoom + middle-button drag (mouse)
  const pointers = new Map(); // active pointers while playing: id -> {x, y} in CSS px
  let gesture = null; // {x, y, d}: midpoint and distance of the two fingers at the last event
  let panning = null; // middle-button drag: {id, x, y}
  function twoFingers() {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    sfx.unlock();
    const g = ui.game;
    if (ui.mode !== 'play' || !g.canEdit()) return;
    canvas.setPointerCapture(e.pointerId);
    const [px, py] = localPoint(e);
    pointers.set(e.pointerId, { x: px, y: py });
    if (pointers.size >= 2) {
      // a second finger turns whatever was being drawn into a pan / zoom gesture
      stroke = null;
      renderer.preview = null;
      if (pointers.size === 2) gesture = { ...twoFingers(), d0: 0, z0: renderer.cam.zoom };
      if (gesture) gesture.d0 = gesture.d;
      return;
    }
    if (e.button === 1) { panning = { id: e.pointerId, x: px, y: py }; e.preventDefault(); return; }
    const n = renderer.pickNode(px, py);
    renderer.hover = n;
    const tool = e.button === 2 ? 'erase' : ui.tool;
    stroke = { tool, last: n, start: n, id: e.pointerId };
    if (n < 0) return;
    if (tool === 'light' || tool === 'round' || tool === 'ovp') {
      const r = g.placeFeature(n, tool);
      if (r.ok) sfx.place();
      else denyFor(r.reason);
      stroke = null;
    } else if (tool === 'big') {
      const r = g.placeBig(n);
      if (r.ok) sfx.place();
      else denyFor(r.reason);
      stroke = null;
    } else if (tool === 'mega') {
      const r = g.placeMega(g.megaAnchor(n));
      if (r.ok) sfx.place();
      else denyFor(r.reason);
      stroke = null;
    } else if (tool === 'hand') {
      pickHand(g, n);
      stroke = null;
    } else if (tool === 'tp') {
      pickPortal(g, n);
      stroke = null;
    } else if (tool === 'tun') {
      stroke.target = -1;
      renderer.preview = null;
    } else if (tool === 'erase') {
      const w = g.world;
      // a click removes a placed feature, the whole big roundabout (click its green island) or a tunnel (click a portal)
      if (g.removeFeature(n) || (w.island[n] && g.removeBigAt(n)) || g.removeTunnelAt(n, true) || g.removePortal(n)) sfx.erase();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const g = ui.game;
    const [px, py] = localPoint(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: px, y: py });
    if (gesture && pointers.size >= 2) {
      const now = twoFingers();
      renderer.panBy(now.x - gesture.x, now.y - gesture.y);
      // zoom is derived from the finger distance at the start of the gesture (not accumulated per event), because the two
      // fingers' move events arrive one at a time and a clamped zoom would otherwise drift
      if (gesture.d0 > 8 && now.d > 8) {
        const target = Math.max(1, Math.min(3, gesture.z0 * now.d / gesture.d0));
        renderer.zoomAt(now.x, now.y, target / renderer.cam.zoom);
      }
      gesture.x = now.x; gesture.y = now.y; gesture.d = now.d;
      return;
    }
    if (panning && e.pointerId === panning.id) {
      renderer.panBy(px - panning.x, py - panning.y);
      panning.x = px; panning.y = py;
      return;
    }
    const n = renderer.pickNode(px, py);
    renderer.hover = e.pointerType === 'touch' && !stroke ? -1 : n;
    if (!stroke || e.pointerId !== stroke.id || ui.mode !== 'play' || !g.canEdit()) return;
    if (stroke.tool === 'tun') { updateTunnelPreview(g, n); return; }
    if (n < 0 || n === stroke.last) return;
    if (stroke.last < 0) { stroke.last = n; stroke.start = n; return; }
    if (CLICK_TOOLS.includes(stroke.tool)) return;
    let cur = stroke.last;
    let guard = g.cols + g.rows + 4;
    while (cur !== n && guard-- > 0) {
      const next = stepToward(g, cur, n);
      applyStep(g, cur, next);
      cur = next;
    }
    stroke.last = n;
  });

  // tunnel: drag from the entrance along a row / column; the exit snaps to 2-6 cells away
  function updateTunnelPreview(g, p) {
    const a = stroke.start;
    if (a < 0 || p < 0) return;
    const w = g.world;
    const dc = w.col(p) - w.col(a), dr = w.row(p) - w.row(a);
    let b = -1;
    if (Math.abs(dc) >= Math.abs(dr) && dc !== 0) b = a + Math.sign(dc) * Math.min(Math.abs(dc), MM.CFG.TUNNEL_MAX);
    else if (dr !== 0) b = a + Math.sign(dr) * Math.min(Math.abs(dr), MM.CFG.TUNNEL_MAX) * w.cols;
    stroke.target = b;
    renderer.preview = b < 0 ? null : { a, b, reason: g.checkTunnel(a, b) };
  }

  const endStroke = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) gesture = null;
    if (panning && e.pointerId === panning.id) panning = null;
    if (stroke && e.pointerId === stroke.id) {
      if (stroke.tool === 'tun' && ui.game.canEdit() && ui.mode === 'play') {
        if (stroke.target >= 0) {
          const r = ui.game.addTunnel(stroke.start, stroke.target);
          if (r.ok) sfx.place(); else denyFor(r.reason);
        } else if (stroke.start >= 0) {
          deny('從入口拖曳到出口(同一直線,2–6 格)');
        }
      }
      stroke = null;
      renderer.preview = null;
    }
    if (e.pointerType === 'touch') renderer.hover = -1;
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', () => { renderer.hover = -1; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (ui.mode !== 'play') return;
    const [px, py] = localPoint(e);
    renderer.zoomAt(px, py, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  }, { passive: false });
  $('btnFit').onclick = () => { sfx.click(); renderer.resetCamera(); };

  // ---------------------------------------------------------------- buttons / keys
  function togglePause() {
    if (ui.mode === 'play') showPause();
    else if (ui.mode === 'pause' && ui.game.canEdit()) resume();
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
  // time of day: 永晝 / 永夜 / 晝夜交替
  const TIME_MODES = ['cycle', 'day', 'night'];
  const TIME_NAMES = { cycle: '晝夜交替', day: '永晝', night: '永夜' };
  function setTimeMode(m, announce) {
    renderer.timeMode = m;
    store.set(TIME_KEY, m);
    $('icoDay').style.display = m === 'day' ? '' : 'none';
    $('icoNight').style.display = m === 'night' ? '' : 'none';
    $('icoCycle').style.display = m === 'cycle' ? '' : 'none';
    $('btnTime').title = '晝夜:' + TIME_NAMES[m];
    if (announce) toast('模式:' + TIME_NAMES[m]);
  }
  function nextTimeMode() { setTimeMode(TIME_MODES[(TIME_MODES.indexOf(renderer.timeMode) + 1) % 3], true); sfx.click(); }
  $('btnTime').onclick = nextTimeMode;
  { const saved = store.get(TIME_KEY); setTimeMode(TIME_MODES.includes(saved) ? saved : 'cycle', false); }

  // map: random (every new game gets one of the three) or a fixed one: white snow country (Hokkaido), green forest, ukiyo-e beach
  const MAP_MODES = ['random', 'snow', 'forest', 'beach'];
  const MAP_NAMES = { random: '隨機(每局換地圖)', snow: '雪國(全白雪地)', forest: '森林(含雪地)', beach: '平原(浮世繪)' };
  const THEME_NAMES = { snow: '雪國', forest: '森林', beach: '平原(浮世繪)' };
  function showMapUi() {
    const m = renderer.mapMode;
    for (const k of MAP_MODES) $('ico' + k[0].toUpperCase() + k.slice(1)).style.display = m === k ? '' : 'none';
    $('btnMap').title = '地圖:' + MAP_NAMES[m] + '(目前:' + THEME_NAMES[renderer.mapTheme] + ')';
  }
  ui.mapUi = showMapUi;
  ui.themeName = (t) => THEME_NAMES[t];
  function setMapMode(m, announce) {
    renderer.setMapMode(m);
    store.set(MAP_KEY, renderer.mapMode);
    showMapUi();
    if (announce) toast('地圖:' + MAP_NAMES[renderer.mapMode] + (renderer.mapMode === 'random' ? '(目前:' + THEME_NAMES[renderer.mapTheme] + ')' : ''));
  }
  $('btnMap').onclick = () => { setMapMode(MAP_MODES[(MAP_MODES.indexOf(renderer.mapMode) + 1) % MAP_MODES.length], true); sfx.click(); };
  { const saved = store.get(MAP_KEY); setMapMode(MAP_MODES.includes(saved) ? saved : 'random', false); }

  // fullscreen (+ landscape lock where the browser allows it)
  const fsEl = document.documentElement;
  const canFs = !!(fsEl.requestFullscreen || fsEl.webkitRequestFullscreen);
  if (!canFs) $('btnFull').style.display = 'none';
  $('btnFull').onclick = () => {
    sfx.click();
    const inFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (inFs) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    const req = (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl);
    Promise.resolve(req).then(() => {
      try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); } catch (e) { /* not supported */ }
    }).catch(() => {});
  };

  $('btnRestart').onclick = () => {
    if (ui.game.state === 'over' || ui.game.state === 'collapse' || ui.game.score < 5 || window.confirm('確定要重新開始嗎?')) restart();
  };
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const map = { 1: 'road', 2: 'hw', 3: 'wide', 4: 'light', 5: 'round', 6: 'ovp', 7: 'tun', 8: 'erase', 9: 'tp' };
    const btn = map[e.key] && document.querySelector(`[data-tool="${map[e.key]}"]`);
    if (btn && !btn.classList.contains('locked') && ui.mode === 'play') setTool(map[e.key]);
    else if (e.key === ' ' || e.key === 'p' || e.key === 'P') { e.preventDefault(); togglePause(); }
    else if (e.key === 'n' || e.key === 'N') nextTimeMode();
    else if (e.key === 'm' || e.key === 'M') $('btnMap').click();
    else if (e.key === '0') renderer.resetCamera();
    else if (e.key.startsWith('Arrow') && renderer.isZoomed()) {
      e.preventDefault();
      const k = 70;
      renderer.panBy(e.key === 'ArrowLeft' ? k : e.key === 'ArrowRight' ? -k : 0, e.key === 'ArrowUp' ? k : e.key === 'ArrowDown' ? -k : 0);
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && ui.mode === 'play') showPause(); });
  let resizeTimer = 0;
  function onResize() {
    resize();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resize();
      // before the first move the map can still be re-rolled to fit the new orientation; mid-game it stays put
      if (ui.mode === 'start') newGame();
      hintOrientation();
    }, 150);
  }
  if (window.ResizeObserver) new ResizeObserver(onResize).observe(stage);
  else window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  let hinted = false;
  function hintOrientation() {
    if (hinted || window.innerHeight <= window.innerWidth || window.innerWidth > 700) return;
    hinted = true;
    toast('橫放手機,地圖更大更好玩');
  }

  // ---------------------------------------------------------------- HUD
  const hud = { score: -1, week: -1, day: -1, fill: -1, inv: '', fly: '' };
  const OPTIONAL_TOOLS = ['hw', 'wide', 'light', 'round', 'ovp', 'tun', 'mega', 'sea', 'tp', 'nuke', 'hand']; // (the big roundabout still exists in the engine but is not offered)
  const unlockedTools = new Set();
  let fitShown = false;
  function updateHud(g) {
    const z = renderer.isZoomed();
    if (z !== fitShown) { fitShown = z; $('btnFit').style.display = z ? '' : 'none'; }
    const mode = g.flyMode ? 'fly' : g.fujiMode ? 'fuji' : ''; // the random mode that is running, if any
    const modeSig = mode + (mode && g.modeLeft > 0 ? Math.ceil(g.modeLeft) : '');
    if (hud.fly !== modeSig) {
      hud.fly = modeSig;
      $('modePill').style.display = mode ? '' : 'none';
      $('modePill').classList.toggle('fuji', mode === 'fuji');
      $('icoFly').style.display = mode === 'fuji' ? 'none' : '';
      $('icoFuji').style.display = mode === 'fuji' ? '' : 'none';
      $('modeName').textContent = mode === 'fuji' ? '藤原模式' : '起飛啦';
      $('modeLeft').textContent = mode && g.modeLeft > 0 ? Math.ceil(g.modeLeft) + ' 秒' : '';
    }
    if (hud.score !== g.score) { hud.score = g.score; $('score').textContent = g.score; }
    const best = Math.max(ui.best, g.score);
    $('best').textContent = '最高 ' + best;
    if (hud.week !== g.week) { hud.week = g.week; $('weekName').textContent = `第 ${g.week} 週`; }
    const d = g.dayIndex();
    if (hud.day !== d) { hud.day = d; $('dayName').textContent = '週' + DAYS[d]; }
    const f = Math.round((g.weekTime / MM.CFG.WEEK_SECONDS) * 1000) / 10;
    if (hud.fill !== f) { hud.fill = f; $('weekFill').style.width = f + '%'; }
    const sig = OPTIONAL_TOOLS.map((k) => g.inv[k]).join('|') + '|' + g.nextPortalStyle();
    if (sig !== hud.inv) {
      hud.inv = sig;
      $('icoTp').innerHTML = TP_ICONS[g.nextPortalStyle() || 'blue'];
      for (const k of OPTIONAL_TOOLS) {
        const btn = document.querySelector(`[data-tool="${k}"]`);
        if (g.inv[k] > 0) unlockedTools.add(k); // a tool shows up the first time you own one
        btn.classList.toggle('locked', !unlockedTools.has(k));
        btn.classList.toggle('empty', g.inv[k] <= 0);
        const badge = btn.querySelector('.badge');
        if (badge) badge.textContent = k === 'hand' ? '∞' : g.inv[k];
      }
    }
  }

  // ---------------------------------------------------------------- events
  function handleEvents(g) {
    if (!g.events.length) return;
    const evs = g.events.splice(0);
    renderer.addEvents(evs);
    for (const e of evs) {
      if (e.type === 'deliver') { sfx.deliver(e.color); if (e.weight > 1) sfx.sport(); }
      else if (e.type === 'spawn' && g.time > 1) sfx.spawn();
      else if (e.type === 'week') { /* modal handled below */ ui.pendingWeek = e; }
      else if (e.type === 'fuji') {
        sfx.fuji(e.on);
        const sec = MM.CFG.FUJI_SECONDS;
        toast(e.on ? `藤原模式!${sec % 60 ? sec + ' 秒' : sec / 60 + ' 分鐘'}內所有車輛加速,輪胎冒白煙` : '藤原模式結束,車速恢復正常');
      }
      else if (e.type === 'fly') { sfx.fly(e.on); toast(e.on ? `起飛啦!${MM.CFG.FLY_SECONDS} 秒內所有汽車飛天直奔目的地` : '降落,汽車回到路上'); }
      else if (e.type === 'mayorend') toast('無敵時間結束,路網撐住了!');
      else if (e.type === 'teleport') sfx.teleport();
      else if (e.type === 'nukegift') toast('Kayray 又送來一顆超級原子彈(工具列「原子彈」)');
      else if (e.type === 'portalgift') {
        sfx.gift();
        toast(`送達 ${g.score} 輛!獲得一對${e.style === 'blue' ? '藍色傳送門' : '任意門'}(工具列「傳送門」)`);
      }
    }
  }

  // ---------------------------------------------------------------- main loop
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const g = ui.game;
    if (g) {
      if (ui.mode === 'play' && g.state === 'running') {
        g.update(dt * ui.speed);
        renderer.police.update(dt * ui.speed * g.boost()); // the patrol cars join in 藤原模式
      }
      handleEvents(g);
      if (ui.mode === 'play' && g.state === 'upgrade') showUpgrade(g, ui.pendingWeek);
      if ((g.state === 'over' || g.state === 'collapse') && !ui.overShown) {
        ui.overTimer += dt;
        if (ui.overTimer > 1.1) {
          ui.overShown = true; ui.mode = 'pause';
          if (g.state === 'collapse') showCollapse(g); else showOver(g);
        }
      }
      updateHud(g);
      updateMayorBar(g);
      renderer.render(now);
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- boot
  refreshSoundIcon();
  newGame();
  showStart();
  setTimeout(hintOrientation, 700);
  requestAnimationFrame(frame);
})();
