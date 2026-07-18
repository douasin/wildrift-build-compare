"""wr-meta.com scraper -> local sqlite (wildrift.sqlite)

Usage:
  python scraper/scrape.py --test          # only a few champions
  python scraper/scrape.py                 # full scrape (champions + items + icons)
  python scraper/scrape.py --reparse       # re-parse from cached page HTML in DB (no network)
  python scraper/scrape.py --icons-only    # only download missing icons
"""
import argparse
import gzip
import json
import re
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from bs4 import BeautifulSoup, Comment, NavigableString, Tag

BASE = 'https://wr-meta.com'
HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'}
DB_PATH = Path(__file__).resolve().parent.parent / 'wildrift.sqlite'
DELAY = 0.35  # politeness delay between page fetches

session = requests.Session()
session.headers.update(HEADERS)


# ---------------------------------------------------------------- DB ----------
SCHEMA = """
CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY, html_gz BLOB, fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS champions (
  id INTEGER PRIMARY KEY, slug TEXT, name TEXT, url TEXT, patch TEXT,
  lane TEXT, roles TEXT, portrait_url TEXT, stats_json TEXT, scraped_at TEXT
);
CREATE TABLE IF NOT EXISTS abilities (
  champ_id INTEGER, slot TEXT, name TEXT, cooldown TEXT, cost TEXT,
  text TEXT, damage_json TEXT, icon_url TEXT,
  PRIMARY KEY (champ_id, slot)
);
CREATE TABLE IF NOT EXISTS champion_builds (
  champ_id INTEGER, section TEXT, position INTEGER, item_name TEXT,
  PRIMARY KEY (champ_id, section, position)
);
CREATE TABLE IF NOT EXISTS champion_runes (
  champ_id INTEGER, kind TEXT, position INTEGER, rune_name TEXT,
  PRIMARY KEY (champ_id, kind, position)
);
CREATE TABLE IF NOT EXISTS champion_spells (
  champ_id INTEGER, position INTEGER, spell_name TEXT,
  PRIMARY KEY (champ_id, position)
);
CREATE TABLE IF NOT EXISTS items (
  name TEXT PRIMARY KEY, subtitle TEXT, stats_json TEXT, passives TEXT,
  gold INTEGER, tier TEXT, icon_url TEXT, tips TEXT
);
CREATE TABLE IF NOT EXISTS runes (
  name TEXT PRIMARY KEY, subtitle TEXT, text TEXT, parsed_json TEXT, icon_url TEXT
);
CREATE TABLE IF NOT EXISTS icons (
  url TEXT PRIMARY KEY, data BLOB, content_type TEXT
);
"""


def db_connect():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    return conn


def fetch(url, binary=False):
    r = session.get(url, timeout=30)
    r.raise_for_status()
    return r.content if binary else r.text


def cache_page(conn, url, html):
    conn.execute('REPLACE INTO pages(url, html_gz, fetched_at) VALUES (?,?,datetime("now"))',
                 (url, gzip.compress(html.encode('utf-8')), ))


def get_page(conn, url, refetch=True):
    if not refetch:
        row = conn.execute('SELECT html_gz FROM pages WHERE url=?', (url,)).fetchone()
        if row:
            return gzip.decompress(row[0]).decode('utf-8')
    html = fetch(url)
    cache_page(conn, url, html)
    time.sleep(DELAY)
    return html


# ------------------------------------------------------------ helpers ---------
EMOJI_TOKEN = {
    'abilitypower': 'AP', 'attackdamage': 'AD', 'armor': 'ARMOR',
    'magicresistance': 'MR', 'heal': 'HP', 'mana': 'MANA', 'mpreg': 'MP5',
    'movementspeed': 'MS', 'attackspeed': 'AS', 'criticalstrike': 'CRIT',
    'healthregeneration': 'HP5', 'perlevel': 'PERLEVEL', 'energy': 'ENERGY',
}
ICONSTAT_TOKEN = {
    'ap': 'AP', 'ad': 'AD', 'cdr': 'CD', 'mana': 'MANA', 'hp': 'HP',
    'armor': 'ARMOR', 'mr': 'MR', 'as': 'AS', 'crit': 'CRIT', 'ms': 'MS',
    'perlevel': 'PERLEVEL', 'energy': 'ENERGY', 'vamp': 'VAMP',
}


