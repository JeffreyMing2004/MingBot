/**
 * 图片处理：URL 变换 → 下载校验 → 磁盘/内存缓存，供富媒体上传使用。
 * 移植自 bili-notify/media.py（Python 版已在 QQ 开放平台长期验证可行）。
 *
 * 为什么不能把图片 URL 直接塞进 Markdown ![](url)：
 *   那是客户端去加载这个链接，QQ 要求链接提前在
 *   「开放平台 → 开发设置 → 消息 URL 配置」报备，没报备手机端直接裂图。
 *   而富媒体上传（本地 base64 直传 / 平台按 url 代拉）不走客户端渲染，
 *   不受报备限制 —— 所以默认本地下载后 base64 上传。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./logger');

// 单张图片上限（字节）。QQ 富媒体对超大图上传会失败，手机端 QQ 对大图
// 也容易加载失败/显示异常，所以下载时直接用 B站 CDN 的 720 宽缩放参数。
const MAX_BYTES = 2 * 1024 * 1024;

// 官方上传返回的 file_info 有有效期（响应体 ttl 字段，秒）。接口没给 ttl
// 时只缓存这么久 —— 宁可重新传一次，也不要拿失效的 file_info 导致发送失败。
const DEFAULT_FILE_INFO_TTL = 600;
const FILE_INFO_SAFE_MARGIN = 900;

const CACHE_DIR = path.join(__dirname, '..', 'data', 'imgcache');
const TMP_DIR = path.join(CACHE_DIR, 'tmp');
// 短期图片保留 5 分钟：同一张封面常要连发好几个群 / 失败后重试，
// 保留期内复用本地文件，不用反复去 B站下载（白白多请求还容易撞风控）。
const TMP_TTL = 300;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function key(url) {
  return crypto.createHash('sha1').update(String(url || '')).digest('hex').slice(0, 20);
}

function looksJpeg(data) {
  return data && data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}

function looksPng(data) {
  return data && data.length >= 8 && PNG_MAGIC.equals(data.subarray(0, 8));
}

// QQ 图片只收 png/jpg。webp/gif 传上去会失败，直接放弃更干净。
function usable(data) {
  return !!data && (looksJpeg(data) || looksPng(data));
}

/**
 * 把 B站图片 URL 转成 jpg + 限制宽高，两件事：
 *   1. 格式：B站 CDN 的 webp 后缀换成 .jpg 能取到内容，不用本地转码
 *   2. 尺寸：原图动辄 1920×1080 好几 MB，手机端加载容易失败；
 *      直接用 CDN 参数（@720w_720h_1c.jpg）缩放，体积小、手机友好
 */
function jpegVariant(url, maxW = 0) {
  if (!url) return '';
  let u = String(url).replace(/@[^/@]*$/, '');   // 去掉已有的 @缩放参数
  u = u.replace(/\.(webp|gif)$/i, '.jpg');
  if (!/\.(jpg|jpeg|png)$/i.test(u) && u.includes('hdslb.com')) u += '.jpg';
  if (maxW && u.includes('hdslb.com')) u += `@${maxW}w_${maxW}h_1c.jpg`;
  return u;
}

// B站图床域名后缀白名单：只把这些域名的图内嵌进 Markdown 卡片，
// 避免把任意第三方地址塞进消息（对齐 bili-notify 的 allowed_image_url）
const IMG_HOST_SUFFIXES = ['.hdslb.com', '.bilivideo.com', '.biliimg.com'];

/**
 * 内嵌进 Markdown 的图片 URL：补协议 → 域名白名单 → webp/gif 转 jpg。
 * 默认不压尺寸（bili-notify 同款默认）：平台转存的是原图，加 CDN 压缩参数
 * 反而可能个别图床不兼容；QQ 只收 png/jpg 所以格式转换无条件生效。
 * 域名不在白名单返回 ''（这种图走富媒体 base64 直传，不进卡片）。
 */
