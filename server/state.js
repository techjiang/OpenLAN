'use strict';
/**
 * OpenLAN 运行时状态中枢
 * 管理：本机实例身份 / 浏览器会话 / 文件索引与令牌 / 局域网对端 / 快速分享 /
 *       发送(offer/outbound)与接收(inbound)任务 / 传输记录，并通过 EventEmitter 广播事件。
 */
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { uid, shortId, hmacHex, safeBaseName, osLabel, hostname, listFilesInDir, logg } = require('./util');

const log = logg.tag('state');

class OpenLANState extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.instance = null;
    this.filesCache = null;         // {at, list}
    this.sessions = new Map();      // sid -> session
    this.peers = new Map();         // id -> peer (来自 UDP 组播 / 手动添加)
    this.shares = new Map();        // code -> share
    this.offers = new Map();        // oid -> offer （会话推送）
    this.inbound = new Map();       // pid -> inbound （接收对方实例推送）
    this.outbound = new Map();      // pid -> outbound （本机推送文件给对方实例）
    this.records = [];
    this._pruneTimer = null;
  }

  async init() {
    const cfg = this.cfg;
    for (const d of [cfg.sharedDir, cfg.downloadDir, path.join(cfg.downloadDir, '.incoming'), cfg.dataDir]) {
      await fsp.mkdir(d, { recursive: true });
    }
    this.instance = await this._loadIdentity();
    this.instance.version = require('../package.json').version;
    this.instance.os = osLabel();
    this.instance.host = hostname();
    this.instance.autoAccept = cfg.autoAccept;
    this.instance.pinSet = !!cfg.pin;
    this.instance.dir = cfg.sharedDir;
    this.instance.downloadDir = cfg.downloadDir;
    this.instance.peerPort = cfg.port;
    log.info('实例身份', this.instance.id, this.instance.name);
    this._pruneTimer = setInterval(() => this._prune(), 10000);
    if (this._pruneTimer.unref) this._pruneTimer.unref();
  }

  async _loadIdentity() {
    const idPath = path.join(this.cfg.dataDir, 'instance.json');
    let ident = {};
    try {
      ident = JSON.parse(await fsp.readFile(idPath, 'utf8'));
    } catch (_) { /* 首次运行 */ }
    if (!ident.id) ident.id = 'OL-' + uid(10).toUpperCase();
    if (!ident.secret) ident.secret = uid(32);
    ident.name = this.cfg.name || ident.name || `${hostname()} 的 OpenLAN`;
    ident.created = ident.created || Date.now();
    try {
      await fsp.writeFile(idPath, JSON.stringify(ident, null, 2));
    } catch (e) {
      log.warn('写入实例身份失败', e.message);
    }
    return ident;
  }

  // ---------- 文件索引 / 令牌 ----------
  fileToken(entry) {
    const key = `${entry.name}:${entry.size}:${Math.floor(entry.mtime)}`;
    return hmacHex(this.instance.secret, 'file|' + key).slice(0, 24);
  }

  async listFiles(force = false) {
    const now = Date.now();
    if (!force && this.filesCache && now - this.filesCache.at < 1500) return this.filesCache.list;
    const list = await listFilesInDir(this.cfg.sharedDir);
    const out = list
      .sort((a, b) => b.mtime - a.mtime)
      .map((f) => ({
        token: this.fileToken(f),
        name: f.name,
        size: f.size,
        mtime: Math.floor(f.mtime),
      }));
    this.filesCache = { at: now, list: out };
    return out;
  }

  invalidateFiles() { this.filesCache = null; }

  async lookupFileByToken(token) {
    const list = await this.listFiles(true);
    return list.find((f) => f.token === token) || null;
  }

  async deleteSharedFile(token) {
    const f = await this.lookupFileByToken(token);
    if (!f) return false;
    const abs = path.join(this.cfg.sharedDir, f.name);
    const st = await fsp.stat(abs);
    if (!st.isFile()) return false;
    try {
      await fsp.unlink(abs);
    } catch (e) {
      // Windows 上文件被占用 / 权限不足 / 目录锁定都会走到这里，需给出可读原因
      const err = new Error(`文件可能正被占用或权限不足（${e.code || e.message}）`);
      err.code = e.code || 'EFILE';
      throw err;
    }
    this.invalidateFiles();
    return true;
  }

  // ---------- 浏览器会话 ----------
  openSession({ sid, name, ip, ua }) {
    let s = this.sessions.get(sid);
    const now = Date.now();
    if (!s) {
      s = {
        sid,
        name: name || '浏览器设备',
        label: guessDeviceLabel(ua),
        ip,
        ua,
        created: now,
        lastSeen: now,
        sse: null,
        lastSseAt: 0,
        pendingOffers: [],
      };
      this.sessions.set(sid, s);
      this.addRecord({ kind: 'sys', dir: 'sys', title: '新设备接入', detail: `${s.name}(${s.label})`, bytes: 0, state: 'ok' });
    } else {
      s.lastSeen = now;
      if (name) s.name = name;
      s.label = guessDeviceLabel(ua || s.ua);
      s.ip = ip || s.ip;
    }
    return s;
  }

  renameSession(sid, name) {
    const s = this.sessions.get(sid);
    if (!s) return false;
    const n = safeBaseName(name);
    s.name = n || '浏览器设备';
    return true;
  }

  heartbeat(sid) {
    const s = this.sessions.get(sid);
    if (s) { s.lastSeen = Date.now(); s.heartbeats = (s.heartbeats || 0) + 1; }
  }

  attachSse(sid, res) {
    const s = this.sessions.get(sid);
    if (!s) return null;
    if (s.sse) { try { s.sse.end(); } catch (_) { /* noop */ } }
    s.sse = res;
    s.lastSseAt = Date.now();
    return s;
  }

  detachSse(sid) {
    const s = this.sessions.get(sid);
    if (s) s.sse = null;
  }

  isOnline(sid) {
    const s = this.sessions.get(sid);
    return !!s && (!!s.sse || Date.now() - s.lastSeen < 30000);
  }

  listSessions() {
    const out = [];
    for (const s of this.sessions.values()) {
      out.push({
        sid: s.sid,
        name: s.name,
        label: s.label,
        ip: s.ip,
        online: this.isOnline(s.sid),
        lastSeen: s.lastSeen,
        created: s.created,
      });
    }
    return out.sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen));
  }

  /** 供 SSE 重连时重放：针对该会话的待处理 offer + 本机待处理 inbound */
  collectReplay(sid) {
    const offers = [];
    for (const o of this.offers.values()) {
      if (o.sid !== sid && o.sid !== '*') continue;
      if (o.state === 'pending' || o.state === 'accepted') offers.push(offerView(o));
    }
    const inbound = [];
    for (const j of this.inbound.values()) {
      if (j.state === 'pending' || j.state === 'receiving') inbound.push(inboundView(j));
    }
    return { offers, inbound };
  }

  // ---------- 局域网实例（对端） ----------
  upsertPeer(p) {
    const old = this.peers.get(p.id);
    const peer = old ? Object.assign(old, p) : { firstSeen: Date.now(), ...p };
    peer.lastSeen = Date.now();
    this.peers.set(p.id, peer);
  }

  addManualPeer({ name, host, url }) {
    const id = 'manual-' + crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
    const old = this.peers.get(id) || {};
    const peer = {
      id,
      name: safeBaseName(name) || host || '手动设备',
      host,
      os: '',
      url,
      urls: [url],
      version: '',
      manual: true,
      firstSeen: old.firstSeen || Date.now(),
    };
    peer.lastSeen = Date.now();
    this.peers.set(id, peer);
    return peer;
  }

  listPeers() {
    const out = [];
    for (const p of this.peers.values()) {
      const online = p.manual ? Date.now() - p.lastSeen < 6 * 3600 * 1000 : Date.now() - p.lastSeen < 15000;
      out.push({
        id: p.id,
        name: p.name,
        host: p.host,
        os: p.os,
        url: p.url,
        urls: p.urls || [p.url],
        online,
        lastSeen: p.lastSeen,
        firstSeen: p.firstSeen,
        autoAccept: !!p.autoAccept,
        version: p.version,
        manual: !!p.manual,
      });
    }
    return out.sort((a, b) => (b.online - a.online) || (a.firstSeen - b.firstSeen));
  }

  // ---------- 快速分享（扫码 / 提取码） ----------
  createShare({ files = [], text = '', minutes = 1440 }) {
    const code = shortId(4);
    const now = Date.now();
    const share = {
      code,
      files: files.map((f) => ({ token: f.token, name: f.name, size: f.size })),
      text,
      createdAt: now,
      expireAt: now + minutes * 60 * 1000,
      hits: 0,
    };
    this.shares.set(code, share);
    this.addRecord({
      kind: 'share', dir: 'sys', title: '创建快速分享', detail: `${share.files.length} 个文件 · 提取码 ${code}`,
      bytes: files.reduce((a, f) => a + (f.size || 0), 0), state: 'ok',
    });
    this._prune();
    return share;
  }

  getShare(code) {
    const s = this.shares.get(String(code || '').toUpperCase());
    if (!s) return null;
    if (Date.now() > s.expireAt) { this.shares.delete(s.code); return null; }
    s.hits++;
    return s;
  }

  // ---------- 会话推送（offer） ----------
  createOffer({ sid, from, files = [], text = '', ttlMs = 30 * 60 * 1000 }) {
    const oid = 'OF-' + uid(8).toUpperCase();
    const offer = {
      oid,
      sid,                    // 目标 sid，或 '*' 表示广播给所有会话
      from: from || { id: this.instance.id, name: this.instance.name },
      files: files.map((f) => ({ token: f.token, name: f.name, size: f.size })),
      text,
      state: 'pending',
      createdAt: Date.now(),
      expireAt: Date.now() + ttlMs,
      received: 0,
    };
    this.offers.set(oid, offer);
    if (sid === '*') {
      for (const s of this.sessions.values()) s.pendingOffers.push(oid);
    } else {
      const s = this.sessions.get(sid);
      if (s) s.pendingOffers.push(oid);
    }
    return offer;
  }

  acceptOffer(oid) {
    const o = this.offers.get(oid);
    if (!o || o.state !== 'pending') return null;
    o.state = 'accepted';
    o.acceptedAt = Date.now();
    return o;
  }

  finishOffer(oid, ok, detail) {
    const o = this.offers.get(oid);
    if (!o) return;
    o.state = ok ? 'done' : 'denied';
    o.doneAt = Date.now();
    this.addRecord({
      kind: 'session', dir: 'out', title: ok ? `已送达 ${o.from.name}` : '对方拒绝接收',
      detail: detail || (o.files.length ? `${o.files.length} 个文件` : '文本'),
      bytes: ok ? o.received : 0,
      state: ok ? 'ok' : 'denied',
    });
  }

  // ---------- 接收：对方实例推送（inbound） ----------
  createInbound({ pid, sender, files = [], text = '' }) {
    const total = files.reduce((a, f) => a + f.size, 0);
    const job = {
      pid,
      sender: sender || {},
      files: files.map((f) => ({ name: safeBaseName(f.name) || 'unnamed', size: f.size || 0 })),
      text,
      totalBytes: total,
      receivedBytes: 0,
      state: 'pending',
      createdAt: Date.now(),
      dir: null,
    };
    this.inbound.set(pid, job);
    this.pushEvent({ type: 'inbound', job: inboundView(job) });
    return job;
  }

  getInbound(pid) { return this.inbound.get(pid) || null; }

  setInboundState(pid, state, extra = {}) {
    const j = this.inbound.get(pid);
    if (!j) return null;
    Object.assign(j, extra, { state });
    this.pushEvent({ type: 'inbound', job: inboundView(j) });
    return j;
  }

  // ---------- 发送：本机推送文件给对端（outbound） ----------
  createOutbound({ pid, peer, files = [], text = '', from }) {
    const total = files.reduce((a, f) => a + f.size, 0);
    const job = {
      pid,
      peer: peer || {},
      from: from || { id: this.instance.id, name: this.instance.name },
      files: files.map((f) => ({ token: f.token, name: safeBaseName(f.name) || 'unnamed', size: f.size, abs: f.abs })),
      text,
      totalBytes: total,
      sentBytes: 0,
      fileDone: files.map(() => false),
      state: 'waiting',
      createdAt: Date.now(),
    };
    this.outbound.set(pid, job);
    this.pushEvent({ type: 'outbound', job: outboundView(job) });
    return job;
  }

  setOutboundState(pid, state, extra = {}) {
    const j = this.outbound.get(pid);
    if (!j) return null;
    Object.assign(j, extra, { state });
    this.pushEvent({ type: 'outbound', job: outboundView(j) });
    return j;
  }

  // ---------- 事件广播 ----------
  pushEvent(ev) {
    this.emit('push', ev);
  }

  // ---------- 记录 ----------
  addRecord(r) {
    const rec = {
      ts: Date.now(),
      kind: r.kind || 'sys',
      dir: r.dir || 'sys',
      title: r.title || '',
      detail: r.detail || '',
      bytes: r.bytes || 0,
      state: r.state || 'ok',
    };
    this.records.unshift(rec);
    if (this.records.length > 800) this.records.length = 800;
    this.pushEvent({ type: 'record' });
  }

  listRecords() { return this.records.slice(0, 300); }

  // ---------- 后台清理 ----------
  _prune() {
    const now = Date.now();
    for (const [sid, s] of this.sessions) {
      if (!s.sse && now - s.lastSeen > 5 * 60 * 1000) this.sessions.delete(sid);
    }
    for (const [id, p] of this.peers) {
      const ttl = p.manual ? 6 * 3600 * 1000 : 60 * 1000;
      if (now - p.lastSeen > ttl) this.peers.delete(id);
    }
    for (const [code, s] of this.shares) {
      if (now > s.expireAt) this.shares.delete(code);
    }
    for (const [oid, o] of this.offers) {
      if (now > o.expireAt && o.state === 'pending') o.state = 'expired';
      if ((o.state === 'expired' || o.state === 'done' || o.state === 'denied') && now - (o.doneAt || o.expireAt) > 3600 * 1000) {
        this.offers.delete(oid);
      }
    }
  }

  async destroy() {
    if (this._pruneTimer) clearInterval(this._pruneTimer);
  }
}