def img_token(img):
    alt = (img.get('alt') or '').strip().lower()
    if alt in EMOJI_TOKEN:
        return ' {%s} ' % EMOJI_TOKEN[alt]
    src = img.get('data-src') or img.get('src') or ''
    m = re.search(r'icon-stat/([a-z]+)', src, re.I)
    if m and m.group(1).lower() in ICONSTAT_TOKEN:
        return ' {%s} ' % ICONSTAT_TOKEN[m.group(1).lower()]
    return ' '


def normalize(el):
    """Element -> plain text with {AP}-style tokens for stat icons."""
    parts = []

    def walk(node):
        if isinstance(node, Comment):
            return
        if isinstance(node, NavigableString):
            parts.append(str(node))
        elif isinstance(node, Tag):
            if node.name == 'img':
                parts.append(img_token(node))
            elif node.name == 'br':
                parts.append('\n')
            else:
                for c in node.children:
                    walk(c)
    walk(el)
    text = ''.join(parts)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r' ?\n ?', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


STAT_KEYS = {
    'attackdamage': 'ad', 'heal': 'hp', 'healthregeneration': 'hp5',
    'attackspeed': 'as', 'mana': 'mana', 'mpreg': 'mp5',
    'movementspeed': 'ms', 'armor': 'armor', 'magicresistance': 'mr',
    'criticalstrike': 'crit',
}


# --------------------------------------------- ability damage extraction ------
DMG_TYPES = [
    ('true damage', 'true'), ('magic damage', 'magic'),
    ('physical damage', 'physical'), ('heal', 'heal'), ('shield', 'shield'),
]
RATIO_STATS = [
    (r'bonus\s*\{AD\}', 'bonusAD'), (r'extra\s*\{AD\}', 'bonusAD'),
    (r'\{AD\}', 'AD'), (r'\{AP\}', 'AP'),
    (r'bonus\s*(?:health|\{HP\})', 'bonusHP'),
    (r'max(?:imum)?\s*(?:health|\{HP\})', 'maxHP'),
    (r'\{HP\}', 'maxHP'),
    (r'max(?:imum)?\s*(?:mana|\{MANA\})', 'maxMana'),
    (r'\{ARMOR\}|armor', 'armor'), (r'\{MR\}|magic resist(?:ance)?', 'mr'),
    (r"(?:of\s+)?(?:their|target'?s?)\s+max(?:imum)?\s+health", 'targetMaxHP'),
]


def balanced_parens(text):
    """Yield (start, end, inner) for top-level balanced paren groups."""
    depth = 0
    start = None
    for i, ch in enumerate(text):
        if ch == '(':
            if depth == 0:
                start = i
            depth += 1
        elif ch == ')':
            if depth > 0:
                depth -= 1
                if depth == 0 and start is not None:
                    yield start, i + 1, text[start + 1:i]
    return


def parse_ratio_part(part):
    part = part.strip()
    m = re.match(r'^([\d.]+(?:\s*/\s*[\d.]+)*)\s*%\s*(.*)$', part)
    if not m:
        return None
    vals = [float(x) for x in re.split(r'\s*/\s*', m.group(1))]
    pct = vals[0] if len(vals) == 1 else vals
    rest = m.group(2).strip()
    for pat, stat in RATIO_STATS:
        if re.search(pat, rest, re.I):
            return {'pct': pct, 'stat': stat}
    if rest == '' or rest.lower().startswith(('per', 'of')):
        return {'pct': pct, 'stat': 'unknown', 'raw': part}
    return {'pct': pct, 'stat': 'unknown', 'raw': part}


