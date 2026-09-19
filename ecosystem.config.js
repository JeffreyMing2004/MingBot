/**
 * PM2 进程管理器配置
 * 使用方式: npx pm2 start ecosystem.config.js
 */
module.exports = {
  apps: [{
    name: 'mingbot',
    script: './src/index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
    },
    env_development: {
      NODE_ENV: 'development',
      QQ_BOT_SANDBOX: 'true',
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    kill_timeout: 5000,
    listen_timeout: 8000,
  }],
};
