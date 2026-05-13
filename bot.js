#!/usr/bin/env node
// Eagle 靈感庫自動更新機器人
// 兩個來源：
//   1. Awwwards SOTD —— 抓每個作品的 element 預覽影片
//   2. Mobbin —— 用持久化登入瀏覽器抓 mobile/web app 的 screens
//
// 用法：
//   node bot.js                  # 跑兩個流程
//   node bot.js --setup-mobbin   # 第一次設定 Mobbin（手動登入一次）
//   node bot.js --probe-mobbin   # 只跑 Mobbin 結構勘查（dump logs/mobbin-structure.json）

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// ---------- 設定區 ----------
const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const EAGLE_CLI = path.join(os.homedir(), '.claude/skills/eagle-skill/scripts/eagle-api-cli.js');
const LOGS_DIR = path.join(ROOT, 'logs');
const MOBBIN_PROFILE_DIR = path.join(os.homedir(), '.eagle-bot/mobbin-profile');

const AWWWARDS_BASE = 'https://www.awwwards.com';
const AWWWARDS_LIST_URL = `${AWWWARDS_BASE}/websites/sites_of_the_day/`;
const MOBBIN_BASE = 'https://mobbin.com';

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// ---------- 小工具 ----------
const log = (...args) => {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  console.log(`[${ts}]`, ...args);
};

const prompt = (q) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (ans) => {
      rl.close();
      resolve(ans);
    });
  });

