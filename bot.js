#!/usr/bin/env node
// Eagle 靈感庫自動更新機器人 v3
// 來源：
//   • Awwwards — SOTD + Nominees（可在 config 啟用 / 停用任一）
//   • Mobbin — Latest feed + Category 輪換（每週用 ISO 週數 modulo 自動換分類）
//
// 功能：
//   • macOS 桌面通知（跑完跳結果）
//   • 黑名單（黑名單 keyword / app / category 自動 skip）
//   • 失敗 retry（上次 HEAD fail 的 mp4 下次跑時 retry 一次）
//
// 用法：
//   node bot.js                  # 跑兩個流程
//   node bot.js --setup-mobbin   # 第一次設定 Mobbin（手動登入一次）
//   node bot.js --probe-mobbin   # 只跑 Mobbin 結構勘查

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- 路徑與設定 ----------
const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const EAGLE_CLI = path.join(os.homedir(), '.claude/skills/eagle-skill/scripts/eagle-api-cli.js');
const LOGS_DIR = path.join(ROOT, 'logs');
const EAGLE_BOT_DIR = path.join(os.homedir(), '.eagle-bot');
const MOBBIN_PROFILE_DIR = path.join(EAGLE_BOT_DIR, 'mobbin-profile');
const FAILED_URLS_PATH = path.join(EAGLE_BOT_DIR, 'failed-urls.json');

const AWWWARDS_BASE = 'https://www.awwwards.com';
// Awwwards 各 source 對應的列表頁
const AWWWARDS_SOURCE_URLS = {
  sotd: `${AWWWARDS_BASE}/websites/sites_of_the_day/`,
  nominees: `${AWWWARDS_BASE}/websites/nominees/`,
};
const MOBBIN_BASE = 'https://mobbin.com';

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(EAGLE_BOT_DIR)) fs.mkdirSync(EAGLE_BOT_DIR, { recursive: true });

// ---------- 小工具 ----------
const log = (...args) => {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  console.log(`[${ts}]`, ...args);
};

