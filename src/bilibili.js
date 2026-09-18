/**
 * B站动态监控模块
 * 支持 Cookie 认证以绕过 412 反爬限制
 * 每5分钟检测指定UP主的动态更新
 */

const fs = require('fs');
const path = require('path');

// 数据存储文件路径
const DATA_DIR = path.join(__dirname, '..', 'data');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const LAST_DYNAMICS_FILE = path.join(DATA_DIR, 'last_dynamics.json');
const CONFIG_FILE = path.join(DATA_DIR, 'bilibili_config.json');

/**
 * 默认配置
 */
let biliConfig = {
  cookie: '',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
};

/**
 * 确保数据目录存在
 */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * 加载 B站配置（包含 Cookie）
 */
function loadBiliConfig() {
  ensureDataDir();
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      biliConfig = { ...biliConfig, ...config };
    } catch (e) {
      console.error('读取 B站配置失败:', e.message);
    }
  }
  return biliConfig;
}

/**
 * 保存 B站配置
 */
function saveBiliConfig(config) {
  ensureDataDir();
  biliConfig = { ...biliConfig, ...config };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(biliConfig, null, 2));
}

/**
 * 读取订阅配置
 * @returns {Object} { guildId: { channelId, upList: [{ uid, name }] } }
 */
function loadSubscriptions() {
  ensureDataDir();
  if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf-8'));
    } catch (e) {
      console.error('读取订阅配置失败:', e.message);
      return {};
    }
  }
  return {};
}

/**
 * 保存订阅配置
 * @param {Object} subscriptions
 */
function saveSubscriptions(subscriptions) {
  ensureDataDir();
  fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2));
}

/**
 * 读取最后检测到的动态ID
 * @returns {Object} { upUid: dynamicId }
 */
function loadLastDynamics() {
  ensureDataDir();
  if (fs.existsSync(LAST_DYNAMICS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(LAST_DYNAMICS_FILE, 'utf-8'));
    } catch (e) {
      console.error('读取动态记录失败:', e.message);
      return {};
    }
  }
  return {};
}

/**
 * 保存最后检测到的动态ID
 * @param {Object} lastDynamics
 */
function saveLastDynamics(lastDynamics) {
  ensureDataDir();
  fs.writeFileSync(LAST_DYNAMICS_FILE, JSON.stringify(lastDynamics, null, 2));
}

/**
 * 获取请求头
 */
function getHeaders(referer) {
  const config = loadBiliConfig();
  return {
    'User-Agent': config.userAgent,
    'Referer': referer || 'https://space.bilibili.com/',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cookie': config.cookie,
  };
}

/**
 * 获取UP主最新动态 (使用 polymer web-dynamic API)
 * @param {string|number} uid - UP主UID
 * @returns {Promise<Object|null>} 最新动态信息或null
 */
async function fetchLatestDynamic(uid) {
  const uidStr = String(uid);
  const urls = [
    // polymer 新版动态 API
    `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?offset=&host_mid=${uidStr}`,
    // 备用：旧版动态 API
    `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=${uidStr}&offset_dynamic_id=0&need_top=1&platform=web`,
  ];

  for (const url of urls) {
    try {
      const referer = `https://space.bilibili.com/${uidStr}/dynamic`;
      const response = await fetch(url, { headers: getHeaders(referer) });
      
      if (!response.ok) {
        console.log(`[${uidStr}] HTTP ${response.status}: ${response.statusText}`);
        continue;
      }
      
      const text = await response.text();
      if (!text.trim().startsWith('{')) {
        console.log(`[${uidStr}] 非 JSON 响应 (可能被拦截):`, text.slice(0, 100));
        continue;
      }
      
      const data = JSON.parse(text);
      
      if (data.code === -412) {
        console.log(`[${uidStr}] 请求被拦截 (412)，请配置有效 Cookie`);
        continue;
      }
      if (data.code === -799) {
        console.log(`[${uidStr}] 请求过于频繁 (799)`);
        continue;
      }
      if (data.code !== 0) {
        console.log(`[${uidStr}] API 返回错误: ${data.code} - ${data.message}`);
        continue;
      }
      
      // 解析 polymer API 响应
      if (data.data?.items?.length) {
        const item = data.data.items[0];
        const modules = item.modules;
        
        if (!modules) continue;
        
        const author = modules.module_author;
        const dynamic = modules.module_dynamic;
        
        if (!author || !dynamic) continue;
        
        const desc = dynamic.desc;
        let content = '';
        let images = [];
        
        if (desc?.text) {
          content = desc.text;
        }
        if (desc?.rich_text_nodes) {
          content = desc.rich_text_nodes.map(n => n.text || '').join('');
        }
        if (dynamic.major?.opus?.summary?.text) {
          content = dynamic.major.opus.summary.text;
        }
        
        // 提取图片
        if (dynamic.major?.opus?.pics) {
          images = dynamic.major.opus.pics.map(p => p.url);
        } else if (dynamic.major?.draw?.items) {
          images = dynamic.major.draw.items.map(i => i.src);
        }
        
        // 处理转发
        let originInfo = null;
        if (dynamic.major?.archive) {
          originInfo = {
            title: dynamic.major.archive.title,
            desc: dynamic.major.archive.desc,
            pic: dynamic.major.archive.cover,
          };
        }
        
        return {
          dynamicId: item.id_str,
          uid: author.mid,
          timestamp: author.pub_ts,
          type: item.type,
          content: content.trim(),
          images,
          originInfo,
          url: `https://t.bilibili.com/${item.id_str}`,
        };
      }
      
      // 解析旧版 API 响应
      if (data.data?.cards?.length) {
        const card = data.data.cards[0];
        const desc = card.desc;
        
        // 跳过置顶
        if (desc.is_top === 1 && data.data.cards.length > 1) {
          const card2 = data.data.cards[1];
          return parseLegacyCard(card2);
        }
        return parseLegacyCard(card);
      }
    } catch (error) {
      console.error(`[${uidStr}] 获取动态异常:`, error.message);
    }
  }
  
  return null;
}

