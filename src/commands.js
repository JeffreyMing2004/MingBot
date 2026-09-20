/**
 * 命令注册表
 */
const commands = new Map();

function registerCommand(name, options) {
  const entry = { name: name.toLowerCase(), description: options.description, handler: options.handler, aliases: options.aliases || [] };
  commands.set(entry.name, entry);
  for (const alias of entry.aliases) {
    commands.set(alias.toLowerCase(), entry);
  }
}

function getCommand(name) {
  return commands.get(name.toLowerCase());
}

function getAllCommands() {
  return commands;
}

/**
 * 执行命令，返回 true 表示已处理
 * message 对象必须包含 reply(text) 方法以兼容回调模式
 */
async function executeCommand(message, commandName, args) {
  const command = getCommand(commandName);
  if (!command) return false;
  try {
    await command.handler(message, args);
    return true;
  } catch (error) {
    console.error(`[CMD ERR] ${commandName}:`, error);
    if (typeof message.reply === 'function') {
      await message.reply('❌ 命令执行出错，请稍后重试。');
    }
    return true;
  }
}

module.exports = { registerCommand, getCommand, getAllCommands, executeCommand };
