'use strict';
/**
 * OpenLAN 通用工具
 */
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

const APP_VERSION = require('../package.json').version;
const APP_NAME = 'OpenLAN';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let logLevel = 'info';
let quiet = false;

function setLogOptions(opts = {}) {
  if (opts.level) logLevel = opts.level;
  if (typeof opts.quiet === 'boolean') quiet = opts.quiet;
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(tag, level, args) {
  if (quiet && level !== 'error') return;
  if (LOG_LEVELS[level] < LOG_LEVELS[logLevel]) return;
  const color = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }[level] || '';
  const reset = '\x1b[0m';
  const head = `${color}[${level.toUpperCase()}]${reset} ${ts()} ${tag}`;
  // eslint-disable-next-line no-console
  console.log(head, ...args);
}

const logger = {
  debug: (...a) => log('OpenLAN', 'debug', a),
  info: (...a) => log('OpenLAN', 'info', a),
  warn: (...a) => log('OpenLAN', 'warn', a),
  error: (...a) => log('OpenLAN', 'error', a),
  tag(tag) {
    return {
      debug: (...a) => log(tag, 'debug', a),
      info: (...a) => log(tag, 'info', a),
      warn: (...a) => log(tag, 'warn', a),
      error: (...a) => log(tag, 'error', a),
    };
  },
};
const logg = logger;

function uid(len = 12) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

function shortId(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/** 是否为安全文件名字符（防止路径穿越） */
function safeBaseName(name) {
  const n = String(name || '').replace(/[\\/]/g, '_');
  if (!n || n === '.' || n === '..') return '';
  return n.replace(/[\x00-\x1f<>:"|?*]/g, '_').slice(0, 240);
}

/** 获取本机所有 IPv4 局域网地址（排除回环、虚拟网卡可根据参数过滤） */
function lanIPv4s() {
  const list = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const isVirtual = /^(vEthernet|docker|vmnet|vbox|tailscale|zerotier|utun|lo)/i.test(name);
        list.push({ addr: iface.address, name, virtual: isVirtual });
      }
    }
  }
  // 真实网卡优先
  list.sort((a, b) => (a.virtual === b.virtual ? 0 : a.virtual ? 1 : -1));
  return list;
}

function osLabel() {
  const p = os.platform();
  const m = { win32: 'Windows', darwin: 'macOS', linux: 'Linux', freebsd: 'FreeBSD' };
  return m[p] || p;
}

function hostname() {
  return os.hostname() || 'openlan-host';
}

/** 目录下所有文件条目（仅第一层文件） */
async function listFilesInDir(dir) {
  const out = [];
  let items = [];
  try {
    items = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const it of items) {
    if (!it.isFile()) continue;
    const abs = path.join(dir, it.name);
    try {
      const st = await fs.promises.stat(abs);
      out.push({ name: it.name, abs, size: st.size, mtime: st.mtimeMs });
    } catch (_) { /* ignore */ }
  }
  return out;
}

function bytesHuman(n) {
  if (!Number.isFinite(n)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${s} ${units[i]}`;
}

function speedHuman(bytesPerSec) {
  return `${bytesHuman(bytesPerSec)}/s`;
}

function parseSize(str) {
  if (typeof str !== 'string') return NaN;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(str.trim());
  if (!m) return NaN;
  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.round(parseFloat(m[1]) * (units[(m[2] || 'b').toLowerCase()] || 1));
}

/** 目录展示用：位于当前工作目录内时显示相对路径（如 .\\shared），否则原样显示绝对路径 */
function displayPath(p) {
  const base = process.cwd();
  const rel = path.relative(base, p);
  if (!rel) return '.' + path.sep;
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return p;
  return '.' + path.sep + rel;
}

function parseArgs(argv) {
  const cfg = {};
  const boolKeys = ['auto-accept', 'no-discovery', 'quiet', 'no-qr', 'no-open', 'version', 'help'];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--') && !a.startsWith('-')) continue;
    a = a.replace(/^--/, '').replace(/^-/, '');
    if (boolKeys.includes(a)) { cfg[a] = true; continue; }
    const eq = a.indexOf('=');
    let key = a;
    let val;
    if (eq > 0) { key = a.slice(0, eq); val = a.slice(eq + 1); }
    else { val = argv[i + 1]; i++; }
    cfg[key] = val;
  }
  return cfg;
}

module.exports = {
  APP_VERSION,
  APP_NAME,
  setLogOptions,
  logger,
  logg,
  uid,
  shortId,
  sha256Hex,
  hmacHex,
  safeBaseName,
  lanIPv4s,
  osLabel,
  hostname,
  listFilesInDir,
  bytesHuman,
  speedHuman,
  parseSize,
  displayPath,
  parseArgs,
};
