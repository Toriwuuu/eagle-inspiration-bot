# Eagle 靈感庫自動更新機器人

每週自動從 [Awwwards](https://www.awwwards.com) 抓取 SOTD（Site of the Day）的設計靈感，存進你的 Eagle 收藏夾，並標好分類 tag。

## 它做什麼

- 用無頭瀏覽器（Playwright）開 Awwwards 列表頁
- 攔截每個作品頁面的 `.mp4` 預覽影片（就是你用 Chrome Eagle 插件拖拉的同一個檔案）
- 若該作品沒有影片，自動退回抓 hero JPG
- 透過 Eagle 的本機 API 寫入指定資料夾，附帶標題、工作室、live URL、tag、註記
- 自動去重：已存在的作品（依 live URL 比對）會跳過
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

### 4. 安裝每週排程

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
  "source": "sotd",
  "maxSites": 7,
  "elementsPerSite": 3,
  "eagleFolderName": "Awwwards",
  "extraTags": ["awwwards", "sotd"],
  "skipIfLiveUrlExists": true
}
```

| 參數 | 說明 |
|---|---|
| `maxSites` | 每次最多抓幾個 SOTD 作品（預設 7 ＝ 一週份） |
| `elementsPerSite` | 每個作品最多抓幾個 element 預覽影片（預設 3）。每個 element 是一個獨立的 .mp4 設計細節（如 header 動畫、product page、scroll interaction）。設成 1 = 每個作品只存代表元素，設成 10 = 幾乎全收 |
| `eagleFolderName` | Eagle 裡的目標資料夾名稱（找不到會自動建立） |
| `extraTags` | 每筆作品都會額外加上的 tag |
| `skipIfLiveUrlExists` | `true` 跳過已存在的作品（依 live website URL 比對；只要該作品有任何 element 已收過，整個作品就跳過） |

**抓取規則**：
- 對每個 SOTD：抓出該作品在 Awwwards 頁面上的所有 element 預覽影片（.mp4），最多取前 `elementsPerSite` 個
- 若該作品沒有任何 element（少數情況），fallback 抓 hero JPG 主視覺
- 每個 element 在 Eagle 內名稱會是「作品名 - element 描述」（例：`Floema - Homepage Header`）

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

**Q: 所有作品都被歸成「圖片」沒影片？**
A: 把 `videoWaitTimeoutMs` 調大（例如 15000），或者單次手動跑 `node bot.js` 看 log 是不是 Awwwards 改版了。

**Q: 想加 Behance / Dribbble / Pinterest？**
A: 仿照 `bot.js` 內 `fetchListing` + `fetchDetail` 的結構，新增類似函式即可。下個版本會加。

---

## 檔案結構

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
