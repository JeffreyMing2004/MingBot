/**
 * 示例：插件/命令处理器
 * 可以将复杂的命令逻辑拆分到单独的文件中
 */

// 简单的命令注册表
const commands = new Map();

/**
 * 注册命令
 * @param {string} name - 命令名称
 * @param {Object} options - 命令选项
 * @param {string} options.description - 命令描述
 * @param {Function} options.handler - 处理函数
 * @param {string[]} [options.aliases] - 命令别名
 */
function registerCommand(name, options) {
  commands.set(name.toLowerCase(), {
    name: name.toLowerCase(),
    description: options.description,
    handler: options.handler,
    aliases: options.aliases || [],
  });

  // 注册别名
  if (options.aliases) {
    for (const alias of options.aliases) {
      commands.set(alias.toLowerCase(), commands.get(name.toLowerCase()));
    }
  }
}

/**
 * 获取命令
 * @param {string} name - 命令名称
 * @returns {Object|undefined}
 */
function getCommand(name) {
  return commands.get(name.toLowerCase());
}

/**
 * 获取所有命令列表
 * @returns {Map}
 */
function getAllCommands() {
  return commands;
}

/**
 * 执行命令
 * @param {Object} message - 消息对象
 * @param {string} commandName - 命令名称
 * @param {string[]} args - 参数数组
 */
async function executeCommand(message, commandName, args) {
  const command = getCommand(commandName);
  if (!command) {
    return false;
  }

  try {
    await command.handler(message, args);
    return true;
  } catch (error) {
    console.error(`命令执行错误 [${commandName}]:`, error);
    await message.reply('❌ 命令执行出错，请稍后重试。');
    return true;
  }
}

// 导出
module.exports = {
  registerCommand,
  getCommand,
  getAllCommands,
  executeCommand,
};