/**
 * 解析旧版动态卡片
 */
function parseLegacyCard(card) {
  const desc = card.desc;
  const cardContent = JSON.parse(card.card);
  
  let content = '';
  let images = [];
  let originInfo = null;
  
  if (cardContent.item) {
    content = cardContent.item.description || cardContent.item.content || '';
    if (cardContent.item.pictures) {
      images = cardContent.item.pictures.map(p => p.img_src).slice(0, 9);
    }
  } else if (cardContent.content) {
    content = cardContent.content;
  } else if (cardContent.title) {
    content = cardContent.title;
    if (cardContent.desc) content += '\n' + cardContent.desc;
    if (cardContent.pic) images.push(cardContent.pic);
  }
  
  if (cardContent.origin && cardContent.origin_user) {
    const origin = JSON.parse(cardContent.origin);
    originInfo = {
      name: cardContent.origin_user.info.uname,
      content: origin.item?.description || origin.content || origin.title || '转发内容',
    };
  }
  
  return {
    dynamicId: desc.dynamic_id_str,
    uid: desc.uid,
    timestamp: desc.timestamp,
    type: desc.type,
    content: content.trim(),
    images,
    originInfo,
    url: `https://t.bilibili.com/${desc.dynamic_id_str}`,
  };
}

/**
 * 格式化动态消息用于发送
 * @param {Object} dynamic - 动态对象
 * @param {string} upName - UP主名称
 * @returns {string} 格式化后的消息
 */