function guessDeviceLabel(ua) {
  const u = String(ua || '');
  if (/iPhone|iPad|iPod/i.test(u)) return 'iOS 设备';
  if (/Android/i.test(u)) return 'Android 设备';
  if (/Macintosh/i.test(u)) return 'Mac';
  if (/Windows/i.test(u)) return 'Windows 设备';
  if (/Linux/i.test(u)) return 'Linux 设备';
  return '浏览器';
}

// ---------- 对外视图（避免把内部字段发给前端） ----------
function offerView(o) {
  return {
    oid: o.oid,
    from: o.from,
    files: o.files,
    text: o.text,
    state: o.state,
    createdAt: o.createdAt,
  };
}
function inboundView(j) {
  return {
    pid: j.pid,
    sender: j.sender,
    files: j.files,
    text: j.text,
    state: j.state,
    totalBytes: j.totalBytes,
    receivedBytes: j.receivedBytes,
    createdAt: j.createdAt,
    err: j.err,
    dir: j.dir,
  };
}
function outboundView(j) {
  return {
    pid: j.pid,
    peer: j.peer,
    files: j.files.map((f, i) => ({ name: f.name, size: f.size, done: !!(j.fileDone && j.fileDone[i]) })),
    text: j.text,
    state: j.state,
    totalBytes: j.totalBytes,
    sentBytes: j.sentBytes,
    createdAt: j.createdAt,
    err: j.err,
  };
}

module.exports = {
  OpenLANState,
  guessDeviceLabel,
  offerView,
  inboundView,
  outboundView,
};