// macOS 桌面通知（用 osascript，零依賴）
function notify(title, body) {
  if (CONFIG.notifyOnFinish === false) return;
  const escTitle = String(title).replace(/[\\"]/g, '\\$&');
  const escBody = String(body).replace(/[\\"]/g, '\\$&').replace(/\n/g, ' · ');
  try {
    spawn('osascript', [
      '-e',
      `display notification "${escBody}" with title "${escTitle}"`,
    ]);
  } catch {
    /* 通知失敗不影響主流程 */
  }
}

// ISO 週數（給分類輪換用，可重現、跨年正確）
function getIsoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// 依本週週數從 categories 陣列輪換 N 個（每週遞進 N 個位置，循環）
function pickCategoriesForWeek(categories, count) {
  if (!Array.isArray(categories) || categories.length === 0 || count < 1) return [];
  const week = getIsoWeek();
  const start = (week * count) % categories.length;
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(categories[(start + i) % categories.length]);
  }
  return [...new Set(out)];
}

// 呼叫 Eagle skill 的 CLI
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

// Eagle 資料夾
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

// 失敗 URL 載入 / 寫入
function loadFailedUrls() {
  try {
    if (!fs.existsSync(FAILED_URLS_PATH)) return [];
    const arr = JSON.parse(fs.readFileSync(FAILED_URLS_PATH, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveFailedUrls(arr) {
  fs.writeFileSync(FAILED_URLS_PATH, JSON.stringify(arr, null, 2));
}

// HEAD 驗證遠端 URL 真的回 video/*
async function verifyVideoUrl(url, referer) {
  try {
    const r = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: referer ? { Referer: referer } : {},
    });
    const ct = r.headers.get('content-type') || '';
    return { ok: r.ok && /^video\//i.test(ct), status: r.status, contentType: ct };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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

async function fetchAwwwardsListing(context, listUrl, max) {
  const page = await context.newPage();
  await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

// 黑名單：依關鍵字檢查作品標題 / liveUrl / detailUrl
function isAwwwardsBlocked(detail, blocklist) {
  const keywords = (blocklist?.awwwardsKeywords || []).filter(Boolean).map((k) => k.toLowerCase());
  if (!keywords.length) return null;
  const haystack = `${detail.title || ''} ${detail.liveUrl || ''} ${detail.detailUrl || ''}`.toLowerCase();
  return keywords.find((kw) => haystack.includes(kw)) || null;
}

async function runAwwwardsFlow(globalStats) {
  const cfg = CONFIG.awwwards;
  if (!cfg?.enabled) {
    log('Awwwards 流程：已停用，跳過');
    return;
  }

  log('\n========== Awwwards 流程 ==========');
  const folderId = await ensureFolder(cfg.eagleFolderName);
  const { browser, context } = await openHeadlessBrowser();
  const stats = { added: 0, skipped: 0, failed: 0, blocked: 0, videoCount: 0, imageCount: 0 };

  try {
    const sources = (cfg.sources || []).filter((s) => s.enabled);
    if (!sources.length) {
      log('⚠ 沒有啟用的 Awwwards source（檢查 config.awwwards.sources）');
      return;
    }

    for (const src of sources) {
      const listUrl = AWWWARDS_SOURCE_URLS[src.type];
      if (!listUrl) {
        log(`⚠ 未知 source type："${src.type}"，跳過`);
        continue;
      }
      log(`\n--- Awwwards ${src.type.toUpperCase()} (${src.maxSites} 筆) ---`);
      log(`從 ${listUrl} 抓列表…`);

      const detailUrls = await fetchAwwwardsListing(context, listUrl, src.maxSites);
      log(`找到 ${detailUrls.length} 個細節頁`);

      for (const [i, url] of detailUrls.entries()) {
        log(`\n[${src.type} ${i + 1}/${detailUrls.length}] ${url}`);
        try {
          const detail = await fetchAwwwardsDetail(context, url);
          log(`  作品：${detail.title}`);
          log(`  網站：${detail.liveUrl || '(找不到)'}`);
          log(`  找到 ${detail.items.length} 個 element`);

          // 黑名單檢查
          const blockedBy = isAwwwardsBlocked(detail, CONFIG.blocklist);
          if (blockedBy) {
            log(`  🚫 黑名單命中（"${blockedBy}"），跳過`);
            stats.blocked++;
            continue;
          }

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
            `來源：Awwwards ${src.type}`,
            detail.liveUrl ? `Live: ${detail.liveUrl}` : null,
            `Awwwards: ${detail.detailUrl}`,
            `抓取時間：${new Date().toISOString().slice(0, 10)}`,
          ].filter(Boolean).join('\n');

          const itemTags = [...cfg.extraTags, src.type];

          await callEagle('item_add', {
            folders: [folderId],
            tags: itemTags,
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
    }
  } finally {
    await browser.close();
  }

  log(`\nAwwwards 結果：新增 ${stats.added}（影片 ${stats.videoCount}、圖片 ${stats.imageCount}）／跳過 ${stats.skipped}／黑名單 ${stats.blocked}／失敗 ${stats.failed}`);
  globalStats.awwwards = stats;
}

// =====================================================================
//                          Mobbin 流程
// =====================================================================

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
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return context;
}

async function detectLogin(page) {
  try {
    const url = page.url();
    if (/\/login|sign-in|signup/i.test(url)) return false;
    if (/\/discover\//i.test(url)) return true;
    return await page.evaluate(() => !!document.querySelector('a[href^="/saved"]'));
  } catch {
    return false;
  }
}

async function setupMobbinSession() {
  log('=== Mobbin 首次設定 ===');
  log('將開啟你系統的 Chrome（獨立 profile，跟你日常的 Chrome 分開）');
  log('請在瀏覽器內登入 Mobbin（用你平常用的 Google 帳號）');
  log('登入成功後，bot 會自動偵測並關閉瀏覽器、儲存 session\n');

  const context = await openMobbinBrowser(false);
  const page = await context.newPage();
  await page.goto(MOBBIN_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });

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
    log('⚠ 等待超時（6 分鐘）。Session 已儲存目前狀態');
  }

  await context.close();
}

async function probeMobbinStructure() {
  log('=== Mobbin 頁面結構勘查 ===');
  const context = await openMobbinBrowser(true);
  const result = { probedAt: new Date().toISOString(), pages: {} };
  const candidates = [
    { name: 'home', url: MOBBIN_BASE },
    { name: 'latest_ios', url: `${MOBBIN_BASE}/discover/apps/ios/latest` },
    { name: 'category_health', url: `${MOBBIN_BASE}/search/apps/ios?content_type=apps&sort=publishedAt&filter=appCategories.Health+%26+Fitness` },
  ];
  for (const c of candidates) {
    const page = await context.newPage();
    try {
      const resp = await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
      const info = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        videoCount: document.querySelectorAll('video[src*="bytescale"]').length,
        appLinks: Array.from(document.querySelectorAll('a[href^="/apps/"]'))
          .slice(0, 15)
          .map((a) => ({ text: a.textContent.trim().slice(0, 60), href: a.getAttribute('href') })),
      }));
      result.pages[c.name] = { status: resp.status(), tried: c.url, ...info };
      log(`  ${c.name}: HTTP ${resp.status()}, video=${info.videoCount}`);
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

// 抓 mobbin 任一 listing URL 的 video flows
async function fetchMobbinFlows(context, listUrl, maxApps, screensPerApp, label) {
  const page = await context.newPage();
  try {
    log(`  [${label}] 訪問 ${listUrl}`);
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.waitForSelector('video[src*="bytescale"]', { timeout: 10000 });
    } catch {
      log(`  [${label}] ⚠ 沒等到 video 元素，這個來源可能空了`);
    }
    await page.waitForTimeout(2000);

    const scrollCount = Math.max(3, Math.ceil((maxApps * screensPerApp) / 5));
    for (let i = 0; i < scrollCount; i++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await page.waitForTimeout(1200);
    }

    const items = await page.evaluate(
      ({ maxApps, screensPerApp }) => {
        const videos = Array.from(document.querySelectorAll('video[src*="bytescale"]')).filter(
          (v) => (v.src || '').includes('app_flow_videos')
        );
        const out = [];
        const appCounts = {};
        for (const v of videos) {
          const src = v.src;
          if (!src) continue;
          const uuidMatch = src.match(/app_flow_videos\/([0-9a-f-]{36})/i);
          const stableId = uuidMatch ? uuidMatch[1] : src;
          const card = v.closest('li');
          if (!card) continue;
          const logoImg = card.querySelector('img[alt$=" logo" i]');
          const appName = (logoImg?.alt || '').replace(/ logo$/i, '').trim() || null;
          const detailEl = card.querySelector('a[href^="/apps/"]');
          const detailHref = detailEl?.getAttribute('href') || null;
          const detailUrl = detailHref ? new URL(detailHref, location.origin).href : null;
          const appKey = appName || 'unknown';
          appCounts[appKey] = (appCounts[appKey] || 0) + 1;
          if (appCounts[appKey] > screensPerApp) continue;
          out.push({ src, stableId, poster: v.getAttribute('poster'), appName, detailUrl });
          if (Object.keys(appCounts).length > maxApps) {
            out.pop();
            delete appCounts[appKey];
            break;
          }
        }
        return out;
      },
      { maxApps, screensPerApp }
    );
    return items;
  } finally {
    await page.close();
  }
}

// 抓 app 細節頁的 animation 影片（每個 screen 的 micro-interaction）
// detailUrl 通常是 .../<app-uuid>/<flow-uuid>/screens；mobbin 會 render 該 flow 內每個 screen 的 animation
async function fetchAppAnimations(context, detailUrl, max, excludeStableIds = new Set()) {
  if (!detailUrl || max <= 0) return [];
  const page = await context.newPage();
  try {
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForSelector('video[src*="bytescale"]', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    // 滾兩下載入更多 screen
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollBy(0, 1500));
      await page.waitForTimeout(700);
    }
    return await page.evaluate(
      ({ max, excluded }) => {
        const videos = Array.from(
          document.querySelectorAll('video[src*="bytescale"]')
        ).filter((v) => /animations\/[0-9a-f-]{36}/i.test(v.src || ''));
        const seen = new Set(excluded);
        const out = [];
        for (const v of videos) {
          const src = v.src;
          const m = src.match(/animations\/([0-9a-f-]{36})/i);
          if (!m) continue;
          if (seen.has(m[1])) continue;
          seen.add(m[1]);
          const anchor =
            v.closest('a[href^="/screens/"]') ||
            v.parentElement?.querySelector('a[href^="/screens/"]');
          out.push({
            src,
            stableId: m[1],
            screenHref: anchor?.getAttribute('href') || null,
            kind: 'animation',
          });
          if (out.length >= max) break;
        }
        return out;
      },
      { max, excluded: [...excludeStableIds] }
    );
  } finally {
    await page.close();
  }
}

function isMobbinBlocked(flow, blocklist) {
  const apps = (blocklist?.mobbinApps || []).filter(Boolean);
  if (flow.appName && apps.includes(flow.appName)) return `app:${flow.appName}`;
  return null;
}

// 處理單一 flow / animation → 寫進 Eagle（共用 latest / category / retry 邏輯）
async function ingestMobbinFlow(flow, ctx) {
  const { folderId, baseTags, source, existingStableIds, stats, newlyFailedRef } = ctx;
  const kindLabel = flow.kind === 'animation' ? '🎬' : '📱';
  const displayName = `${flow.appName || 'Unknown'} - ${flow.stableId.slice(0, 8)}`;
  log(`  [${source}] ${kindLabel} ${displayName}`);

  // 黑名單
  const blockedBy = isMobbinBlocked(flow, CONFIG.blocklist);
  if (blockedBy) {
    log(`    🚫 黑名單命中（${blockedBy}）`);
    stats.blocked++;
    return;
  }

  // 去重
  if (CONFIG.mobbin.skipIfSourceUrlExists && existingStableIds.has(flow.stableId)) {
    log('    ⏭ 已存在');
    stats.skipped++;
    return;
  }

  // HEAD 驗證
  const verify = await verifyVideoUrl(flow.src, MOBBIN_BASE + '/');
  if (!verify.ok) {
    log(`    ⚠ HEAD 不正常（${verify.status || verify.error}, type=${verify.contentType || '-'}），記入失敗清單`);
    newlyFailedRef.push({
      src: flow.src,
      name: displayName,
      appName: flow.appName,
      detailUrl: flow.detailUrl,
      source,
      stableId: flow.stableId,
      failedAt: new Date().toISOString(),
    });
    stats.failed++;
    return;
  }

  const annotation = [
    `App: ${flow.appName || '(unknown)'}`,
    `來源：Mobbin ${source}`,
    flow.detailUrl ? `Mobbin: ${flow.detailUrl}` : null,
    `stableId: ${flow.stableId}`,
    `抓取時間：${new Date().toISOString().slice(0, 10)}`,
  ].filter(Boolean).join('\n');

  const itemTags = [...baseTags, source];
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

  log('    ✓ 已加入 Eagle');
  stats.added++;
  if (flow.appName) stats.appCount.add(flow.appName);
  existingStableIds.add(flow.stableId);
}

// 處理失敗清單 retry（HEAD 仍 fail 就 drop）
async function retryFailedUrls(ctx) {
  const failed = loadFailedUrls();
  if (!failed.length) return;
  log(`\n--- 重試上次失敗的 ${failed.length} 筆 ---`);
  for (const item of failed) {
    if (ctx.existingStableIds.has(item.stableId)) {
      log(`  ⏭ ${item.name} 已存在，從失敗清單移除`);
      continue;
    }
    const verify = await verifyVideoUrl(item.src, MOBBIN_BASE + '/');
    if (!verify.ok) {
      log(`  ✗ ${item.name} 仍失敗（${verify.status || verify.error}），drop`);
      continue;
    }
    try {
      await callEagle('item_add', {
        folders: [ctx.folderId],
        tags: [...ctx.baseTags, item.source || 'retry', ...(item.appName ? [item.appName] : [])],
        annotation: `App: ${item.appName || '(unknown)'}\n來源：Mobbin ${item.source || 'retry'}\nstableId: ${item.stableId}\n重試於：${new Date().toISOString().slice(0, 10)}`,
        items: [
          {
            source: { type: 'url', url: item.src, website: item.detailUrl || MOBBIN_BASE },
            name: item.name,
          },
        ],
      });
      log(`  ✓ ${item.name} retry 成功`);
      ctx.stats.added++;
      ctx.existingStableIds.add(item.stableId);
    } catch (e) {
      log(`  ❌ ${item.name} retry 寫入 Eagle 失敗：${e.message}`);
    }
  }
}

async function runMobbinFlow(globalStats) {
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
  const stats = { added: 0, skipped: 0, failed: 0, blocked: 0, appCount: new Set() };
  const newlyFailed = [];

  try {
    // 驗證 session
    const checkPage = await context.newPage();
    await checkPage.goto(MOBBIN_BASE, { waitUntil: 'domcontentloaded' });
    await checkPage.waitForTimeout(2000);
    const loggedIn = await detectLogin(checkPage);
    await checkPage.close();
    if (!loggedIn) {
      log('⚠ Mobbin session 失效，請手動跑：node bot.js --setup-mobbin');
      globalStats.mobbin = stats;
      return;
    }
    log('✓ Mobbin session 有效');

    // 預載已存在的 stableIds（去重用）
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
        log(`現有 ${existingStableIds.size} 個 stableId 在 Mobbin 資料夾內`);
      }
    }

    const ctx = {
      folderId,
      baseTags: cfg.extraTags,
      existingStableIds,
      stats,
      newlyFailedRef: newlyFailed,
    };

    // 1. 先 retry 上次失敗
    await retryFailedUrls(ctx);

    // 2. 跑每個啟用的 feed
    const feeds = (cfg.feeds || []).filter((f) => f.enabled);
    const blockedCats = (CONFIG.blocklist?.mobbinCategories || []).filter(Boolean);

    for (const feed of feeds) {
      if (feed.type === 'latest') {
        log(`\n--- Mobbin Latest (${feed.maxApps} apps × ${feed.screensPerApp} 筆/app) ---`);
        const url = `${MOBBIN_BASE}/discover/apps/${cfg.platform}/latest`;
        // 從 latest feed 抓每個 app 1 個 flow video（封面）
        const flows = await fetchMobbinFlows(context, url, feed.maxApps, 1, 'latest');
        log(`找到 ${flows.length} 個 flow video`);
        for (const flow of flows) {
          await ingestMobbinFlow({ ...flow, kind: 'flow_video' }, { ...ctx, source: 'latest' });
          // 同一 app 從細節頁額外抓 animations 補滿 screensPerApp
          const extraNeeded = (feed.screensPerApp || 1) - 1;
          if (extraNeeded > 0 && flow.detailUrl) {
            const animations = await fetchAppAnimations(
              context,
              flow.detailUrl,
              extraNeeded,
              existingStableIds
            );
            for (const ani of animations) {
              await ingestMobbinFlow(
                { ...ani, appName: flow.appName, detailUrl: flow.detailUrl },
                { ...ctx, source: 'latest' }
              );
            }
          }
        }
      } else if (feed.type === 'category') {
        const pickedCats = pickCategoriesForWeek(feed.categories, feed.categoriesPerRun || 1)
          .filter((c) => !blockedCats.includes(c));
        if (!pickedCats.length) {
          log('⚠ Mobbin category：本週沒挑到任何分類（檢查 blocklist 是否擋掉全部）');
          continue;
        }
        log(`\n--- Mobbin Category 輪換（本週 ISO 週 ${getIsoWeek()}）---`);
        log(`本週分類：${pickedCats.join(', ')}`);
        for (const category of pickedCats) {
          const encoded = encodeURIComponent(category).replace(/%20/g, '+');
          const url = `${MOBBIN_BASE}/search/apps/${cfg.platform}?content_type=apps&sort=publishedAt&filter=appCategories.${encoded}`;
          const flows = await fetchMobbinFlows(
            context,
            url,
            feed.maxAppsPerCategory,
            1,
            `category:${category}`
          );
          log(`  ${category}: 找到 ${flows.length} 個 flow`);
          const tag = `category:${category}`;
          const extraNeeded = (feed.screensPerApp || 1) - 1;
          for (const flow of flows) {
            await ingestMobbinFlow(
              { ...flow, kind: 'flow_video' },
              { ...ctx, source: tag, baseTags: [...cfg.extraTags, `category:${category}`] }
            );
            if (extraNeeded > 0 && flow.detailUrl) {
              const animations = await fetchAppAnimations(
                context,
                flow.detailUrl,
                extraNeeded,
                existingStableIds
              );
              for (const ani of animations) {
                await ingestMobbinFlow(
                  { ...ani, appName: flow.appName, detailUrl: flow.detailUrl },
                  { ...ctx, source: tag, baseTags: [...cfg.extraTags, `category:${category}`] }
                );
              }
            }
          }
        }
      }
    }
  } finally {
    await context.close();
    saveFailedUrls(newlyFailed);
  }

  log(
    `\nMobbin 結果：新增 ${stats.added}／跳過 ${stats.skipped}／黑名單 ${stats.blocked}／失敗 ${stats.failed}／涵蓋 ${stats.appCount.size} 個 app`
  );
  if (newlyFailed.length) {
    log(`  失敗清單寫到 ${FAILED_URLS_PATH}（下次跑會 retry）`);
  }
  globalStats.mobbin = stats;
}

// =====================================================================
//                          Godly.website 流程
// =====================================================================

const GODLY_BASE = 'https://godly.website';

async function fetchGodlyListing(context, max) {
  const page = await context.newPage();
  await page.goto(GODLY_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  // 滾動載入更多卡片
  for (let i = 0; i < Math.ceil(max / 6); i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForTimeout(700);
  }
  const hrefs = await page.$$eval('a[href^="/website/"]', (els) =>
    els.map((a) => a.getAttribute('href'))
  );
  await page.close();
  return [...new Set(hrefs)].slice(0, max).map((h) => GODLY_BASE + h);
}

async function fetchGodlyDetail(context, detailUrl) {
  const page = await context.newPage();
  try {
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const data = await page.evaluate(() => {
      const title =
        document.querySelector('h1')?.textContent?.trim() ||
        document.title.replace(/\s*[-|]\s*Godly.*$/i, '').trim();
      const video = document.querySelector('video');
      const videoSrc =
        video?.src ||
        video?.currentSrc ||
        video?.querySelector('source')?.getAttribute('src') ||
        null;
      const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content');

      // 找 Visit 連結（去掉 ?ref=godly query）
      let liveUrl = null;
      const anchors = Array.from(document.querySelectorAll('a[href^="http"]')).filter(
        (a) => !a.href.includes('godly.website')
      );
      const visitAnchor =
        anchors.find((a) => /^visit\s*$/i.test(a.textContent.trim())) || anchors[0];
      if (visitAnchor) {
        liveUrl = visitAnchor.getAttribute('href')?.replace(/[?&]ref=godly\b/i, '') || null;
        liveUrl = liveUrl?.replace(/[?&]$/, '');
      }
      return {
        title,
        mediaUrl: videoSrc || ogImage,
        mediaType: videoSrc ? 'video' : 'image',
        liveUrl,
      };
    });
    return { ...data, detailUrl };
  } finally {
    await page.close();
  }
}

async function runGodlyFlow(globalStats) {
  const cfg = CONFIG.godly;
  if (!cfg?.enabled) {
    log('Godly 流程：已停用，跳過');
    return;
  }
  log('\n========== Godly 流程 ==========');
  const folderId = await ensureFolder(cfg.eagleFolderName);
  const { browser, context } = await openHeadlessBrowser();
  const stats = { added: 0, skipped: 0, failed: 0, blocked: 0, videoCount: 0, imageCount: 0 };
  try {
    log(`從 ${GODLY_BASE}/ 抓列表…`);
    const urls = await fetchGodlyListing(context, cfg.maxSites);
    log(`找到 ${urls.length} 個細節頁`);
    for (const [i, url] of urls.entries()) {
      log(`\n[godly ${i + 1}/${urls.length}] ${url}`);
      try {
        const detail = await fetchGodlyDetail(context, url);
        log(`  作品：${detail.title}`);
        log(`  網站：${detail.liveUrl || '(無)'}`);
        log(`  媒體：${detail.mediaType}`);

        const blockedBy = isAwwwardsBlocked(detail, CONFIG.blocklist);
        if (blockedBy) {
          log(`  🚫 黑名單命中（"${blockedBy}"）`);
          stats.blocked++;
          continue;
        }
        if (cfg.skipIfLiveUrlExists && detail.liveUrl) {
          const exist = await callEagle('item_get', { url: detail.liveUrl, limit: 1 });
          const list = exist?.data || exist?.result || exist;
          if (Array.isArray(list) && list.length > 0) {
            log('  ⏭ 已存在');
            stats.skipped++;
            continue;
          }
        }
        if (!detail.mediaUrl) {
          log('  ⚠ 沒可用媒體');
          stats.failed++;
          continue;
        }
        await callEagle('item_add', {
          folders: [folderId],
          tags: cfg.extraTags,
          annotation: [
            `作品：${detail.title}`,
            `來源：Godly.website`,
            `Live: ${detail.liveUrl || '-'}`,
            `Godly: ${detail.detailUrl}`,
            `抓取時間：${new Date().toISOString().slice(0, 10)}`,
          ].join('\n'),
          items: [
            {
              source: {
                type: 'url',
                url: detail.mediaUrl,
                website: detail.liveUrl || detail.detailUrl,
              },
              name: detail.title,
            },
          ],
        });
        log('  ✓ 已加入 Eagle');
        stats.added++;
        if (detail.mediaType === 'video') stats.videoCount++;
        else stats.imageCount++;
      } catch (e) {
        log('  ❌ 失敗：', e.message);
        stats.failed++;
      }
    }
  } finally {
    await browser.close();
  }
  log(
    `\nGodly 結果：新增 ${stats.added}（影片 ${stats.videoCount}、圖片 ${stats.imageCount}）／跳過 ${stats.skipped}／黑名單 ${stats.blocked}／失敗 ${stats.failed}`
  );
  globalStats.godly = stats;
}

// =====================================================================
//                  Mobbin 主題手動搜尋（--search）
// =====================================================================

// 常見搜尋詞 → mobbin 官方 pattern 名稱對應
const MOBBIN_PATTERN_ALIAS = {
  onboarding: 'Welcome & Get Started',
  welcome: 'Welcome & Get Started',
  signup: 'Signup',
  signin: 'Login',
  login: 'Login',
  paywall: 'Subscription & Paywall',
  subscription: 'Subscription & Paywall',
  payment: 'Payment Method',
  checkout: 'Checkout',
  profile: 'My Account & Profile',
  settings: 'Settings',
  search: 'Search',
  notification: 'Notifications',
};

async function runMobbinSearch(rawQuery, count) {
  if (!rawQuery) {
    log('用法：node bot.js --search <pattern或關鍵字> [count]');
    log('例：node bot.js --search onboarding 10');
    log(`支援的別名：${Object.keys(MOBBIN_PATTERN_ALIAS).join(', ')}`);
    return;
  }

  const pattern = MOBBIN_PATTERN_ALIAS[rawQuery.toLowerCase()] || rawQuery;
  const cfg = CONFIG.mobbin;
  log(`=== Mobbin 主題搜尋：${pattern}（${count} 筆）===`);

  if (!fs.existsSync(MOBBIN_PROFILE_DIR)) {
    log('⚠ Mobbin profile 不存在，請先跑：node bot.js --setup-mobbin');
    return;
  }

  const folderId = await ensureFolder(cfg.eagleFolderName);
  const context = await openMobbinBrowser(true);
  const stats = { added: 0, skipped: 0, failed: 0, blocked: 0, appCount: new Set() };
  const newlyFailed = [];

  try {
    const checkPage = await context.newPage();
    await checkPage.goto(MOBBIN_BASE, { waitUntil: 'domcontentloaded' });
    await checkPage.waitForTimeout(2000);
    const loggedIn = await detectLogin(checkPage);
    await checkPage.close();
    if (!loggedIn) {
      log('⚠ Mobbin session 失效，請手動跑：node bot.js --setup-mobbin');
      return;
    }

    // 預載去重 set
    const existingStableIds = new Set();
    const existing = await callEagle('item_get', {
      folders: [folderId], fullDetails: true, limit: 1000,
    });
    const existingList = existing?.data || existing?.result || existing;
    if (Array.isArray(existingList)) {
      for (const it of existingList) {
        const m = (it.annotation || '').match(/stableId:\s*([0-9a-f-]{36})/i);
        if (m) existingStableIds.add(m[1]);
      }
    }

    const encoded = encodeURIComponent(pattern).replace(/%20/g, '+');
    const url = `${MOBBIN_BASE}/search/apps/${cfg.platform}?content_type=screens&sort=trending&filter=screenPatterns.${encoded}`;
    log(`訪問 ${url}`);

    // 直接走 fetchAppAnimations 邏輯（search 結果頁也是 animations 形式）
    const page = await context.newPage();
    let animations = [];
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('video[src*="bytescale"]', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2000);
      // 滾動載入更多
      const scrollTimes = Math.ceil(count / 5);
      for (let i = 0; i < scrollTimes; i++) {
        await page.evaluate(() => window.scrollBy(0, 1500));
        await page.waitForTimeout(800);
      }
      animations = await page.evaluate(
        ({ max, excluded }) => {
          const seen = new Set(excluded);
          const videos = Array.from(document.querySelectorAll('video[src*="bytescale"]')).filter((v) =>
            /animations\/[0-9a-f-]{36}/i.test(v.src || '')
          );
          const out = [];
          for (const v of videos) {
            const m = v.src.match(/animations\/([0-9a-f-]{36})/i);
            if (!m || seen.has(m[1])) continue;
            seen.add(m[1]);
            // 找 app logo（向上找 app 卡片）
            const card = v.closest('a[href^="/screens/"]')?.closest('li') || v.closest('li');
            const logoImg = card?.querySelector('img[alt$=" logo" i]');
            const appName = (logoImg?.alt || '').replace(/ logo$/i, '').trim() || null;
            out.push({
              src: v.src,
              stableId: m[1],
              kind: 'animation',
              appName,
            });
            if (out.length >= max) break;
          }
          return out;
        },
        { max: count, excluded: [...existingStableIds] }
      );
    } finally {
      await page.close();
    }

    log(`找到 ${animations.length} 個 animation`);

    const ctx = {
      folderId,
      baseTags: [...cfg.extraTags, 'manual', `pattern:${pattern}`],
      source: `search:${pattern}`,
      existingStableIds,
      stats,
      newlyFailedRef: newlyFailed,
    };
    for (const ani of animations) {
      await ingestMobbinFlow({ ...ani, detailUrl: url }, ctx);
    }
  } finally {
    await context.close();
    // 把本次失敗 merge 進 existing failed-urls.json（不要覆蓋既有 retry queue）
    if (newlyFailed.length) {
      const existing = loadFailedUrls();
      saveFailedUrls([...existing, ...newlyFailed]);
    }
  }

  const body = `主題「${pattern}」新增 ${stats.added}／跳過 ${stats.skipped}／黑名單 ${stats.blocked}／失敗 ${stats.failed}`;
  log(`\n${body}`);
  notify('Eagle Inspiration Bot', body);
}

// =====================================================================
//                          月報生成（--report）
// =====================================================================

// 主程式每次跑完會 check 上個月月報是否已存在；不在就自動生成
async function maybeAutoGenerateLastMonthReport() {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const ym = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}`;
  const reportPath = path.join(LOGS_DIR, `monthly-${ym}.md`);
  if (fs.existsSync(reportPath)) return;
  log(`\n自動生成上月報告：${ym}`);
  await generateMonthlyReport(ym);
}

async function generateMonthlyReport(yearMonth) {
  if (!yearMonth) {
    const now = new Date();
    const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    yearMonth = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}`;
  }
  log(`\n========== 月報生成 ${yearMonth} ==========`);
  const [year, month] = yearMonth.split('-').map(Number);
  const monthStart = new Date(year, month - 1, 1).getTime();
  const monthEnd = new Date(year, month, 1).getTime();

  const folderNames = [
    CONFIG.awwwards?.eagleFolderName,
    CONFIG.mobbin?.eagleFolderName,
    CONFIG.godly?.eagleFolderName,
  ].filter(Boolean);

  const tree = await callEagle('folder_get', { getAllHierarchy: true });
  const tList = tree?.data || tree?.result || tree;
  const folderIds = [];
  for (const name of folderNames) {
    const f = findFolderByName(tList, name);
    if (f) folderIds.push(f.id);
  }
  if (!folderIds.length) {
    log('找不到任何來源資料夾');
    return;
  }

  const allItems = [];
  for (const fid of folderIds) {
    const r = await callEagle('item_get', { folders: [fid], fullDetails: true, limit: 1000 });
    const items = r?.data || [];
    allItems.push(...items);
  }

  // Eagle 預設不回時間欄位，從 annotation 內的「抓取時間：YYYY-MM-DD」parse
  // 我們 bot 自己寫入的 annotation 一定有這欄位
  const getItemDate = (it) => {
    const m = (it.annotation || '').match(/抓取時間：(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  };
  const monthPrefix = yearMonth; // "2026-05"

  const filtered = allItems.filter((it) => {
    const d = getItemDate(it);
    return d && d.startsWith(monthPrefix);
  });

  const stats = {
    total: filtered.length,
    bySource: { awwwards: 0, mobbin: 0, godly: 0, other: 0 },
    byKind: { video: 0, image: 0 },
    awwwardsBreakdown: {},
    mobbinApps: {},
    mobbinCategories: {},
    samples: [],
  };

  for (const it of filtered) {
    const tags = it.tags || [];
    const ext = (it.ext || '').toLowerCase();
    if (/^(mp4|webm|mov|m4v)$/i.test(ext)) stats.byKind.video++;
    else stats.byKind.image++;

    if (tags.includes('awwwards')) {
      stats.bySource.awwwards++;
      for (const t of tags) {
        if (['sotd', 'nominees'].includes(t)) {
          stats.awwwardsBreakdown[t] = (stats.awwwardsBreakdown[t] || 0) + 1;
        }
      }
    } else if (tags.includes('mobbin')) {
      stats.bySource.mobbin++;
      for (const t of tags) {
        if (t.startsWith('category:')) {
          const cat = t.slice('category:'.length);
          stats.mobbinCategories[cat] = (stats.mobbinCategories[cat] || 0) + 1;
        }
      }
      const m = (it.annotation || '').match(/^App:\s*(.+?)$/m);
      if (m && m[1] !== '(unknown)') {
        stats.mobbinApps[m[1]] = (stats.mobbinApps[m[1]] || 0) + 1;
      }
    } else if (tags.includes('godly')) {
      stats.bySource.godly++;
    } else {
      stats.bySource.other++;
    }

    if (stats.samples.length < 8) {
      stats.samples.push({ name: it.name, ext, tags: tags.slice(0, 4) });
    }
  }

  const pct = (n) => (stats.total ? Math.round((100 * n) / stats.total) : 0);
  const topApps = Object.entries(stats.mobbinApps).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topCats = Object.entries(stats.mobbinCategories).sort((a, b) => b[1] - a[1]);

  const md = `# 靈感蒐集月報 ${yearMonth}

> 生成於 ${new Date().toISOString().slice(0, 10)} · 由 Eagle Inspiration Bot 自動產生

## 總覽

- 本月新增 **${stats.total}** 筆靈感
- 影片 ${stats.byKind.video} · 圖片 ${stats.byKind.image}

## 來源比例

| 來源 | 筆數 | 比例 |
|---|---:|---:|
| Awwwards | ${stats.bySource.awwwards} | ${pct(stats.bySource.awwwards)}% |
| Mobbin | ${stats.bySource.mobbin} | ${pct(stats.bySource.mobbin)}% |
| Godly | ${stats.bySource.godly} | ${pct(stats.bySource.godly)}% |
${stats.bySource.other ? `| 其他 | ${stats.bySource.other} | ${pct(stats.bySource.other)}% |\n` : ''}

## Awwwards 細分

- SOTD: ${stats.awwwardsBreakdown.sotd || 0}
- Nominees: ${stats.awwwardsBreakdown.nominees || 0}

## Mobbin Top Apps

${topApps.length ? topApps.map(([app, n]) => `- **${app}** × ${n}`).join('\n') : '*（本月無 Mobbin 內容）*'}

## Mobbin 分類分布

${topCats.length ? topCats.map(([cat, n]) => `- ${cat} × ${n}`).join('\n') : '*（本月無分類內容）*'}

## 樣本（前 ${stats.samples.length} 筆）

${stats.samples.map((s) => `- ${s.name} · .${s.ext} · [${s.tags.join(', ')}]`).join('\n')}

---

*配置：${folderNames.join(' / ')}*
`;

  const reportPath = path.join(LOGS_DIR, `monthly-${yearMonth}.md`);
  fs.writeFileSync(reportPath, md);
  log(`✓ 月報已寫到 ${reportPath}`);
  log(`  總計 ${stats.total} 筆（Awwwards ${stats.bySource.awwwards} / Mobbin ${stats.bySource.mobbin} / Godly ${stats.bySource.godly}）`);
}

// =====================================================================
//                      Web Dashboard（--config-ui）
// =====================================================================

async function startConfigUI() {
  const http = require('http');
  const PORT = 3030;
  const HTML_PATH = path.join(ROOT, 'dashboard.html');

  const server = http.createServer(async (req, res) => {
    const sendJSON = (obj, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === 'GET' && req.url === '/') {
        const html = fs.readFileSync(HTML_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } else if (req.method === 'GET' && req.url === '/api/config') {
        sendJSON(JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')));
      } else if (req.method === 'POST' && req.url === '/api/config') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(body);
        // 寫入前驗證一下基本結構
        if (typeof parsed !== 'object' || !parsed.awwwards || !parsed.mobbin) {
          sendJSON({ ok: false, error: '結構不完整：缺 awwwards / mobbin section' }, 400);
          return;
        }
        fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(parsed, null, 2) + '\n');
        sendJSON({ ok: true });
      } else if (req.method === 'GET' && req.url === '/api/status') {
        // 簡單 status：mobbin profile 是否存在、failed-urls 數量
        const status = {
          mobbinSetup: fs.existsSync(MOBBIN_PROFILE_DIR),
          failedCount: loadFailedUrls().length,
          isoWeek: getIsoWeek(),
        };
        sendJSON(status);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    } catch (e) {
      sendJSON({ ok: false, error: e.message }, 500);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}`;
    log(`✓ Dashboard 已啟動：${url}`);
    log('按 Ctrl-C 結束');
    try {
      spawn('open', [url]);
    } catch {
      /* ignore */
    }
  });

  await new Promise(() => {}); // 永遠不返回
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

  // --search <query> [count]
  const searchIdx = args.indexOf('--search');
  if (searchIdx >= 0) {
    const query = args[searchIdx + 1];
    const count = parseInt(args[searchIdx + 2] || '10', 10);
    await runMobbinSearch(query, count);
    return;
  }

  // --report [YYYY-MM]
  if (args.includes('--report')) {
    const idx = args.indexOf('--report');
    const month = args[idx + 1] && /^\d{4}-\d{2}$/.test(args[idx + 1]) ? args[idx + 1] : null;
    await generateMonthlyReport(month);
    return;
  }

  // --config-ui
  if (args.includes('--config-ui')) {
    await startConfigUI();
    return;
  }

  try {
    await callEagle('get_app_info', {});
  } catch (e) {
    log('❌ Eagle 連線失敗（請確認 Eagle 已開啟且 MCP plugin 已啟用）：', e.message);
    notify('Eagle Inspiration Bot 失敗', 'Eagle 連線失敗，請確認 Eagle 已開啟');
    process.exit(1);
  }

  const globalStats = { awwwards: null, mobbin: null };

  try {
    await runAwwwardsFlow(globalStats);
  } catch (e) {
    log('❌ Awwwards 流程錯誤：', e.message);
  }

  try {
    await runMobbinFlow(globalStats);
  } catch (e) {
    log('❌ Mobbin 流程錯誤：', e.message);
  }

  try {
    await runGodlyFlow(globalStats);
  } catch (e) {
    log('❌ Godly 流程錯誤：', e.message);
  }

  // 跑完順便補上個月的月報（若尚未存在）
  try {
    await maybeAutoGenerateLastMonthReport();
  } catch (e) {
    log('⚠ 月報自動生成失敗：', e.message);
  }

  // 桌面通知
  const aw = globalStats.awwwards || { added: 0 };
  const mb = globalStats.mobbin || { added: 0 };
  const gd = globalStats.godly || { added: 0 };
  const total = aw.added + mb.added + gd.added;
  const body = `本週新增 ${total} 筆 · Awwwards ${aw.added} · Mobbin ${mb.added}（${mb.appCount?.size || 0} app） · Godly ${gd.added}`;
  notify('Eagle Inspiration Bot', body);
  log('\n=== 結束 ===');
  log(body);
}

main().catch((e) => {
  log('❌ 未預期錯誤：', e.stack || e.message);
  notify('Eagle Inspiration Bot 失敗', e.message || '未知錯誤');
  process.exit(1);
});
