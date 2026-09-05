'use strict';
/**
 * OpenLAN P2P 传输引擎
 * 负责「设备选择传输」跨实例直推：
 *   A(发送) --invite--> B(接收)   → B 用户确认后调用 A 的 /go
 *   A --分块(带 SHA-256)--> B     → 完成后 A 通知 complete
 * 所有跨实例调用都会在多个可达地址中自动选择。
 */
const http = require('http');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { uid, shortId, safeBaseName, sha256Hex, lanIPv4s, logg } = require('./util');

const log = logg.tag('p2p');

// ---------------------------------------------------------------- HTTP 客户端

function httpCall(base, pathname, { method = 'POST', headers = {}, body, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(pathname, base.endsWith('/') ? base : base + '/'); } catch (e) { reject(new Error('非法地址 ' + base)); return; }
    const isHttp = url.protocol === 'http:';
    const mod = isHttp ? http : null;
    if (!mod) { reject(new Error('仅支持 HTTP 协议')); return; }
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method,
      headers: Object.assign({ connection: 'close' }, headers),
    }, (res) => {
      const chunks = [];
      let len = 0;
      res.on('data', (c) => { chunks.push(c); len += c.length; if (len > 8 * 1024 * 1024) req.destroy(new Error('响应过大')); });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let data = null;
        const ct = String(res.headers['content-type'] || '');
        if (ct.includes('application/json')) { try { data = JSON.parse(buf.toString('utf8')); } catch (_) { data = null; } }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, data });
      });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