// 呼叫 Eagle skill 的 CLI 並把 stdout 的 JSON 解析回來
function callEagle(tool, params) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [EAGLE_CLI, 'call', tool, '--json', JSON.stringify(params)]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Eagle CLI failed (${tool}): ${stderr.trim() || stdout.trim()}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Eagle CLI returned invalid JSON (${tool}): ${stdout.slice(0, 200)}`));
      }
    });
  });
}

// ---------- Eagle 資料夾 ----------
async function ensureFolder(name) {
  const tree = await callEagle('folder_get', { getAllHierarchy: true });
  const list = tree?.data || tree?.result || tree;
  const found = findFolderByName(list, name);
  if (found) {
    log(`✓ 找到資料夾「${name}」(id=${found.id})`);
    return found.id;
  }
  log(`建立新資料夾「${name}」…`);
  const created = await callEagle('folder_create', { folders: [{ name }] });
  const newFolder = (created?.data || created?.result || created)?.[0] || created;
  return newFolder.id || newFolder.folderId;
}

function findFolderByName(folders, name) {
  if (!Array.isArray(folders)) return null;
  for (const f of folders) {
    if (f.name === name) return f;
    const sub = findFolderByName(f.children || f.folders || [], name);
    if (sub) return sub;
  }
  return null;
}

// =====================================================================
//                          Awwwards 流程
// =====================================================================

async function openHeadlessBrowser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  return { browser, context };
}

async function fetchAwwwardsListing(context, max) {
  const page = await context.newPage();
  await page.goto(AWWWARDS_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const hrefs = await page.$$eval('a[href^="/sites/"]', (els) =>
    els.map((a) => a.getAttribute('href'))
  );
  await page.close();
  const unique = [...new Set(hrefs)].filter((h) => /^\/sites\/[a-z0-9-]+\/?$/i.test(h));
  return unique.slice(0, max).map((h) => AWWWARDS_BASE + h);
}

function posterToVideoUrl(posterUrl) {
  if (!posterUrl) return null;
  return posterUrl.replace(/_static\.(jpeg|jpg|png)$/i, '.mp4');
}

async function fetchAwwwardsDetail(context, detailUrl) {
  const page = await context.newPage();
  try {
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const data = await page.evaluate(() => {
      const get = (sel) => document.querySelector(sel)?.getAttribute('content') || null;
      const title =
        get('meta[property="og:title"]')?.replace(/\s*[-|]\s*Awwwards.*$/, '').trim() || null;
      const heroJpg = get('meta[property="og:image"]');

      const externalDomains = [
        'awwwards.com', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com',
        'linkedin.com', 'youtube.com', 'google.com', 'apple.com', 'gstatic.com',
      ];
      const isExternal = (href) =>
        href && /^https?:\/\//.test(href) && !externalDomains.some((d) => href.includes(d));

      let liveUrl = null;
      const anchors = Array.from(document.querySelectorAll('a'));
      for (const a of anchors) {
        const href = a.getAttribute('href');
        if (
          isExternal(href) &&
          (a.textContent.includes('Visit Website') ||
            a.textContent.includes('Visit Site') ||
            a.classList.contains('visit-website'))
        ) {
          liveUrl = href;
          break;
        }
      }
      if (!liveUrl) {
        for (const a of anchors) {
          const href = a.getAttribute('href');
          if (isExternal(href)) {
            liveUrl = href;
            break;
          }
        }
      }

      const siteSlug = location.pathname.match(/\/sites\/([^/]+)/)?.[1] || '';
      const videos = Array.from(document.querySelectorAll('video[data-poster]'));
      const elements = videos.map((v) => {
        const poster = v.getAttribute('data-poster');
        const anchor =
          v.closest('a[href*="/inspiration/"]') ||
          v.parentElement?.querySelector('a[href*="/inspiration/"]');
        let elementName = null;
        if (anchor) {
          const text = anchor.textContent.trim();
          if (text) {
            elementName = text;
          } else {
            const m = anchor.getAttribute('href')?.match(/\/inspiration\/(.+?)\/?$/);
            if (m) {
              let slug = m[1];
              if (siteSlug && slug.endsWith('-' + siteSlug)) {
                slug = slug.slice(0, -(siteSlug.length + 1));
              }
              elementName = slug.replace(/-/g, ' ');
            }
          }
        }
        return { poster, elementName };
      });

      return { title, heroJpg, liveUrl, elements };
    });

    const items = data.elements.map((el, i) => ({
      mediaUrl: posterToVideoUrl(el.poster),
      mediaType: 'video',
      name: el.elementName
        ? `${data.title} - ${el.elementName}`
        : `${data.title} - element ${i + 1}`,
    }));
    if (items.length === 0 && data.heroJpg) {
      items.push({
        mediaUrl: data.heroJpg,
        mediaType: 'image',
        name: data.title || detailUrl.split('/').pop(),
      });
    }

    return { title: data.title || detailUrl.split('/').pop(), liveUrl: data.liveUrl, detailUrl, items };
  } finally {
    await page.close();
  }
}

async function runAwwwardsFlow() {
  const cfg = CONFIG.awwwards;
  if (!cfg?.enabled) {
    log('Awwwards 流程：已停用，跳過');
    return;
  }

  log('\n========== Awwwards 流程 ==========');
  const folderId = await ensureFolder(cfg.eagleFolderName);
  const { browser, context } = await openHeadlessBrowser();
  const stats = { added: 0, skipped: 0, failed: 0, videoCount: 0, imageCount: 0 };

  try {
    log(`從 ${AWWWARDS_LIST_URL} 抓列表…`);
    const detailUrls = await fetchAwwwardsListing(context, cfg.maxSites);
    log(`找到 ${detailUrls.length} 個 SOTD 細節頁`);

    for (const [i, url] of detailUrls.entries()) {
      log(`\n[${i + 1}/${detailUrls.length}] ${url}`);
      try {
        const detail = await fetchAwwwardsDetail(context, url);
        log(`  作品：${detail.title}`);
        log(`  網站：${detail.liveUrl || '(找不到)'}`);
        log(`  找到 ${detail.items.length} 個 element`);

        if (cfg.skipIfLiveUrlExists && detail.liveUrl) {
          const exist = await callEagle('item_get', { url: detail.liveUrl, limit: 1 });
          const list = exist?.data || exist?.result || exist;
          if (Array.isArray(list) && list.length > 0) {
            log('  ⏭ Eagle 內已有此作品，跳過');
            stats.skipped++;
            continue;
          }
        }

        const itemsToAdd = detail.items.filter((it) => it.mediaUrl).slice(0, cfg.elementsPerSite);
        if (itemsToAdd.length === 0) {
          log('  ⚠ 沒有可用媒體，跳過');
          stats.failed++;
          continue;
        }

        const annotation = [
          `作品：${detail.title}`,
          detail.liveUrl ? `Live: ${detail.liveUrl}` : null,
          `Awwwards: ${detail.detailUrl}`,
          `抓取時間：${new Date().toISOString().slice(0, 10)}`,
        ].filter(Boolean).join('\n');

        await callEagle('item_add', {
          folders: [folderId],
          tags: cfg.extraTags,
          annotation,
          items: itemsToAdd.map((it) => ({
            source: {
              type: 'url',
              url: it.mediaUrl,
              website: detail.liveUrl || detail.detailUrl,
            },
            name: it.name,
          })),
        });

        log(`  ✓ 已加入 ${itemsToAdd.length} 筆`);
        stats.added += itemsToAdd.length;
        itemsToAdd.forEach((it) => {
          if (it.mediaType === 'video') stats.videoCount++;
          else stats.imageCount++;
        });
      } catch (e) {
        log('  ❌ 抓取失敗：', e.message);
        stats.failed++;
      }
    }
  } finally {
    await browser.close();
  }

  log(`\nAwwwards 結果：新增 ${stats.added} 筆（影片 ${stats.videoCount}、圖片 ${stats.imageCount}）／跳過 ${stats.skipped} 個作品／失敗 ${stats.failed}`);
}

// =====================================================================
//                          Mobbin 流程
// =====================================================================

// 開啟持久化瀏覽器 — setup 模式用 headless:false，自動模式用 headless:true
// 用系統真實 Chrome (channel: 'chrome') + 反偵測 args 繞過 Google 「不安全瀏覽器」攔截
async function openMobbinBrowser(headless) {
  if (!fs.existsSync(MOBBIN_PROFILE_DIR)) {
    fs.mkdirSync(MOBBIN_PROFILE_DIR, { recursive: true });
  }
  const context = await chromium.launchPersistentContext(MOBBIN_PROFILE_DIR, {
    headless,
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  // 抹掉 navigator.webdriver 痕跡（Google 用這個判斷自動化瀏覽器）
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return context;
}

// 檢查目前 session 是否仍是登入狀態。判斷依據：
// 進首頁後，URL 沒被導去 /login，且頁面內找得到登入後才有的元素（如用戶頭像）
async function isMobbinLoggedIn(context) {
  const page = await context.newPage();
  try {
    await page.goto(MOBBIN_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const currentUrl = page.url();
    // 判斷 1：URL 不該停在 /login 或含 sign-in 字樣
    if (/\/login|sign-in|signup/.test(currentUrl)) return false;
    // 判斷 2：頁面內找用戶相關元素（avatar、profile 連結、logout 按鈕）
    const loggedIn = await page.evaluate(() => {
      const tests = [
        document.querySelector('img[alt*="avatar" i]'),
        document.querySelector('a[href*="/profile"]'),
        document.querySelector('a[href*="/account"]'),
        document.querySelector('button[aria-label*="user" i]'),
        document.querySelector('[data-testid*="user" i]'),
        document.querySelector('[data-testid*="avatar" i]'),
      ];
      return tests.some(Boolean);
    });
    return loggedIn;
  } finally {
    await page.close();
  }
}

// 偵測是否已登入。Mobbin 特徵（實測）：
//   - 未登入：mobbin.com 顯示登入頁／導到 /login
//   - 已登入：mobbin.com 自動導向 /discover/apps/ios/latest，且頁面有 /saved 連結（個人收藏入口）
async function detectLogin(page) {
  try {
    const url = page.url();
    if (/\/login|sign-in|signup/i.test(url)) return false;
    if (/\/discover\//i.test(url)) return true; // 首頁被導到 /discover/... 就是登入了
    return await page.evaluate(() => {
      // /saved 路徑只有登入後才有
      return !!document.querySelector('a[href^="/saved"]');
    });
  } catch {
    return false;
  }
}

// First-run：開系統 Chrome（持久化 profile）讓使用者手動登入
// 不用 readline，改用 polling 偵測登入狀態，登入後 5 秒自動 close（兼容前景/背景模式）
async function setupMobbinSession() {
  log('=== Mobbin 首次設定 ===');
  log('將開啟你系統的 Chrome（獨立 profile，跟你日常的 Chrome 分開）');
  log('請在瀏覽器內登入 Mobbin（用你平常用的 Google 帳號）');
  log('登入成功後，bot 會自動偵測並關閉瀏覽器、儲存 session\n');

  const context = await openMobbinBrowser(false);
  const page = await context.newPage();
  await page.goto(MOBBIN_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Polling：每 3 秒檢查一次，總共最多等 6 分鐘
  const maxWaitMs = 6 * 60 * 1000;
  const pollIntervalMs = 3000;
  const startedAt = Date.now();
  let loggedIn = false;

  while (Date.now() - startedAt < maxWaitMs) {
    loggedIn = await detectLogin(page);
    if (loggedIn) break;
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsedSec % 30 === 0) {
      log(`  …等待登入（已等 ${elapsedSec}s / 360s）`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (loggedIn) {
    log('✓ 偵測到登入！再等 5 秒讓 cookies 寫入…');
    await new Promise((r) => setTimeout(r, 5000));
    log('✓ Session 已儲存到 ' + MOBBIN_PROFILE_DIR);
  } else {
    log('⚠ 等待超時（6 分鐘）。先存目前 session，登入若未完成下次跑 --probe-mobbin 會提示');
  }

  await context.close();
}

// Prober：勘查登入後 mobbin 的頁面結構，dump 到 logs/mobbin-structure.json
async function probeMobbinStructure() {
  log('=== Mobbin 頁面結構勘查 ===');
  const context = await openMobbinBrowser(true);
  const result = { probedAt: new Date().toISOString(), pages: {} };

  // 候選 URL — 看哪些可達、頁面長什麼樣
  const candidates = [
    { name: 'home', url: MOBBIN_BASE },
    { name: 'apps_ios_latest', url: `${MOBBIN_BASE}/apps/ios/latest` },
    { name: 'apps_ios', url: `${MOBBIN_BASE}/apps/ios` },
    { name: 'discover_ios', url: `${MOBBIN_BASE}/discover/ios` },
    { name: 'browse_ios', url: `${MOBBIN_BASE}/browse/ios/apps` },
    { name: 'apps_web', url: `${MOBBIN_BASE}/apps/web` },
  ];

  for (const c of candidates) {
    const page = await context.newPage();
    try {
      const resp = await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
      const info = await page.evaluate(() => {
        const sampleAnchors = Array.from(document.querySelectorAll('a[href]'))
          .slice(0, 30)
          .map((a) => ({ text: a.textContent.trim().slice(0, 60), href: a.getAttribute('href') }))
          .filter((a) => a.href);
        const imgs = Array.from(document.querySelectorAll('img[src]'))
          .slice(0, 10)
          .map((i) => ({ src: i.getAttribute('src')?.slice(0, 150), alt: i.alt?.slice(0, 60) }));
        const videos = Array.from(document.querySelectorAll('video'))
          .slice(0, 5)
          .map((v) => ({
            src: v.src || v.currentSrc,
            poster: v.getAttribute('poster'),
            sources: Array.from(v.querySelectorAll('source')).map((s) => s.src),
            dataAttrs: Object.fromEntries(
              Array.from(v.attributes).filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value])
            ),
          }));
        return {
          url: location.href,
          title: document.title,
          h1: document.querySelector('h1')?.textContent?.trim(),
          anchorSample: sampleAnchors,
          imgSample: imgs,
          videoSample: videos,
          appLinks: Array.from(document.querySelectorAll('a[href*="/apps/"]'))
            .slice(0, 15)
            .map((a) => ({ text: a.textContent.trim().slice(0, 60), href: a.getAttribute('href') })),
        };
      });
      result.pages[c.name] = { status: resp.status(), tried: c.url, ...info };
      log(`  ${c.name}: HTTP ${resp.status()}, landed at ${info.url}`);
    } catch (e) {
      result.pages[c.name] = { error: e.message, tried: c.url };
      log(`  ${c.name}: ${e.message}`);
    } finally {
      await page.close();
    }
  }

  await context.close();
  const outPath = path.join(LOGS_DIR, 'mobbin-structure.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  log(`✓ 結構勘查結果寫到 ${outPath}`);
}

// 抓 mobbin latest feed 的 video flows
async function fetchMobbinFlows(context, cfg) {
  const url = `${MOBBIN_BASE}/discover/apps/${cfg.platform}/${cfg.source}`;
  const page = await context.newPage();
  try {
    log(`  訪問 ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // 等 video 元素載入（lazy）
    try {
      await page.waitForSelector('video[src*="bytescale"]', { timeout: 10000 });
    } catch {
      log('  ⚠ 沒等到 video 元素出現');
    }
    await page.waitForTimeout(2000);

    // 滾動載入更多（infinite scroll feed）
    const scrollCount = Math.max(3, Math.ceil(cfg.maxApps * cfg.screensPerApp / 5));
    for (let i = 0; i < scrollCount; i++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await page.waitForTimeout(1200);
    }

    const items = await page.evaluate(
      ({ maxApps, screensPerApp }) => {
        const videos = Array.from(document.querySelectorAll('video[src*="bytescale"]')).filter((v) =>
          (v.src || '').includes('app_flow_videos')
        );
        const out = [];
        const appCounts = {};

        for (const v of videos) {
          const src = v.src;
          if (!src) continue;

          // 從 src 萃取穩定的 video uuid 當作去重 key（query string 會變動）
          const uuidMatch = src.match(/app_flow_videos\/([0-9a-f-]{36})/i);
          const stableId = uuidMatch ? uuidMatch[1] : src;

          // 每個 video 的卡片容器是最近的 <li> — 實測確認，比往上數 N 層更穩
          const card = v.closest('li');
          if (!card) continue;

          // app name：卡片內 logo 的 alt 屬性（"<App> logo"）
          const logoImg = card.querySelector('img[alt$=" logo" i]');
          const appName = (logoImg?.alt || '').replace(/ logo$/i, '').trim() || null;

          // detail URL：卡片內 /apps/<app-slug-uuid>/<flow-uuid>/screens 連結
          const detailEl = card.querySelector('a[href^="/apps/"]');
          const detailHref = detailEl?.getAttribute('href') || null;
          const detailUrl = detailHref
            ? new URL(detailHref, location.origin).href
            : null;

          // mobbin 列表頁的卡片只有 app logo + 預覽影片，沒有獨立的 flow 名稱
          // flow 名稱要進細節頁才有；這裡先留 null，後續用 stableId 短碼識別
          const flowText = null;

          // 限制每個 app 最多 screensPerApp 筆
          const appKey = appName || 'unknown';
          appCounts[appKey] = (appCounts[appKey] || 0) + 1;
          if (appCounts[appKey] > screensPerApp) continue;

          out.push({
            src,
            stableId,
            poster: v.getAttribute('poster'),
            appName,
            flowText,
            detailUrl,
          });

          // 限制總 app 數：已經收到 maxApps 個 app 之後，後面新 app 就不再加
          const distinctApps = Object.keys(appCounts).length;
          if (distinctApps > maxApps) {
            out.pop();
            delete appCounts[appKey];
            break;
          }
        }
        return out;
      },
      { maxApps: cfg.maxApps, screensPerApp: cfg.screensPerApp }
    );

    return items;
  } finally {
    await page.close();
  }
}