def extract_damage_instances(text):
    """Find '(40/75/110/145 + 45% {AP} ...)' groups; return structured list."""
    out = []
    for start, end, inner in balanced_parens(text):
        inner_clean = inner.strip()
        m = re.match(r'^([\d.]+(?:\s*/\s*[\d.]+)+|[\d.]+)\s*(.*)$', inner_clean, re.S)
        if not m:
            continue
        base_str, rest = m.group(1), m.group(2).strip()
        if rest and not rest.startswith('+'):
            continue  # e.g. "(0)" growth notes or odd text
        base = [float(x) for x in re.split(r'\s*/\s*', base_str)]
        ratios = []
        ok = True
        if rest:
            # split top-level '+' parts (rest may itself contain nested parens - rare)
            for part in re.split(r'\s*\+\s*', rest)[1:] if rest.startswith('+') else []:
                if not part.strip():
                    continue
                r = parse_ratio_part(part)
                if r is None:
                    ok = False
                else:
                    ratios.append(r)
        # damage type: prefer a mention directly before "deals X magic damage (...)",
        # else directly after "dealing X (...) physical damage", else any within 130 back
        back = text[max(0, start - 130):start].lower()
        fwd = text[end:end + 60].lower()

        def nearest(hay, from_end):
            bd, bt = 10 ** 9, None
            for phrase, t in DMG_TYPES:
                j = hay.rfind(phrase) if from_end else hay.find(phrase)
                if j >= 0:
                    d = (len(hay) - j) if from_end else j
                    if d < bd:
                        bd, bt = d, t
            return bd, bt

        dtype = 'unknown'
        bdist, btype = nearest(back, True)
        fdist, ftype = nearest(fwd, False)
        if btype and bdist <= 35:
            dtype = btype
        elif ftype and fdist <= 45:
            dtype = ftype
        elif btype:
            dtype = btype
        elif ftype:
            dtype = ftype
        if len(base) == 1 and not ratios:
            continue  # single number, no ratio: not a damage formula
        out.append({
            'base': base, 'ratios': ratios, 'type': dtype,
            'raw': inner_clean, 'clean': ok,
            'context': text[max(0, start - 90):start].strip()[-90:],
        })
    return out