/** 依次尝试多个地址，网络层失败则换下一个；收到 HTTP 响应即返回（成功或业务错误由调用方判断） */
async function callAnyBases(bases, pathname, opts = {}) {
  const list = (bases || []).filter(Boolean);
  if (!list.length) throw new Error('对方没有可用地址');
  let lastErr = null;
  for (const base of list) {
    try {
      return await httpCall(base, pathname, opts);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('无法连接对方设备');
}

function jsonReq(opts) {
  const o = Object.assign({}, opts);
  o.headers = Object.assign({ 'content-type': 'application/json' }, opts.headers);
  o.body = Buffer.from(JSON.stringify(opts.body || {}));
  return o;
}

// ---------------------------------------------------------------- 引擎

const CHUNK_RETRY = 3;

class P2PManager {
  constructor(state) {
    this.state = state;
    this.cfg = state.cfg;
    this._hashes = new Map(); // pid:fileIndex -> sha256 (发送端计算)
    this._aborted = new Set();
  }

  myUrls() {
    const port = this.cfg.port;
    const urls = lanIPv4s().map((i) => i.addr).filter(Boolean).map((a) => `http://${a}:${port}`);
    if (!urls.length) urls.push(`http://127.0.0.1:${port}`);
    return urls;
  }

  _xheaders() {
    return {
      'x-openlan-id': this.state.instance.id,
      'x-openlan-name': Buffer.from(this.state.instance.name || '').toString('base64'),
      'x-openlan-pin': this.cfg.pin || '',
    };
  }

  _isRemotePinOk(req) {
    const myPin = this.cfg.pin;
    if (!myPin) return true;
    return req.headers['x-openlan-pin'] === myPin;
  }

  // ============================================================ 发送端（Outbound）

  /**
   * 前端触发：选择对端设备 + 本机共享文件，向对方发出邀请。
   * peer: {id,name,urls,url,...}; tokenIds: 本机文件 token；text: 可选文本
   */
  async sendInvite({ peer, tokenIds = [], text = '' }) {
    const st = this.state;
    const files = [];
    for (const t of tokenIds) {
      const f = await st.lookupFileByToken(t);
      if (!f) continue;
      files.push({ token: f.token, name: f.name, size: f.size, abs: path.join(st.cfg.sharedDir, f.name) });
    }
    if (!files.length && !text) throw new Error('没有可发送的内容');
    if (!peer || !peer.id) throw new Error('目标设备无效');
    if (peer.id === st.instance.id) throw new Error('不能发送给自己');

    const pid = 'TX-' + shortId(6);
    const job = st.createOutbound({
      pid,
      peer: { id: peer.id, name: peer.name },
      files,
      text,
      from: { id: st.instance.id, name: st.instance.name },
    });

    const body = {
      pid,
      sender: {
        id: st.instance.id,
        name: st.instance.name,
        host: st.instance.host,
        urls: this.myUrls(),
      },
      files: files.map((f) => ({ name: f.name, size: f.size })),
      text,
    };
    const bases = peer.urls && peer.urls.length ? peer.urls : [peer.url].filter(Boolean);
    try {
      const res = await callAnyBases(bases, '/api/p2p/invite', jsonReq({ body, headers: this._xheaders(), timeoutMs: 10000 }));
      if (!res.data || res.data.ok !== true) {
        throw new Error((res.data && (res.data.error || res.data.message)) || `对方返回 ${res.status}`);
      }
      job.peer.bases = res.data.baseUrls || bases;
      // 等待对方接受的超时
      const timeoutMs = this.cfg.waitAcceptSec * 1000;
      const timer = setTimeout(() => {
        if (job.state === 'waiting') {
          st.setOutboundState(pid, 'canceled', { err: '对方超时未接受' });
          st.addRecord({ kind: 'p2p', dir: 'out', title: `→ ${job.peer.name}`, detail: '等待超时已取消', bytes: job.totalBytes, state: 'error' });
          this._notifyRemoteAbort(bases, pid, 'sender-timeout');
        }
      }, timeoutMs);
      timer.unref && timer.unref();
      job.expireTimer = timer;
      return { pid, state: 'waiting', peer: job.peer };
    } catch (e) {
      st.setOutboundState(pid, 'error', { err: e.message });
      st.addRecord({ kind: 'p2p', dir: 'out', title: `→ ${peer.name}`, detail: `邀请失败：${e.message}`, bytes: 0, state: 'error' });
      throw e;
    }
  }

  /** 接收端接受后回调：开始推送 */
  async handleGo(pid, receiver) {
    const st = this.state;
    const job = st.outbound.get(pid);
    if (!job) return { ok: false, error: '任务不存在或已被取消' };
    if (job.state === 'sending') return { ok: true }; // 幂等
    if (job.state !== 'waiting') return { ok: false, error: `当前状态(${job.state})无法开始` };
    job.receiver = { id: receiver.id, name: receiver.name, urls: receiver.urls || [] };
    if (job.expireTimer) clearTimeout(job.expireTimer);
    // 后台发送，不阻塞请求
    this._runOutbound(job).catch((e) => log.error('outbound error', e));
    return { ok: true };
  }

  async cancelOutbound(pid) {
    const st = this.state;
    const job = st.outbound.get(pid);
    if (!job) return;
    if (job.expireTimer) clearTimeout(job.expireTimer);
    if (job.state === 'done' || job.state === 'error') return;
    const wasWaiting = job.state === 'waiting';
    st.setOutboundState(pid, 'canceled', { err: '已取消' });
    st.addRecord({ kind: 'p2p', dir: 'out', title: `→ ${job.peer.name}`, detail: '发送已取消', bytes: job.sentBytes || 0, state: 'error' });
    if (wasWaiting) this._notifyRemoteAbort(job.peer.bases || [job.peer.url], pid, 'canceled');
  }

  async handleDenied(pid) {
    const st = this.state;
    const job = st.outbound.get(pid);
    if (!job) return { ok: false, error: '任务不存在' };
    if (job.expireTimer) clearTimeout(job.expireTimer);
    st.setOutboundState(pid, 'denied', { err: '对方拒绝接收' });
    st.addRecord({ kind: 'p2p', dir: 'out', title: `→ ${job.peer.name}`, detail: '对方拒绝接收', bytes: 0, state: 'denied' });
    return { ok: true };
  }

  async _notifyRemoteAbort(bases, pid, reason) {
    try {
      await callAnyBases(bases, `/api/p2p/in/${pid}/abort`, jsonReq({ body: { reason }, headers: this._xheaders(), timeoutMs: 6000 }));
    } catch (_) { /* 尽力通知 */ }
  }

  async _runOutbound(job) {
    const st = this.state;
    const pid = job.pid;
    st.setOutboundState(pid, 'sending', { sentBytes: 0, startedAt: Date.now() });
    const bases = (job.receiver.urls && job.receiver.urls.length ? job.receiver.urls : [job.receiver.url]).filter(Boolean);
    if (!bases.length) {
      st.setOutboundState(pid, 'error', { err: '接收端地址缺失' });
      return;
    }
    try {
      for (let fi = 0; fi < job.files.length; fi++) {
        await this._sendOneFile(job, fi, bases);
        job.fileDone[fi] = true;
        this._emitThrottled(job);
      }
      // 通知对方完整
      const res = await callAnyBases(bases, `/api/p2p/in/${pid}/complete`, jsonReq({
        headers: this._xheaders(),
        timeoutMs: 15000,
        body: {
          files: job.files.map((f, i) => ({ name: f.name, size: f.size, done: job.fileDone[i] })),
          text: job.text,
        },
      }));
      if (!res.data || res.data.ok !== true) throw new Error((res.data && res.data.error) || `complete 返回 ${res.status}`);
      st.setOutboundState(pid, 'done', { doneAt: Date.now() });
      st.addRecord({
        kind: 'p2p', dir: 'out', title: `→ ${job.peer.name}`,
        detail: `${job.files.length ? job.files.length + ' 个文件' : '文本'} · 已完成`,
        bytes: job.totalBytes, state: 'ok',
      });
    } catch (e) {
      st.setOutboundState(pid, 'error', { err: e.message });
      st.addRecord({ kind: 'p2p', dir: 'out', title: `→ ${job.peer.name}`, detail: `失败：${e.message}`, bytes: job.sentBytes, state: 'error' });
      this._notifyRemoteAbort(bases, pid, 'error:' + e.message);
    }
  }

  async _sendOneFile(job, fi, bases) {
    const st = this.state;
    const file = job.files[fi];
    const pid = job.pid;
    const chunkSize = this.cfg.p2pChunk;
    const threads = Math.min(this.cfg.p2pThreads, Math.max(1, Math.ceil(file.size / chunkSize)));

    let fd;
    try {
      fd = await fsp.open(file.abs, 'r');
    } catch (e) {
      throw new Error(`无法读取文件 ${file.name}: ${e.message}`);
    }
    try {
      const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
      let next = 0;
      const readOne = async () => {
        while (true) {
          if (this._aborted.has(pid)) return false;
          const index = next++;
          if (index >= totalChunks) return true;
          const offset = index * chunkSize;
          const len = Math.min(chunkSize, file.size - offset);
          if (len <= 0) return true;
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fd.read(buf, 0, len, offset);
          if (bytesRead !== len) throw new Error('读取不完整');
          const sha = sha256Hex(buf);
          await this._postChunkWithRetry(bases, pid, fi, index, offset, buf, sha);
          job.sentBytes += len;
          this._emitThrottled(job);
        }
      };
      const workers = [];
      for (let i = 0; i < threads; i++) workers.push(readOne());
      await Promise.all(workers);
      job.shaHashes = job.shaHashes || [];
      job.shaHashes[fi] = ''; // 分块级校验，不计算整文件哈希
    } finally {
      await fd.close().catch(() => {});
    }
  }

  async _postChunkWithRetry(bases, pid, fileIndex, index, offset, buf, sha) {
    let lastErr;
    for (let attempt = 0; attempt < CHUNK_RETRY; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
      try {
        const res = await callAnyBases(bases, `/api/p2p/in/${pid}/chunk`, {
          method: 'POST',
          headers: Object.assign({
            'x-file': String(fileIndex),
            'x-index': String(index),
            'x-offset': String(offset),
            'x-length': String(buf.length),
            'x-sha256': sha,
            'content-length': String(buf.length),
          }, this._xheaders()),
          body: buf,
          timeoutMs: 20000,
        });
        if (res.data && res.data.ok === true) return;
        if (res.data && res.data.error) throw new Error(`接收端:${res.data.error}`);
        throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('分块发送失败');
  }

  _emitThrottled(job) {
    const now = Date.now();
    if (!job._lastEmit || now - job._lastEmit > 300) {
      job._lastEmit = now;
      const st = this.state;
      st.setOutboundState(job.pid, job.state, { sentBytes: job.sentBytes });
    }
  }

  // ============================================================ 接收端（Inbound）

  /** 对方发起邀请（收到来自远端的 invite） */
  async onRemoteInvite(body, req) {
    const st = this.state;
    if (!this._isRemotePinOk(req)) return { ok: false, error: 'PIN 校验失败，请在两台设备上使用相同的 --pin' };
    const pid = body.pid;
    if (st.inbound.has(pid)) return { ok: false, error: '重复的传输任务' };
    const sender = {
      id: body.sender.id,
      name: safeBaseName(body.sender.name) || '未知设备',
      host: body.sender.host,
      urls: Array.isArray(body.sender.urls) ? body.sender.urls : [],
    };
    const files = (body.files || []).map((f) => ({ name: String(f.name || ''), size: Number(f.size) || 0 })).filter((f) => f.name);
    const text = String(body.text || '');
    if (!files.length && !text) return { ok: false, error: '空传输任务' };
    const job = st.createInbound({ pid, sender, files, text });
    st.addRecord({ kind: 'p2p', dir: 'in', title: `来自 ${sender.name} 的推送`, detail: `${files.length} 个文件${text ? ' + 文本' : ''}`, bytes: job.totalBytes, state: 'ok' });
    // 无人值守自动接受
    if (this.cfg.autoAccept) {
      await this.acceptInbound(pid);
    }
    return { ok: true, pid, state: job.state, baseUrls: this.myUrls() };
  }

  /** 本机用户点击接受（或自动接受时调用） */
  async acceptInbound(pid) {
    const st = this.state;
    const job = st.getInbound(pid);
    if (!job) throw new Error('任务不存在');
    if (job.state === 'receiving') return job;
    if (job.state !== 'pending') throw new Error(`任务当前状态(${job.state})不能接受`);
    st.setInboundState(pid, 'receiving');
    try {
      // 纯文本任务：先落盘，再通知发送端走完生命周期
      if (job.text && !job.files.length) {
        await this._saveTextInbound(job);
        const bases = job.sender.urls;
        await callAnyBases(bases, `/api/p2p/${pid}/go`, jsonReq({
          headers: this._xheaders(),
          timeoutMs: 12000,
          body: { receiver: { id: st.instance.id, name: st.instance.name, host: st.instance.host, urls: this.myUrls() } },
        }));
        st.setInboundState(pid, 'done', { doneAt: Date.now() });
        st.addRecord({ kind: 'p2p', dir: 'in', title: `来自 ${job.sender.name} 的文本`, detail: '已保存', bytes: Buffer.byteLength(job.text), state: 'ok' });
        return job;
      }
      // 通知发送端开始
      const bases = job.sender.urls;
      const res = await callAnyBases(bases, `/api/p2p/${pid}/go`, jsonReq({
        headers: this._xheaders(),
        timeoutMs: 12000,
        body: { receiver: { id: st.instance.id, name: st.instance.name, host: st.instance.host, urls: this.myUrls() } },
      }));
      if (!res.data || res.data.ok !== true) {
        throw new Error((res.data && res.data.error) || `发送端返回 ${res.status}`);
      }
      return job;
    } catch (e) {
      st.setInboundState(pid, 'error', { err: e.message });
      st.addRecord({ kind: 'p2p', dir: 'in', title: `来自 ${job.sender.name}`, detail: `接受失败：${e.message}`, bytes: 0, state: 'error' });
      throw e;
    }
  }

  /** 本机用户拒绝 */
  async denyInbound(pid) {
    const st = this.state;
    const job = st.getInbound(pid);
    if (!job || job.state !== 'pending') return { ok: false };
    st.setInboundState(pid, 'denied', { err: '用户拒绝' });
    st.addRecord({ kind: 'p2p', dir: 'in', title: `来自 ${job.sender.name}`, detail: '已拒绝', bytes: 0, state: 'denied' });
    try {
      await callAnyBases(job.sender.urls, `/api/p2p/${pid}/denied`, jsonReq({
        headers: this._xheaders(), timeoutMs: 6000, body: { reason: '用户拒绝' },
      }));
    } catch (_) { /* 尽力通知 */ }
    return { ok: true };
  }

  /** 对方取消 / 出错时的接收端兜底 */
  async onRemoteAbort(pid) {
    const st = this.state;
    const job = st.getInbound(pid);
    if (!job) return { ok: true };
    if (job.state === 'receiving') {
      await this._cleanupFiles(job);
    }
    if (job.state === 'pending' || job.state === 'receiving') {
      st.setInboundState(pid, job.state === 'pending' ? 'denied' : 'error', { err: job.state === 'pending' ? '发送方已取消' : '传输中断' });
    }
    return { ok: true };
  }

  /** 接收分块：校验 SHA-256 并写入磁盘 */
  async writeInboundChunk(pid, headers, buf) {
    const st = this.state;
    const job = st.getInbound(pid);
    if (!job) return { ok: false, error: '任务不存在' };
    if (job.state !== 'receiving') return { ok: false, error: '任务未在接受中' };
    const fileIndex = parseInt(headers['x-file'], 10);
    const offset = parseInt(headers['x-offset'], 10);
    const index = headers['x-index'];
    const expectSha = headers['x-sha256'];
    const file = job.files[fileIndex];
    if (!file) return { ok: false, error: '文件索引非法' };
    if (index === undefined) return { ok: false, error: '缺少分块索引' };
    if (!job._chunkSeen) job._chunkSeen = new Set();
    const key = fileIndex + ':' + index;
    if (job._chunkSeen.has(key)) return { ok: true }; // 重复分块，幂等
    const actualSha = sha256Hex(buf);
    if (expectSha && expectSha !== actualSha) return { ok: false, error: `分块校验失败 file#${fileIndex} idx#${index}` };
    try {
      await this._ensureInboundFile(job, fileIndex);
      const fd = job._fds[fileIndex];
      const len = buf.length;
      const { bytesWritten } = await fd.write(buf, 0, len, offset);
      if (bytesWritten !== len) return { ok: false, error: '写入不完整' };
      job._chunkSeen.add(key);
      job.receivedBytes += len;
      this._emitInboundThrottled(job);
      return { ok: true, receivedBytes: job.receivedBytes };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async _ensureInboundFile(job, fileIndex) {
    if (job._fds && job._fds[fileIndex]) return;
    // 防止多分块并发触发多次 'w' 打开：同文件互斥，只允许一次打开
    if (!job._ensureQueue) job._ensureQueue = {};
    const queue = job._ensureQueue;
    if (queue[fileIndex]) return queue[fileIndex];
    const task = this._openInboundFile(job, fileIndex);
    queue[fileIndex] = task;
    try {
      await task;
    } finally {
      delete queue[fileIndex];
    }
  }

  async _openInboundFile(job, fileIndex) {
    const st = this.state;
    if (!job.baseDir) {
      const stamp = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const date = `${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}-${p(stamp.getHours())}${p(stamp.getMinutes())}`;
      job.baseDir = path.join(st.cfg.downloadDir, `${job.sender.name || 'device'}_${date}_${pidSafe(job.pid)}`);
    }
    await fsp.mkdir(job.baseDir, { recursive: true });
    if (job._fds && job._fds[fileIndex]) return;
    const target = path.join(job.baseDir, job.files[fileIndex].name);
    const fd = await fsp.open(target, 'w');
    job._fds = job._fds || [];
    job._targets = job._targets || [];
    job._fds[fileIndex] = fd;
    job._targets[fileIndex] = target;
  }

  async _saveTextInbound(job) {
    const st = this.state;
    const stamp = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const date = `${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}-${p(stamp.getHours())}${p(stamp.getMinutes())}`;
    const baseDir = path.join(st.cfg.downloadDir, `${job.sender.name || 'device'}_${date}_${pidSafe(job.pid)}`);
    await fsp.mkdir(baseDir, { recursive: true });
    const name = safeBaseName((job.sender.name || 'text') + ' 的文本') || '文本';
    const target = path.join(baseDir, `${name}.txt`);
    await fsp.writeFile(target, job.text, 'utf8');
    job.baseDir = baseDir;
    job._targets = [target];
  }

  /** 接收端最终校验并落盘完成 */
  async completeInbound(pid) {
    const st = this.state;
    const job = st.getInbound(pid);
    if (!job) return { ok: false, error: '任务不存在' };
    if (job.state !== 'receiving') return { ok: true }; // 幂等
    try {
      if (job._fds) {
        for (const fd of job._fds) if (fd) await fd.close().catch(() => {});
      }
      job._fds = [];
      // 校验已写字节与声明一致
      const expectTotal = job.totalBytes;
      if (expectTotal > 0 && job.receivedBytes !== expectTotal) {
        throw new Error(`字节数不一致 (收到 ${job.receivedBytes}/${expectTotal})`);
      }
      st.setInboundState(pid, 'done', { doneAt: Date.now() });
      st.addRecord({
        kind: 'p2p', dir: 'in', title: `来自 ${job.sender.name}`, detail: '接收完成', bytes: job.receivedBytes, state: 'ok',
      });
      return { ok: true, dir: job.baseDir };
    } catch (e) {
      st.setInboundState(pid, 'error', { err: e.message });
      st.addRecord({ kind: 'p2p', dir: 'in', title: `来自 ${job.sender.name}`, detail: `接收失败：${e.message}`, bytes: job.receivedBytes, state: 'error' });
      this._notifyRemoteAbort(job.sender.urls, pid, 'receiver-error:' + e.message);
      return { ok: false, error: e.message };
    }
  }

  async _cleanupFiles(job) {
    if (job._fds) for (const fd of job._fds) if (fd) await fd.close().catch(() => {});
    job._fds = [];
    if (job.baseDir) {
      try { await fsp.rm(job.baseDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
    }
  }

  _emitInboundThrottled(job) {
    const now = Date.now();
    if (!job._lastEmitIn || now - job._lastEmitIn > 300) {
      job._lastEmitIn = now;
      const st = this.state;
      st.setInboundState(job.pid, job.state, { receivedBytes: job.receivedBytes });
    }
  }
}

function pidSafe(pid) {
  return String(pid || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16);
}

module.exports = { P2PManager, httpCall, callAnyBases };
