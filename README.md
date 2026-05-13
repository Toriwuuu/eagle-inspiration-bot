# Eagle 靈感庫自動更新機器人

每週自動從多個來源抓取設計靈感，存進你的 Eagle 收藏夾。內建 Web dashboard 讓你視覺化編輯設定、月報自動產生。

## 它做什麼

**Awwwards**（無頭瀏覽器抓 .mp4 預覽影片）：
- SOTD（Site of the Day）：每天 1 個精選
- Nominees：每天 ~20 個提名作品，週中跑也常有新東西

**Mobbin**（持久化登入瀏覽器，跟 Chrome Eagle 插件拖拉行為一致）：
- Latest feed：每個 app 抓 1 個 flow 預覽 + 進細節頁額外抓 N-1 個 micro-animation
- 分類輪換：每週用 ISO 週數 modulo 自動換 2 個分類（Health & Fitness / Travel / Lifestyle…）
- 自動去重（依 video stableId UUID）

**Godly.website**：策展型 web design gallery，hero `.mp4` 直連、不需登入

**Land-book**：靜態網頁設計圖庫，首頁卡片含高解析縮圖（純圖片來源）

**功能**：
- macOS 桌面通知：跑完跳「本週新增 X 筆」
- 黑名單：keyword / app / category 自動 skip
- 失敗 retry：HEAD fail 的 URL 下次跑開頭重試一次
- 主題手動觸發：`node bot.js --search onboarding 10` 隨時抓特定主題
- 月報生成：`node bot.js --report 2026-05` dump markdown 月度統計，每月跑時自動生成上月
- Web dashboard：`node bot.js --config-ui` 開 localhost:3030 視覺化編輯 config

**排程**：透過 macOS launchd 每週自動執行

---

## 安裝步驟

### 1. 前置需求