function formatDynamicMessage(dynamic, upName) {
  const time = new Date(dynamic.timestamp * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  
  let msg = `🔔 **${upName} 发布新动态**\n`;
  msg += `📅 ${time}\n\n`;
  
  if (dynamic.originInfo) {
    msg += `🔁 **转发**`;
    if (dynamic.originInfo.title) msg += `: ${dynamic.originInfo.title}`;
    msg += `\n`;
    if (dynamic.originInfo.content) msg += `${dynamic.originInfo.content}\n`;
    msg += `\n`;
  }
  
  if (dynamic.content) {
    const maxContentLen = 500;
    let content = dynamic.content;
    if (content.length > maxContentLen) {
      content = content.slice(0, maxContentLen) + '...';
    }
    msg += `${content}\n\n`;
  }
  
  if (dynamic.images.length > 0) {
    msg += `🖼️ 包含 ${dynamic.images.length} 张图片\n\n`;
  }
  
  msg += `🔗 [查看动态](${dynamic.url})`;
  
  return msg;
}

/**
 * 检查单个UP主的动态更新
 * @param {Object} client - QQ Bot 客户端
 * @param {Object} subscription - 订阅信息
 * @param {Object} lastDynamics - 最后动态记录
 * @returns {Promise<Object>} 更新后的 lastDynamics
 */
async function checkUpDynamic(client, subscription, lastDynamics) {
  const { guildId, channelId, upList } = subscription;
  
  for (const up of upList) {
    const { uid, name } = up;
    const uidStr = String(uid);
    
    try {
      const latestDynamic = await fetchLatestDynamic(uid);
      
      if (!latestDynamic) {
        console.log(`[${name}] 暂无动态或获取失败`);
        continue;
      }
      
      const lastDynamicId = lastDynamics[uidStr];
      const currentDynamicId = latestDynamic.dynamicId;
      
      // 首次检测，只记录不发送
      if (!lastDynamicId) {
        console.log(`[${name}] 首次检测，记录动态ID: ${currentDynamicId}`);
        lastDynamics[uidStr] = currentDynamicId;
        continue;
      }
      
      // 有新动态
      if (currentDynamicId !== lastDynamicId) {
        console.log(`[${name}] 检测到新动态: ${currentDynamicId}`);
        
        const message = formatDynamicMessage(latestDynamic, name);
        try {
          await client.postMessage(channelId, message);
          console.log(`[${name}] 已推送至频道 ${channelId}`);
        } catch (sendError) {
          console.error(`[${name}] 发送失败:`, sendError.message);
        }
        
        lastDynamics[uidStr] = currentDynamicId;
      } else {
        console.log(`[${name}] 无更新`);
      }
    } catch (error) {
      console.error(`[${name}] 检测异常:`, error.message);
    }
  }
  
  return lastDynamics;
}

/**
 * 启动定时检测任务
 * @param {Object} client - QQ Bot 客户端
 * @param {number} intervalMinutes - 检测间隔（分钟），默认5分钟
 */
function startDynamicMonitor(client, intervalMinutes = 5) {
  console.log(`🕐 启动B站动态监控，间隔: ${intervalMinutes}分钟`);
  loadBiliConfig();
  
  if (!biliConfig.cookie) {
    console.log('⚠️ 未配置 B站 Cookie，可能无法获取动态 (会触发 412)');
    console.log('💡 使用 `/bili_cookie <Cookie>` 设置，或编辑 data/bilibili_config.json');
  }
  
  const checkAll = async () => {
    const subscriptions = loadSubscriptions();
    const lastDynamics = loadLastDynamics();
    
    let hasUpdates = false;
    
    for (const [guildId, subscription] of Object.entries(subscriptions)) {
      if (!subscription.upList || subscription.upList.length === 0) continue;
      
      const updated = await checkUpDynamic(client, subscription, lastDynamics);
      Object.assign(lastDynamics, updated);
      hasUpdates = true;
    }
    
    if (hasUpdates) {
      saveLastDynamics(lastDynamics);
    }
  };
  
  // 立即执行一次
  checkAll();
  
  // 设置定时器
  const intervalMs = intervalMinutes * 60 * 1000;
  const timer = setInterval(checkAll, intervalMs);
  
  return timer;
}

/**
 * 添加订阅
 * @param {string} guildId - 频道ID
 * @param {string} channelId - 子频道ID
 * @param {Array} upList - UP主列表 [{ uid, name }]
 */
function addSubscription(guildId, channelId, upList) {
  const subscriptions = loadSubscriptions();
  
  if (!subscriptions[guildId]) {
    subscriptions[guildId] = { channelId, upList: [] };
  }
  
  const existingUids = new Set(subscriptions[guildId].upList.map(u => String(u.uid)));
  for (const up of upList) {
    if (!existingUids.has(String(up.uid))) {
      subscriptions[guildId].upList.push(up);
    }
  }
  
  saveSubscriptions(subscriptions);
  return subscriptions[guildId];
}

/**
 * 移除订阅
 * @param {string} guildId - 频道ID
 * @param {string|number} uid - UP主UID
 */
function removeSubscription(guildId, uid) {
  const subscriptions = loadSubscriptions();
  
  if (subscriptions[guildId]) {
    subscriptions[guildId].upList = subscriptions[guildId].upList.filter(
      u => String(u.uid) !== String(uid)
    );
    
    if (subscriptions[guildId].upList.length === 0) {
      delete subscriptions[guildId];
    }
    
    saveSubscriptions(subscriptions);
  }
}

/**
 * 获取频道的所有订阅
 * @param {string} guildId - 频道ID
 * @returns {Array} UP主列表
 */
function getSubscriptions(guildId) {
  const subscriptions = loadSubscriptions();
  return subscriptions[guildId]?.upList || [];
}

/**
 * 搜索UP主UID（通过用户名）
 * @param {string} keyword - 搜索关键词
 * @returns {Promise<Array>} 搜索结果
 */
async function searchUpByName(keyword) {
  try {
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=bili_user&keyword=${encodeURIComponent(keyword)}`;
    const response = await fetch(url, { headers: getHeaders('https://search.bilibili.com/') });
    
    if (!response.ok) return [];
    
    const text = await response.text();
    if (!text.trim().startsWith('{')) return [];
    
    const data = JSON.parse(text);
    if (data.code !== 0 || !data.data?.result?.length) return [];
    
    return data.data.result.map(user => ({
      uid: user.mid,
      name: user.uname,
      face: user.upic,
      sign: user.sign,
    })).slice(0, 10);
  } catch (error) {
    console.error('搜索UP主失败:', error.message);
    return [];
  }
}

/**
 * 设置 B站 Cookie
 * @param {string} cookie - 完整的 Cookie 字符串
 */
function setBiliCookie(cookie) {
  saveBiliConfig({ cookie });
  console.log('✅ B站 Cookie 已更新');
  return biliConfig;
}

/**
 * 获取当前 B站配置
 */
function getBiliConfig() {
  return loadBiliConfig();
}

module.exports = {
  startDynamicMonitor,
  addSubscription,
  removeSubscription,
  getSubscriptions,
  searchUpByName,
  loadSubscriptions,
  loadLastDynamics,
  fetchLatestDynamic,
  formatDynamicMessage,
  setBiliCookie,
  getBiliConfig,
};
