# Eagle 靈感庫自動更新機器人

每週自動從 [Awwwards](https://www.awwwards.com) + [Mobbin](https://mobbin.com) 抓取設計靈感，存進你的 Eagle 收藏夾，並標好分類 tag。

## 它做什麼

**Awwwards SOTD**：
- 用無頭瀏覽器（Playwright）開 Awwwards 列表頁
- 對每個作品抓多個 element 預覽 `.mp4`（就是你用 Chrome Eagle 插件拖拉的同一個檔案）
- 若該作品沒有影片，自動退回抓 hero JPG
- 自動去重：已存在的作品（依 live URL 比對）會跳過

**Mobbin Latest**：
- 用持久化登入的瀏覽器（你的 Mobbin session 存本機）開 `/discover/apps/ios/latest`
- 抓 N 個最新加入的 app，每個 app 的預覽 flow 影片
- 自動去重（依 flow stableId）

**共通**：
- 透過 Eagle 本機 API 寫入指定資料夾、附 tag、註記
- 透過 macOS launchd 每週自動執行

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
