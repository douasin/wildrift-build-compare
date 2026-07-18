"""Export wildrift.sqlite -> site/data.js + site/icons/*

Usage: python scraper/export_site.py
"""
import json
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / 'wildrift.sqlite'
SITE = ROOT / 'docs'  # GitHub Pages 直接發佈這個資料夾
ICONS = SITE / 'icons'


# --------------------------------------------------- item stat line parsing ---
STAT_PATTERNS = [
    (r'\+\s*([\d.]+)\s*%\s*Critical (?:Rate|Strike)', 'critPct'),
    (r'\+\s*([\d.]+)\s*%\s*Attack Speed', 'asPct'),
    (r'\+\s*([\d.]+)\s*%\s*(?:Move|Movement) Speed', 'msPct'),
    (r'\+\s*([\d.]+)\s*%\s*Magic Penetration', 'mpenPct'),
    (r'\+\s*([\d.]+)\s*%\s*Armor Penetration', 'apenPct'),
    (r'\+\s*([\d.]+)\s*%\s*(?:Physical Vamp|Omnivamp|Life Steal|Vamp)', 'vampPct'),
    (r'\+\s*([\d.]+)\s*%\s*Heal(?:ing)? (?:and Shield )?Power', 'healPct'),
    (r'\+\s*([\d.]+)\s*Ability Power', 'ap'),
    (r'\+\s*([\d.]+)\s*Attack Damage', 'ad'),
    (r'\+\s*([\d.]+)\s*Max(?:imum)? Health', 'hp'),
    (r'\+\s*([\d.]+)\s*Max(?:imum)? Mana', 'mana'),
    (r'\+\s*([\d.]+)\s*Ability Haste', 'haste'),
    (r'\+\s*([\d.]+)\s*Armor(?!\s*Pen)', 'armor'),
    (r'\+\s*([\d.]+)\s*Magic Resist(?:ance)?', 'mr'),
    (r'\+\s*([\d.]+)\s*Magic Penetration', 'mpen'),
    (r'\+\s*([\d.]+)\s*Armor Penetration', 'apen'),
    (r'\+\s*([\d.]+)\s*(?:Health|HP) Regen', 'hp5'),
    (r'\+\s*([\d.]+)\s*Mana Regen', 'mp5'),
]


def parse_stat_lines(lines):
    out = {}
    for line in lines:
        for pat, key in STAT_PATTERNS:
            m = re.search(pat, line, re.I)
            if m:
                out[key] = out.get(key, 0) + float(m.group(1))
                break
    return out


def icon_filename(url):
    base = re.sub(r'[^a-zA-Z0-9._-]', '_', url.split('/')[-1]) or 'x'
    # avoid collisions between same basename in different folders
    h = format(abs(hash(url)) % 0xFFFF, '04x')
    if '.' in base:
        stem, ext = base.rsplit('.', 1)
        return f'{stem}_{h}.{ext}'
    return f'{base}_{h}'


def main():
    conn = sqlite3.connect(DB)
    ICONS.mkdir(parents=True, exist_ok=True)

    icon_map = {}  # url -> relative path

    def export_icon(url):
        if not url:
            return ''
        if url in icon_map:
            return icon_map[url]
        row = conn.execute('SELECT data FROM icons WHERE url=?', (url,)).fetchone()
        if not row:
            icon_map[url] = ''
            return ''
        fn = icon_filename(url)
        (ICONS / fn).write_bytes(row[0])
        icon_map[url] = 'icons/' + fn
        return icon_map[url]

    # items
    items = {}
    for name, subtitle, stats_json, passives, gold, tier, icon_url, tips in conn.execute(
            'SELECT name,subtitle,stats_json,passives,gold,tier,icon_url,tips FROM items'):
        lines = json.loads(stats_json or '[]')
        items[name] = {
            'name': name, 'subtitle': subtitle or '',
            'stats': parse_stat_lines(lines), 'statLines': lines,
            'gold': gold, 'tier': tier or '', 'icon': export_icon(icon_url),
            'desc': passives or '',
        }

    # runes
    runes = {}
    for name, subtitle, text, parsed_json, icon_url in conn.execute(
            'SELECT name,subtitle,text,parsed_json,icon_url FROM runes'):
        runes[name] = {
            'name': name, 'subtitle': subtitle or '', 'text': text or '',
            'parsed': json.loads(parsed_json or '{}'), 'icon': export_icon(icon_url),
        }

    # champions (skip non-champion pages that slipped in via sitemap)
    champs = []
    for cid, slug, name, url, patch, lane, roles, portrait, stats_json in conn.execute(
            'SELECT id,slug,name,url,patch,lane,roles,portrait_url,stats_json FROM champions ORDER BY name'):
        n_ab = conn.execute('SELECT COUNT(*) FROM abilities WHERE champ_id=?', (cid,)).fetchone()[0]
        stats = json.loads(stats_json or '{}')
        if n_ab < 4 or not stats:
            continue
        abilities = {}
        for slot, aname, cd, cost, text, dmg_json, aicon in conn.execute(
                'SELECT slot,name,cooldown,cost,text,damage_json,icon_url FROM abilities WHERE champ_id=?', (cid,)):
            abilities[slot] = {
                'slot': slot, 'name': aname, 'cd': cd, 'cost': cost, 'text': text,
                'damage': json.loads(dmg_json or '[]'), 'icon': export_icon(aicon),
            }
        builds = {}
        for section, pos, item_name in conn.execute(
                'SELECT section,position,item_name FROM champion_builds WHERE champ_id=? '
                'ORDER BY position', (cid,)):
            builds.setdefault(section, []).append(item_name)
        crunes = {}
        for kind, pos, rune_name in conn.execute(
                'SELECT kind,position,rune_name FROM champion_runes WHERE champ_id=? ORDER BY position', (cid,)):
            crunes.setdefault(kind, []).append(rune_name)
        spells = [r[0] for r in conn.execute(
            'SELECT spell_name FROM champion_spells WHERE champ_id=? ORDER BY position', (cid,))]
        champs.append({
            'id': cid, 'slug': slug, 'name': name, 'url': url, 'patch': patch,
            'lane': lane, 'roles': roles, 'portrait': export_icon(portrait),
            'stats': json.loads(stats_json or '{}'),
            'abilities': abilities, 'builds': builds, 'runes': crunes, 'spells': spells,
        })

    data = {'champions': champs, 'items': items, 'runes': runes,
            'patch': champs[0]['patch'] if champs else ''}
    js = 'window.WR_DATA = ' + json.dumps(data, ensure_ascii=False) + ';\n'
    (SITE / 'data.js').write_text(js, encoding='utf-8')
    print(f'exported {len(champs)} champions, {len(items)} items, {len(runes)} runes, '
          f'{len([v for v in icon_map.values() if v])} icons')
    print(f'data.js: {len(js) // 1024} KB -> {SITE / "data.js"}')


if __name__ == '__main__':
    main()
