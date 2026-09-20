const path = require('path');

module.exports = {
  apps: [{
    name: 'mingbot',
    script: 'src/index.js',
    cwd: path.resolve('H:\\WorkSpace\\MingBot'),
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      QQ_BOT_USE_CALLBACK: 'true',
      QQ_BOT_SANDBOX: 'true',
      BOT_PORT: '9000',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      NO_PROXY: 'localhost,127.0.0.1,*.api.sgroup.qq.com,*.qq.com',
    },
    max_memory_restart: '512M',
    error_file: path.resolve('H:\\WorkSpace\\MingBot', 'logs', 'pm2-error.log'),
    out_file: path.resolve('H:\\WorkSpace\\MingBot', 'logs', 'pm2-out.log'),
    log_date_format: 'HH:mm:ss',
    ignore_watch: ['node_modules', 'logs', '.pm2', '.vscode', 'data', '.npm-cache', '.pnpm-store'],
    watch: false,
  }],
};