# ------------------------------------------------------- champion parse -------
def parse_champion(html, url):
    soup = BeautifulSoup(html, 'html.parser')
    data = {'url': url}
    m = re.match(r'.*/(\d+)-([a-z0-9-]+)\.html', url)
    data['id'] = int(m.group(1))
    data['slug'] = m.group(2)

    h1 = soup.find('h1')
    title = h1.get_text(' ', strip=True) if h1 else ''
    tm = re.match(r'Wild Rift:\s*(.+?)\s*Build Guide\s*\(([^)]+)\)', title)
    data['name'] = tm.group(1).title() if tm else data['slug'].replace('-', ' ').title()
    data['patch'] = tm.group(2) if tm else ''

    role_b = soup.find(string=re.compile(r'^\s*role\s*-?\s*$')) or None
    roles = ''
    p = soup.select_one('.fmeta4 p')
    if p:
        rm = re.search(r'role\s*-\s*(.+?)\.', p.get_text(' ', strip=True))
        if rm:
            roles = rm.group(1).strip()
    data['roles'] = roles

    lane = ''
    for h in soup.find_all(['h2', 'h3']):
        hm = re.match(r'^(Top|Mid|Baron|Dragon|Jungle|Support|ADC|Duo)\b.*Build items and runes',
                      h.get_text(' ', strip=True), re.I)
        if hm:
            lane = hm.group(1)
            break
    data['lane'] = lane

    og = soup.find('meta', property='og:image')
    data['portrait_url'] = og['content'] if og else ''

    # base stats
    stats = {}
    sb = soup.select_one('.stats-block')
    if sb:
        for b in sb.find_all('b'):
            img = b.find('img')
            if not img:
                continue
            key = STAT_KEYS.get((img.get('alt') or '').lower())
            if not key:
                continue
            sm = re.search(r'([\d.]+)\s*\(([\d.]+)\)', b.get_text(' ', strip=True))
            if sm:
                stats[key] = [float(sm.group(1)), float(sm.group(2))]
    data['stats'] = stats

    # abilities: first occurrence of each slot letter
    abilities = {}
    for holder in soup.select('.ability-holder'):
        marker = holder.select_one('.ability-marker')
        ptag = holder.find('p')
        img = holder.select_one('.ability-img img')
        if not marker or not ptag:
            continue
        slot = marker.get_text(strip=True)
        if slot in abilities:
            continue
        text = normalize(ptag)
        name_m = re.search(r'\((?:PASSIVE|Q|W|E|R)\)\s*([^\n]+)', text)
        cd = cost = ''
        cdm = re.search(r'\{CD\}\s*([\d/.\s]+s)', text)
        if cdm:
            cd = cdm.group(1).strip()
        costm = re.search(r'\{(?:MANA|ENERGY)\}\s*([\d/\s]+)', text)
        if costm:
            cost = costm.group(1).strip()
        abilities[slot] = {
            'slot': slot,
            'name': (name_m.group(1).strip() if name_m else ''),
            'cooldown': cd, 'cost': cost, 'text': text,
            'damage': extract_damage_instances(text),
            'icon_url': img.get('data-src') or img.get('src') or '' if img else '',
        }
    data['abilities'] = abilities

    # items: key build (ordered walk through the Key items flex block)
    builds = []   # (section, pos, item_name)
    items_found = {}  # name -> item dict (tooltip data)

    def parse_item_tooltip(ptag, icon):
        name_b = ptag.find('b', class_='iname')
        if not name_b:
            return None
        name = name_b.get_text(strip=True)
        subtitle = ''
        sub = name_b.find_next_sibling('b', class_='cdr')
        if sub:
            subtitle = sub.get_text(strip=True)
        stats = []
        for st in ptag.find_all('b', class_='istats'):
            stats.append(normalize(st))
        text = normalize(ptag)
        gold = None
        gm = ptag.find('b', class_='goldt')
        if gm:
            try:
                gold = int(re.sub(r'\D', '', gm.get_text()))
            except ValueError:
                gold = None
        return {'name': name, 'subtitle': subtitle, 'stats': stats,
                'text': text, 'gold': gold, 'icon_url': icon}

    def item_name_of(holder):
        b = holder.select_one('p b.iname')
        if b:
            return b.get_text(strip=True)
        sp = holder.find('span')
        return sp.get_text(strip=True) if sp else None

    key_h3 = None
    for h in soup.find_all('h3'):
        if h.get_text(strip=True).lower() == 'key items':
            key_h3 = h
            break
    if key_h3:
        flex = key_h3.find_next(class_='flex-block')
        if flex:
            pos = 0
            section = ''
            for el in flex.descendants:
                if isinstance(el, Tag):
                    cls = el.get('class') or []
                    if 'bildtitle2' in cls:
                        section = el.get_text(strip=True)
                    if 'ico-holder3' in cls:
                        nm = item_name_of(el)
                        if nm:
                            builds.append((section or 'Build', pos, nm))
                            pos += 1
                        ptag = el.find('p')
                        img = el.find('img')
                        if ptag:
                            it = parse_item_tooltip(
                                ptag, (img.get('data-src') or '') if img else '')
                            if it:
                                items_found[it['name']] = it

    # situational items
    sit_h3 = None
    for h in soup.find_all('h3'):
        if h.get_text(strip=True).lower() == 'situational items':
            sit_h3 = h
            break
    if sit_h3:
        pos = 0
        nxt = sit_h3.find_next(class_='flex-block') or sit_h3.parent
        if nxt:
            for holder in nxt.select('.sit-item-list, .ico-holder3'):
                nm = item_name_of(holder) or (
                    holder.select_one('b.iname').get_text(strip=True)
                    if holder.select_one('b.iname') else None)
                if nm:
                    builds.append(('Situational', pos, nm))
                    pos += 1
                ptag = holder.find('p')
                img = holder.find('img')
                if ptag:
                    it = parse_item_tooltip(ptag, (img.get('data-src') or '') if img else '')
                    if it:
                        items_found[it['name']] = it
    data['builds'] = builds
    data['items_found'] = items_found

    # runes
    runes = []   # (kind, pos, name)
    rune_defs = {}

    def parse_rune_box(box, kind, pos):
        name_b = box.select_one('b.iname')
        if not name_b:
            return pos
        name = name_b.get_text(strip=True)
        ptag = box.find('p')
        img = box.find('img')
        sub = box.select_one('b.cdr')
        rune_defs[name] = {
            'name': name,
            'subtitle': sub.get_text(strip=True) if sub else '',
            'text': normalize(ptag) if ptag else '',
            'icon_url': (img.get('data-src') or '') if img else '',
        }
        runes.append((kind, pos, name))
        return pos + 1

    rb_h3 = None
    for h in soup.find_all('h3'):
        if 'runes build' in h.get_text(strip=True).lower():
            rb_h3 = h
            break
    if rb_h3:
        box = rb_h3.find_next(class_='runesbox')
        if box:
            pos = 0
            for rbox in box.select('.rune-box'):
                kind = 'keystone' if pos == 0 else 'minor'
                pos = parse_rune_box(rbox, kind, pos)
    sit_rune_h3 = None
    for h in soup.find_all('h3'):
        if 'situational runes' in h.get_text(strip=True).lower():
            sit_rune_h3 = h
            break
    if sit_rune_h3:
        box = sit_rune_h3.find_next(class_='runesbox') or sit_rune_h3.parent
        pos = 0
        if box and box is not (rb_h3.find_next(class_='runesbox') if rb_h3 else None):
            for rbox in box.select('.rune-box'):
                pos = parse_rune_box(rbox, 'situational', pos)
    data['runes'] = runes
    data['rune_defs'] = rune_defs

    # summoner spells
    spells = []
    sp_h3 = None
    for h in soup.find_all('h3'):
        if h.get_text(strip=True).lower() == 'summoner spells':
            sp_h3 = h
            break
    if sp_h3:
        blk = sp_h3.find_next(class_='flex-block')
        if blk:
            for b in blk.select('b.iname'):
                nm = b.get_text(strip=True)
                if nm not in spells:
                    spells.append(nm)
    data['spells'] = spells
    return data


