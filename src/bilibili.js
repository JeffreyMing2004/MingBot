/**
 * B站动态监控模块
 * 每5分钟检测指定UP主的动态更新
 */

const fs = require('fs');
const path = require('path');

/**
 * B站动态API响应结构
 * 使用用户动态 API: https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history
 */

// 数据存储文件路径
const DATA_DIR = path.join(__dirname, '..', 'data');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const LAST_DYNAMICS_FILE = path.join(DATA_DIR, 'last_dynamics.json');

/**
 * 确保数据目录存在
 */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
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
      console.error('读取订阅配置失败:', e);
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
      console.error('读取动态记录失败:', e);
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
 * 获取UP主最新动态
 * @param {string|number} uid - UP主UID
 * @returns {Promise<Object|null>} 最新动态信息或null
 */
async function fetchLatestDynamic(uid) {
  try {
    const url = `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=${uid}&offset_dynamic_id=0&need_top=1&platform=web`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://space.bilibili.com/',
      },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.code !== 0 || !data.data?.cards?.length) {
      return null;
    }
    
    // 取第一条非置顶动态（index 0 可能是置顶，取最新的）
    const cards = data.data.cards;
    let latestCard = cards[0];
    
    // 如果第一条是置顶，尝试取第二条
    if (latestCard.desc?.type === 64 || latestCard.desc?.is_top === 1) {
      latestCard = cards[1] || latestCard;
    }
    
    const card = latestCard;
    const desc = card.desc;
    const cardContent = JSON.parse(card.card);
    
    // 解析动态内容
    let content = '';
    let images = [];
    let originInfo = null;
    
    // 处理不同类型的动态
    if (cardContent.item) {
      // 普通动态/图文动态
      content = cardContent.item.description || cardContent.item.content || '';
      if (cardContent.item.pictures) {
        images = cardContent.item.pictures.map(p => p.img_src).slice(0, 9);
      }
    } else if (cardContent.content) {
      // 纯文本动态
      content = cardContent.content;
    } else if (cardContent.title) {
      // 视频/文章动态
      content = cardContent.title;
      if (cardContent.desc) content += '\n' + cardContent.desc;
      if (cardContent.pic) images.push(cardContent.pic);
    }
    
    // 处理转发动态
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
  } catch (error) {
    console.error(`获取UP主 ${uid} 动态失败:`, error.message);
    return null;
  }
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
    msg += `🔁 **转发自 @${dynamic.originInfo.name}**\n`;
    msg += `${dynamic.originInfo.content}\n\n`;
  }
  
  if (dynamic.content) {
    // 限制内容长度
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
 * @param {Object} subscription - 订阅信息 { guildId, channelId, upList }
 * @param {Object} lastDynamics - 最后动态记录 { uid: dynamicId }
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
        console.log(`[${name}] 暂无动态`);
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
        
        // 发送到频道
        const message = formatDynamicMessage(latestDynamic, name);
        try {
          await client.postMessage(channelId, message);
          console.log(`[${name}] 已推送至频道 ${channelId}`);
        } catch (sendError) {
          console.error(`[${name}] 发送失败:`, sendError.message);
        }
        
        // 更新记录
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
  
  // 合并UP主列表，去重
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
    
    // 如果没有UP主了，删除整个频道订阅
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
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://search.bilibili.com/',
      },
    });
    
    if (!response.ok) return [];
    
    const data = await response.json();
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
};
