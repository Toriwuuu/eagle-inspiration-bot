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

function isMobbinBlocked(flow, blocklist) {
  const apps = (blocklist?.mobbinApps || []).filter(Boolean);
  if (flow.appName && apps.includes(flow.appName)) return `app:${flow.appName}`;
  return null;
}

// 處理單一 flow → 寫進 Eagle（共用 latest / category / retry 邏輯）
async function ingestMobbinFlow(flow, ctx) {
  const { folderId, baseTags, source, existingStableIds, stats, newlyFailedRef } = ctx;
  const displayName = `${flow.appName || 'Unknown'} - ${flow.stableId.slice(0, 8)}`;
  log(`  [${source}] ${displayName}`);

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
        log(`\n--- Mobbin Latest (${feed.maxApps} apps × ${feed.screensPerApp} screens) ---`);
        const url = `${MOBBIN_BASE}/discover/apps/${cfg.platform}/latest`;
        const flows = await fetchMobbinFlows(context, url, feed.maxApps, feed.screensPerApp, 'latest');
        log(`找到 ${flows.length} 個 flow`);
        for (const flow of flows) {
          await ingestMobbinFlow(flow, { ...ctx, source: 'latest' });
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
          for (const flow of flows) {
            await ingestMobbinFlow(flow, {
              ...ctx,
              source: tag,
              baseTags: [...cfg.extraTags, `category:${category}`],
            });
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

  // 桌面通知
  const aw = globalStats.awwwards || { added: 0 };
  const mb = globalStats.mobbin || { added: 0 };
  const total = aw.added + mb.added;
  const body =
    `本週新增 ${total} 筆 · Awwwards ${aw.added}（含黑名單 ${aw.blocked || 0} / 跳過 ${aw.skipped || 0}） · Mobbin ${mb.added}（${mb.appCount?.size || 0} 個 app）`;
  notify('Eagle Inspiration Bot', body);
  log('\n=== 結束 ===');
  log(body);
}

main().catch((e) => {
  log('❌ 未預期錯誤：', e.stack || e.message);
  notify('Eagle Inspiration Bot 失敗', e.message || '未知錯誤');
  process.exit(1);
});