def save_champion(conn, d):
    conn.execute('REPLACE INTO champions(id,slug,name,url,patch,lane,roles,portrait_url,stats_json,scraped_at) '
                 'VALUES (?,?,?,?,?,?,?,?,?,datetime("now"))',
                 (d['id'], d['slug'], d['name'], d['url'], d['patch'], d['lane'],
                  d['roles'], d['portrait_url'], json.dumps(d['stats'])))
    conn.execute('DELETE FROM abilities WHERE champ_id=?', (d['id'],))
    for slot, ab in d['abilities'].items():
        conn.execute('INSERT INTO abilities VALUES (?,?,?,?,?,?,?,?)',
                     (d['id'], slot, ab['name'], ab['cooldown'], ab['cost'],
                      ab['text'], json.dumps(ab['damage']), ab['icon_url']))
    conn.execute('DELETE FROM champion_builds WHERE champ_id=?', (d['id'],))
    seen = set()
    for section, pos, nm in d['builds']:
        if (section, pos) in seen:
            continue
        seen.add((section, pos))
        conn.execute('INSERT INTO champion_builds VALUES (?,?,?,?)', (d['id'], section, pos, nm))
    conn.execute('DELETE FROM champion_runes WHERE champ_id=?', (d['id'],))
    seen = set()
    for kind, pos, nm in d['runes']:
        if (kind, pos) in seen:
            continue
        seen.add((kind, pos))
        conn.execute('INSERT INTO champion_runes VALUES (?,?,?,?)', (d['id'], kind, pos, nm))
    conn.execute('DELETE FROM champion_spells WHERE champ_id=?', (d['id'],))
    for i, nm in enumerate(d['spells']):
        conn.execute('INSERT INTO champion_spells VALUES (?,?,?)', (d['id'], i, nm))
    # upsert item tooltips (do not clobber richer /items/ data: only insert if missing)
    for nm, it in d['items_found'].items():
        row = conn.execute('SELECT 1 FROM items WHERE name=?', (nm,)).fetchone()
        if not row:
            conn.execute('INSERT INTO items(name,subtitle,stats_json,passives,gold,tier,icon_url,tips) '
                         'VALUES (?,?,?,?,?,?,?,?)',
                         (nm, it['subtitle'], json.dumps(it['stats']), it['text'],
                          it['gold'], '', it['icon_url'], ''))
    for nm, rd in d['rune_defs'].items():
        conn.execute('REPLACE INTO runes(name,subtitle,text,parsed_json,icon_url) VALUES (?,?,?,?,?)',
                     (nm, rd['subtitle'], rd['text'], json.dumps(parse_rune(rd['text'])), rd['icon_url']))


