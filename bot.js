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
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- 路徑與設定 ----------
const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
// Eagle 內建 REST API（Eagle App 一開啟就有，不需要任何 plugin）
// 預設 http://localhost:41595，可用環境變數覆寫
const EAGLE_API = process.env.EAGLE_API_BASE || 'http://localhost:41595';
const EAGLE_API_TOKEN = process.env.EAGLE_API_TOKEN || '';
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

// 手動單跑某來源時，把列表撈深一點，這樣可以跳過已抓過的、繼續往下湊
function poolSizeForManual(target, multiplier = 5, cap = 60) {
  return Math.max(target, Math.min(target * multiplier, cap));
}

// 預載指定資料夾裡的所有 annotation，用 regex 抽出某個 key 的 URL（例：Awwwards: https://...）
// 目的：在進 detail 頁之前就過濾掉已抓過的項目，省下大量網路請求
function normalizeUrl(u) {
  if (!u) return u;
  // 拿掉常見的 utm / ref query，方便和 listing URL 對齊
  return u.replace(/[?&](ref|utm_\w+)=[^&]*/gi, '').replace(/[?&]$/, '').trim();
}
async function loadExistingUrlsFromAnnotation(folderId, pattern) {
  try {
    const existing = await callEagle('item_get', {
      folders: [folderId],
      fullDetails: true,
      limit: 1000,
    });
    const list = existing?.data || existing?.result || existing;
    const set = new Set();
    if (Array.isArray(list)) {
      for (const it of list) {
        const m = (it.annotation || '').match(pattern);
        if (m) set.add(normalizeUrl(m[1]));
      }
    }
    return set;
  } catch (e) {
    log(`⚠ 預載 Eagle 資料夾現有 URL 失敗：${e.message}`);
    return new Set();
  }
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

// ---------- Eagle 內建 REST API 相容層 ----------
// 對外保留原本的 callEagle(tool, params) 介面，內部全部改打 Eagle 內建 API。
// 好處：bot.js 其他地方一行都不用改，也不再依賴 Claude skill 或 Eagle MCP plugin。

async function eagleFetch(method, pathname, { query, body } = {}) {
  const qs = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
  }
  if (EAGLE_API_TOKEN) qs.set('token', EAGLE_API_TOKEN);
  const q = qs.toString();
  const url = EAGLE_API + pathname + (q ? `?${q}` : '');
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(url, opts);
  } catch (e) {
    throw new Error(`Eagle API 連不上（${EAGLE_API}）：${e.message}`);
  }
  let json = null;
  try { json = await r.json(); } catch { /* 非 JSON 回應 */ }
  if (!r.ok || (json && json.status && json.status !== 'success')) {
    const msg = (json && (json.message || JSON.stringify(json))) || `HTTP ${r.status}`;
    throw new Error(`Eagle API 錯誤 (${pathname}): ${msg}`);
  }
  return json;
}

// 「依 URL 找」是兜底去重用的，但內建 API 不支援 url 過濾。
// 折衷：掃近 1000 筆最新項目，比對 item.url 或 annotation 內含這個網址。
// 加 5 分鐘快取，避免 loop 裡每筆都重撈。
let _recentCache = { at: 0, items: [] };
async function eagleRecentItems() {
  if (_recentCache.items.length && Date.now() - _recentCache.at < 5 * 60 * 1000) {
    return _recentCache.items;
  }
  const j = await eagleFetch('GET', '/api/item/list', { query: { limit: 1000 } });
  _recentCache = { at: Date.now(), items: j?.data || [] };
  return _recentCache.items;
}

// 內建 API 的 folders 過濾「不含子資料夾」，但舊 MCP 是會遞迴的。
// Mobbin / Land-book 的 item 都被 reorganize 搬進子資料夾，所以查根資料夾時
// 要把每個 folder id 展開成「自己 + 所有子孫」，否則月報 / 縮圖牆會看不到它們。
let _folderTreeCache = { at: 0, tree: [] };
async function eagleFolderTree() {
  if (_folderTreeCache.tree.length && Date.now() - _folderTreeCache.at < 60 * 1000) {
    return _folderTreeCache.tree;
  }
  const j = await eagleFetch('GET', '/api/folder/list');
  _folderTreeCache = { at: Date.now(), tree: j?.data || [] };
  return _folderTreeCache.tree;
}
function collectDescendantIds(nodes, wanted, acc, capturing) {
  for (const f of nodes) {
    const isTarget = capturing || wanted.has(f.id);
    if (isTarget) acc.add(f.id);
    if (f.children && f.children.length) {
      collectDescendantIds(f.children, wanted, acc, isTarget);
    }
  }
  return acc;
}
async function expandFolderIds(ids) {
  const wanted = new Set(ids);
  const tree = await eagleFolderTree();
  const acc = collectDescendantIds(tree, wanted, new Set(), false);
  for (const id of ids) acc.add(id); // 保底：要求的 id 一定包含
  return [...acc];
}

async function callEagle(tool, params = {}) {
  switch (tool) {
    case 'get_app_info':
      return eagleFetch('GET', '/api/application/info');

    case 'folder_get': {
      // 內建 /api/folder/list 直接回完整巢狀資料夾樹（每層有 children）
      const j = await eagleFetch('GET', '/api/folder/list');
      return { data: j?.data || [] };
    }

    case 'folder_create': {
      const out = [];
      for (const f of params.folders || []) {
        const j = await eagleFetch('POST', '/api/folder/create', {
          body: { folderName: f.name, ...(f.parentId ? { parent: f.parentId } : {}) },
        });
        if (j?.data) out.push(j.data);
      }
      _folderTreeCache.at = 0; // 新資料夾建好，失效快取
      return { data: out };
    }

    case 'item_get': {
      if (params.url) {
        const target = normalizeUrl(params.url);
        const items = await eagleRecentItems();
        const hit = items.filter(
          (it) =>
            normalizeUrl(it.url || '') === target ||
            (it.annotation || '').includes(params.url)
        );
        return { data: hit.slice(0, params.limit || hit.length) };
      }
      const query = { limit: params.limit || 200 };
      if (params.folders && params.folders.length) {
        query.folders = await expandFolderIds(params.folders); // 含子資料夾
      }
      if (params.tags && params.tags.length) query.tags = params.tags;
      const j = await eagleFetch('GET', '/api/item/list', { query });
      return { data: j?.data || [] };
    }

    case 'item_add': {
      const sharedTags = params.tags || [];
      const folderId = (params.folders || [])[0];
      let ok = 0;
      let lastErr = null;
      for (const it of params.items || []) {
        const src = it.source || {};
        const mediaUrl = src.url;
        try {
          await eagleFetch('POST', '/api/item/addFromURL', {
            body: {
              url: mediaUrl,
              name: it.name || 'untitled',
              // 跟舊 MCP plugin 行為一致：item.url 存「來源頁網址」(作品/詳情頁)，
              // 不是媒體檔網址。這樣新舊資料一致，dashboard 邏輯不用改。
              // 點擊用的連結是 dashboard 從 annotation 解析的，不靠 item.url。
              website: src.website || mediaUrl,
              tags: [...sharedTags, ...(it.tags || [])],
              annotation: it.annotation || params.annotation || '',
              ...(folderId ? { folderId } : {}),
            },
          });
          ok++;
        } catch (e) {
          lastErr = e;
        }
      }
      if (ok === 0 && lastErr) throw lastErr;
      _recentCache.at = 0; // 失效快取，讓後續去重看得到剛加進去的
      return { data: { added: ok } };
    }

    case 'item_update': {
      for (const it of params.items || []) {
        const body = { id: it.id };
        const folders = it.folders || params.folders;
        const tags = it.tags || params.tags;
        const annotation = it.annotation ?? params.annotation;
        if (folders) body.folders = folders;
        if (tags) body.tags = tags;
        if (annotation !== undefined) body.annotation = annotation;
        await eagleFetch('POST', '/api/item/update', { body });
      }
      return { data: { updated: (params.items || []).length } };
    }

    default:
      throw new Error(`callEagle: 未支援的動作 ${tool}`);
  }
}