- Mac 上安裝好 [Eagle](https://eagle.cool) 並開啟
- Eagle 設定中啟用 **MCP plugin**（讓 Eagle 本機 API 服務跑在 port 41596）
- 已安裝 [Node.js](https://nodejs.org)（v18 以上）

### 2. 安裝依賴

```bash
cd "/Users/ching-wu/Desktop/sildeproject/eagle inspiration bot"
npm install
```

`npm install` 會自動跑 `playwright install chromium`，下載一份無頭 Chromium（約 170MB，**一次性**）。

### 3. 手動測試一次

```bash
node bot.js
```

成功的話會看到類似：

```
[2026-05-13 14:30:00] === Eagle Inspiration Bot 啟動 ===
[2026-05-13 14:30:01] ✓ 找到資料夾「Awwwards」(id=...)
[2026-05-13 14:30:03] 找到 7 個 SOTD 細節頁
[2026-05-13 14:30:05] [1/7] https://www.awwwards.com/sites/floema
[2026-05-13 14:30:08]   作品：Floema
[2026-05-13 14:30:08]   網站：https://www.floema.com/en
[2026-05-13 14:30:08]   找到 7 個 element
[2026-05-13 14:30:09]   ✓ 已加入 3 筆
...
[2026-05-13 14:31:00] === 執行結果 ===
[2026-05-13 14:31:00] 新增 18 筆（影片 16、圖片 2）
```

打開 Eagle，應該會看到「Awwwards」資料夾裡多了當週的靈感。

### 4. Mobbin 首次登入（一次性）

```bash
node bot.js --setup-mobbin
```

會發生什麼：
1. 跳出一個 Chrome 視窗（**獨立 profile**，看不到你日常 Chrome 的書籤/分頁）
2. 在裡面登入 Mobbin（用你平常用的 Google 帳號）
3. 登入完成後**不用回 terminal 按 Enter**，bot 會自己偵測到登入並關閉瀏覽器，把 session 存到 `~/.eagle-bot/mobbin-profile/`
4. 接著自動跑「結構勘查」dump 到 `logs/mobbin-structure.json`（之後 debug 用）

之後每週自動跑時就完全不用再登入，bot 用 headless 模式靜悄悄地用同一個 session 抓資料。**如果某天 Mobbin 把你登出，重跑這個指令一次即可**。

### 5. 安裝每週排程

```bash
chmod +x install-schedule.sh
./install-schedule.sh
```

預設：**每週一早上 9:00 自動執行**。Eagle 必須是開啟狀態（不然會 log 失敗）。

---

## 調整參數

打開 `config.json`：

```json
{
  "notifyOnFinish": true,
  "awwwards": {
    "enabled": true,
    "eagleFolderName": "Awwwards",
    "extraTags": ["awwwards"],
    "elementsPerSite": 4,
    "skipIfLiveUrlExists": true,
    "sources": [
      { "type": "sotd",     "enabled": true, "maxSites": 7 },
      { "type": "nominees", "enabled": true, "maxSites": 10 }
    ]
  },
  "mobbin": {
    "enabled": true,
    "platform": "ios",
    "eagleFolderName": "Mobbin",
    "extraTags": ["mobbin"],
    "skipIfSourceUrlExists": true,
    "feeds": [
      { "type": "latest", "enabled": true, "maxApps": 5, "screensPerApp": 3 },
      {
        "type": "category",
        "enabled": true,
        "categories": ["Health & Fitness","Travel & Transportation","Lifestyle","Shopping","Food & Drink","Finance","Productivity"],
        "categoriesPerRun": 2,
        "maxAppsPerCategory": 3
      }
    ]
  },
  "blocklist": {
    "awwwardsKeywords": [],
    "mobbinApps": [],
    "mobbinCategories": []
  }
}
```

### 全域

| 參數 | 說明 |
|---|---|
| `notifyOnFinish` | 跑完跳 macOS 桌面通知顯示新增筆數。預設 `true` |

### Awwwards 區段

| 參數 | 說明 |
|---|---|
| `enabled` | 設成 `false` 停用整個 Awwwards 流程 |
| `elementsPerSite` | 每個作品最多抓幾個 element 預覽影片（預設 4）|
| `skipIfLiveUrlExists` | 跳過已存在的作品（依 live website URL 比對）|
| `sources[]` | 來源陣列。每個來源獨立 enabled / maxSites |
| └ `type: "sotd"` | Site of the Day — 每天 1 個精選，列表頁固定最近 7 天 |
| └ `type: "nominees"` | Nominees — 所有提名作品，每天有大量新提名進來，週中跑也常有新東西 |

### Mobbin 區段

| 參數 | 說明 |
|---|---|
| `enabled` | 設成 `false` 停用整個 Mobbin 流程 |
| `platform` | `"ios"` 或 `"web"` |
| `skipIfSourceUrlExists` | 跳過已存在的 flow（依 mobbin video stableId UUID 比對）|
| `feeds[]` | feed 陣列。每個 feed 獨立 enabled |
| └ `type: "latest"` | 全平台 latest feed，固定那幾筆 |
| └ `type: "category"` | 分類輪換：bot 用本週 ISO 週數 modulo 從 `categories[]` 挑 `categoriesPerRun` 個分類，每週自動換不重複 |

### 黑名單

| 參數 | 說明 |
|---|---|
| `awwwardsKeywords` | 作品標題 / live URL 含這些 keyword（不分大小寫）的就 skip |
| `mobbinApps` | 這些 app 名稱的 flow 一律 skip |
| `mobbinCategories` | 這些分類即使輪到也跳過 |

### 失敗 retry

mp4 下載前的 HEAD 驗證若失敗，會記到 `~/.eagle-bot/failed-urls.json`，下次 bot 跑時開頭自動重試一次；再失敗就 drop（不會無限累積）。

改完不需重啟，下次跑 `node bot.js` 或排程觸發時即生效。

---

## CLI 指令一覽

```bash
node bot.js                       # 跑全部來源（Awwwards + Mobbin + Godly + Land-book）
node bot.js --setup-mobbin        # 首次設定 Mobbin 登入
node bot.js --probe-mobbin        # 重新勘查 mobbin 頁面結構
node bot.js --search onboarding 10   # 按主題搜尋 mobbin，存 10 筆進 Eagle
node bot.js --search "Subscription & Paywall" 5   # 直接傳 mobbin pattern 名稱
node bot.js --report              # 生成上月月報
node bot.js --report 2026-04      # 生成指定月份月報
node bot.js --config-ui           # 啟動本機 dashboard（localhost:3030）
```

### 主題搜尋 alias

`--search` 後可用以下別名（會自動對應到 mobbin 官方 pattern）：

`onboarding` / `welcome` / `signup` / `login` / `signin` / `paywall` / `subscription` / `payment` / `checkout` / `profile` / `settings` / `search` / `notification`

或直接傳 mobbin 官方 pattern 名稱（例 `"Empty State"`、`"Filters & Sorting"` 等）。

---

## Web Dashboard

兩種啟動方式：

**雙擊版（推薦）**：直接雙擊專案資料夾裡的 `dashboard.command`，會自動開終端機 + 瀏覽器。用完按 Ctrl-C 或關掉終端機視窗即可。

**指令版**：

```bash
node bot.js --config-ui
```

兩種方式都會開瀏覽器到 `http://localhost:3030`，可以：
- 開關每個來源（Awwwards / Mobbin / Godly / Land-book）
- 調整 maxSites / maxApps 等所有參數
- 編輯黑名單清單
- 看當前 Mobbin session 狀態、失敗 URL 數量、ISO 週數
- **縮圖牆預覽**：近 3/7/14/30 天的新增 items，影片 hover 自動播放
- **即時月報**：當月統計（無需等到月底自動生成）

設定改完按右下「儲存設定」會寫回 `config.json`，下次 bot 跑時即生效。按 Ctrl-C 結束 dashboard。

---

## 月報

每次 bot 跑時若上個月的月報還沒生成過，會自動產出到 `logs/monthly-YYYY-MM.md`。也能手動跑：

```bash
node bot.js --report 2026-04
```

月報內容：
- 本月總筆數、影片 vs 圖片比例
- 來源比例（Awwwards / Mobbin / Godly）
- Awwwards 細分（SOTD vs Nominees）
- Mobbin Top 5 apps、分類分布
- 樣本前 8 筆

---

## 改排程時間

編輯 `com.user.eagle-inspiration.plist.template`，找這段：

```xml
<key>StartCalendarInterval</key>
<dict>
    <key>Weekday</key>     <!-- 0=週日, 1=週一, ..., 6=週六 -->
    <integer>1</integer>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
</dict>
```

改完後重新跑 `./install-schedule.sh` 即可。

---

## 移除排程

```bash
./uninstall-schedule.sh
```

---

## 看 log

```bash
tail -f logs/bot.log
```

---

## 排程相關指令

```bash
# 查看排程是否已載入
launchctl list | grep eagle-inspiration

# 立即觸發一次（不等到下次排程時間）
launchctl start com.user.eagle-inspiration
```

---

## 常見問題

**Q: 跑出來說 Eagle 連線失敗？**
A: 確認 Eagle App 開著、且 MCP plugin 啟用。可以用以下指令驗證：
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:41596/api/tools/call -H "Content-Type: application/json" -d '{"tool":"get_app_info","params":{}}'
```
回傳 `200` 即正常。

**Q: Mobbin 流程提示「session 失效」？**
A: 重跑 `node bot.js --setup-mobbin` 重新登入。Mobbin 通常不會頻繁登出，但偶爾會（換密碼、清 cookies、太久沒用等）。

**Q: Mobbin 流程跑出來 mp4 HEAD 不正常？**
A: 偶發。bot 已內建防護 — 對每個 mp4 URL 先發 HEAD 驗證 content-type 是 `video/*` 才寫入 Eagle。若全部都 fail，可能是你的網路擋了 `bytescale.mobbin.com` 或 mobbin 改 URL 結構。

**Q: 想加 Behance / Dribbble / Pinterest？**
A: 仿照 `bot.js` 內 `fetchAwwwardsListing` + `fetchAwwwardsDetail` 或 `fetchMobbinFlows` 的結構，新增類似函式即可。

**Q: Mobbin 我想抓特定 app（不是 latest）怎麼辦？**
A: 目前 `source` 只支援 `"latest"`。要抓特定 app 需要進入 `/apps/<app-slug>/screens` 路徑並修改 `fetchMobbinFlows`。歡迎告訴我你的需求。

---

## 檔案結構

**外部資料**：
- `~/.eagle-bot/mobbin-profile/` — Mobbin 持久化登入 session（cookies + localStorage）

```
eagle inspiration bot/
├── bot.js                              # 主程式
├── config.json                         # 使用者可調參數
├── package.json                        # 依賴：playwright
├── com.user.eagle-inspiration.plist.template  # launchd 排程範本
├── install-schedule.sh                 # 安裝排程
├── uninstall-schedule.sh               # 移除排程
├── README.md                           # 本文件
└── logs/
    └── bot.log                         # 執行紀錄（自動產生）
```
