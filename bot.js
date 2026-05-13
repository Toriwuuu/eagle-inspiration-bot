#!/usr/bin/env node
// Eagle 靈感庫自動更新機器人
// 從 Awwwards SOTD 抓取每個作品的 element 預覽影片，自動存進 Eagle 指定資料夾。
//
// 想像成一個小幫手：每週去逛 Awwwards 一次，把當週優秀作品的設計細節
// （header 動畫、product page、scroll interaction 之類的小片段）打包送進你的 Eagle。

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------- 設定區 ----------
const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const EAGLE_CLI = path.join(
  require('os').homedir(),
  '.claude/skills/eagle-skill/scripts/eagle-api-cli.js'
);
const AWWWARDS_BASE = 'https://www.awwwards.com';
const LIST_URL = `${AWWWARDS_BASE}/websites/sites_of_the_day/`;

// ---------- 小工具 ----------
const log = (...args) => {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  console.log(`[${ts}]`, ...args);
};

// 包一層 Promise，呼叫 Eagle skill 的 CLI 並把 stdout 的 JSON 解析回來
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

// ---------- Eagle 資料夾管理 ----------
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

// ---------- Awwwards 抓取 ----------
async function openBrowser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  return { browser, context };
}

// 從列表頁拿出前 N 個 SOTD 細節頁 URL
async function fetchListing(context, max) {
  const page = await context.newPage();
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const hrefs = await page.$$eval('a[href^="/sites/"]', (els) =>
    els.map((a) => a.getAttribute('href'))
  );
  await page.close();
  const unique = [...new Set(hrefs)].filter((h) => /^\/sites\/[a-z0-9-]+\/?$/i.test(h));
  return unique.slice(0, max).map((h) => AWWWARDS_BASE + h);
}

// 把 element 的 poster URL（_static.jpeg）轉成真實影片 URL
// 例：.../element/2026/04/abc_static.jpeg → .../element/2026/04/abc.mp4
function posterToVideoUrl(posterUrl) {
  if (!posterUrl) return null;
  return posterUrl.replace(/_static\.(jpeg|jpg|png)$/i, '.mp4');
}

// 訪問一個 SOTD 細節頁，回傳作品資訊與所有 element
async function fetchDetail(context, detailUrl) {
  const page = await context.newPage();
  try {
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const data = await page.evaluate(() => {
      const get = (sel) => document.querySelector(sel)?.getAttribute('content') || null;

      // 標題、og:image、og:url
      const title =
        get('meta[property="og:title"]')?.replace(/\s*[-|]\s*Awwwards.*$/, '').trim() || null;
      const heroJpg = get('meta[property="og:image"]');

      // live website：找 "Visit Website" 按鈕，再 fallback 第一個非 awwwards 外連
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

      // 從 detail URL 推出站名 slug（給後面 element 名字去尾用）
      const siteSlug = location.pathname.match(/\/sites\/([^/]+)/)?.[1] || '';

      // 抓所有 element 影片：找 video[data-poster]
      const videos = Array.from(document.querySelectorAll('video[data-poster]'));
      const elements = videos.map((v) => {
        const poster = v.getAttribute('data-poster');
        // 找這個 video 對應的 inspiration anchor，從 anchor text 拿描述
        const anchor =
          v.closest('a[href*="/inspiration/"]') ||
          v.parentElement?.querySelector('a[href*="/inspiration/"]');
        let elementName = null;
        if (anchor) {
          const text = anchor.textContent.trim();
          if (text) {
            elementName = text;
          } else {
            // 從 href slug 推：/inspiration/homepage-header-floema → "homepage header"
            const m = anchor.getAttribute('href')?.match(/\/inspiration\/(.+?)\/?$/);
            if (m) {
              let slug = m[1];
              // 去掉尾段重複的站名
              if (siteSlug && slug.endsWith('-' + siteSlug)) {
                slug = slug.slice(0, -(siteSlug.length + 1));
              }
              elementName = slug.replace(/-/g, ' ');
            }
          }
        }
        return { poster, elementName };
      });

      return { title, heroJpg, liveUrl, elements, siteSlug };
    });

    // 把 poster URL 轉成真實 mp4 URL
    const items = data.elements.map((el, i) => ({
      mediaUrl: posterToVideoUrl(el.poster),
      mediaType: 'video',
      name: el.elementName
        ? `${data.title} - ${el.elementName}`
        : `${data.title} - element ${i + 1}`,
    }));

    // 若沒有任何 element，fallback 用 og:image 主視覺
    if (items.length === 0 && data.heroJpg) {
      items.push({
        mediaUrl: data.heroJpg,
        mediaType: 'image',
        name: data.title || detailUrl.split('/').pop(),
      });
    }

    return {
      title: data.title || detailUrl.split('/').pop(),
      liveUrl: data.liveUrl,
      detailUrl,
      items,
    };
  } finally {
    await page.close();
  }
}

// ---------- 主流程 ----------
async function main() {
  log('=== Eagle Inspiration Bot 啟動 ===');
  log('設定：', JSON.stringify(CONFIG));

  let folderId;
  try {
    folderId = await ensureFolder(CONFIG.eagleFolderName);
  } catch (e) {
    log('❌ Eagle 連線失敗（請確認 Eagle 已開啟且 MCP plugin 已啟用）：', e.message);
    process.exit(1);
  }

  const { browser, context } = await openBrowser();
  const stats = { added: 0, skipped: 0, failed: 0, videoCount: 0, imageCount: 0 };

  try {
    log(`從 ${LIST_URL} 抓列表…`);
    const detailUrls = await fetchListing(context, CONFIG.maxSites);
    log(`找到 ${detailUrls.length} 個 SOTD 細節頁`);

    for (const [i, url] of detailUrls.entries()) {
      log(`\n[${i + 1}/${detailUrls.length}] ${url}`);
      try {
        const detail = await fetchDetail(context, url);
        log(`  作品：${detail.title}`);
        log(`  網站：${detail.liveUrl || '(找不到)'}`);
        log(`  找到 ${detail.items.length} 個 element`);

        // 去重：以 liveUrl 為 key 查 Eagle（同作品已抓過就整筆跳過）
        if (CONFIG.skipIfLiveUrlExists && detail.liveUrl) {
          const exist = await callEagle('item_get', { url: detail.liveUrl, limit: 1 });
          const list = exist?.data || exist?.result || exist;
          if (Array.isArray(list) && list.length > 0) {
            log('  ⏭ Eagle 內已有此作品，跳過');
            stats.skipped++;
            continue;
          }
        }

        // 截取前 elementsPerSite 個 element
        const itemsToAdd = detail.items
          .filter((it) => it.mediaUrl)
          .slice(0, CONFIG.elementsPerSite);

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
        ]
          .filter(Boolean)
          .join('\n');

        // 一次性 batch 加入所有 element
        await callEagle('item_add', {
          folders: [folderId],
          tags: CONFIG.extraTags,
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

  log('\n=== 執行結果 ===');
  log(`新增 ${stats.added} 筆（影片 ${stats.videoCount}、圖片 ${stats.imageCount}）`);
  log(`跳過 ${stats.skipped} 個作品（已存在）`);
  log(`失敗 ${stats.failed} 筆`);
}

main().catch((e) => {
  log('❌ 未預期錯誤：', e.stack || e.message);
  process.exit(1);
});
