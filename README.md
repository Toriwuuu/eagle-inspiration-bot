# Eagle 靈感庫自動更新機器人

每週自動從 4 個設計來源抓靈感存進 Eagle，內建 Web Dashboard 讓你視覺化操作、即時手動觸發、看縮圖牆與月報。

> **完全沒寫過程式？** 不用怕，也不需要任何 AI 工具。直接看下面這節 → [給完全沒寫過程式的人：從零開始的完整教學](#給完全沒寫過程式的人從零開始的完整教學)。跟著一步步做，大約 15 分鐘就能跑起來。

---

## 抓哪些來源

| 來源 | 內容 | 媒體 | 備註 |
|---|---|---|---|
| **Awwwards** | SOTD（每日精選）+ Nominees（提名作品） | mp4 預覽影片 | 不用登入 |
| **Mobbin** | iOS App + Web 網頁的最新上架 + 分類（SaaS / AI / Health & Fitness…） | mp4 flow 影片 + animation | **需要登入**；Pro 帳號才看得到完整 flow |
| **Godly** | 策展 web design gallery | hero `.mp4` 或圖片 | 不用登入 |
| **Land-book** | 網頁設計圖庫首頁卡片 | 高解析縮圖 | 不用登入；Cloudflare 擋了一下下 |

---

## 主要功能

**Web Dashboard**（localhost:3030）
- 每個來源獨立 toggle 開關，關掉的卡片會自動收合
- **「只抓 XXX」按鈕**：每張卡片獨立手動觸發，跑前可調數量、可勾選要從哪些分類抓
- 手動抓取會「滾到湊夠新項目為止」 — 已抓過的自動跳過、繼續往下找
- 預過濾：進 detail 頁前先比對 Eagle 已存在的 URL，省下大量請求時間
- **縮圖牆**：近 3/7/14/30 天的新增 items，影片 hover 自動播放
- **「上次抓取」filter**：標出 + 只顯示最近一次跑抓到的；卡片左上角脈動紅點
- **即時月報**：當月統計，無需等到月底自動生成
- Mobbin 沒登入時會跳警告 banner 跟「立刻登入」按鈕，不用回 terminal 摸 CLI

**自動化**
- macOS launchd 排程，預設每週一 9:00
- 跑完跳 macOS 桌面通知顯示新增筆數
- 失敗 URL 自動 retry：HEAD fail 的下次跑開頭重試一次
- 月報：每月跑時自動生成上個月 markdown 統計

**進階**
- 黑名單：keyword / app / category 自動 skip
- 主題搜尋：`--search onboarding 10` 隨時抓特定 Mobbin pattern
- 每次 bot 啟動會打 `RunId` 進 annotation，dashboard 用來精準分組「上次抓取」

---

## 給完全沒寫過程式的人：從零開始的完整教學

這節是寫給「會用 Eagle、但從來沒打開過終端機、不會寫程式」的人。
照順序做，不用懂任何指令的意思，**複製貼上就好**。整個過程大約 15 分鐘，
電腦只要是 **Mac** 就行，**不需要 Claude、ChatGPT 或任何 AI**。

> 為什麼會用到「打指令」？因為這支工具沒有做成可以雙擊的 App。
> 你可以把終端機想成「用打字代替點按鈕」的視窗，跟著貼上就行，不會弄壞電腦。

---

### 步驟 0：先確認你有什麼

- 一台 **Mac**（macOS）
- 已經安裝好 **[Eagle](https://eagle.cool)**（就是你平常在收圖的那個 App）
- 大約 15 分鐘、和穩定的網路（中間要下載約 170MB 的東西）

---

### 步驟 1：認識「終端機」（Terminal）

終端機是 Mac 內建的一個 App，長得像一個黑底或白底、可以打字的視窗。

**怎麼打開：**

1. 按鍵盤右上角的 **放大鏡圖示**（或按 `Command + 空白鍵`）打開 Spotlight 搜尋
2. 輸入 **`Terminal`**（或中文「終端機」）
3. 按 `Enter`，會跳出一個可以打字的視窗

> 之後所有「請在終端機輸入」的步驟，都是：把指令複製 → 貼到這個視窗 → 按 `Enter`。
> 貼上的方式是 `Command + V`，跟你平常貼上文字一樣。

---

### 步驟 2：安裝 Node.js（這支工具的「引擎」）

這支工具是用 Node.js 寫的，所以電腦要先有 Node.js 才能跑它。

1. 打開瀏覽器，到 **[https://nodejs.org](https://nodejs.org)**
2. 點畫面上**左邊那顆綠色按鈕**（標示 **LTS**，代表長期穩定版）下載
3. 下載完打開那個 `.pkg` 安裝檔，像裝一般 App 一樣**一直按「繼續」→「同意」→「安裝」**到結束
4. 裝完，回到**終端機**，貼上這行按 Enter 確認裝好了：

```bash
node -v
```

> 如果出現類似 `v20.11.0` 這種版本號，就代表成功了。
> 如果出現 `command not found`，把終端機**整個視窗關掉、重新打開**再試一次（剛裝好需要重開才生效）。

---

### 步驟 3：把這個專案下載到電腦

最簡單的方式（不用懂 git）：

1. 打開這個專案的 GitHub 頁面：
   **[github.com/Toriwuuu/eagle-inspiration-bot](https://github.com/Toriwuuu/eagle-inspiration-bot)**
2. 點頁面右上方綠色的 **`< > Code`** 按鈕
3. 選最下面的 **`Download ZIP`**
4. 下載完，在「下載項目」資料夾找到那個 zip，**double-click 解壓縮**
5. 把解壓出來的資料夾**拖到你好找的地方**，例如桌面

> 解壓後的資料夾名字可能是 `eagle-inspiration-bot-main`，沒關係，名字不影響使用。

---

### 步驟 4：用終端機「進入」這個資料夾

終端機需要知道你要操作哪個資料夾。有個不用打路徑的偷吃步：

1. 在終端機先打 **`cd`**，然後**多打一個空白鍵**（`cd ` 後面有一格空白）
2. 打開 **Finder**，找到剛剛解壓的那個專案資料夾
3. 把那個**資料夾直接用滑鼠拖進終端機視窗**放開 —— 它會自動把路徑填進去
4. 回到終端機按 `Enter`

整行看起來會像這樣（你的路徑會不一樣，那是正常的）：

```bash
cd /Users/你的名字/Desktop/eagle-inspiration-bot-main
```

> 怎麼確認進對地方了？貼上 `ls` 按 Enter，如果看到 `bot.js`、`README.md`、`dashboard.command` 這些檔名，就對了。

---

### 步驟 5：安裝它需要的東西

在終端機（確定還在步驟 4 那個資料夾裡）貼上這行，按 Enter：

```bash
npm install
```

> 它會開始下載一堆東西，畫面會一直跑文字、跑進度條，**這是正常的，請耐心等**。
> 其中包含一個約 170MB 的瀏覽器（Chromium），只下載這一次。
> 等到游標停下來、又出現可以打字的提示符號，就代表裝完了。
> 過程中出現黃色的 `warn` 字樣可以忽略；只有大片**紅色 `error`** 才是真的出問題。

---

### 步驟 6：打開 Eagle

很簡單：**把 Eagle App 打開、讓它開著就好**，不用設定什麼，也不用裝任何外掛。
這支工具會自動跟 Eagle 溝通、把靈感存進去。

---

### 步驟 7：啟動控制台（Dashboard）

這是你之後**主要會用的畫面**，所有操作都在這裡點按鈕，不用再碰終端機。

**方法 A（最簡單）：** 在 Finder 裡找到專案資料夾內的 **`dashboard.command`**，**double-click 它**。

> **第一次雙擊可能被 Mac 擋住**，這很常見，不是壞掉：
> - 如果跳出「**無法打開，因為來自未識別的開發者**」或「Apple 無法檢查是否含惡意軟體」：
>   對著 `dashboard.command` **按右鍵 → 選「打開」→ 在跳出的視窗再按一次「打開」**。之後就不會再問。
> - 如果雙擊後是用「文字編輯」打開、或終端機說 `permission denied`：
>   回終端機（步驟 4 那個資料夾）貼這行按 Enter，給它執行權限，再重試雙擊：
>   ```bash
>   chmod +x dashboard.command
>   ```

**方法 B：** 直接在終端機（步驟 4 那個資料夾）貼上：

```bash
node bot.js --config-ui
```

不管哪種方法，成功後瀏覽器會自動打開 **`http://localhost:3030`**，看到控制台畫面就成功了。

> 這個終端機視窗在你用控制台的期間**請保持開著**，關掉它就等於關掉控制台。用完再關。

---

### 步驟 8：第一次登入 Mobbin（只有 Mobbin 來源需要）

Awwwards、Godly、Land-book 三個來源不用登入就能抓。只有 **Mobbin** 要登入一次：

1. 在控制台上方，會看到「Mobbin 尚未登入」加一顆 **「立刻登入」** 按鈕（或 Mobbin 卡片裡有黃色提示），點它
2. 它會自動開一個**獨立的 Chrome 視窗**（不會動到你平常 Chrome 的書籤、帳號）
3. 你在那個視窗裡，用你的 Google 帳號**登入 Mobbin**
4. 登入完成它會自己關掉視窗，控制台的提示變成綠色「已登入」

> 之後都記住這次登入，不用每次重登。哪天被 Mobbin 登出，控制台會再提醒你點一次。
> （免費 Mobbin 帳號也能登，但大部分完整 flow 影片要 Pro 才看得到、才抓得到。）

---

### 步驟 9：抓一次看看

在控制台上：

- 右上角 **「立刻跑一次」** ＝ 四個來源全部抓一輪
- 每張來源卡片上的 **「只抓 XXX」** ＝ 只抓那一個來源，跑前還能調數量

點下去後，下方會即時跑出進度文字。跑完，打開你的 **Eagle**，就會看到
`Awwwards`、`Mobbin`、`Godly`、`Land-book` 這幾個資料夾裡多了新靈感。

到這裡你就完成了，**日常使用只要開 Eagle + 雙擊 `dashboard.command` 點按鈕即可**。

---

### 步驟 10（可選）：讓它每週自動幫你抓

如果想要它每週一早上 9:00 自動跑、完全不用管：

在終端機（步驟 4 那個資料夾）依序貼上這兩行，各按一次 Enter：

```bash
chmod +x install-schedule.sh
./install-schedule.sh
```

之後每週一 9:00（只要那時候電腦開著、Eagle 也開著）它就會自己抓、抓完跳桌面通知。
不想要了就跑 `./uninstall-schedule.sh` 取消。

---

### 卡關了？對照這張表

| 你看到的狀況 | 怎麼辦 |
|---|---|
| 打 `node -v` 說 `command not found` | Node.js 沒裝好，或裝完沒重開終端機。把終端機視窗關掉重開再試；還是不行就重裝步驟 2 |
| `npm install` 跑出大片紅色 error | 多半是網路問題。確認有網路，重跑一次 `npm install` |
| 雙擊 `dashboard.command` 用文字編輯打開 / 說 permission denied | 跑步驟 7 裡的 `chmod +x dashboard.command` 再重試 |
| 雙擊 `dashboard.command` 被 Mac 擋（未識別開發者） | 對它**按右鍵 → 打開 → 再按一次打開**（見步驟 7） |
| 控制台打不開、瀏覽器沒自動跳 | 手動在瀏覽器網址列輸入 `http://localhost:3030` |
| 跑的時候說「Eagle 連線失敗」 | Eagle App 沒開。把 Eagle 打開，再跑一次 |
| 終端機關掉後控制台就壞了 | 正常。控制台需要那個終端機視窗開著；要用就重新雙擊 `dashboard.command` |
| 一直顯示「找到 0 個 flow video」 | 多半是 Mobbin 免費帳號（完整影片要 Pro），或 Mobbin 被登出了，回控制台重登 |

> 如果表上沒有你的狀況，把終端機裡那段**紅色文字截圖**起來問人，會比較好幫你看。

---

## 安裝

> 下面是給「已經熟悉終端機」的人的精簡版。沒寫過程式請看上面那節。

### 前置需求

- macOS
- [Eagle](https://eagle.cool) App —— **開著就好,不需要裝任何 plugin**。Eagle 內建本機 API(port 41595)一啟動就有,bot 直接用它。
- [Node.js](https://nodejs.org) v18+

> 不需要 Claude、ChatGPT 或任何 AI 工具。這支 bot 是純 Node.js 程式,執行過程完全不碰 AI。任何有 Eagle 的人都能用。

### 1. 拿到專案 + 裝依賴

把整個資料夾複製到你電腦任意位置(或 `git clone`),用終端機 `cd` 進去後:

```bash
npm install
```

`npm install` 會自動下載 Playwright 的 Chromium（約 170 MB，一次性）。

### 2. 啟動 Dashboard

```bash
node bot.js --config-ui
```

或雙擊 `dashboard.command`。瀏覽器會自動開到 `http://localhost:3030`。

### 3. 第一次登入 Mobbin

打開 Dashboard → 上方狀態列會顯示「Mobbin 尚未登入」+「立刻登入」按鈕，或 Mobbin 卡片內會有黃色 banner → 點下去。

會發生什麼：
1. bot 開一個獨立 Chrome 視窗（不會碰到你日常 Chrome 的書籤）
2. 你在裡面用 Google 登入 Mobbin
3. 偵測到登入完成自動關閉視窗，session 存到 `~/.eagle-bot/mobbin-profile/`
4. Dashboard banner 變綠「✓ 已登入」

之後排程跑都用同一份 session，不用再登。被 Mobbin 登出時 dashboard 會偵測到並再次跳警告。

### 4. 跑一次試試

Dashboard 右上方有「立刻跑一次」全部跑，或每張卡片有「只抓 XXX」單獨跑。

或從 terminal：
```bash
node bot.js
```

### 5. 安裝每週排程（可選）

```bash
chmod +x install-schedule.sh
./install-schedule.sh
```

預設每週一 9:00 自動跑。Eagle 必須開著（不然會 log 失敗）。

---

## 每日使用

**全自動**：什麼都不用做，每週一 9:00 跑完看通知。

**想看看本週抓了什麼**：開 Dashboard → 縮圖牆。「上次抓取」pill 點下去只看本週新增。

**想多抓某類靈感**：
1. 開 Dashboard
2. 找到那個來源的卡片，點「只抓 XXX」
3. 調數量（例如想要 10 個新作品）
4. （Awwwards / Mobbin 可額外勾要從哪些分類抓）
5. 點「開始抓取」

bot 會在背景跑、log 即時顯示在 dashboard 下方。跑完縮圖牆會自動 refresh + 新項目脈動紅點標示。

---

## CLI 指令（進階）

```bash
node bot.js                                # 跑全部來源
node bot.js --only awwwards                # 只跑某一來源（awwwards / mobbin / godly / landbook）
node bot.js --only mobbin --manual-target 10  # 只跑 Mobbin，目標 10 個新項目
node bot.js --config-ui                    # 啟動 Dashboard（localhost:3030）
node bot.js --setup-mobbin                 # CLI 版 Mobbin 登入（一般用 Dashboard 即可）
node bot.js --probe-mobbin                 # 勘查 Mobbin 頁面結構（debug 用）
node bot.js --search onboarding 10         # 主題搜尋 Mobbin，存 10 筆
node bot.js --report                       # 生成上月月報
node bot.js --report 2026-04               # 生成指定月份月報
```

**主題搜尋 alias**：`onboarding` / `welcome` / `signup` / `login` / `paywall` / `subscription` / `payment` / `checkout` / `profile` / `settings` / `search` / `notification`，或直接傳 Mobbin 官方 pattern（`"Empty State"`、`"Filters & Sorting"`…）。

---

## config.json 結構

主要透過 Dashboard 調整，這裡列出底層結構供進階參考。

```json
{
  "notifyOnFinish": true,
  "schedule": { "frequency": "weekly", "weekday": 1, "hour": 9, "minute": 0 },

  "awwwards": {
    "enabled": true,
    "eagleFolderName": "Awwwards",
    "extraTags": ["awwwards"],
    "elementsPerSite": 4,
    "skipIfLiveUrlExists": true,
    "sources": [
      { "type": "sotd",     "enabled": true, "maxSites": 7  },
      { "type": "nominees", "enabled": true, "maxSites": 10 }
    ]
  },

  "mobbin": {
    "enabled": true,
    "platforms": ["ios", "web"],
    "eagleFolderName": "Mobbin",
    "extraTags": ["mobbin"],
    "skipIfSourceUrlExists": true,
    "feeds": [
      {
        "type": "category",
        "enabled": true,
        "categoriesByPlatform": {
          "ios": ["*", "Health & Fitness", "Travel & Transportation", "Lifestyle"],
          "web": ["*", "SaaS", "AI", "E-Commerce"]
        },
        "categoriesPerRun": 2,
        "maxAppsPerCategory": 3,
        "screensPerApp": 1
      }
    ]
  },

  "godly":    { "enabled": true, "eagleFolderName": "Godly",     "maxSites": 5, "extraTags": ["godly"],    "skipIfLiveUrlExists": true },
  "landbook": { "enabled": true, "eagleFolderName": "Land-book", "maxSites": 8, "extraTags": ["landbook"], "skipIfSourceUrlExists": true },

  "blocklist": { "awwwardsKeywords": [], "mobbinApps": [], "mobbinCategories": [] }
}
```

### 重點欄位

**Mobbin 來源池**：`categoriesByPlatform.ios` / `.web` 是每平台的「來源池」。每週用 ISO 週數從池子裡輪換 `categoriesPerRun` 個。特殊值 `"*"` 表示「全站最新」(不限分類，直接抓 `/discover/apps/{platform}/latest`)，跟其它分類混在同一個池子裡輪。

**Awwwards 來源**：`sources[]` 內每個 type（sotd / nominees）獨立 enabled + maxSites。

**黑名單**：
- `awwwardsKeywords` — 作品標題 / live URL 含這些字（不分大小寫）就 skip
- `mobbinApps` — 這些 app 名稱的 flow 一律 skip
- `mobbinCategories` — 這些分類即使輪到也跳過

**失敗 retry**：mp4 下載前的 HEAD 驗證失敗會記到 `~/.eagle-bot/failed-urls.json`，下次 bot 開頭自動重試一次；再失敗就 drop。

---

## 排程

### 改時間

編輯 `com.user.eagle-inspiration.plist.template`：

```xml
<key>StartCalendarInterval</key>
<dict>
    <key>Weekday</key>  <!-- 0=週日, 1=週一, ..., 6=週六 -->
    <integer>1</integer>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
</dict>
```

或直接在 Dashboard 的「排程」區塊調，按「儲存排程」會自動重灌。

改完跑 `./install-schedule.sh` 重新安裝。

### 移除

```bash
./uninstall-schedule.sh
```

### 排程相關

```bash
# 查看排程是否載入
launchctl list | grep eagle-inspiration

# 立刻觸發一次（不等到下次排程時間）
launchctl start com.user.eagle-inspiration
```

---

## 看 log

```bash
tail -f logs/bot.log
```

或開 Dashboard，「立刻跑一次 / 只抓 XXX」都會把 log 即時顯示在下方。

---

## 常見問題

**Q: Eagle 連線失敗？**
A: 確認 Eagle App 開著就好(不用裝 plugin)。驗證內建 API:
```bash
curl -s http://localhost:41595/api/application/info
```
回 `{"status":"success",...}` 即正常。沒回應就是 Eagle 沒開,或被防火牆擋了。

**Q: Eagle 不是裝在這台、或 port 被改過？**
A: 用環境變數覆寫,例如:
```bash
EAGLE_API_BASE=http://localhost:41595 node bot.js
```
若你在 Eagle 偏好設定有開 API token,加 `EAGLE_API_TOKEN=你的token`。一般預設沒開,可忽略。

**Q: Mobbin 跑出來 session 失效？**
A: Dashboard 上方狀態列會顯示「尚未登入」並跳警告，點「立刻登入」即可。

**Q: 免費 Mobbin 帳號能不能用？**
A: 能登入，但 Mobbin 大部分完整 flow 影片只有 Pro 才看得到、bot 也才抓得到。免費帳號跑起來 log 會顯示「找到 0 個 flow video」很多次。

**Q: Mobbin 跑出來 mp4 HEAD 不正常？**
A: 偶發。bot 對每個 mp4 先發 HEAD 驗證 content-type 是 `video/*` 才寫入 Eagle。若全部都 fail，可能是網路擋了 `bytescale.mobbin.com` 或 Mobbin 改 URL 結構。

**Q: 手動抓取很多次都湊不到目標數量？**
A: 表示這個來源最近大部分都已經在你 Eagle 裡。bot 預設最多滾 12 次列表頁找新項目；超過就停。可以等下一週新東西上來，或調降 manual target。

**Q: 想換排程改成每天？**
A: Dashboard「排程」區塊把「每週」改成「每天」，按儲存即可。底層用 macOS launchd。

**Q: 想加新來源（Behance / Dribbble / Pinterest）？**
A: 仿照 `bot.js` 內 `runAwwwardsFlow` / `runGodlyFlow` 的結構即可。每個 flow 主要做：抓 listing → 預過濾已存在的 URL → 進 detail 頁 → 寫進 Eagle。

---

## 檔案結構

```
eagle inspiration bot/
├── bot.js                              # 主程式（單檔，含 4 個來源 flow + dashboard server + 排程管理）
├── dashboard.html                      # Web Dashboard 介面（單檔靜態 HTML/CSS/JS）
├── dashboard.command                   # 雙擊啟動 dashboard（macOS）
├── config.json                         # 使用者可調參數
├── package.json                        # 依賴：playwright
├── com.user.eagle-inspiration.plist.template  # launchd 排程範本
├── install-schedule.sh                 # 安裝排程
├── uninstall-schedule.sh               # 移除排程
├── README.md                           # 本文件
└── logs/
    ├── bot.log                         # 執行紀錄
    ├── monthly-YYYY-MM.md              # 月報（每月自動產出）
    └── mobbin-structure.json           # Mobbin 結構勘查（debug 用）
```

**外部資料**：
- `~/.eagle-bot/mobbin-profile/` — Mobbin 持久化登入 session（cookies + localStorage）
- `~/.eagle-bot/failed-urls.json` — 失敗 URL 待重試清單

---

MIT License