function inlineImageUrl(url) {
  if (!url) return '';
  let u = String(url).trim();
  if (u.startsWith('//')) u = 'https:' + u;
  if (u.startsWith('http://')) u = 'https://' + u.slice('http://'.length);
  let host = '';
  try { host = new URL(u).hostname.toLowerCase(); } catch (e) { return ''; }
  if (!IMG_HOST_SUFFIXES.some(s => host.endsWith(s))) return '';
  return jpegVariant(u, 0);
}

// ─── 短期磁盘缓存 ─────────────────────────────────────────────────────────────
function ensureDirs() {
  for (const d of [CACHE_DIR, TMP_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
  }
}

function saveTmp(data, url) {
  ensureDirs();
  const p = path.join(TMP_DIR, key(url) + (looksPng(data) ? '.png' : '.jpg'));
  try { fs.writeFileSync(p, data); return p; } catch (e) { return ''; }
}

function loadTmp(url, maxAge = TMP_TTL) {
  if (!url) return null;
  for (const ext of ['.jpg', '.png']) {
    const p = path.join(TMP_DIR, key(url) + ext);
    try {
      if (maxAge > 0 && Date.now() - fs.statSync(p).mtimeMs > maxAge * 1000) continue;
      const d = fs.readFileSync(p);
      if (!d.length) continue;
      try { fs.utimesSync(p, new Date(), new Date()); } catch (e) { /* 用一次续一期 */ }
      return d;
    } catch (e) { /* 该后缀不存在，试下一个 */ }
  }
  return null;
}

let lastSweep = 0;
// 清掉保留期外的临时图片；内部 60 秒节流，不必每次发送都 listdir
function sweepTmp(force = false) {
  const now = Date.now();
  if (!force && now - lastSweep < 60_000) return;
  lastSweep = now;
  try {
    for (const name of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, name);
      try {
        if (now - fs.statSync(p).mtimeMs > TMP_TTL * 1000) fs.unlinkSync(p);
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* 目录不存在 */ }
}

/** 取图片二进制：先查 5 分钟短期缓存，没命中才走网络。失败返回 null。 */
async function getImageData(url) {
  const hit = loadTmp(url);
  if (hit) return hit;
  const target = jpegVariant(url, 720) || jpegVariant(url);
  if (!target) return null;
  try {
    const res = await fetch(target, {
      headers: {
        'User-Agent': UA,
        // 不带 Referer 的话 B站图床会返回占位图
        'Referer': 'https://www.bilibili.com/',
        'Accept': 'image/jpeg,image/png,image/*,*/*',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      log.warn(`[media] 图片下载失败 HTTP ${res.status}: ${target}`);
      return null;
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length || data.length > MAX_BYTES) return null;
    if (!usable(data)) return null;   // webp/gif 传上去也会失败，直接放弃
    saveTmp(data, url);
    sweepTmp();
    return data;
  } catch (e) {
    log.warn(`[media] 图片下载异常 ${target}: ${e.message}`);
    return null;
  }
}

// ─── file_info 缓存（内存）───────────────────────────────────────────────────
// 同一张图在 file_info 有效期内发多个群时不用重复上传
const fileInfoCache = new Map();

function cachedFileInfo(url) {
  const hit = fileInfoCache.get(key(url));
  if (!hit) return null;
  if (hit.expire <= Date.now()) {
    fileInfoCache.delete(key(url));
    return null;
  }
  return hit.file_info;
}

function rememberFileInfo(url, fileInfo, ttl) {
  const t = parseInt(ttl, 10) || 0;
  const sec = t > 0 ? Math.max(60, t - FILE_INFO_SAFE_MARGIN) : DEFAULT_FILE_INFO_TTL;
  fileInfoCache.set(key(url), { file_info: fileInfo, expire: Date.now() + sec * 1000 });
}

function forgetFileInfo(url) {
  fileInfoCache.delete(key(url));
}

module.exports = { jpegVariant, inlineImageUrl, getImageData, usable, cachedFileInfo, rememberFileInfo, forgetFileInfo, sweepTmp };
