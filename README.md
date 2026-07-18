# Wild Rift 出裝符文比較網站

從 [wr-meta.com](https://wr-meta.com) 抓取英雄／出裝／符文／物品資料，
選擇英雄後可編排多組「出裝順序＋符文」方案，依經濟時間軸模擬
「接完一整套 combo」對平均脆皮與坦克的收益曲線，協助判斷最佳出裝。

## 使用

直接雙擊 `docs/index.html`（或執行 `start.bat`）即可，不需要伺服器。

- 首頁選英雄（可搜尋英文名）
- 「方案 A（推薦）」預設為 wr-meta 的推薦完整出裝與符文
- 「＋複製為新方案」後調整出裝順序／符文／combo，即可在圖表中疊線比較
- 圖表 X 軸為遊戲時間，圓點＝完成一件裝備；hover 可看細節
- 可切換「以目標血量百分比顯示」（100% 虛線＝可秒殺）
- 方案會自動存在瀏覽器 localStorage（依英雄分開記錄）

## 資料維護

所有爬取結果存在 `wildrift.sqlite`（含原始頁面 HTML 快取與 icon 圖檔 BLOB）。

```
python scraper/scrape.py            # 重新爬取全部（新版本更新時）
python scraper/scrape.py --test     # 只爬 4 隻測試
python scraper/scrape.py --reparse  # 不連網，用 DB 內快取的 HTML 重新解析（改 parser 後用）
python scraper/scrape.py --icons-only  # 只補抓缺少的 icon
python scraper/export_site.py       # 匯出 docs/data.js + docs/icons/
```

需求：Python 3 + `requests` + `beautifulsoup4`。

### SQLite 結構

| 表 | 內容 |
|---|---|
| `pages` | 每頁原始 HTML（gzip），可離線重解析 |
| `champions` | 英雄基礎屬性（1級值＋每級成長）、路線、版本 |
| `abilities` | 技能敘述、CD、耗魔、解析出的傷害公式 JSON |
| `champion_builds` | 各區段出裝（Start/Core/Boots/Example build/Situational） |
| `champion_runes` / `champion_spells` | 推薦符文／召喚師技能 |
| `items` | 物品屬性、價格、被動敘述、icon |
| `runes` | 符文敘述與解析出的傷害數值 |
| `icons` | 所有圖檔 BLOB（url 為 key） |

## 計算模型（近似假設）

- 經濟：`金錢 = 500 + GPM × 分鐘`（GPM 可調，預設 680）；出裝依順序累積購買
- 等級曲線：內建近似表（約 18.5 分到 15 級），技能加點依「主升」優先序，R 於 5/9/13
- 傷害：解析 wr-meta 技能敘述中的 `(基礎/每級 + 係數% 屬性)` 公式；
  魔法／物理傷害依目標抗性減免（含穿透），真實傷害直加；平 A 以暴擊期望值計
- 符文：有傷害數值的（如 Electrocute）依等級線性內插並套用適應之力
- 裝備特效：咒刃（Lich Bane / Trinity Force / Sheen）、Blackfire Torch 燃燒、
  Luden's Echo 為近似值，可整體關閉；Rabadon +40% AP 有計入
- 目標假人：脆皮／坦克血量與雙抗隨時間成長（脆皮少量防裝、坦克大量防裝）
- 無法解析的敘述段（例如 % 血量處決、Zed R 這類複雜結算）不會列入，
  可在「傷害組成」勾選處確認實際計入哪些部分