# ------------------------------------------------------------ rune parse ------
def parse_rune(text):
    """Extract damage value / cooldown from rune tooltip text."""
    out = {}
    dm = re.search(r'Damage value:\s*([\d.]+)\s*-\s*([\d.]+)', text, re.I)
    if dm:
        out['dmgMin'] = float(dm.group(1))
        out['dmgMax'] = float(dm.group(2))
    ratios = []
    for rm in re.finditer(r'([\d.]+)\s*%\s*(extra|bonus)?\s*\{(AP|AD|HP)\}', text):
        stat = rm.group(3)
        if rm.group(2):
            stat = 'bonus' + stat
        ratios.append({'pct': float(rm.group(1)), 'stat': stat})
    if ratios:
        out['ratios'] = ratios
    cm = re.search(r'Cooldown:\s*([\d.]+)\s*-?\s*([\d.]+)?s', text, re.I)
    if cm:
        out['cdMax'] = float(cm.group(1))
        out['cdMin'] = float(cm.group(2)) if cm.group(2) else float(cm.group(1))
    return out


# ------------------------------------------------------------ items page ------
def scrape_items_page(conn):
    html = get_page(conn, BASE + '/items/')
    soup = BeautifulSoup(html, 'html.parser')
    count = 0
    for name_b in soup.find_all('b', class_='iname'):
        ptag = name_b.find_parent('p')
        if not ptag:
            continue
        name = name_b.get_text(strip=True)
        sub = name_b.find_next_sibling('b', class_='cdr')
        subtitle = sub.get_text(strip=True) if sub else ''
        stats = [normalize(st) for st in ptag.find_all('b', class_='istats')]
        passives = normalize(ptag)
        gold = None
        gm = ptag.find('b', class_='goldt')
        if gm:
            digits = re.sub(r'\D', '', gm.get_text())
            gold = int(digits) if digits else None
        holder = ptag.find_parent(class_=re.compile('ico-holder|bild-img-short'))
        icon = ''
        if holder:
            img = holder.find('img')
            if img:
                icon = img.get('data-src') or img.get('src') or ''
        tier = ''
        if holder:
            ench = holder.select_one('.enchant')
            if ench:
                tier = ench.get_text(strip=True)
        tips = ''
        tm = re.search(re.escape(name) + r'\s*TIPS:\s*(.+)', passives, re.S)
        if tm:
            tips = tm.group(1).strip()
        if not icon:  # keep icon already captured from champion-page tooltips
            row = conn.execute('SELECT icon_url FROM items WHERE name=?', (name,)).fetchone()
            if row and row[0]:
                icon = row[0]
        conn.execute('REPLACE INTO items(name,subtitle,stats_json,passives,gold,tier,icon_url,tips) '
                     'VALUES (?,?,?,?,?,?,?,?)',
                     (name, subtitle, json.dumps(stats), passives, gold, tier, icon, tips))
        count += 1
    conn.commit()
    print(f'items page: {count} item entries')


# ------------------------------------------------------------- discovery ------
ROLE_PAGES = ['assassins', 'fighters', 'mages', 'marksmen', 'supports', 'tanks']


def discover_champions(conn):
    urls = set()
    for cat in ROLE_PAGES:
        try:
            html = get_page(conn, f'{BASE}/{cat}/')
            urls |= set(re.findall(r'href="(https://wr-meta\.com/\d+-[a-z0-9-]+\.html)"', html))
        except Exception as e:
            print(f'  role page {cat}: {e}')
    # sitemap fallback / supplement
    for sm_url in [BASE + '/sitemap.xml']:
        try:
            xml = fetch(sm_url)
            locs = re.findall(r'<loc>(https://wr-meta\.com/[^<]+)</loc>', xml)
            subs = [u for u in locs if u.endswith('.xml')]
            pages = [u for u in locs if re.match(r'https://wr-meta\.com/\d+-[a-z0-9-]+\.html$', u)]
            urls |= set(pages)
            for s in subs[:20]:
                try:
                    x2 = fetch(s)
                    urls |= set(re.findall(r'<loc>(https://wr-meta\.com/\d+-[a-z0-9-]+\.html)</loc>', x2))
                except Exception:
                    pass
        except Exception as e:
            print(f'  sitemap: {e}')
    return sorted(urls, key=lambda u: int(re.search(r'/(\d+)-', u).group(1)))