async function runMobbinFlow() {
  const cfg = CONFIG.mobbin;
  if (!cfg?.enabled) {
    log('Mobbin 流程：已停用，跳過');
    return;
  }

  log('\n========== Mobbin 流程 ==========');

  if (!fs.existsSync(MOBBIN_PROFILE_DIR)) {
    log('⚠ Mobbin profile 不存在，請先跑：node bot.js --setup-mobbin');
    return;
  }

  const folderId = await ensureFolder(cfg.eagleFolderName);
  const context = await openMobbinBrowser(true);
  const stats = { added: 0, skipped: 0, failed: 0, appCount: new Set() };

  try {
    // 驗證 session
    const checkPage = await context.newPage();
    await checkPage.goto(MOBBIN_BASE, { waitUntil: 'domcontentloaded' });
    await checkPage.waitForTimeout(2000);
    const loggedIn = await detectLogin(checkPage);
    await checkPage.close();
    if (!loggedIn) {
      log('⚠ Mobbin session 失效，請手動跑：node bot.js --setup-mobbin');
      return;
    }
    log('✓ Mobbin session 有效');

    // 預先建立「已存在的 stableId」集合，用於去重
    // 從 Mobbin 資料夾內現有 items 的 annotation 萃取 stableId
    const existingStableIds = new Set();
    if (cfg.skipIfSourceUrlExists) {
      const existing = await callEagle('item_get', {
        folders: [folderId],
        fullDetails: true,
        limit: 1000,
      });
      const existingList = existing?.data || existing?.result || existing;
      if (Array.isArray(existingList)) {
        for (const it of existingList) {
          const m = (it.annotation || '').match(/stableId:\s*([0-9a-f-]{36})/i);
          if (m) existingStableIds.add(m[1]);
        }
        log(`現有 ${existingStableIds.size} 個 stableId 在 Mobbin 資料夾內（用於去重）`);
      }
    }

    const flows = await fetchMobbinFlows(context, cfg);
    log(`找到 ${flows.length} 個 flow，分屬 ${new Set(flows.map((f) => f.appName)).size} 個 app`);

    for (const [i, flow] of flows.entries()) {
      const displayName = `${flow.appName || 'Unknown'} - ${flow.flowText || flow.stableId.slice(0, 8)}`;
      log(`\n[${i + 1}/${flows.length}] ${displayName}`);

      try {
        if (cfg.skipIfSourceUrlExists && existingStableIds.has(flow.stableId)) {
          log('  ⏭ Eagle 內已有此 flow，跳過');
          stats.skipped++;
          continue;
        }

        // 防護：HEAD 驗證 mp4 URL 真的回 video/* content-type
        // （避免 Eagle 收到非 video response 後 fallback 到首頁 HTML，name 被改成 page title）
        try {
          const r = await fetch(flow.src, {
            method: 'HEAD',
            redirect: 'follow',
            headers: { Referer: MOBBIN_BASE + '/' },
          });
          const ct = r.headers.get('content-type') || '';
          if (!r.ok || !/^video\//i.test(ct)) {
            log(`  ⚠ mp4 HEAD 不正常 (HTTP ${r.status}, type=${ct})，跳過`);
            stats.failed++;
            continue;
          }
        } catch (e) {
          log(`  ⚠ mp4 HEAD 失敗：${e.message}，跳過`);
          stats.failed++;
          continue;
        }

        const annotation = [
          `App: ${flow.appName || '(unknown)'}`,
          flow.flowText ? `Flow: ${flow.flowText}` : null,
          flow.detailUrl ? `Mobbin: ${flow.detailUrl}` : null,
          `stableId: ${flow.stableId}`,
          `抓取時間：${new Date().toISOString().slice(0, 10)}`,
        ].filter(Boolean).join('\n');

        const itemTags = [...cfg.extraTags, cfg.platform];
        if (flow.appName) itemTags.push(flow.appName);

        await callEagle('item_add', {
          folders: [folderId],
          tags: itemTags,
          annotation,
          items: [
            {
              source: {
                type: 'url',
                url: flow.src,
                website: flow.detailUrl || MOBBIN_BASE,
              },
              name: displayName,
            },
          ],
        });

        log('  ✓ 已加入 Eagle');
        stats.added++;
        if (flow.appName) stats.appCount.add(flow.appName);
      } catch (e) {
        log('  ❌ 失敗：', e.message);
        stats.failed++;
      }
    }
  } finally {
    await context.close();
  }

  log(
    `\nMobbin 結果：新增 ${stats.added} 筆／跳過 ${stats.skipped} 筆／失敗 ${stats.failed}／涵蓋 ${stats.appCount.size} 個 app`
  );
}

// =====================================================================
//                          主流程
// =====================================================================

async function main() {
  const args = process.argv.slice(2);
  log('=== Eagle Inspiration Bot 啟動 ===');

  if (args.includes('--setup-mobbin')) {
    await setupMobbinSession();
    log('\n接著跑結構勘查…');
    await probeMobbinStructure();
    return;
  }
  if (args.includes('--probe-mobbin')) {
    await probeMobbinStructure();
    return;
  }

  // Eagle 連線預檢
  try {
    await callEagle('get_app_info', {});
  } catch (e) {
    log('❌ Eagle 連線失敗（請確認 Eagle 已開啟且 MCP plugin 已啟用）：', e.message);
    process.exit(1);
  }

  // Awwwards
  try {
    await runAwwwardsFlow();
  } catch (e) {
    log('❌ Awwwards 流程錯誤：', e.message);
  }

  // Mobbin
  try {
    await runMobbinFlow();
  } catch (e) {
    log('❌ Mobbin 流程錯誤：', e.message);
  }

  log('\n=== 結束 ===');
}

main().catch((e) => {
  log('❌ 未預期錯誤：', e.stack || e.message);
  process.exit(1);
});
