'use strict';
/**
 * OpenLAN 服务入口
 * 启动：node server/index.js [选项]
 */
const { resolve, helpText } = require('../config');
const { setLogOptions, logger, logg, APP_NAME, APP_VERSION, bytesHuman, displayPath } = require('./util');

const log = logg.tag('boot');

async function main() {
  const cfg = resolve();
  if (cfg.help) { console.log(helpText()); process.exit(0); }
  if (cfg.version) { console.log(APP_VERSION); process.exit(0); }
  setLogOptions({ level: cfg.quiet ? 'error' : 'info', quiet: cfg.quiet });

  logger.info('');
  logger.info(`  ██████╗ ██████╗ ███████╗███╗   ██╗██╗      █████╗ ███╗   ██╗`);
  logger.info(` ██╔═══██╗██╔══██╗██╔════╝████╗  ██║██║     ██╔══██╗████╗  ██║`);
  logger.info(` ██║   ██║██████╔╝█████╗  ██╔██╗ ██║██║     ███████║██╔██╗ ██║`);
  logger.info(` ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██║     ██╔══██║██║╚██╗██║`);
  logger.info(` ╚██████╔╝██║     ███████╗██║ ╚████║███████╗██║  ██║██║ ╚████║`);
  logger.info(`  ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝`);
  logger.info(` ${APP_NAME} v${APP_VERSION}  —  开源局域网文件急速传输工具`);
  logger.info('');

  const { OpenLANState } = require('./state');
  const { P2PManager } = require('./p2p');
  const { OpenLANHttp } = require('./http');
  const { Discovery } = require('./discovery');

  const state = new OpenLANState(cfg);
  await state.init();

  const p2p = new P2PManager(state);
  const http = new OpenLANHttp(state, p2p);
  await http.start();

  let discovery = null;
  if (cfg.discovery) {
    discovery = new Discovery(state);
    try {
      discovery.start();
    } catch (e) {
      log.warn('设备发现未启动：', e.message);
    }
  } else {
    log.info('设备发现已关闭（--no-discovery）');
  }

  // 事件转发（SSE 广播在 OpenLANHttp.start 中注册，此处兜底日志）
  state.on('push', (ev) => {
    if (ev && ev.type === 'record') return;
    if (process.env.OPENLAN_DEBUG) log.debug('event:', ev.type);
  });

  printUrls(cfg, state, http, p2p);

  if (cfg.open) {
    const open = require('child_process');
    const first = p2p.myUrls()[0] || `http://127.0.0.1:${cfg.port}`;
    try {
      const platform = process.platform;
      const cmd = platform === 'win32' ? 'start ""' : platform === 'darwin' ? 'open' : 'xdg-open';
      open.exec(`${cmd} "${first}"`, { windowsHide: true });
    } catch (_) { /* 打开失败可忽略 */ }
  }

  const shutdown = async () => {
    log.info('正在关闭 OpenLAN ...');
    if (discovery) discovery.stop();
    if (http.server) http.server.close();
    await state.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function printUrls(cfg, state, http, p2p) {
  log.info('──────────────────────────────────────────────────────');
  log.info(`  共享目录 : ${displayPath(cfg.sharedDir)}`);
  log.info(`  接收目录 : ${displayPath(cfg.downloadDir)}`);
  if (cfg.pin) log.info(`  访问 PIN : ${cfg.pin}  (开启保护)`);
  if (cfg.autoAccept) log.info(`  无人值守 : 已开启自动接受推送`);
  const urls = p2p.myUrls();
  if (urls.length) {
    log.info('  局域网访问:');
    for (const u of urls) log.info(`    ${u}`);
    log.info('  本机访问  : http://127.0.0.1:' + cfg.port);
    log.info('  手机/其它设备：请用上方「局域网访问」地址，并确保本机防火墙放行 Node.js / TCP ' + cfg.port);
  } else {
    log.info('  本机访问  : http://127.0.0.1:' + cfg.port);
    log.warn('  未发现局域网地址，其他设备可能无法访问');
  }
  try {
    const QR = require('qrcode');
    const qrUrl = urls[0] || `http://127.0.0.1:${cfg.port}`;
    QR.toString(qrUrl, { type: 'terminal', small: true })
      .then((s) => { log.info('  扫码直达  : ' + qrUrl + '\n' + s); })
      .catch(() => {});
  } catch (_) { /* qrcode 未安装时跳过控制台二维码 */ }
  log.info('  提示：Ctrl+C 停止服务；查看 docs/使用文档.md 获取更多用法');
  log.info('──────────────────────────────────────────────────────');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[FATAL]', e);
  process.exit(1);
});