# --------------------------------------------------------------- icons --------
def download_icons(conn, workers=8):
    urls = set()
    for (u,) in conn.execute('SELECT portrait_url FROM champions'):
        if u:
            urls.add(u)
    for (u,) in conn.execute('SELECT icon_url FROM abilities'):
        if u:
            urls.add(u)
    for (u,) in conn.execute('SELECT icon_url FROM items'):
        if u:
            urls.add(u)
    for (u,) in conn.execute('SELECT icon_url FROM runes'):
        if u:
            urls.add(u)
    have = {u for (u,) in conn.execute('SELECT url FROM icons')}
    todo = sorted(urls - have)
    print(f'icons: {len(todo)} to download ({len(have)} cached)')

    def grab(u):
        full = u if u.startswith('http') else BASE + u
        r = session.get(full, timeout=30)
        r.raise_for_status()
        return u, r.content, r.headers.get('Content-Type', '')

    ok = err = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(grab, u): u for u in todo}
        for f in as_completed(futs):
            try:
                u, data, ct = f.result()
                conn.execute('REPLACE INTO icons VALUES (?,?,?)', (u, data, ct))
                ok += 1
                if ok % 100 == 0:
                    conn.commit()
                    print(f'  {ok}/{len(todo)}')
            except Exception as e:
                err += 1
                print(f'  icon fail {futs[f]}: {e}')
    conn.commit()
    print(f'icons done: {ok} ok, {err} failed')


# ----------------------------------------------------------------- main -------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--test', action='store_true')
    ap.add_argument('--reparse', action='store_true')
    ap.add_argument('--icons-only', action='store_true')
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()

    conn = db_connect()

    if args.icons_only:
        download_icons(conn)
        return

    if args.reparse:
        rows = conn.execute("SELECT url, html_gz FROM pages WHERE url LIKE '%.html'").fetchall()
        print(f'reparsing {len(rows)} cached champion pages')
        for url, gz in rows:
            html = gzip.decompress(gz).decode('utf-8')
            try:
                d = parse_champion(html, url)
                save_champion(conn, d)
            except Exception as e:
                print(f'  parse fail {url}: {e}')
        conn.commit()
        scrape_items_page(conn)
        return

    if args.test:
        champ_urls = [BASE + '/1-ahri.html', BASE + '/4-zed.html',
                      BASE + '/47-jinx.html', BASE + '/36-malphite.html']
    else:
        champ_urls = discover_champions(conn)
        print(f'discovered {len(champ_urls)} champion pages')
    if args.limit:
        champ_urls = champ_urls[:args.limit]

    for i, url in enumerate(champ_urls, 1):
        try:
            html = get_page(conn, url)
            d = parse_champion(html, url)
            save_champion(conn, d)
            conn.commit()
            print(f'[{i}/{len(champ_urls)}] {d["name"]} ({d["lane"]}) '
                  f'abilities={len(d["abilities"])} build={len(d["builds"])} runes={len(d["runes"])}')
        except Exception as e:
            print(f'[{i}/{len(champ_urls)}] FAIL {url}: {e}')

    scrape_items_page(conn)
    download_icons(conn)
    conn.commit()
    n = conn.execute('SELECT COUNT(*) FROM champions').fetchone()[0]
    ni = conn.execute('SELECT COUNT(*) FROM items').fetchone()[0]
    nr = conn.execute('SELECT COUNT(*) FROM runes').fetchone()[0]
    nc = conn.execute('SELECT COUNT(*) FROM icons').fetchone()[0]
    print(f'DB: {n} champions, {ni} items, {nr} runes, {nc} icons -> {DB_PATH}')


if __name__ == '__main__':
    main()