// Eagle 資料夾
async function ensureFolder(name) {
  const tree = await callEagle('folder_get', { getAllHierarchy: true, fullDetails: true });
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

function findDirectChildByName(folders, name) {
  if (!Array.isArray(folders)) return null;
  return folders.find((f) => f.name === name) || null;
}

// 依路徑（陣列）確保整條資料夾鏈存在；沒有就一層一層建。回傳最末層 folder id
// 例：ensureFolderPath(['Mobbin', 'iOS', 'SaaS']) → 'leafFolderId'
async function ensureFolderPath(pathArray) {
  if (!Array.isArray(pathArray) || !pathArray.length) {
    throw new Error('ensureFolderPath: 空路徑');
  }
  const tree = await callEagle('folder_get', { getAllHierarchy: true, fullDetails: true });
  let level = tree?.data || tree?.result || tree || [];
  let parentId = null;
  let leafId = null;
  for (const segment of pathArray) {
    const existing = findDirectChildByName(level, segment);
    if (existing) {
      leafId = existing.id;
      parentId = existing.id;
      level = existing.children || existing.folders || [];
    } else {
      const created = await callEagle('folder_create', {
        folders: [{ name: segment, ...(parentId ? { parentId } : {}) }],
      });
      const newFolder = (created?.data || created?.result || created)?.[0] || created;
      leafId = newFolder.id || newFolder.folderId;
      parentId = leafId;
      level = [];
      log(`  建立資料夾「${pathArray.slice(0, pathArray.indexOf(segment) + 1).join(' / ')}」`);
    }
  }
  return leafId;
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

async function readAwwwardsSiteUrls(page) {
  const hrefs = await page.$$eval('a[href^="/sites/"]', (els) =>
    els.map((a) => a.getAttribute('href'))
  );
  const unique = [...new Set(hrefs)].filter((h) => /^\/sites\/[a-z0-9-]+\/?$/i.test(h));
  return unique.map((h) => AWWWARDS_BASE + h);
}

async function fetchAwwwardsListing(context, listUrl, opts = {}) {
  // 兼容兩種 API：傳 number 就是 legacy max；傳 object 就是 progressive 模式
  const isLegacy = typeof opts === 'number';
  const max = isLegacy ? opts : (opts.max || 100);
  const targetNew = isLegacy ? 0 : (opts.targetNew || 0);
  const existingSet = isLegacy ? null : (opts.existingSet || null);
  const maxScrolls = isLegacy ? 0 : (opts.maxScrolls || 0);

  const page = await context.newPage();
  try {
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    let urls = await readAwwwardsSiteUrls(page);

    if (targetNew && existingSet) {
      let lastCount = urls.length;
      let stagnant = 0;
      for (let scrolls = 0; scrolls < maxScrolls; scrolls++) {
        const newCount = urls.filter((u) => !existingSet.has(normalizeUrl(u))).length;
        if (newCount >= targetNew) break;
        await page.evaluate(() => window.scrollBy(0, 1500));
        await page.waitForTimeout(700);
        urls = await readAwwwardsSiteUrls(page);
        if (urls.length === lastCount) {
          if (++stagnant >= 2) break;
        } else {
          stagnant = 0;
          lastCount = urls.length;
        }
      }
      return urls;
    }

    return urls.slice(0, max);
  } finally {
    await page.close();
  }
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

async function runAwwwardsFlow(globalStats, opts = {}) {
  const cfg = CONFIG.awwwards;
  if (!cfg?.enabled) {
    log('Awwwards 流程：已停用，跳過');
    return;
  }
  const manual = !!opts.manual;

  log('\n========== Awwwards 流程 ==========');
  if (manual) log('手動模式：每個來源都會撈深一點、跳過已抓過的');
  const folderId = await ensureFolder(cfg.eagleFolderName);
  const { browser, context } = await openHeadlessBrowser();
  const stats = { added: 0, skipped: 0, failed: 0, blocked: 0, videoCount: 0, imageCount: 0 };

  try {
    let sources = (cfg.sources || []).filter((s) => s.enabled);
    // 手動篩選：使用者只勾了部分 sub-source（sotd / nominees）
    if (manual && Array.isArray(opts.manualFilter?.sources)) {
      const allowed = new Set(opts.manualFilter.sources);
      const before = sources.length;
      sources = sources.filter((s) => allowed.has(s.type));
      log(`手動篩選 sub-source：${[...allowed].join(', ')}（${before} → ${sources.length}）`);
    }
    if (!sources.length) {
      log('⚠ 沒有啟用的 Awwwards source（檢查 config.awwwards.sources 或手動篩選）');
      return;
    }

    // 預載：把資料夾裡所有「Awwwards: <url>」的細節頁網址收進 Set，待會用來預過濾 listing
    const existingAwwwardsUrls = await loadExistingUrlsFromAnnotation(
      folderId,
      /Awwwards:\s*(https?:\/\/\S+)/i,
    );
    log(`現有 ${existingAwwwardsUrls.size} 個 Awwwards 細節頁在資料夾內（預過濾用）`);

    for (const src of sources) {
      const listUrl = AWWWARDS_SOURCE_URLS[src.type];
      if (!listUrl) {
        log(`⚠ 未知 source type："${src.type}"，跳過`);
        continue;
      }
      const target = (manual && opts.manualTarget) ? opts.manualTarget : src.maxSites;
      log(`\n--- Awwwards ${src.type.toUpperCase()} (目標 ${target}${manual ? '，滾到湊夠為止' : ''}) ---`);
      log(`從 ${listUrl} 抓列表…`);

      const allListed = manual
        ? await fetchAwwwardsListing(context, listUrl, {
            targetNew: target,
            existingSet: existingAwwwardsUrls,
            maxScrolls: 12,
          })
        : await fetchAwwwardsListing(context, listUrl, target);
      // 預過濾：跳過 Set 裡已有的，省下進 detail 頁
      const filtered = allListed.filter((u) => !existingAwwwardsUrls.has(normalizeUrl(u)));
      const prefiltered = allListed.length - filtered.length;
      log(`  共讀到 ${allListed.length} 個，新的 ${filtered.length} 個，已過濾 ${prefiltered} 個`);
      if (prefiltered > 0) stats.skipped += prefiltered;

      let newAddedSites = 0;
      for (const [i, url] of filtered.entries()) {
        if (newAddedSites >= target) {
          log(`\n✓ ${src.type}: 已湊到 ${target} 個新作品，停止`);
          break;
        }
        log(`\n[${src.type} ${i + 1}/${filtered.length}] ${url}`);
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

          // 兜底：若 Awwwards URL 預過濾沒抓到（比方說早期沒寫 annotation），再用 liveUrl 再檢查一次
          if (cfg.skipIfLiveUrlExists && detail.liveUrl) {
            const exist = await callEagle('item_get', { url: detail.liveUrl, limit: 1 });
            const list = exist?.data || exist?.result || exist;
            if (Array.isArray(list) && list.length > 0) {
              log('  ⏭ Eagle 內已有此作品（liveUrl 比對），跳過');
              stats.skipped++;
              existingAwwwardsUrls.add(normalizeUrl(url));
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
            opts.runId ? `RunId: ${opts.runId}` : null,
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
          newAddedSites++;
          existingAwwwardsUrls.add(normalizeUrl(url));
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
  const { folderId, baseTags, source, existingStableIds, stats, newlyFailedRef, runId } = ctx;
  const kindLabel = flow.kind === 'animation' ? '🎬' : '📱';
  const displayName = `${flow.appName || 'Unknown'} - ${flow.stableId.slice(0, 8)}`;
  log(`  [${source}] ${kindLabel} ${displayName}`);

  // 黑名單
  const blockedBy = isMobbinBlocked(flow, CONFIG.blocklist);
  if (blockedBy) {
    log(`    🚫 黑名單命中（${blockedBy}）`);
    stats.blocked++;
    return false;
  }

  // 去重
  if (CONFIG.mobbin.skipIfSourceUrlExists && existingStableIds.has(flow.stableId)) {
    log('    ⏭ 已存在');
    stats.skipped++;
    return false;
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
    return false;
  }

  const annotation = [
    `App: ${flow.appName || '(unknown)'}`,
    `來源：Mobbin ${source}`,
    flow.detailUrl ? `Mobbin: ${flow.detailUrl}` : null,
    `stableId: ${flow.stableId}`,
    `抓取時間：${new Date().toISOString().slice(0, 10)}`,
    runId ? `RunId: ${runId}` : null,
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
  return true;
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

async function runMobbinFlow(globalStats, opts = {}) {
  const cfg = CONFIG.mobbin;
  if (!cfg?.enabled) {
    log('Mobbin 流程：已停用，跳過');
    return;
  }
  const manual = !!opts.manual;

  log('\n========== Mobbin 流程 ==========');
  if (manual) log('手動模式：每個來源都會撈深一點、跳過已抓過的');
  if (!fs.existsSync(MOBBIN_PROFILE_DIR)) {
    log('⚠ Mobbin profile 不存在，請從 dashboard 點「立刻登入」完成 Mobbin 登入');
    return;
  }

  // 確保根資料夾存在；子資料夾按 (platform, category) 才動態建
  const rootFolderName = cfg.eagleFolderName;
  const folderId = await ensureFolder(rootFolderName);
  // 子資料夾 cache：key = `${platform}|${category}` → leaf folder id
  // 第一次用到才建，省 API call
  const folderCache = new Map();
  async function getMobbinLeafFolderId(platform, category) {
    const key = `${platform}|${category}`;
    if (folderCache.has(key)) return folderCache.get(key);
    const platLabel = platform === 'ios' ? 'iOS' : 'Web';
    const catLabel = category === '*' ? '全站最新' : category;
    const id = await ensureFolderPath([rootFolderName, platLabel, catLabel]);
    folderCache.set(key, id);
    return id;
  }

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
      log('⚠ Mobbin session 失效，請從 dashboard 點「立刻登入」重新登入 Mobbin');
      globalStats.mobbin = stats;
      return;
    }
    log('✓ Mobbin session 有效');

    // 預載已存在的 stableIds（去重用）— 用 tag 查，不受資料夾結構影響
    const existingStableIds = new Set();
    if (cfg.skipIfSourceUrlExists) {
      const existing = await callEagle('item_get', {
        tags: ['mobbin'],
        fullDetails: true,
        limit: 1000,
      });
      const existingList = existing?.data || existing?.result || existing;
      if (Array.isArray(existingList)) {
        for (const it of existingList) {
          const m = (it.annotation || '').match(/stableId:\s*([0-9a-f-]{36})/i);
          if (m) existingStableIds.add(m[1]);
        }
        log(`現有 ${existingStableIds.size} 個 stableId 在 Mobbin 資料夾樹內`);
      }
    }

    // 支援多平台：cfg.platforms 是陣列；若舊版只有 cfg.platform 也接受
    let platforms = (Array.isArray(cfg.platforms) && cfg.platforms.length
      ? cfg.platforms
      : (cfg.platform ? [cfg.platform] : ['ios']));
    // 手動篩選：使用者指定要跑哪些平台
    if (manual && Array.isArray(opts.manualFilter?.platforms)) {
      platforms = opts.manualFilter.platforms.filter((p) => ['ios', 'web'].includes(p));
      log(`手動篩選平台：${platforms.join(', ')}`);
    }

    const retryCtx = {
      folderId,
      baseTags: cfg.extraTags,
      existingStableIds,
      stats,
      newlyFailedRef: newlyFailed,
    };

    // 1. 先 retry 上次失敗
    await retryFailedUrls(retryCtx);

    // 2. 跑每個啟用的 feed × 每個 platform
    const feeds = (cfg.feeds || []).filter((f) => f.enabled);
    const blockedCats = (CONFIG.blocklist?.mobbinCategories || []).filter(Boolean);

    for (const platform of platforms) {
      const platformTag = `platform:${platform}`;
      const ctx = {
        folderId,
        baseTags: [...cfg.extraTags, platformTag],
        existingStableIds,
        stats,
        newlyFailedRef: newlyFailed,
        runId: opts.runId,
      };
      log(`\n===== Mobbin 平台：${platform} =====`);

      // 手動模式下使用者有自己挑分類時，獨立的 latest feed 不要硬跑：
      // category feed 已能處理「全站最新」(* sentinel)，使用者沒勾就代表不想要 latest
      const manualPickedCats = !!(manual && opts.manualFilter?.categoriesByPlatform);
      const hasEnabledCategoryFeed = feeds.some((f) => f.type === 'category');

      for (const feed of feeds) {
        if (feed.type === 'latest') {
          if (manualPickedCats && hasEnabledCategoryFeed) {
            log(`\n--- Mobbin Latest [${platform}]：手動模式已指定分類，跳過全站最新（如需最新請勾「全站最新」）---`);
            continue;
          }
          // 支援每平台各自的設定：feed.byPlatform[platform] 優先，沒設就用舊版 maxApps / screensPerApp
          const perPlat = (feed.byPlatform && feed.byPlatform[platform]) || {};
          const configTarget = perPlat.maxApps ?? feed.maxApps ?? 5;
          const target = (manual && opts.manualTarget) ? opts.manualTarget : configTarget;
          const screensPerApp = perPlat.screensPerApp ?? feed.screensPerApp ?? 3;
          const poolSize = manual ? poolSizeForManual(target) : target;
          log(`\n--- Mobbin Latest [${platform}] (目標 ${target} apps × ${screensPerApp} 筆/app${manual ? `，池 ${poolSize}` : ''}) ---`);
          const url = `${MOBBIN_BASE}/discover/apps/${platform}/latest`;
          const leafFolderId = await getMobbinLeafFolderId(platform, '*');
          const flows = await fetchMobbinFlows(context, url, poolSize, 1, 'latest');
          log(`找到 ${flows.length} 個 flow video`);
          let newAddedApps = 0;
          for (const flow of flows) {
            if (manual && newAddedApps >= target) {
              log(`  ✓ latest [${platform}]: 已湊到 ${target} 個新 app，停止`);
              break;
            }
            const added = await ingestMobbinFlow({ ...flow, kind: 'flow_video' }, { ...ctx, source: 'latest', folderId: leafFolderId });
            if (added) newAddedApps++;
            const extraNeeded = (screensPerApp || 1) - 1;
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
                  { ...ctx, source: 'latest', folderId: leafFolderId }
                );
              }
            }
          }
        } else if (feed.type === 'category') {
          // 手動篩選優先：使用者直接指定本次要跑哪些分類
          const manualCats = (manual && opts.manualFilter?.categoriesByPlatform?.[platform]) || null;
          let pickedCats;
          if (manualCats) {
            pickedCats = manualCats.filter((c) => c === '*' || !blockedCats.includes(c));
            if (!pickedCats.length) {
              log(`⚠ Mobbin [${platform}]：手動篩選後沒有任何分類`);
              continue;
            }
            log(`\n--- Mobbin 手動選擇 [${platform}] ---`);
          } else {
            // 自動：讀 config 分類池，依本週輪換
            const platCats = (feed.categoriesByPlatform && feed.categoriesByPlatform[platform])
              || feed.categories
              || [];
            if (!platCats.length) {
              log(`⚠ Mobbin category [${platform}]：沒有設定任何分類，跳過`);
              continue;
            }
            pickedCats = pickCategoriesForWeek(platCats, feed.categoriesPerRun || 1)
              .filter((c) => !blockedCats.includes(c));
            if (!pickedCats.length) {
              log(`⚠ Mobbin category [${platform}]：本週沒挑到任何分類（檢查 blocklist 是否擋掉全部）`);
              continue;
            }
            log(`\n--- Mobbin 來源輪換 [${platform}]（本週 ISO 週 ${getIsoWeek()}）---`);
          }
          log(`本週來源：${pickedCats.map((c) => (c === '*' ? '全站最新' : c)).join(', ')}`);
          for (const category of pickedCats) {
            const isAll = category === '*';
            const url = isAll
              ? `${MOBBIN_BASE}/discover/apps/${platform}/latest`
              : `${MOBBIN_BASE}/search/apps/${platform}?content_type=apps&sort=publishedAt&filter=appCategories.${encodeURIComponent(category).replace(/%20/g, '+')}`;
            const label = isAll ? `latest:${platform}` : `category:${category}`;
            const displayName = isAll ? '全站最新' : category;
            const target = (manual && opts.manualTarget) ? opts.manualTarget : feed.maxAppsPerCategory;
            const poolSize = manual ? poolSizeForManual(target) : target;
            const leafFolderId = await getMobbinLeafFolderId(platform, category);
            const flows = await fetchMobbinFlows(
              context,
              url,
              poolSize,
              1,
              label
            );
            log(`  ${displayName}: 找到 ${flows.length} 個 flow${manual ? `（目標 ${target}，撈深一點）` : ''}`);
            const tag = isAll ? `source:latest` : `category:${category}`;
            const catBaseTags = [...cfg.extraTags, platformTag, tag];
            const extraNeeded = (feed.screensPerApp || 1) - 1;
            let newAddedApps = 0;
            for (const flow of flows) {
              if (manual && newAddedApps >= target) {
                log(`  ✓ ${displayName}: 已湊到 ${target} 個新 app，停止`);
                break;
              }
              const added = await ingestMobbinFlow(
                { ...flow, kind: 'flow_video' },
                { ...ctx, source: tag, baseTags: catBaseTags, folderId: leafFolderId }
              );
              if (added) newAddedApps++;
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
                    { ...ctx, source: tag, baseTags: catBaseTags, folderId: leafFolderId }
                  );
                }
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

// 從 item 的 tags 推出該歸到哪個 (platform, category) 子資料夾
function classifyMobbinItem(tags) {
  let platform = null;
  let category = null;
  for (const t of tags || []) {
    if (t.startsWith('platform:')) platform = t.slice('platform:'.length);
    else if (t.startsWith('category:')) category = t.slice('category:'.length);
    else if (t === 'source:latest' || t === 'latest') category = '*';
  }
  // 舊資料沒寫 platform → 預設 ios（早期只有 iOS）
  if (!platform) platform = 'ios';
  // 沒有任何分類 / latest 標記 → 當成全站最新
  if (!category) category = '*';
  return { platform, category };
}

// 把現有 Mobbin 資料夾裡的 item 依 tag 重新分類進 Mobbin/<平台>/<分類> 子資料夾
async function reorganizeMobbin() {
  const cfg = CONFIG.mobbin;
  const rootFolderName = cfg?.eagleFolderName || 'Mobbin';
  log('=== 重新整理 Mobbin 資料夾結構 ===');

  // 抓所有有 mobbin tag 的 item
  const res = await callEagle('item_get', {
    tags: ['mobbin'],
    fullDetails: true,
    limit: 1000, // Eagle API 上限就是 1000，超過會回參數錯誤
  });
  const items = res?.data || res?.result || res;
  if (!Array.isArray(items) || !items.length) {
    log('沒有任何帶 mobbin tag 的 item，結束');
    return;
  }
  log(`找到 ${items.length} 個 Mobbin item，開始分類…`);

  // 依目標子資料夾分組
  const groups = new Map(); // key = `${platform}|${category}` → { platform, category, ids: [] }
  for (const it of items) {
    const { platform, category } = classifyMobbinItem(it.tags);
    const key = `${platform}|${category}`;
    if (!groups.has(key)) groups.set(key, { platform, category, ids: [] });
    groups.get(key).ids.push(it.id);
  }

  log(`分成 ${groups.size} 組：`);
  for (const { platform, category, ids } of groups.values()) {
    const catLabel = category === '*' ? '全站最新' : category;
    log(`  ${platform === 'ios' ? 'iOS' : 'Web'} / ${catLabel} — ${ids.length} 筆`);
  }

  // 逐組建好子資料夾、批次搬移
  const folderCache = new Map();
  let moved = 0;
  for (const { platform, category, ids } of groups.values()) {
    const platLabel = platform === 'ios' ? 'iOS' : 'Web';
    const catLabel = category === '*' ? '全站最新' : category;
    const cacheKey = `${platform}|${category}`;
    let leafId = folderCache.get(cacheKey);
    if (!leafId) {
      leafId = await ensureFolderPath([rootFolderName, platLabel, catLabel]);
      folderCache.set(cacheKey, leafId);
    }
    // item_update 一次帶整組（folders 用 shared 參數，items 只給 id）
    const BATCH = 50;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      await callEagle('item_update', {
        folders: [leafId],
        items: slice.map((id) => ({ id })),
      });
      moved += slice.length;
      log(`  ${platLabel} / ${catLabel}：已搬 ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
    }
  }

  log(`\n✓ 完成：共重新分類 ${moved} 筆到 ${groups.size} 個子資料夾`);
}

// 通用：依某個 tag 前綴把單一來源資料夾分進子資料夾（Godly / Land-book 共用）
async function reorganizeByTagPrefix({ rootName, sourceTag, prefix, fallback }) {
  log(`=== 重新整理 ${rootName} 資料夾結構 ===`);
  const res = await callEagle('item_get', {
    tags: [sourceTag],
    fullDetails: true,
    limit: 1000, // Eagle API 上限
  });
  const items = res?.data || res?.result || res;
  if (!Array.isArray(items) || !items.length) {
    log(`沒有任何帶 ${sourceTag} tag 的 item，結束`);
    return;
  }
  log(`找到 ${items.length} 個 ${rootName} item，開始分類…`);

  const groups = new Map(); // label → ids[]
  for (const it of items) {
    const hit = (it.tags || []).find((t) => t.startsWith(prefix));
    const label = hit ? hit.slice(prefix.length).trim() || fallback : fallback;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(it.id);
  }

  log(`分成 ${groups.size} 組：`);
  for (const [label, ids] of groups) log(`  ${label} — ${ids.length} 筆`);

  let moved = 0;
  for (const [label, ids] of groups) {
    const leafId = await ensureFolderPath([rootName, label]);
    const BATCH = 50;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      await callEagle('item_update', {
        folders: [leafId],
        items: slice.map((id) => ({ id })),
      });
      moved += slice.length;
      log(`  ${label}：已搬 ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
    }
  }
  log(`\n✓ 完成：共重新分類 ${moved} 筆到 ${groups.size} 個子資料夾`);
}

const reorganizeGodly = () =>
  reorganizeByTagPrefix({ rootName: CONFIG.godly?.eagleFolderName || 'Godly', sourceTag: 'godly', prefix: 'godly-type:', fallback: '未分類' });

const reorganizeLandbook = () =>
  reorganizeByTagPrefix({ rootName: CONFIG.landbook?.eagleFolderName || 'Land-book', sourceTag: 'landbook', prefix: 'lb-cat:', fallback: '未分類' });

// =====================================================================
//                          Godly.website 流程
// =====================================================================

const GODLY_BASE = 'https://godly.website';

async function readGodlyUrls(page) {
  const hrefs = await page.$$eval('a[href^="/website/"]', (els) =>
    els.map((a) => a.getAttribute('href'))
  );
  return [...new Set(hrefs)].map((h) => GODLY_BASE + h);
}

// 「滾到湊夠新項目為止」：每滾一輪讀完整列表，filter 後若新的 < targetNew 就繼續
async function fetchGodlyListing(context, { targetNew, existingSet, maxScrolls = 12 } = {}) {
  const page = await context.newPage();
  try {
    await page.goto(GODLY_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    let urls = await readGodlyUrls(page);
    let lastCount = urls.length;
    let stagnant = 0;

    for (let scrolls = 0; scrolls < maxScrolls; scrolls++) {
      const newCount = existingSet
        ? urls.filter((u) => !existingSet.has(normalizeUrl(u))).length
        : urls.length;
      if (newCount >= (targetNew || 0)) break;

      await page.evaluate(() => window.scrollBy(0, 1500));
      await page.waitForTimeout(700);
      urls = await readGodlyUrls(page);

      if (urls.length === lastCount) {
        if (++stagnant >= 2) break;
      } else {
        stagnant = 0;
        lastCount = urls.length;
      }
    }

    return urls;
  } finally {
    await page.close();
  }
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

      // 分類：Godly 的 metadata chip 是 <a href="/?types=[...]">，文字就是人類可讀標籤
      const types = [
        ...new Set(
          Array.from(document.querySelectorAll('a[href*="?types="]'))
            .map((a) => a.textContent.trim())
            .filter((t) => t && t.length < 30)
        ),
      ];

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
        types,
      };
    });
    return { ...data, detailUrl };
  } finally {
    await page.close();
  }
}

async function runGodlyFlow(globalStats, opts = {}) {
  const cfg = CONFIG.godly;
  if (!cfg?.enabled) {
    log('Godly 流程：已停用，跳過');
    return;
  }
  const manual = !!opts.manual;
  const target = (manual && opts.manualTarget) ? opts.manualTarget : cfg.maxSites;
  log('\n========== Godly 流程 ==========');
  if (manual) log(`手動模式：滾到湊夠 ${target} 個新項目為止（最多滾 12 次）`);
  const folderId = await ensureFolder(cfg.eagleFolderName);
  const { browser, context } = await openHeadlessBrowser();
  const stats = { added: 0, skipped: 0, failed: 0, blocked: 0, videoCount: 0, imageCount: 0 };
  try {
    // 預載：用 annotation 裡的「Godly: <url>」當去重 key，這樣可以在進 detail 頁前先過濾
    const existingGodlyUrls = await loadExistingUrlsFromAnnotation(
      folderId,
      /Godly:\s*(https?:\/\/\S+)/i,
    );
    log(`現有 ${existingGodlyUrls.size} 個 Godly 細節頁在資料夾內（預過濾用）`);

    log(`從 ${GODLY_BASE}/ 抓列表…`);
    const allUrls = await fetchGodlyListing(context, {
      targetNew: target,
      existingSet: existingGodlyUrls,
      maxScrolls: manual ? 12 : 3,
    });
    const urls = allUrls.filter((u) => !existingGodlyUrls.has(normalizeUrl(u)));
    const prefiltered = allUrls.length - urls.length;
    log(`  滾完共讀到 ${allUrls.length} 個，新的 ${urls.length} 個，已過濾 ${prefiltered} 個`);
    if (prefiltered > 0) stats.skipped += prefiltered;
    let newAdded = 0;
    for (const [i, url] of urls.entries()) {
      if (newAdded >= target) {
        log(`\n✓ 已湊到 ${target} 個新項目，停止`);
        break;
      }
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
        // 兜底：若 godly URL 預過濾沒抓到（舊資料），再用 liveUrl 再檢查一次
        if (cfg.skipIfLiveUrlExists && detail.liveUrl) {
          const exist = await callEagle('item_get', { url: detail.liveUrl, limit: 1 });
          const list = exist?.data || exist?.result || exist;
          if (Array.isArray(list) && list.length > 0) {
            log('  ⏭ 已存在（liveUrl 比對）');
            stats.skipped++;
            existingGodlyUrls.add(normalizeUrl(url));
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
          tags: [
            ...cfg.extraTags,
            ...(detail.types || []).map((t) => `godly-type:${t}`),
          ],
          annotation: [
            `作品：${detail.title}`,
            `來源：Godly.website`,
            `Live: ${detail.liveUrl || '-'}`,
            `Godly: ${detail.detailUrl}`,
            `抓取時間：${new Date().toISOString().slice(0, 10)}`,
            opts.runId ? `RunId: ${opts.runId}` : null,
          ].filter(Boolean).join('\n'),
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
        newAdded++;
        existingGodlyUrls.add(normalizeUrl(url));
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
//                          Land-book 流程
// =====================================================================
// Land-book 是靜態圖庫（無影片）。首頁 /websites/ 列表卡片就含高解析縮圖，
// 細節頁有 Cloudflare 嚴格挑戰所以我們只抓首頁卡片（slug 解析出標題）。

const LANDBOOK_BASE = 'https://land-book.com';

function parseLandbookSlug(href) {
  // /websites/94564-floemaA-R-a-spaces-for-people-made-for-life
  const m = href.match(/^\/websites\/(\d+)-(.+)$/);
  if (!m) return { id: null, title: href };
  const id = m[1];
  let title = m[2].replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  title = title.replace(/\b\w/g, (c) => c.toUpperCase());
  return { id, title };
}

// 從 Land-book 首頁讀出當前 DOM 上的所有卡片
function readLandbookCardsFromPage(page) {
  return page.evaluate(() => {
    const out = [];
    const anchors = document.querySelectorAll('a[href^="/websites/"]');
    const seen = new Set();
    for (const a of anchors) {
      const href = a.getAttribute('href');
      if (!href || href.includes('#') || !/^\/websites\/\d+-.+/.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      let card = a.closest('article, li, div');
      while (card && !card.querySelector('img')) {
        card = card.parentElement;
        if (!card || card.tagName === 'BODY') {
          card = null;
          break;
        }
      }
      const img = card?.querySelector('img');
      const imgSrc = img?.src || img?.getAttribute('data-src') || null;
      if (!imgSrc || /favicon|logo|icon/i.test(imgSrc)) continue;
      // 類別：img alt 後綴「- <類別> design inspiration」是 Land-book 的權威分類徽章
      const alt = img?.getAttribute('alt') || '';
      const m = alt.match(/-\s*([A-Za-z]+)\s+design inspiration\s*$/i);
      const raw = m ? m[1].toLowerCase() : '';
      const cat =
        raw === 'landing' ? 'Landing Page'
        : raw === 'ecommerce' ? 'Ecommerce'
        : raw === 'portfolio' ? 'Portfolio'
        : raw === 'template' ? 'Template'
        : raw === 'blog' ? 'Blog'
        : 'Other';
      out.push({ href, imgSrc, cat });
    }
    return out;
  });
}

// 「滾到湊夠新卡為止」：每滾一輪重讀整頁卡片，filter 後若新的 < targetNew 就繼續滾
// 連續兩輪沒新增就視為到底，提前結束
async function fetchLandbookCards(context, { targetNew, existingSet, maxScrolls = 12 } = {}) {
  const page = await context.newPage();
  try {
    await page.goto(LANDBOOK_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Land-book 首頁靠 Cloudflare，等他放行
    await page.waitForTimeout(8000);

    let cards = await readLandbookCardsFromPage(page);
    let lastCount = cards.length;
    let stagnant = 0;

    for (let scrolls = 0; scrolls < maxScrolls; scrolls++) {
      const newCount = existingSet
        ? cards.filter((c) => !existingSet.has(normalizeUrl(LANDBOOK_BASE + c.href))).length
        : cards.length;
      if (newCount >= (targetNew || 0)) break;

      await page.evaluate(() => window.scrollBy(0, 1500));
      await page.waitForTimeout(700);
      cards = await readLandbookCardsFromPage(page);

      if (cards.length === lastCount) {
        if (++stagnant >= 2) break;
      } else {
        stagnant = 0;
        lastCount = cards.length;
      }
    }

    return cards;
  } finally {
    await page.close();
  }
}

async function runLandbookFlow(globalStats, opts = {}) {
  const cfg = CONFIG.landbook;
  if (!cfg?.enabled) {
    log('Land-book 流程：已停用，跳過');
    return;
  }
  const manual = !!opts.manual;
  const target = (manual && opts.manualTarget) ? opts.manualTarget : cfg.maxSites;
  log('\n========== Land-book 流程 ==========');
  if (manual) log(`手動模式：滾到湊夠 ${target} 個新項目為止（最多滾 12 次）`);
  const folderId = await ensureFolder(cfg.eagleFolderName);
  const { browser, context } = await openHeadlessBrowser();
  const stats = { added: 0, skipped: 0, failed: 0, blocked: 0 };
  try {
    // 預載：把資料夾裡所有「Detail: <url>」收進 Set（Land-book 的 detail URL 從 listing 就拿得到，最容易預過濾）
    const existingDetailUrls = await loadExistingUrlsFromAnnotation(
      folderId,
      /Detail:\s*(https?:\/\/\S+)/i,
    );
    log(`現有 ${existingDetailUrls.size} 個 Land-book detail 在資料夾內（預過濾用）`);

    log(`從 ${LANDBOOK_BASE}/ 抓首頁卡片…`);
    const allCards = await fetchLandbookCards(context, {
      targetNew: target,
      existingSet: existingDetailUrls,
      maxScrolls: manual ? 12 : 3,
    });
    const cards = allCards.filter((c) => !existingDetailUrls.has(normalizeUrl(LANDBOOK_BASE + c.href)));
    const prefiltered = allCards.length - cards.length;
    log(`  滾完共讀到 ${allCards.length} 張，新的 ${cards.length} 張，已過濾 ${prefiltered} 張`);
    if (prefiltered > 0) stats.skipped += prefiltered;
    let newAdded = 0;
    for (const [i, card] of cards.entries()) {
      if (newAdded >= target) {
        log(`\n✓ 已湊到 ${target} 個新項目，停止`);
        break;
      }
      const detailUrl = LANDBOOK_BASE + card.href;
      const { title } = parseLandbookSlug(card.href);
      log(`\n[landbook ${i + 1}/${cards.length}] ${title}`);
      try {
        const blockedBy = isAwwwardsBlocked({ title, tags: [] }, CONFIG.blocklist);
        if (blockedBy) {
          log(`  🚫 黑名單命中（"${blockedBy}"）`);
          stats.blocked++;
          continue;
        }
        // 兜底：預載漏掉的舊資料還是會被擋住
        if (cfg.skipIfSourceUrlExists) {
          const exist = await callEagle('item_get', { url: detailUrl, limit: 1 });
          const list = exist?.data || exist?.result || exist;
          if (Array.isArray(list) && list.length > 0) {
            log('  ⏭ 已存在');
            stats.skipped++;
            existingDetailUrls.add(normalizeUrl(detailUrl));
            continue;
          }
        }
        await callEagle('item_add', {
          folders: [folderId],
          tags: [...cfg.extraTags, `lb-cat:${card.cat || 'Other'}`],
          annotation: [
            `作品：${title}`,
            `來源：Land-book`,
            `Detail: ${detailUrl}`,
            `抓取時間：${new Date().toISOString().slice(0, 10)}`,
            opts.runId ? `RunId: ${opts.runId}` : null,
          ].filter(Boolean).join('\n'),
          items: [
            {
              source: { type: 'url', url: card.imgSrc, website: detailUrl },
              name: title,
            },
          ],
        });
        log('  ✓ 已加入 Eagle');
        stats.added++;
        newAdded++;
        existingDetailUrls.add(normalizeUrl(detailUrl));
      } catch (e) {
        log('  ❌ 失敗：', e.message);
        stats.failed++;
      }
    }
  } finally {
    await browser.close();
  }
  log(
    `\nLand-book 結果：新增 ${stats.added}／跳過 ${stats.skipped}／黑名單 ${stats.blocked}／失敗 ${stats.failed}`
  );
  globalStats.landbook = stats;
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
    log('⚠ Mobbin profile 不存在，請從 dashboard 點「立刻登入」完成 Mobbin 登入');
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
      log('⚠ Mobbin session 失效，請從 dashboard 點「立刻登入」重新登入 Mobbin');
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
    const platform = (Array.isArray(cfg.platforms) && cfg.platforms[0]) || cfg.platform || 'ios';
    const url = `${MOBBIN_BASE}/search/apps/${platform}?content_type=screens&sort=trending&filter=screenPatterns.${encoded}`;
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
    CONFIG.landbook?.eagleFolderName,
  ].filter(Boolean);

  const tree = await callEagle('folder_get', { getAllHierarchy: true, fullDetails: true });
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
    bySource: { awwwards: 0, mobbin: 0, godly: 0, landbook: 0, other: 0 },
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
    } else if (tags.includes('landbook')) {
      stats.bySource.landbook++;
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
| Land-book | ${stats.bySource.landbook} | ${pct(stats.bySource.landbook)}% |
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
  log(`  總計 ${stats.total} 筆（Awwwards ${stats.bySource.awwwards} / Mobbin ${stats.bySource.mobbin} / Godly ${stats.bySource.godly} / Land-book ${stats.bySource.landbook}）`);
}

// =====================================================================
//                      Dashboard 預覽輔助
// =====================================================================

// 從 annotation 抽出「網頁連結」（點擊縮圖跳轉用）
function extractWebsiteUrl(annotation, source) {
  if (!annotation) return null;
  const get = (label) => {
    const m = annotation.match(new RegExp('^' + label + ':\\s*(.+)$', 'm'));
    if (!m) return null;
    const v = m[1].trim();
    if (!v || v === '-') return null;
    return v;
  };
  // Awwwards / Godly：優先 Live（實際作品網站）
  if (source === 'awwwards') return get('Live') || get('Awwwards');
  if (source === 'godly')    return get('Live') || get('Godly');
  if (source === 'mobbin')   return get('Mobbin');
  if (source === 'landbook') return get('Detail');
  return get('Live') || get('Detail') || null;
}

// 撈所有來源資料夾、依日期遞減回近 N 天的 items（包含可直接播的 source URL）
async function fetchRecentItems(days) {
  const folderNames = [
    CONFIG.awwwards?.eagleFolderName,
    CONFIG.mobbin?.eagleFolderName,
    CONFIG.godly?.eagleFolderName,
    CONFIG.landbook?.eagleFolderName,
  ].filter(Boolean);

  const tree = await callEagle('folder_get', { getAllHierarchy: true, fullDetails: true });
  const tList = tree?.data || tree?.result || tree;
  const folderIds = [];
  for (const name of folderNames) {
    const f = findFolderByName(tList, name);
    if (f) folderIds.push(f.id);
  }
  if (!folderIds.length) return [];

  const all = [];
  for (const fid of folderIds) {
    const r = await callEagle('item_get', { folders: [fid], fullDetails: true, limit: 500 });
    const items = r?.data || [];
    all.push(...items);
  }

  const todayMs = Date.now();
  const cutoffMs = todayMs - days * 86400 * 1000;
  const parsed = all
    .map((it) => {
      const m = (it.annotation || '').match(/抓取時間：(\d{4}-\d{2}-\d{2})/);
      const date = m ? m[1] : null;
      const ms = date ? new Date(date).getTime() : 0;
      const ext = (it.ext || '').toLowerCase();
      const isVideo = /^(mp4|webm|mov|m4v)$/i.test(ext);
      const tags = it.tags || [];
      let source = 'other';
      if (tags.includes('awwwards')) source = 'awwwards';
      else if (tags.includes('mobbin')) source = 'mobbin';
      else if (tags.includes('godly')) source = 'godly';
      else if (tags.includes('landbook')) source = 'landbook';
      // sourceUrl: Eagle 把原始 URL 存在 url 欄位（媒體檔網址，hover 影片用）
      const sourceUrl = it.url || null;
      const annotation = it.annotation || '';
      // websiteUrl: 從 annotation 解析「網頁連結」(點擊用)
      // Awwwards / Godly 優先 Live（實際作品網站），其次來源頁
      // Mobbin / Land-book 用來源頁
      const websiteUrl = extractWebsiteUrl(annotation, source);
      // Eagle 內的精確時間：modificationTime 是 ms。沒有就退回 annotation 日期或 0
      const addedAt = it.modificationTime || it.importedAt || it.btime || ms || 0;
      // 從 annotation 抽 RunId：同一次 bot 啟動寫進去的都是同一個值
      const runIdMatch = (it.annotation || '').match(/RunId:\s*(\S+)/);
      const runId = runIdMatch ? runIdMatch[1] : null;
      return {
        id: it.id,
        name: it.name,
        date,
        ms,
        addedAt,
        runId,
        ext,
        isVideo,
        tags,
        source,
        sourceUrl,
        websiteUrl,
        annotation,
      };
    })
    .filter((x) => x.ms >= cutoffMs)
    .sort((a, b) => {
      if (b.ms !== a.ms) return b.ms - a.ms;
      // 同日資料 → interleave 各來源（讓每個 source 都有機會被看到）
      return (a.id || '').localeCompare(b.id || '');
    })
    .slice(0, 200);
  return parsed;
}

// 為了 dashboard preview，重用 generateMonthlyReport 的統計邏輯但不寫檔
async function previewMonthlyMarkdown(yearMonth) {
  // 簡化版：直接呼叫既有 generateMonthlyReport 後讀檔；但 generateMonthlyReport 會寫檔
  // 為了不污染 logs/，這裡複製核心邏輯成 inline，回傳字串即可
  const [year, month] = yearMonth.split('-').map(Number);

  const folderNames = [
    CONFIG.awwwards?.eagleFolderName,
    CONFIG.mobbin?.eagleFolderName,
    CONFIG.godly?.eagleFolderName,
    CONFIG.landbook?.eagleFolderName,
  ].filter(Boolean);
  const tree = await callEagle('folder_get', { getAllHierarchy: true, fullDetails: true });
  const tList = tree?.data || tree?.result || tree;
  const folderIds = [];
  for (const name of folderNames) {
    const f = findFolderByName(tList, name);
    if (f) folderIds.push(f.id);
  }
  if (!folderIds.length) return `# ${yearMonth}\n\n*找不到任何來源資料夾*`;

  const allItems = [];
  for (const fid of folderIds) {
    const r = await callEagle('item_get', { folders: [fid], fullDetails: true, limit: 1000 });
    allItems.push(...(r?.data || []));
  }
  const monthPrefix = yearMonth;
  const filtered = allItems.filter((it) =>
    (it.annotation || '').match(/抓取時間：(\d{4}-\d{2}-\d{2})/)?.[1]?.startsWith(monthPrefix)
  );

  const bySource = { awwwards: 0, mobbin: 0, godly: 0, landbook: 0, other: 0 };
  const byKind = { video: 0, image: 0 };
  const mobbinApps = {};
  for (const it of filtered) {
    const tags = it.tags || [];
    const ext = (it.ext || '').toLowerCase();
    if (/^(mp4|webm|mov|m4v)$/i.test(ext)) byKind.video++;
    else byKind.image++;
    if (tags.includes('awwwards')) bySource.awwwards++;
    else if (tags.includes('mobbin')) {
      bySource.mobbin++;
      const m = (it.annotation || '').match(/^App:\s*(.+?)$/m);
      if (m && m[1] !== '(unknown)') mobbinApps[m[1]] = (mobbinApps[m[1]] || 0) + 1;
    } else if (tags.includes('godly')) bySource.godly++;
    else if (tags.includes('landbook')) bySource.landbook++;
    else bySource.other++;
  }
  const total = filtered.length;
  const pct = (n) => (total ? Math.round((100 * n) / total) : 0);
  const topApps = Object.entries(mobbinApps).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return `# 即時月報預覽 ${yearMonth}

> 此份為 dashboard 即時計算（未寫入檔案）

- 本月已新增 **${total}** 筆
- 影片 ${byKind.video} · 圖片 ${byKind.image}

## 來源比例
- Awwwards ${bySource.awwwards}（${pct(bySource.awwwards)}%）
- Mobbin ${bySource.mobbin}（${pct(bySource.mobbin)}%）
- Godly ${bySource.godly}（${pct(bySource.godly)}%）
- Land-book ${bySource.landbook}（${pct(bySource.landbook)}%）

## Top Mobbin Apps
${topApps.length ? topApps.map(([app, n]) => `- ${app} × ${n}`).join('\n') : '*（本月暫無）*'}
`;
}

// =====================================================================
//                      自訂排程（dashboard 套用）
// =====================================================================

const LAUNCHD_LABEL = 'com.user.eagle-inspiration';
const LAUNCHD_PLIST = path.join(os.homedir(), 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`);

function buildLaunchdPlist(schedule) {
  const hour = clamp(parseInt(schedule.hour, 10) || 9, 0, 23);
  const minute = clamp(parseInt(schedule.minute, 10) || 0, 0, 59);
  const nodePath = process.execPath;
  const nodeDir = path.dirname(nodePath);
  let intervalXml;
  if (schedule.frequency === 'daily') {
    intervalXml = `        <key>Hour</key>\n        <integer>${hour}</integer>\n        <key>Minute</key>\n        <integer>${minute}</integer>`;
  } else if (schedule.frequency === 'monthly') {
    const day = clamp(parseInt(schedule.day, 10) || 1, 1, 28);
    intervalXml = `        <key>Day</key>\n        <integer>${day}</integer>\n        <key>Hour</key>\n        <integer>${hour}</integer>\n        <key>Minute</key>\n        <integer>${minute}</integer>`;
  } else {
    const weekday = clamp(parseInt(schedule.weekday, 10) ?? 1, 0, 6);
    intervalXml = `        <key>Weekday</key>\n        <integer>${weekday}</integer>\n        <key>Hour</key>\n        <integer>${hour}</integer>\n        <key>Minute</key>\n        <integer>${minute}</integer>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${path.join(ROOT, 'bot.js')}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${ROOT}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${nodeDir}:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
${intervalXml}
    </dict>
    <key>StandardOutPath</key>
    <string>${path.join(ROOT, 'logs/bot.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(ROOT, 'logs/bot.log')}</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
`;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function applySchedule(schedule) {
  const plist = buildLaunchdPlist(schedule);
  const launchAgents = path.join(os.homedir(), 'Library/LaunchAgents');
  if (!fs.existsSync(launchAgents)) fs.mkdirSync(launchAgents, { recursive: true });
  fs.writeFileSync(LAUNCHD_PLIST, plist);
  spawnSync('launchctl', ['unload', LAUNCHD_PLIST]);
  const r = spawnSync('launchctl', ['load', LAUNCHD_PLIST]);
  if (r.status !== 0) {
    throw new Error('launchctl load 失敗：' + (r.stderr?.toString() || `exit ${r.status}`));
  }
  return true;
}

function describeSchedule(s) {
  const hh = String(s.hour ?? 9).padStart(2, '0');
  const mm = String(s.minute ?? 0).padStart(2, '0');
  const time = `${hh}:${mm}`;
  if (s.frequency === 'daily') return `每天 ${time}`;
  if (s.frequency === 'monthly') return `每月 ${s.day ?? 1} 號 ${time}`;
  const names = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  return `每${names[s.weekday ?? 1]} ${time}`;
}

// =====================================================================
//                      Web Dashboard（--config-ui）
// =====================================================================

async function startConfigUI() {
  const http = require('http');
  const PORT = 3030;
  const HTML_PATH = path.join(ROOT, 'dashboard.html');

  // 「立刻跑一次」用的執行狀態（記憶體中保留最近一次）
  const runState = {
    running: false,
    lines: [],
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    child: null,
  };

  // Mobbin 登入流程狀態
  const mobbinSetupState = {
    running: false,
    message: '',
    startedAt: null,
    finishedAt: null,
    loggedIn: null,
  };

  const startMobbinSetup = () => {
    if (mobbinSetupState.running) return false;
    mobbinSetupState.running = true;
    mobbinSetupState.message = '正在開啟 Chrome…';
    mobbinSetupState.startedAt = new Date().toISOString();
    mobbinSetupState.finishedAt = null;
    mobbinSetupState.loggedIn = null;

    (async () => {
      let context = null;
      try {
        context = await openMobbinBrowser(false);
        const page = await context.newPage();
        await page.goto(MOBBIN_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
        mobbinSetupState.message = '請在剛開啟的 Chrome 視窗內登入 Mobbin';

        const maxWaitMs = 6 * 60 * 1000;
        const pollIntervalMs = 3000;
        const startedAt = Date.now();
        let loggedIn = false;
        while (Date.now() - startedAt < maxWaitMs) {
          loggedIn = await detectLogin(page);
          if (loggedIn) break;
          const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
          mobbinSetupState.message = `等候登入中…（已等 ${elapsedSec} 秒，最多 360 秒）`;
          await new Promise((r) => setTimeout(r, pollIntervalMs));
        }

        mobbinSetupState.loggedIn = loggedIn;
        mobbinSetupState.message = loggedIn
          ? '✓ 登入成功，已關閉 Chrome'
          : '⚠ 超時未偵測到登入，請再試一次';
      } catch (e) {
        mobbinSetupState.loggedIn = false;
        mobbinSetupState.message = '❌ 啟動失敗：' + e.message;
      } finally {
        try { if (context) await context.close(); } catch { /* ignore */ }
        mobbinSetupState.running = false;
        mobbinSetupState.finishedAt = new Date().toISOString();
      }
    })();

    return true;
  };
  const MAX_LINES = 2000;
  const pushLine = (line) => {
    runState.lines.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    if (runState.lines.length > MAX_LINES) runState.lines.splice(0, runState.lines.length - MAX_LINES);
  };
  // 共用的 spawn + 接 log + 維護 runState
  const beginRun = (spawnArgs, label, env, source = null) => {
    if (runState.running) return false;
    runState.running = true;
    runState.lines = [];
    runState.source = source;
    runState.startedAt = new Date().toISOString();
    runState.finishedAt = null;
    runState.exitCode = null;
    pushLine(`=== ${label} 開始 ===`);
    const child = spawn(process.execPath, spawnArgs, { cwd: ROOT, env: env || process.env });
    runState.child = child;
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line) pushLine(line);
        if (/Mobbin session 失效|Mobbin profile 不存在/.test(line)) {
          mobbinSetupState.loggedIn = false;
          mobbinSetupState.message = '⚠ Session 失效，請重新登入 Mobbin';
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      pushLine(`=== 結束（exit code ${code}）===`);
      runState.running = false;
      runState.exitCode = code;
      runState.finishedAt = new Date().toISOString();
      runState.child = null;
    });
    return true;
  };

  const startRun = (source = null, manualTarget = null, manualFilter = null) => {
    const label = source ? `只跑 ${source}${manualTarget ? `（目標 ${manualTarget}）` : ''}` : '立刻跑一次';
    const spawnArgs = [path.join(ROOT, 'bot.js')];
    if (source) spawnArgs.push('--only', source);
    if (source && manualTarget) spawnArgs.push('--manual-target', String(manualTarget));
    const env = { ...process.env };
    if (source && manualFilter && typeof manualFilter === 'object') {
      env.MANUAL_FILTER = JSON.stringify(manualFilter);
    }
    return beginRun(spawnArgs, label, env, source);
  };

  const startReorganizeMobbin = () =>
    beginRun([path.join(ROOT, 'bot.js'), '--reorganize-mobbin'], '重新整理 Mobbin 分類', process.env, 'reorganize');

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
        // mobbinSetup = profile 目錄存在 AND 最近沒被偵測到 session 失效
        const profileExists = fs.existsSync(MOBBIN_PROFILE_DIR);
        const effectiveLoggedIn = mobbinSetupState.loggedIn === false ? false : profileExists;
        const status = {
          mobbinSetup: effectiveLoggedIn,
          mobbinSetupRunning: mobbinSetupState.running,
          mobbinSetupMessage: mobbinSetupState.message,
          mobbinSetupFinishedAt: mobbinSetupState.finishedAt,
          mobbinSetupLoggedIn: mobbinSetupState.loggedIn,
          failedCount: loadFailedUrls().length,
          isoWeek: getIsoWeek(),
        };
        sendJSON(status);
      } else if (req.method === 'POST' && req.url === '/api/mobbin/setup') {
        const started = startMobbinSetup();
        if (!started) {
          sendJSON({ ok: false, error: 'Mobbin 登入流程已在跑了', state: mobbinSetupState }, 409);
        } else {
          sendJSON({ ok: true, state: mobbinSetupState });
        }
      } else if (req.method === 'POST' && req.url === '/api/reorganize-mobbin') {
        const started = startReorganizeMobbin();
        if (!started) {
          sendJSON({ ok: false, error: '已有任務在跑' }, 409);
        } else {
          sendJSON({ ok: true, startedAt: runState.startedAt, source: 'reorganize' });
        }
      } else if (req.method === 'GET' && req.url.startsWith('/api/thumb')) {
        const u = new URL(req.url, 'http://x');
        const id = u.searchParams.get('id');
        if (!id) {
          res.writeHead(400); res.end('missing id'); return;
        }
        try {
          // 用 Eagle REST API（port 41595）拿縮圖的本機檔案路徑
          const eg = await fetch(`http://localhost:41595/api/item/thumbnail?id=${encodeURIComponent(id)}`);
          const json = await eg.json();
          if (json.status !== 'success' || !json.data) {
            res.writeHead(404); res.end('no thumb'); return;
          }
          const filePath = decodeURIComponent(json.data);
          if (!fs.existsSync(filePath)) {
            res.writeHead(404); res.end('thumb file missing'); return;
          }
          const ext = path.extname(filePath).slice(1).toLowerCase();
          const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[ext] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
          fs.createReadStream(filePath).pipe(res);
        } catch (e) {
          res.writeHead(500); res.end(e.message);
        }
      } else if (req.method === 'GET' && req.url.startsWith('/api/recent')) {
        const u = new URL(req.url, 'http://x');
        const days = parseInt(u.searchParams.get('days') || '7', 10);
        const items = await fetchRecentItems(days);
        sendJSON({ days, items });
      } else if (req.method === 'GET' && req.url.startsWith('/api/monthly-preview')) {
        const u = new URL(req.url, 'http://x');
        const ym = u.searchParams.get('month') || new Date().toISOString().slice(0, 7);
        const md = await previewMonthlyMarkdown(ym);
        sendJSON({ month: ym, markdown: md });
      } else if (req.method === 'POST' && req.url === '/api/schedule') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks).toString('utf8');
        const schedule = JSON.parse(body);
        try {
          applySchedule(schedule);
          // 寫進 config.json 讓設定持久化
          const cfgPath = path.join(ROOT, 'config.json');
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
          cfg.schedule = schedule;
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
          sendJSON({ ok: true, summary: describeSchedule(schedule) });
        } catch (e) {
          sendJSON({ ok: false, error: e.message }, 500);
        }
      } else if (req.method === 'POST' && req.url === '/api/run') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8');
        let source = null;
        let manualTarget = null;
        let manualFilter = null;
        if (raw) {
          try {
            const body = JSON.parse(raw);
            if (body && body.source) source = String(body.source);
            if (body && body.manualTarget != null) {
              const n = parseInt(body.manualTarget, 10);
              if (Number.isFinite(n) && n > 0) manualTarget = n;
            }
            if (body && body.manualFilter && typeof body.manualFilter === 'object') {
              manualFilter = body.manualFilter;
            }
          } catch { /* ignore body parse error */ }
        }
        const VALID = ['awwwards', 'mobbin', 'godly', 'landbook'];
        if (source && !VALID.includes(source)) {
          sendJSON({ ok: false, error: `未知的來源：${source}` }, 400);
        } else {
          const started = startRun(source, manualTarget, manualFilter);
          if (!started) {
            sendJSON({ ok: false, error: '已有任務在跑' }, 409);
          } else {
            sendJSON({ ok: true, startedAt: runState.startedAt, source: runState.source });
          }
        }
      } else if (req.method === 'GET' && req.url.startsWith('/api/run/status')) {
        const u = new URL(req.url, 'http://x');
        const since = Math.max(0, parseInt(u.searchParams.get('since') || '0', 10));
        sendJSON({
          running: runState.running,
          source: runState.source || null,
          total: runState.lines.length,
          lines: runState.lines.slice(since),
          startedAt: runState.startedAt,
          finishedAt: runState.finishedAt,
          exitCode: runState.exitCode,
        });
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

  // --reorganize-mobbin：把現有 Mobbin 資料夾裡的 item 依 tag 重新分類進子資料夾
  if (args.includes('--reorganize-mobbin')) {
    await reorganizeMobbin();
    return;
  }

  // --reorganize-godly / --reorganize-landbook：依分類 tag 分進子資料夾
  if (args.includes('--reorganize-godly')) {
    await reorganizeGodly();
    return;
  }
  if (args.includes('--reorganize-landbook')) {
    await reorganizeLandbook();
    return;
  }

  // --config-ui
  if (args.includes('--config-ui')) {
    await startConfigUI();
    return;
  }

  // --only <source>：只跑單一來源（awwwards / mobbin / godly / landbook）
  const onlyIdx = args.indexOf('--only');
  const onlySource = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
  const VALID_SOURCES = ['awwwards', 'mobbin', 'godly', 'landbook'];
  if (onlySource && !VALID_SOURCES.includes(onlySource)) {
    log(`❌ 未知的 --only 來源：${onlySource}（支援：${VALID_SOURCES.join(', ')}）`);
    process.exit(1);
  }
  const shouldRun = (src) => !onlySource || onlySource === src;

  // --manual-target <N>：手動模式下使用者指定的目標數量（覆蓋 config）
  const manualTargetIdx = args.indexOf('--manual-target');
  const manualTargetRaw = manualTargetIdx >= 0 ? parseInt(args[manualTargetIdx + 1], 10) : null;
  const manualTarget = Number.isFinite(manualTargetRaw) && manualTargetRaw > 0 ? manualTargetRaw : null;

  // MANUAL_FILTER env：手動模式下使用者選的篩選條件（Awwwards 來源 / Mobbin 平台+分類）
  let manualFilter = null;
  if (process.env.MANUAL_FILTER) {
    try {
      manualFilter = JSON.parse(process.env.MANUAL_FILTER);
    } catch (e) {
      log('⚠ 解析 MANUAL_FILTER 失敗：' + e.message);
    }
  }

  try {
    await callEagle('get_app_info', {});
  } catch (e) {
    log('❌ Eagle 連線失敗（請確認 Eagle App 已開啟）：', e.message);
    notify('Eagle Inspiration Bot 失敗', 'Eagle 連線失敗，請確認 Eagle App 已開啟');
    process.exit(1);
  }

  const globalStats = { awwwards: null, mobbin: null };

  // 每次 bot 啟動產生一個 runId（ISO 時間戳）；同一次 run 的所有 item annotation 都會寫進這個 id
  // dashboard 用它精確分組「上次抓取」，不會受同一天的 annotation 日期影響
  const runId = new Date().toISOString();
  log(`本次 runId：${runId}`);

  // 手動單跑某個來源時，每個流程會挖更深、跳過已抓過的，直到湊到目標數
  // manualTarget 不為 null 時，會覆蓋 config 裡的 target（讓使用者每次可以調量）
  // manualFilter 不為 null 時，會覆蓋 config 裡的篩選條件（Awwwards 來源 / Mobbin 平台與分類）
  const flowOpts = { manual: !!onlySource, manualTarget, manualFilter, runId };

  if (shouldRun('awwwards')) {
    try { await runAwwwardsFlow(globalStats, flowOpts); }
    catch (e) { log('❌ Awwwards 流程錯誤：', e.message); }
  }
  if (shouldRun('mobbin')) {
    try { await runMobbinFlow(globalStats, flowOpts); }
    catch (e) { log('❌ Mobbin 流程錯誤：', e.message); }
  }
  if (shouldRun('godly')) {
    try { await runGodlyFlow(globalStats, flowOpts); }
    catch (e) { log('❌ Godly 流程錯誤：', e.message); }
  }
  if (shouldRun('landbook')) {
    try { await runLandbookFlow(globalStats, flowOpts); }
    catch (e) { log('❌ Land-book 流程錯誤：', e.message); }
  }

  // 跑完順便補上個月的月報（單來源跑就跳過，避免每次手動跑都觸發）
  if (!onlySource) {
    try {
      await maybeAutoGenerateLastMonthReport();
    } catch (e) {
      log('⚠ 月報自動生成失敗：', e.message);
    }
  }

  // 桌面通知
  const aw = globalStats.awwwards || { added: 0 };
  const mb = globalStats.mobbin || { added: 0 };
  const gd = globalStats.godly || { added: 0 };
  const lb = globalStats.landbook || { added: 0 };
  const total = aw.added + mb.added + gd.added + lb.added;
  const body = `本週新增 ${total} 筆 · Awwwards ${aw.added} · Mobbin ${mb.added}（${mb.appCount?.size || 0} app） · Godly ${gd.added} · Land-book ${lb.added}`;
  notify('Eagle Inspiration Bot', body);
  log('\n=== 結束 ===');
  log(body);
}

main().catch((e) => {
  log('❌ 未預期錯誤：', e.stack || e.message);
  notify('Eagle Inspiration Bot 失敗', e.message || '未知錯誤');
  process.exit(1);
});
