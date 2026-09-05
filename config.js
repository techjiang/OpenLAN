'use strict';
/**
 * OpenLAN 配置解析：命令行参数 > 环境变量 > 默认值
 * 用法示例：
 *   node server/index.js --port 5555 --dir D:\我的共享 --pin 1234 --auto-accept
 */
const os = require('os');
const path = require('path');
const { parseArgs, parseSize, APP_VERSION } = require('./server/util');

const APP_DIR = __dirname;
const HOME_DIR = os.homedir();

const DEFAULTS = {
  port: 5555,
  bind: '0.0.0.0',
  name: '',
  dir: '',                 // 共享目录，默认 <项目>/shared
  downloadDir: '',         // 接收目录，默认 <项目>/downloads
  dataDir: '',             // 实例身份/临时数据，默认 ~/.openlan
  pin: '',                 // 访问 PIN（可选）
  autoAccept: false,       // 无人值守自动接收
  discovery: true,         // UDP 组播发现
  p2pThreads: 4,           // P2P 推送到对方的分块并发数
  p2pChunkKB: 1024,        // P2P 分块大小（KB）
  waitAcceptSec: 180,      // 等待对方接受的最长时间
  quiet: false,
  open: true,              // 启动后自动打开浏览器（--no-open 关闭）
};

function bool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  return !(v === 'false' || v === '0' || v === 'no' || v === 'off');
}

function resolve() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const g = (k, def) => {
    if (args[k] !== undefined) return args[k];
    const envKey = 'OPENLAN_' + String(k).replace(/-/g, '_').toUpperCase();
    if (env[envKey] !== undefined) return env[envKey];
    return def;
  };

  const cfg = {};
  cfg.port = parseInt(g('port', DEFAULTS.port), 10) || DEFAULTS.port;
  cfg.bind = g('bind', DEFAULTS.bind);
  cfg.name = String(g('name', DEFAULTS.name)).trim();
  cfg.pin = String(g('pin', DEFAULTS.pin)).trim();
  cfg.autoAccept = bool(g('auto-accept', DEFAULTS.autoAccept), DEFAULTS.autoAccept);
  cfg.discovery = bool(g('no-discovery', !DEFAULTS.discovery) ? false : true, DEFAULTS.discovery);
  cfg.quiet = bool(g('quiet', DEFAULTS.quiet), DEFAULTS.quiet);
  cfg.open = bool(g('open', DEFAULTS.open), DEFAULTS.open) && !(args['no-open'] === true);

  cfg.p2pThreads = Math.max(1, Math.min(32, parseInt(g('p2p-threads', DEFAULTS.p2pThreads), 10) || DEFAULTS.p2pThreads));
  cfg.p2pChunkKB = Math.max(64, Math.min(16 * 1024, parseInt(g('p2p-chunk-kb', DEFAULTS.p2pChunkKB), 10) || DEFAULTS.p2pChunkKB));
  cfg.p2pChunk = cfg.p2pChunkKB * 1024;
  cfg.waitAcceptSec = parseInt(g('wait-accept', DEFAULTS.waitAcceptSec), 10) || DEFAULTS.waitAcceptSec;

  cfg.dir = String(g('dir', '') || g('shared', '')).trim();
  cfg.downloadDir = String(g('download-dir', '') || g('save', '')).trim();
  cfg.dataDir = String(g('data-dir', DEFAULTS.dataDir)).trim() || path.join(HOME_DIR, '.openlan');

  cfg.version = !!args.version;
  cfg.help = !!args.help;

  if (!cfg.dir) cfg.dir = path.join(APP_DIR, 'shared');
  if (!cfg.downloadDir) cfg.downloadDir = path.join(APP_DIR, 'downloads');
  cfg.sharedDir = path.resolve(cfg.dir);
  cfg.downloadDir = path.resolve(cfg.downloadDir);
  cfg.dataDir = path.resolve(cfg.dataDir);
  cfg.appDir = APP_DIR;
  cfg.versionText = APP_VERSION;
  return cfg;
}

function helpText() {
  return `
${'OpenLAN'} v${APP_VERSION} — 开源局域网文件急速传输工具

用法:
  node server/index.js [选项]

选项:
  --port <n>           HTTP 端口（默认 5555）
  --bind <ip>          监听地址（默认 0.0.0.0）
  --name <名称>         本机设备显示名称
  --dir <路径>          共享目录（局域网可访问下载，默认 ./shared）
  --download-dir <路径> 接收文件保存目录（默认 ./downloads）
  --pin <数字>          设置访问/推送 PIN 码（可选，防止蹭网设备）
  --auto-accept        无人值守模式：自动接受所有设备推送
  --no-discovery       关闭 UDP 组播设备发现
  --p2p-threads <n>    P2P 推送并发线程数（默认 4，上限 32）
  --p2p-chunk-kb <n>   P2P 分块大小 KB（默认 1024）
  --wait-accept <秒>    等待对方接受时长（默认 180）
  --quiet              静默模式（仅输出错误）
  --open               启动后自动打开本机页面（默认开启）
  --no-open            关闭启动后自动打开浏览器（测试/服务器环境用）
  --version            输出版本
  --help               显示本帮助

环境变量: OPENLAN_PORT / OPENLAN_DIR / OPENLAN_PIN / ... 与参数同名（大写）。
`;
}

module.exports = { resolve, helpText };
