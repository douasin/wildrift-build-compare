/* Wild Rift 出裝符文比較 — UI */
(function () {
  'use strict';
  const D = window.WR_DATA;
  const E = window.WREngine;
  const $ = sel => document.querySelector(sel);

  const COLORS = ['#60a5fa', '#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#fb7185'];
  const TYPE_LABEL = { magic: '魔法', physical: '物理', true: '真實', heal: '治療', shield: '護盾', unknown: '未分類' };

  const state = {
    champ: null,
    loadouts: [],
    active: 0,
    gpm: 680,
    tMax: 18,
    pctMode: false,
  };

  // ---------------- helpers ----------------
  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) n.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined) continue;
      n.append(c.nodeType ? c : document.createTextNode(c));
    }
    return n;
  }
  const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.round(n).toString();
  const fmt0 = n => Math.round(n).toString();
  const fmtPct = p => Array.isArray(p) ? p.join('/') : p;

  function champBuildDefault(c) {
    const b = c.builds || {};
    let order = b['Example build'] || [];
    if (!order.length) {
      order = [...(b['Start'] || []), ...(b['Core'] || []), ...(b['Boots'] || [])];
    }
    // 只留買得到的（有價格）
    return order.filter(n => D.items[n] && D.items[n].gold);
  }

  function champRunesDefault(c) {
    const r = c.runes || {};
    return [...(r.keystone || []), ...(r.minor || [])].slice(0, 5);
  }

  function newLoadout(name, c) {
    return {
      name,
      build: champBuildDefault(c),
      runes: champRunesDefault(c),
      combo: { P: 1, Q: 1, W: 1, E: 1, R: 1, AA: 2 },
      enabledInstances: {},
      priority: ['Q', 'W', 'E'],
      useProcs: true,
    };
  }

  function storageKey() { return 'wrb_' + state.champ.id; }
  function saveState() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify({
        loadouts: state.loadouts, active: state.active, gpm: state.gpm,
      }));
    } catch (e) { /* ignore */ }
  }
  function loadState(c) {
    try {
      const raw = localStorage.getItem('wrb_' + c.id);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.loadouts && s.loadouts.length) {
          state.loadouts = s.loadouts;
          state.active = Math.min(s.active || 0, s.loadouts.length - 1);
          state.gpm = s.gpm || state.gpm;
          return true;
        }
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  // ---------------- picker ----------------
  function renderPicker() {
    const grid = $('#champGrid');
    grid.innerHTML = '';
    const q = ($('#search').value || '').trim().toLowerCase();
    for (const c of D.champions) {
      if (q && !c.name.toLowerCase().includes(q) && !c.slug.includes(q)) continue;
      grid.append(el('div', { class: 'champ-card', onclick: () => selectChamp(c) },
        el('img', { src: c.portrait || '', alt: c.name, loading: 'lazy' }),
        el('div', { class: 'nm' }, c.name),
        el('div', { class: 'ln' }, [c.lane, c.roles].filter(Boolean).join(' · '))
      ));
    }
  }

  function selectChamp(c) {
    if (location.hash !== '#c=' + c.slug) history.replaceState(null, '', '#c=' + c.slug);
    state.champ = c;
    state.loadouts = [];
    state.active = 0;
    if (!loadState(c)) {
      state.loadouts = [newLoadout('方案 A（推薦）', c)];
    }
    $('#picker').style.display = 'none';
    $('#champView').style.display = '';
    renderChampView();
    window.scrollTo(0, 0);
  }

  function backToPicker() {
    history.replaceState(null, '', '#');
    state.champ = null;
    $('#picker').style.display = '';
    $('#champView').style.display = 'none';
  }

  // ---------------- champion view ----------------
  function renderChampView() {
    const c = state.champ;
    const v = $('#champView');
    v.innerHTML = '';
    v.append(
      el('button', { class: 'back-btn', onclick: backToPicker }, '← 回英雄列表'),
      el('div', { class: 'champ-head' },
        el('img', { src: c.portrait || '' }),
        el('div', null,
          el('h2', null, c.name),
          el('div', { class: 'meta' },
            `${c.lane || ''}　${c.roles || ''}　版本 ${c.patch}　`,
            el('a', { href: c.url, target: '_blank' }, 'wr-meta 原頁')),
        )
      ),
      el('div', { class: 'cols' },
        el('div', null, abilitiesPanel(c), statsPanel(c)),
        el('div', null, loadoutPanel(), chartsPanel())
      )
    );
    renderCharts();
  }

  function statsPanel(c) {
    const s = c.stats || {};
    const row = (label, key) => s[key] ?
      el('div', null, `${label}：${s[key][0]}（+${s[key][1]}/級）`) : null;
    return el('div', { class: 'panel' },
      el('h3', null, '基礎屬性（1 級，每級成長）'),
      el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:2px 14px;font-size:13px' },
        row('攻擊力', 'ad'), row('血量', 'hp'),
        row('護甲', 'armor'), row('魔抗', 'mr'),
        row('攻速', 'as'), row('魔力', 'mana'),
        row('移速', 'ms'), row('暴傷%', 'crit'))
    );
  }

  function abilitiesPanel(c) {
    const rows = [];
    for (const slot of ['P', 'Q', 'W', 'E', 'R']) {
      const ab = c.abilities[slot];
      if (!ab) continue;
      rows.push(el('div', { class: 'ab-row' },
        el('img', { src: ab.icon || '' }),
        el('div', null,
          el('details', null,
            el('summary', null,
              el('span', { class: 'slot' }, slot + ' '), ab.name,
              ab.cd ? el('span', { class: 'txt' }, `　CD ${ab.cd}`) : null),
            el('pre', null, ab.text || ''),
          ),
          el('div', { class: 'txt' },
            ab.damage.filter(d => ['magic', 'physical', 'true'].includes(d.type)).map(d =>
              el('span', { class: 'type-' + d.type, style: 'margin-right:10px' },
                `${TYPE_LABEL[d.type]} ${d.base.join('/')}${d.ratios.map(r => ` +${fmtPct(r.pct)}%${r.stat}`).join('')}`))
          )
        )
      ));
    }
    return el('div', { class: 'panel' }, el('h3', null, '技能'), rows);
  }

  // ---------------- loadout editor ----------------
  function activeLoadout() { return state.loadouts[state.active]; }

  function loadoutPanel() {
    const panel = el('div', { class: 'panel', id: 'loadoutPanel' });
    rebuildLoadoutPanel(panel);
    return panel;
  }

  function rebuildLoadoutPanel(panel) {
    panel = panel || $('#loadoutPanel');
    if (!panel) return;
    panel.innerHTML = '';
    const c = state.champ;
    const lo = activeLoadout();

    // tabs
    const tabs = el('div', { class: 'loadout-tabs' });
    state.loadouts.forEach((l, i) => {
      const tab = el('div', {
        class: 'loadout-tab' + (i === state.active ? ' active' : ''),
        onclick: () => { state.active = i; refresh(); },
      }, l.name);
      if (state.loadouts.length > 1) {
        tab.append(el('span', {
          class: 'x', onclick: (ev) => {
            ev.stopPropagation();
            state.loadouts.splice(i, 1);
            state.active = Math.max(0, state.active - (i <= state.active ? 1 : 0));
            refresh();
          }
        }, '✕'));
      }
      tabs.append(tab);
    });
    tabs.append(el('button', {
      class: 'small', onclick: () => {
        const copy = JSON.parse(JSON.stringify(lo));
        copy.name = '方案 ' + String.fromCharCode(65 + state.loadouts.length);
        state.loadouts.push(copy);
        state.active = state.loadouts.length - 1;
        refresh();
      }
    }, '＋ 複製為新方案'));
    panel.append(el('h3', null, '出裝與符文方案'), tabs);

    // rename
    panel.append(el('div', { style: 'margin-bottom:10px' },
      el('label', { class: 'inline' }, '方案名稱：',
        el('input', {
          type: 'text', value: lo.name, style: 'background:var(--bg3);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px',
          onchange: ev => { lo.name = ev.target.value; refresh(); },
        }))));

    // ---- build list ----
    const recommended = [...new Set([...(c.builds['Example build'] || []), ...(c.builds['Core'] || []),
      ...(c.builds['Situational'] || []), ...(c.builds['Boots'] || [])])]
      .filter(nm => D.items[nm] && D.items[nm].gold);
    const allItems = Object.values(D.items).filter(it => it.gold >= 700)
      .sort((a, b) => a.name.localeCompare(b.name)).map(it => it.name);

    panel.append(el('h4', null, '出裝順序（由上到下購買；點物品可直接更換）'));
    const list = el('div', { class: 'build-list' });
    const times = E.itemCompletionTimes(lo.build, state.gpm, D.items);
    lo.build.forEach((nm, i) => {
      const it = D.items[nm] || { gold: 0 };
      const tt = times[i];
      // 點目前物品 -> 開啟選單原位替換
      const swapBtn = itemDropdown(recommended, allItems,
        pick => { lo.build[i] = pick; refresh(); },
        [el('img', { src: it.icon || '' }),
         el('span', { class: 'nm' }, nm),
         el('span', { class: 'dd-caret' }, '▾')],
        'dd-inline');
      list.append(el('div', { class: 'build-item' },
        swapBtn,
        el('span', { class: 'gold' }, (it.gold || 0) + 'g'),
        el('span', { class: 'cum' }, tt ? `約 ${tt.time.toFixed(1)} 分完成` : ''),
        el('button', { onclick: () => { if (i > 0) { [lo.build[i - 1], lo.build[i]] = [lo.build[i], lo.build[i - 1]]; refresh(); } } }, '↑'),
        el('button', { onclick: () => { if (i < lo.build.length - 1) { [lo.build[i + 1], lo.build[i]] = [lo.build[i], lo.build[i + 1]]; refresh(); } } }, '↓'),
        el('button', { onclick: () => { lo.build.splice(i, 1); refresh(); } }, '✕'),
      ));
    });
    panel.append(list);

    // add item (custom dropdown with icons + search)
    panel.append(el('div', { style: 'margin-top:8px' },
      itemDropdown(recommended, allItems, nm => { lo.build.push(nm); refresh(); })));

    // ---- runes ----
    panel.append(el('h4', null, '符文（第 1 格為基石）'));
    const runeNames = Object.keys(D.runes).sort();
    const recRunes = [...(c.runes.keystone || []), ...(c.runes.minor || []), ...(c.runes.situational || [])];
    for (let i = 0; i < 5; i++) {
      const cur = lo.runes[i] || '';
      const rd = D.runes[cur];
      panel.append(el('div', { class: 'rune-row' },
        runeDropdown(cur, recRunes, runeNames, rn => { lo.runes[i] = rn; refresh(); }),
        el('span', { class: 'txt', style: 'font-size:11px;color:var(--fg-dim)' },
          rd && rd.parsed && rd.parsed.dmgMin != null ? `傷害 ${rd.parsed.dmgMin}–${rd.parsed.dmgMax}` : '')));
    }

    // ---- combo ----
    panel.append(el('h4', null, 'Combo 設定（每招施放次數；接完一整套）'));
    const grid = el('div', { class: 'combo-grid' });
    for (const slot of ['P', 'Q', 'W', 'E', 'R']) {
      const ab = c.abilities[slot];
      if (!ab) continue;
      grid.append(el('div', { class: 'combo-cell' },
        el('img', { src: ab.icon || '' }),
        el('span', { class: 'slot' }, slot),
        el('input', {
          type: 'number', min: 0, max: 9, value: lo.combo[slot] != null ? lo.combo[slot] : 1,
          onchange: ev => { lo.combo[slot] = +ev.target.value; refresh(); },
        })));
    }
    grid.append(el('div', { class: 'combo-cell' },
      el('span', { class: 'slot' }, '平A'),
      el('input', {
        type: 'number', min: 0, max: 20, value: lo.combo.AA != null ? lo.combo.AA : 2,
        onchange: ev => { lo.combo.AA = +ev.target.value; refresh(); },
      })));
    panel.append(grid);

    // instance toggles
    const instBox = el('div', { class: 'inst-list' });
    instBox.append(el('div', { style: 'margin:6px 0 2px;color:var(--fg)' }, '傷害組成（可勾選要計入的部分）：'));
    for (const slot of ['P', 'Q', 'W', 'E', 'R']) {
      const ab = c.abilities[slot];
      if (!ab) continue;
      ab.damage.forEach((inst, i) => {
        const key = slot + i;
        const defaultOn = ['magic', 'physical', 'true'].includes(inst.type);
        const on = lo.enabledInstances[key] === undefined ? defaultOn : lo.enabledInstances[key];
        instBox.append(el('label', null,
          el('input', {
            type: 'checkbox', checked: on ? '' : null,
            onchange: ev => { lo.enabledInstances[key] = ev.target.checked; refresh(); },
          }),
          ` ${slot}：`,
          el('span', { class: 'type-' + inst.type }, TYPE_LABEL[inst.type] || inst.type),
          ` ${inst.base.join('/')}${inst.ratios.map(r => ` +${fmtPct(r.pct)}%${r.stat}`).join('')}`,
          inst.context ? el('span', { style: 'opacity:.55' }, `　…${inst.context.slice(-42)}`) : null,
        ));
      });
    }
    panel.append(instBox);

    // options
    panel.append(el('div', { style: 'margin-top:10px' },
      el('label', { class: 'inline' },
        el('input', {
          type: 'checkbox', checked: lo.useProcs !== false ? '' : null,
          onchange: ev => { lo.useProcs = ev.target.checked; refresh(); },
        }), '計入裝備特效（咒刃/燃燒等，近似值）'),
      el('label', { class: 'inline' }, '主升：',
        el('select', {
          onchange: ev => { lo.priority = ev.target.value.split(''); refresh(); },
        }, ['QWE', 'QEW', 'WQE', 'WEQ', 'EQW', 'EWQ'].map(p =>
          el('option', { value: p, selected: (lo.priority || ['Q', 'W', 'E']).join('') === p ? '' : null }, p.split('').join('>'))))),
    ));
  }

  // 自訂符文下拉（含小圖示）
  function runeDropdown(current, recRunes, allRunes, onPick) {
    const rd = D.runes[current];
    const wrap = el('div', { class: 'dd' });
    const btn = el('button', { class: 'dd-btn', type: 'button' },
      rd ? el('img', { src: rd.icon || '' }) : null,
      el('span', { class: 'dd-label' }, current || '（無）'),
      el('span', { class: 'dd-caret' }, '▾'));
    const menu = el('div', { class: 'dd-menu', hidden: '' });

    const opt = rn => {
      const r = D.runes[rn];
      return el('div', {
        class: 'dd-opt' + (rn === current ? ' sel' : ''),
        onclick: () => onPick(rn),
      },
      r && r.icon ? el('img', { src: r.icon }) : el('span', { class: 'dd-noicon' }),
      el('span', null, rn || '（無）'),
      r && r.parsed && r.parsed.dmgMin != null
        ? el('span', { class: 'dd-dmg' }, `${r.parsed.dmgMin}–${r.parsed.dmgMax}`) : null);
    };

    menu.append(el('div', { class: 'dd-opt', onclick: () => onPick('') },
      el('span', { class: 'dd-noicon' }), el('span', null, '（無）')));
    if (recRunes.length) {
      menu.append(el('div', { class: 'dd-group' }, '此英雄推薦'));
      for (const rn of recRunes) menu.append(opt(rn));
    }
    menu.append(el('div', { class: 'dd-group' }, '全部符文'));
    for (const rn of allRunes) menu.append(opt(rn));

    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const wasHidden = menu.hidden;
      document.querySelectorAll('.dd-menu').forEach(m => m.hidden = true);
      menu.hidden = !wasHidden;
    });
    wrap.append(btn, menu);
    return wrap;
  }

  // 自訂物品下拉（含縮圖＋搜尋）；btnChildren 可自訂按鈕外觀（原位替換用）
  function itemDropdown(recommended, allItems, onPick, btnChildren, extraClass) {
    const wrap = el('div', { class: 'dd' + (extraClass ? ' ' + extraClass : '') });
    const btn = el('button', { class: 'dd-btn', type: 'button' },
      ...(btnChildren || [
        el('span', { class: 'dd-label' }, '＋ 加入物品…'),
        el('span', { class: 'dd-caret' }, '▾'),
      ]));
    const menu = el('div', { class: 'dd-menu', hidden: '' });
    menu.addEventListener('click', ev => ev.stopPropagation());

    const search = el('input', {
      class: 'dd-search', type: 'text', placeholder: '搜尋物品…', autocomplete: 'off',
    });
    menu.append(el('div', { class: 'dd-search-box' }, search));
    const listBox = el('div', null);
    menu.append(listBox);

    const opt = nm => {
      const it = D.items[nm];
      return el('div', { class: 'dd-opt', onclick: () => onPick(nm) },
        it && it.icon ? el('img', { class: 'sq', src: it.icon }) : el('span', { class: 'dd-noicon' }),
        el('span', null, nm),
        el('span', { class: 'dd-dmg' }, (it && it.gold ? it.gold + 'g' : '')));
    };

    const renderList = () => {
      listBox.innerHTML = '';
      const q = search.value.trim().toLowerCase();
      const match = nm => !q || nm.toLowerCase().includes(q);
      const rec = recommended.filter(match);
      if (rec.length) {
        listBox.append(el('div', { class: 'dd-group' }, '此英雄推薦/情境物品'));
        rec.forEach(nm => listBox.append(opt(nm)));
      }
      listBox.append(el('div', { class: 'dd-group' }, '全部物品'));
      allItems.filter(match).forEach(nm => listBox.append(opt(nm)));
    };
    search.addEventListener('input', renderList);
    renderList();

    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const wasHidden = menu.hidden;
      document.querySelectorAll('.dd-menu').forEach(m => { m.hidden = true; });
      menu.hidden = !wasHidden;
      if (!menu.hidden) search.focus();
    });
    wrap.append(btn, menu);
    return wrap;
  }

  // ---------------- charts ----------------
  function chartsPanel() {
    return el('div', { class: 'panel', id: 'chartsPanel' });
  }

  function renderCharts() {
    const panel = $('#chartsPanel');
    if (!panel || !state.champ) return;
    panel.innerHTML = '';
    panel.append(el('h3', null, '一套 Combo 收益時間軸'));

    // controls
    panel.append(el('div', { class: 'controls-bar' },
      el('label', null, '每分鐘經濟 GPM：',
        el('input', {
          type: 'number', min: 300, max: 1200, step: 20, value: state.gpm,
          onchange: ev => { state.gpm = +ev.target.value; refresh(); },
        })),
      el('label', null, '時間軸長度（分）：',
        el('input', {
          type: 'number', min: 6, max: 30, value: state.tMax,
          onchange: ev => { state.tMax = +ev.target.value; refresh(); },
        })),
      el('label', { class: 'inline' },
        el('input', {
          type: 'checkbox', checked: state.pctMode ? '' : null,
          onchange: ev => { state.pctMode = ev.target.checked; refresh(); },
        }), '以「目標血量百分比」顯示'),
    ));

    const step = 0.25;
    const seriesFor = target => state.loadouts.map((lo, i) => ({
      label: lo.name,
      color: COLORS[i % COLORS.length],
      points: E.damageCurve(state.champ, lo, state.gpm, target, D.items, D.runes, state.tMax, step),
      markers: E.itemCompletionTimes(lo.build, state.gpm, D.items).filter(m => m.time <= state.tMax),
    }));

    const sq = seriesFor('squishy');
    const tk = seriesFor('tank');

    // legend
    panel.append(el('div', { class: 'legend' }, state.loadouts.map((lo, i) =>
      el('span', null, el('span', { class: 'sw', style: 'background:' + COLORS[i % COLORS.length] }), lo.name))));

    panel.append(
      el('div', { class: 'chart-title' }, `對「平均脆皮」的一套傷害${state.pctMode ? '（占其血量 %）' : '（有效傷害）'}`),
      el('div', { class: 'chart-box' }, drawChart(sq)),
      el('div', { class: 'chart-title' }, `對「平均坦克」的一套傷害${state.pctMode ? '（占其血量 %）' : '（有效傷害）'}`),
      el('div', { class: 'chart-box' }, drawChart(tk)),
    );

    panel.append(snapshotTable(sq, tk));
    panel.append(el('div', { class: 'note' },
      '假設：GPM 恆定、等級曲線近似、目標假人屬性隨時間成長（脆皮少量防裝／坦克大量防裝）。',
      '技能傷害取自 wr-meta 技能敘述解析；未能解析的段落（如 % 血量處決類）不列入，可在傷害組成勾選調整。',
      '圓點＝完成一件裝備的時間點。'));
  }

  function yVal(pt) { return state.pctMode ? Math.min(200, pt.pctOfTargetHP) : pt.effective; }

  function drawChart(series) {
    const W = 860, H = 300, mL = 52, mR = 14, mT = 12, mB = 30;
    const iw = W - mL - mR, ih = H - mT - mB;
    const tMax = state.tMax;
    let yMax = 0;
    for (const s of series) for (const p of s.points) yMax = Math.max(yMax, yVal(p));
    yMax = yMax * 1.08 || 1;

    const X = t => mL + t / tMax * iw;
    const Y = v => mT + ih - v / yMax * ih;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const add = (name, attrs, text) => {
      const n = document.createElementNS('http://www.w3.org/2000/svg', name);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text !== undefined) n.textContent = text;
      svg.append(n);
      return n;
    };

    // grid + axes
    const ySteps = 5;
    for (let i = 0; i <= ySteps; i++) {
      const v = yMax / ySteps * i;
      add('line', { x1: mL, x2: W - mR, y1: Y(v), y2: Y(v), stroke: '#2e3548', 'stroke-width': i === 0 ? 1.4 : 0.6 });
      add('text', { x: mL - 6, y: Y(v) + 4, fill: '#9aa3b8', 'font-size': 11, 'text-anchor': 'end' },
        state.pctMode ? Math.round(v) + '%' : fmt(v));
    }
    for (let t = 0; t <= tMax; t += 2) {
      add('line', { x1: X(t), x2: X(t), y1: mT, y2: mT + ih, stroke: '#2e3548', 'stroke-width': 0.5 });
      add('text', { x: X(t), y: H - 10, fill: '#9aa3b8', 'font-size': 11, 'text-anchor': 'middle' }, t + '分');
    }
    // 100% 參考線（pct 模式 = 秒殺線）
    if (state.pctMode && yMax > 100) {
      add('line', { x1: mL, x2: W - mR, y1: Y(100), y2: Y(100), stroke: '#f47272', 'stroke-width': 1, 'stroke-dasharray': '5 4' });
      add('text', { x: W - mR - 4, y: Y(100) - 4, fill: '#f47272', 'font-size': 10, 'text-anchor': 'end' }, '100%（可秒）');
    }

    // series lines
    series.forEach(s => {
      const d = s.points.map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ',' + Y(yVal(p)).toFixed(1)).join('');
      add('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2 });
      // item markers
      for (const m of s.markers) {
        const pt = s.points.reduce((a, b) => Math.abs(b.t - m.time) < Math.abs(a.t - m.time) ? b : a);
        add('circle', { cx: X(m.time), cy: Y(yVal(pt)), r: 4, fill: s.color, stroke: '#12141c', 'stroke-width': 1.5 })
          .append(svgTitle(`${m.name}\n約 ${m.time.toFixed(1)} 分（累計 ${m.gold}g）`));
      }
    });

    // hover
    const hoverLine = add('line', { x1: 0, x2: 0, y1: mT, y2: mT + ih, stroke: '#9aa3b8', 'stroke-width': 0.8, visibility: 'hidden' });
    svg.addEventListener('mousemove', ev => {
      const rect = svg.getBoundingClientRect();
      const px = (ev.clientX - rect.left) / rect.width * W;
      const t = Math.max(0, Math.min(tMax, (px - mL) / iw * tMax));
      hoverLine.setAttribute('x1', X(t)); hoverLine.setAttribute('x2', X(t));
      hoverLine.setAttribute('visibility', 'visible');
      showTooltip(ev, series, t);
    });
    svg.addEventListener('mouseleave', () => {
      hoverLine.setAttribute('visibility', 'hidden');
      $('#tooltip').style.display = 'none';
    });
    return svg;
  }

  function svgTitle(text) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    t.textContent = text;
    return t;
  }

  function showTooltip(ev, series, t) {
    const tip = $('#tooltip');
    tip.innerHTML = '';
    const first = series[0].points[0];
    const idx = Math.round(t / (series[0].points[1].t - first.t));
    const lv = E.levelAt(t);
    tip.append(el('div', { style: 'color:var(--gold);margin-bottom:4px' },
      `${t.toFixed(1)} 分｜等級 ${lv}｜金錢 ${fmt0(E.goldAt(t, state.gpm))}`));
    series.forEach(s => {
      const p = s.points[Math.min(idx, s.points.length - 1)];
      tip.append(el('div', { class: 'row' },
        el('span', { style: 'color:' + s.color }, s.label),
        el('span', null, `${fmt0(p.effective)}（${p.pctOfTargetHP.toFixed(0)}%血）`)));
      tip.append(el('div', { class: 'row', style: 'opacity:.6;font-size:11px' },
        el('span', null, `已出：${p.doneItems.length ? p.doneItems.join('、') : '（無）'}`)));
    });
    tip.style.display = '';
    tip.style.left = Math.min(window.innerWidth - 340, ev.clientX + 16) + 'px';
    tip.style.top = (ev.clientY + 14) + 'px';
  }

  function snapshotTable(sq, tk) {
    const marks = [3, 6, 9, 12, 15, 18].filter(t => t <= state.tMax);
    const tbl = el('table', { class: 'snap' });
    tbl.append(el('tr', null,
      el('th', null, '方案 / 時間'),
      marks.map(t => el('th', null, `${t} 分（Lv${E.levelAt(t)}）`))));
    state.loadouts.forEach((lo, i) => {
      const rowS = el('tr', null, el('td', null,
        el('span', { class: 'sw', style: 'background:' + COLORS[i % COLORS.length] }), ` ${lo.name}　vs 脆皮`));
      const rowT = el('tr', null, el('td', null, ` ${lo.name}　vs 坦克`));
      for (const t of marks) {
        const idx = Math.round(t / 0.25);
        const ps = sq[i].points[idx], pt = tk[i].points[idx];
        rowS.append(el('td', null, fmt0(ps.effective), ' ', el('span', { class: 'pct' }, `(${ps.pctOfTargetHP.toFixed(0)}%)`)));
        rowT.append(el('td', null, fmt0(pt.effective), ' ', el('span', { class: 'pct' }, `(${pt.pctOfTargetHP.toFixed(0)}%)`)));
      }
      tbl.append(rowS, rowT);
    });
    return tbl;
  }

  // ---------------- refresh ----------------
  function refresh() {
    saveState();
    rebuildLoadoutPanel();
    renderCharts();
  }

  // ---------------- init ----------------
  $('#patch').textContent = D.patch ? '版本 ' + D.patch : '';
  document.addEventListener('click', () => {
    document.querySelectorAll('.dd-menu').forEach(m => { m.hidden = true; });
  });
  $('#search').addEventListener('input', renderPicker);
  renderPicker();
  const hm = location.hash.match(/^#c=([a-z0-9-]+)/);
  if (hm) {
    const c = D.champions.find(x => x.slug === hm[1]);
    if (c) selectChamp(c);
  }
})();
