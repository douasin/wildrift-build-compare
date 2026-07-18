/* 傷害計算引擎：時間軸 -> 等級/金錢 -> 裝備 -> 一套 combo 對目標的有效傷害 */
(function () {
  'use strict';

  // ---- 遊戲時間模型（Wild Rift，分鐘）----
  // 到達各等級的時間（近似曲線，1~15 級）
  const LEVEL_TIMES = [0, 0.8, 1.7, 2.7, 3.8, 5.0, 6.2, 7.5, 8.9, 10.3, 11.8, 13.4, 15.0, 16.7, 18.5];
  const START_GOLD = 500;

  function levelAt(t) {
    let lv = 1;
    for (let i = 0; i < LEVEL_TIMES.length; i++) {
      if (t >= LEVEL_TIMES[i]) lv = i + 1;
    }
    return Math.min(15, lv);
  }

  function goldAt(t, gpm) {
    return START_GOLD + gpm * t;
  }

  // 依出裝順序算出 t 時已完成的裝備
  function itemsAt(build, t, gpm, itemsDb) {
    const gold = goldAt(t, gpm);
    const done = [];
    let spent = 0;
    for (const name of build) {
      const it = itemsDb[name];
      if (!it) continue;
      const cost = it.gold || 0;
      if (spent + cost <= gold) {
        spent += cost;
        done.push(name);
      } else break;
    }
    return done;
  }

  // 每件裝備完成的時間點（分鐘）
  function itemCompletionTimes(build, gpm, itemsDb) {
    const out = [];
    let cum = 0;
    for (const name of build) {
      const it = itemsDb[name];
      if (!it) continue;
      cum += (it.gold || 0);
      out.push({ name, gold: cum, time: Math.max(0, (cum - START_GOLD) / gpm) });
    }
    return out;
  }

  // ---- 技能等級 ----
  // priority: 例如 ['Q','W','E']；R 固定 5/9/13 升
  function abilityRanks(level, priority) {
    const ranks = { Q: 0, W: 0, E: 0, R: 0 };
    ranks.R = level >= 13 ? 3 : level >= 9 ? 2 : level >= 5 ? 1 : 0;
    let points = level - ranks.R;
    // 前三級各學一招（按優先序）
    const learnOrder = [priority[0], priority[1], priority[2]];
    for (let i = 0; i < 3 && points > 0; i++) {
      ranks[learnOrder[i]] = 1;
      points--;
    }
    // 剩餘點數按優先序灌
    for (const s of priority) {
      while (points > 0 && ranks[s] < 4) { ranks[s]++; points--; }
    }
    return ranks;
  }

  // ---- 角色屬性合成 ----
  function champStatsAt(champ, level, doneItems, itemsDb) {
    const bs = champ.stats || {};
    const g = (k, d) => (bs[k] ? bs[k][0] + bs[k][1] * (level - 1) : d);
    const s = {
      level,
      baseAD: g('ad', 60), hp: g('hp', 650), armor: g('armor', 35), mr: g('mr', 35),
      mana: g('mana', 400), ap: 0, bonusAD: 0, bonusHP: 0,
      haste: 0, critPct: 0, asPct: 0,
      mpen: 0, mpenPct: 0, apen: 0, apenPct: 0,
    };
    for (const name of doneItems) {
      const it = itemsDb[name];
      if (!it) continue;
      const st = it.stats || {};
      s.ap += st.ap || 0;
      s.bonusAD += st.ad || 0;
      s.bonusHP += st.hp || 0;
      s.hp += st.hp || 0;
      s.armor += st.armor || 0;
      s.mr += st.mr || 0;
      s.mana += st.mana || 0;
      s.haste += st.haste || 0;
      s.critPct += st.critPct || 0;
      s.asPct += st.asPct || 0;
      s.mpen += st.mpen || 0;
      s.mpenPct += st.mpenPct || 0;
      s.apen += st.apen || 0;
      s.apenPct += st.apenPct || 0;
    }
    s.ad = s.baseAD + s.bonusAD;
    // Rabadon 類乘法被動先忽略；Deathcap 在 WR 是 +40% AP
    if (doneItems.includes("Rabadon's Deathcap")) s.ap *= 1.4;
    return s;
  }

  function statValue(stat, s, target) {
    switch (stat) {
      case 'AP': return s.ap;
      case 'AD': return s.ad;
      case 'bonusAD': return s.bonusAD;
      case 'maxHP': return s.hp;
      case 'bonusHP': return s.bonusHP;
      case 'maxMana': return s.mana;
      case 'armor': return s.armor;
      case 'mr': return s.mr;
      case 'targetMaxHP': return target ? target.hp : 0;
      default: return 0;
    }
  }

  // 係數可能隨技能等級成長（例如 45/55/65/75% AD）
  function ratioPctAt(rt, rank, level, isPassive) {
    const p = rt.pct;
    if (!Array.isArray(p)) return p;
    if (isPassive) {
      return p[Math.min(p.length - 1, Math.floor((level - 1) * p.length / 15))];
    }
    if (rank <= 0) return 0;
    return p[Math.min(rank - 1, p.length - 1)];
  }

  // 傷害實例在某技能等級的基礎值
  function instanceBase(inst, rank, level, isPassive) {
    const arr = inst.base;
    if (!arr || !arr.length) return 0;
    if (arr.length === 1) return arr[0];
    if (isPassive) {
      const idx = Math.min(arr.length - 1, Math.floor((level - 1) * arr.length / 15));
      return arr[idx];
    }
    if (rank <= 0) return 0;
    return arr[Math.min(rank - 1, arr.length - 1)];
  }

  // ---- 目標假人（隨時間成長）----
  function makeTarget(kind, t) {
    const lv = levelAt(t);
    if (kind === 'tank') {
      return {
        kind, label: '坦克',
        hp: 680 + 125 * (lv - 1) + Math.min(2600, 115 * t),
        armor: 46 + 4.4 * (lv - 1) + Math.min(150, 6.5 * t),
        mr: 38 + 2.0 * (lv - 1) + Math.min(130, 5.5 * t),
      };
    }
    return {
      kind, label: '脆皮',
      hp: 600 + 102 * (lv - 1) + Math.min(900, 32 * t),
      armor: 32 + 3.8 * (lv - 1) + Math.min(45, 1.6 * t),
      mr: 32 + 1.4 * (lv - 1) + Math.min(42, 1.5 * t),
    };
  }

  function mitigation(s, target) {
    let armor = target.armor * (1 - (s.apenPct || 0) / 100) - (s.apen || 0);
    let mr = target.mr * (1 - (s.mpenPct || 0) / 100) - (s.mpen || 0);
    if (armor < 0) armor = 0;
    if (mr < 0) mr = 0;
    return {
      phys: 100 / (100 + armor),
      magic: 100 / (100 + mr),
    };
  }

  // ---- 裝備特效（近似值，可關閉）----
  const ITEM_PROCS = {
    'Lich Bane': { label: '咒刃（觸發一次）', type: 'magic', fn: s => 0.75 * s.baseAD + 0.5 * s.ap },
    'Trinity Force': { label: '咒刃（觸發一次）', type: 'physical', fn: s => 2.0 * s.baseAD },
    'Sheen': { label: '咒刃（觸發一次）', type: 'physical', fn: s => 1.0 * s.baseAD },
    'Blackfire Torch': { label: '燃燒 3 秒', type: 'magic', fn: s => 3 * (20 + 0.02 * s.ap) },
    "Luden's Echo": { label: '回聲（觸發一次）', type: 'magic', fn: s => 100 + 0.1 * s.ap },
    'Infinity Orb': { label: '低血量目標暴擊被動（不計）', type: 'none', fn: () => 0 },
  };

  // ---- 符文傷害（keystone / 小符文）----
  function runeDamage(runeName, runesDb, s, level) {
    const r = runesDb[runeName];
    if (!r || !r.parsed) return null;
    const p = r.parsed;
    if (p.dmgMin == null) return null;
    let dmg = p.dmgMin + (p.dmgMax - p.dmgMin) * (level - 1) / 14;
    if (p.ratios && p.ratios.length) {
      // 適應之力：取 AD / AP 貢獻較高者；其他屬性直接加
      let adPart = 0, apPart = 0, other = 0;
      for (const rt of p.ratios) {
        const v = rt.pct / 100 * statValue(rt.stat, s, null);
        if (rt.stat === 'AD' || rt.stat === 'bonusAD') adPart = Math.max(adPart, v);
        else if (rt.stat === 'AP') apPart = Math.max(apPart, v);
        else other += v;
      }
      dmg += Math.max(adPart, apPart) + other;
    }
    return { name: runeName, dmg, adaptive: true };
  }

  // ---- 一套 combo 總傷 ----
  // loadout: { build:[item...], runes:[name...], combo:{Q:1,W:1,E:1,R:1,P:1,AA:2},
  //            enabledInstances: {'Q0':true,...}, useProcs:true, priority:['Q','W','E'] }
  function comboDamage(champ, loadout, t, gpm, targetKind, itemsDb, runesDb) {
    const level = levelAt(t);
    const done = itemsAt(loadout.build, t, gpm, itemsDb);
    const s = champStatsAt(champ, level, done, itemsDb);
    const target = makeTarget(targetKind, t);
    const mit = mitigation(s, target);
    const ranks = abilityRanks(level, loadout.priority || ['Q', 'W', 'E']);

    let phys = 0, magic = 0, trueDmg = 0;
    const parts = [];

    for (const slot of ['P', 'Q', 'W', 'E', 'R']) {
      const ab = champ.abilities[slot];
      if (!ab) continue;
      const count = (loadout.combo[slot] != null) ? loadout.combo[slot] : 1;
      if (count <= 0) continue;
      const isPassive = slot === 'P';
      if (!isPassive && ranks[slot] <= 0) continue;
      ab.damage.forEach((inst, i) => {
        const key = slot + i;
        const en = loadout.enabledInstances[key];
        const defaultOn = inst.type === 'magic' || inst.type === 'physical' || inst.type === 'true';
        if (en === undefined ? !defaultOn : !en) return;
        const base = instanceBase(inst, ranks[slot], level, isPassive);
        if (base <= 0 && !(inst.ratios || []).length) return;
        let val = base;
        for (const rt of inst.ratios || []) {
          val += ratioPctAt(rt, ranks[slot], level, isPassive) / 100 * statValue(rt.stat, s, target);
        }
        val *= count;
        if (val <= 0) return;
        const ty = inst.type === 'unknown' ? 'magic' : inst.type;
        if (ty === 'physical') phys += val;
        else if (ty === 'true') trueDmg += val;
        else if (ty === 'magic') magic += val;
        else return; // heal / shield 不計入傷害
        parts.push({ label: slot + (i > 0 ? '·' + (i + 1) : ''), type: ty, raw: val });
      });
    }

    // 平 A（暴擊期望值）
    const aaCount = loadout.combo.AA != null ? loadout.combo.AA : 2;
    if (aaCount > 0) {
      const crit = Math.min(100, s.critPct) / 100;
      const aa = s.ad * (1 + crit * 0.75) * aaCount;
      phys += aa;
      parts.push({ label: '平A×' + aaCount, type: 'physical', raw: aa });
    }

    // 裝備特效
    if (loadout.useProcs !== false) {
      for (const name of done) {
        const proc = ITEM_PROCS[name];
        if (!proc || proc.type === 'none') continue;
        const v = proc.fn(s);
        if (v <= 0) continue;
        if (proc.type === 'physical') phys += v; else magic += v;
        parts.push({ label: name, type: proc.type, raw: v });
      }
    }

    // 符文（有傷害數值的都算一次觸發）
    for (const rn of loadout.runes || []) {
      const rd = runeDamage(rn, runesDb, s, level);
      if (rd && rd.dmg > 0) {
        // 適應性傷害：依較高屬性決定魔法/物理；統一用「較高者」對應的減免
        const isMagic = s.ap >= s.bonusAD;
        if (isMagic) magic += rd.dmg; else phys += rd.dmg;
        parts.push({ label: rn, type: isMagic ? 'magic' : 'physical', raw: rd.dmg });
      }
    }

    const effective = phys * mit.phys + magic * mit.magic + trueDmg;
    return {
      t, level, gold: goldAt(t, gpm), doneItems: done, stats: s, target,
      phys, magic, trueDmg, effective,
      pctOfTargetHP: effective / target.hp * 100,
      parts, mit,
    };
  }

  // 曲線取樣
  function damageCurve(champ, loadout, gpm, targetKind, itemsDb, runesDb, tMax, step) {
    const pts = [];
    for (let t = 0; t <= tMax + 1e-9; t += step) {
      pts.push(comboDamage(champ, loadout, t, gpm, targetKind, itemsDb, runesDb));
    }
    return pts;
  }

  window.WREngine = {
    LEVEL_TIMES, START_GOLD,
    levelAt, goldAt, itemsAt, itemCompletionTimes, abilityRanks,
    champStatsAt, makeTarget, comboDamage, damageCurve, ITEM_PROCS,
  };
})();
