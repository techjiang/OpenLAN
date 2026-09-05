'use strict';
/**
 * OpenLAN HTTP 服务：静态 UI + REST API + SSE 事件流 + 上传/分片下载/扫码分享
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { URL } = require('url');

const { safeBaseName, sha256Hex, bytesHuman, logg, APP_VERSION, displayPath } = require('./util');
const { guessDeviceLabel } = require('./state');

const log = logg.tag('http');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const PUB_DIR = path.join(__dirname, '..', 'public');

class OpenLANHttp {
  constructor(state, p2p) {
    this.state = state;
    this.p2p = p2p;
    this.cfg = state.cfg;
    this.authorized = new Set(); // 开启 PIN 后，通过校验的 sid
  }

  _isAuthorized(req) {
    if (!this.cfg.pin) return true;
    const sid = req.headers['x-sid'] || '';
    return this.authorized.has(sid);
  }

  start() {
    const server = http.createServer((req, res) => this._dispatch(req, res));
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        log.error(`端口 ${this.cfg.port} 已被占用，请使用 --port 更换端口`);
        process.exit(1);
      } else {
        log.error('HTTP 服务错误', e.message);
      }
    });
    this.server = server;
    // 将状态层事件推送到所有在线会话（SSE）
    this.state.on('push', (ev) => {
      for (const s of this.state.sessions.values()) {
        if (s.sse) this._sseSend(s.sse, ev);
      }
    });
    return new Promise((resolve) => {
      server.listen(this.cfg.port, this.cfg.bind, () => {
        log.info(`HTTP 服务监听 http://0.0.0.0:${this.cfg.port}`);
        resolve(server);
      });
    });
  }

  broadcast(ev) {
    for (const s of this.state.sessions.values()) {
      if (s.sse) this._sseSend(s.sse, ev);
    }
  }

  // ------------------------------------------------------------ 分发

  _dispatch(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    // CORS：允许局域网其它 OpenLAN 实例页面跨站调用（同源优先，此处开放便于调试）
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // 跨实例专用
    if (p.startsWith('/api/p2p/')) return this._routeP2P(req, res, p);

    try {
      if (p.startsWith('/api/')) return this._routeAPI(req, res, p, u);
      if (p.startsWith('/s/')) {
        const code = safeBaseName(decodeURIComponent(p.slice(3)));
        res.writeHead(302, { Location: `/?share=${encodeURIComponent(code)}` });
        res.end();
        return;
      }
      // 根目录静态文件（如 /OpenLAN-Logo.png）或 static/css/js/favicon
      if (p.startsWith('/static/') || p.startsWith('/css/') || p.startsWith('/js/')
        || p === '/favicon.ico' || p === '/favicon.svg'
        || /^\/[A-Za-z0-9._-]+\.[a-z0-9]{1,6}$/i.test(p)) return this._serveStatic(req, res, p);
      // 单页
      return this._serveStatic(req, res, '/index.html');
    } catch (e) {
      this._json(res, 500, { ok: false, error: '内部错误: ' + e.message });
    }
  }

  _routeAPI(req, res, p, u) {
    const st = this.state;
    const q = u.searchParams;
    const send = (code, obj) => this._json(res, code, obj);

    // PIN 门禁：除开放端点外全部要求已授权会话
    if (this.cfg.pin && !this._isAuthorized(req)) {
      const openPaths = ['/api/session/open', '/api/bootstrap', '/api/events', '/api/qr'];
      if (!openPaths.some((x) => p.startsWith(x))) {
        return send(401, { ok: false, error: '需要访问 PIN', pinRequired: true });
      }
    }

    // ---- bootstrap
    if (p === '/api/bootstrap' && req.method === 'GET') {
      const inst = st.instance;
      return send(200, {
        ok: true,
        instance: {
          id: inst.id, name: inst.name, host: inst.host, os: inst.os,
          version: inst.version || APP_VERSION, autoAccept: !!inst.autoAccept,
          pinRequired: !!inst.pinSet, uptime: process.uptime(),
          sharedDir: displayPath(inst.dir), downloadDir: displayPath(inst.downloadDir),
          sharedDirAbs: inst.dir, downloadDirAbs: inst.downloadDir,
        },
        port: this.cfg.port,
        lan: this.p2p.myUrls(),
        features: ['p2p', 'qr', 'share-code', 'text', 'parallel', 'session', 'auto-accept'],
      });
    }

    // ---- session
    if (p === '/api/session/open' && req.method === 'POST') {
      return this._readJson(req, 4096).then((body) => {
        const sid = String(body.sid || q.get('sid') || '');
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(sid)) return send(400, { ok: false, error: 'sid 非法' });
        const ip = req.socket.remoteAddress;
        let name = String(body.name || '').trim();
        if (name.length > 40) name = name.slice(0, 40);
        if (this.cfg.pin && String(body.pin || '') !== this.cfg.pin) {
          return send(401, { ok: false, error: 'PIN 错误', pinRequired: true });
        }
        const s = st.openSession({ sid, name, ip, ua: req.headers['user-agent'] });
        this.authorized.add(sid);
        return send(200, {
          ok: true,
          sid: s.sid,
          name: s.name,
          deviceLabel: guessDeviceLabel(req.headers['user-agent']),
          instanceName: st.instance.name,
          now: Date.now(),
        });
      }).catch(() => send(400, { ok: false, error: '请求体过大或格式错误' }));
    }

    if (p === '/api/session/heartbeat' && req.method === 'POST') {
      const sid = q.get('sid') || '';
      st.heartbeat(sid);
      return send(200, { ok: true });
    }
    if (p === '/api/session/name' && req.method === 'POST') {
      return this._readJson(req, 4096).then((body) => {
        const ok = st.renameSession(String(body.sid || ''), String(body.name || ''));
        return send(ok ? 200 : 404, { ok });
      }).catch(() => send(400, { ok: false }));
    }
    if (p === '/api/sessions' && req.method === 'GET') {
      return send(200, { ok: true, sessions: st.listSessions() });
    }
    if (p === '/api/peers' && req.method === 'GET') {
      return send(200, { ok: true, peers: st.listPeers() });
    }
    // 手动添加对端实例（组播不可达的网络环境，如 AP 隔离）
    if (p === '/api/peers' && req.method === 'POST') {
      return this._readJson(req, 4096).then((body) => {
        const host = String(body.ip || body.host || '').trim().replace(/^https?:\/\//, '').split('/')[0];
        const port = parseInt(body.port, 10);
        const ipOk = /^[\w.-]+$/.test(host) && host.length <= 80;
        if (!ipOk || !port || port < 1 || port > 65535) return send(400, { ok: false, error: '地址格式不正确' });
        const url = `http://${host}:${port}`;
        const peer = st.addManualPeer({ name: body.name, host, url });
        return send(200, { ok: true, peer });
      }).catch(() => send(400, { ok: false, error: '请求无效' }));
    }
    if (p === '/api/devices' && req.method === 'GET') {
      const sessions = st.listSessions().map((s) => ({ kind: 'session', id: s.sid, name: s.name, desc: s.label, online: s.online, lastSeen: s.lastSeen, ip: s.ip }));
      const peers = st.listPeers().map((s) => ({ kind: 'peer', id: s.id, name: s.name, desc: s.host || s.os, online: s.online, lastSeen: s.lastSeen, urls: s.urls, autoAccept: s.autoAccept, version: s.version }));
      const all = [...sessions, ...peers].sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen));
      return send(200, { ok: true, devices: all });
    }

    // ---- files
    if (p === '/api/files' && req.method === 'GET') {
      return st.listFiles().then((files) => send(200, { ok: true, files, sharedDir: this.cfg.sharedDir }));
    }
    if (p === '/api/upload' && req.method === 'POST') {
      return this._handleUpload(req, res);
    }
    let m = p.match(/^\/api\/files\/([A-Za-z0-9]+)$/);
    if (m && req.method === 'DELETE') {
      return st.deleteSharedFile(m[1])
        .then((ok) => send(ok ? 200 : 404, { ok, error: ok ? '' : '文件不存在或已被删除' }))
        .catch((e) => send(409, { ok: false, error: '删除失败：' + e.message }));
    }

    m = p.match(/^\/api\/down\/([A-Za-z0-9]+)$/);
    if (m && req.method === 'GET') return this._handleDownload(req, res, m[1]);

    // ---- 快速分享
    if (p === '/api/shares' && req.method === 'POST') {
      return this._readJson(req, 1 << 20).then((body) => {
        const tokenIds = Array.isArray(body.files) ? body.files : [];
        const minutes = Math.max(1, Math.min(10080, parseInt(body.minutes, 10) || 1440));
        return Promise.all(tokenIds.map((t) => st.lookupFileByToken(t)))
          .then((founds) => {
            const files = founds.filter(Boolean);
            if (!files.length && !body.text) return send(400, { ok: false, error: '没有可分享内容' });
            const share = st.createShare({ files, text: String(body.text || ''), minutes });
            return send(200, { ok: true, share: this._shareView(share) });
          });
      }).catch(() => send(400, { ok: false }));
    }
    m = p.match(/^\/api\/shares\/([A-Za-z0-9]+)$/);
    if (m && req.method === 'GET') {
      const share = st.getShare(m[1]);
      if (!share) return send(404, { ok: false, error: '提取码不存在或已过期' });
      return send(200, { ok: true, share: this._shareView(share) });
    }

    // ---- 会话推送（offer）
    if (p === '/api/offers' && req.method === 'POST') {
      return this._readJson(req, 1 << 20).then(async (body) => {
        const out = { ok: true, sessionOffers: [], outbounds: [] };
        const tokenIds = Array.isArray(body.files) ? body.files : [];
        const text = String(body.text || '');
        const targets = Array.isArray(body.targets) ? body.targets.filter((t) => t && t.id) : [];
        if (!targets.length) return send(400, { ok: false, error: '未选择目标设备' });
        const files = (await Promise.all(tokenIds.map((t) => st.lookupFileByToken(t)))).filter(Boolean);
        if (!files.length && !text) return send(400, { ok: false, error: '没有可发送内容' });
        const sender = { id: st.instance.id, name: st.instance.name };
        for (const t of targets) {
          try {
            if (t.kind === 'session') {
              const offer = st.createOffer({ sid: t.id, from: sender, files, text });
              st.pushEvent({ type: 'offer', offer: require('./state').offerView(offer), toSid: t.id });
              out.sessionOffers.push(offer.oid);
            } else if (t.kind === 'peer') {
              const peer = st.listPeers().find((x) => x.id === t.id);
              if (!peer) throw new Error('对端设备已离线');
              const r = await this.p2p.sendInvite({ peer, tokenIds, text });
              out.outbounds.push(r.pid);
            } else {
              throw new Error('未知设备类型');
            }
          } catch (e) {
            out.error = out.error || [];
            out.error.push({ id: t.id, name: t.name || t.id, message: e.message });
          }
        }
        if (out.error && out.error.length === targets.length) {
          out.ok = false;
          out.error = out.error.map((e) => (e.name ? `${e.name}: ${e.message}` : e.message)).join('；');
        }
        return send(out.ok ? 200 : 400, out);
      }).catch(() => send(400, { ok: false, error: '请求无效' }));
    }
    m = p.match(/^\/api\/offers\/([A-Za-z0-9-]+)$/);
    if (m && req.method === 'GET') {
      const offer = st.offers.get(m[1]);
      if (!offer) return send(404, { ok: false, error: '推送不存在或已过期' });
      return send(200, { ok: true, offer: require('./state').offerView(offer) });
    }
    m = p.match(/^\/api\/offers\/([A-Za-z0-9-]+)\/(accept|done|reject)$/);
    if (m && req.method === 'POST') {
      const oid = m[1];
      const action = m[2];
      const offer = st.offers.get(oid);
      if (!offer) return send(404, { ok: false, error: '推送不存在或已过期' });
      if (action === 'accept') {
        const o = st.acceptOffer(oid);
        if (!o) return send(409, { ok: false, error: '该推送已处理' });
        st.pushEvent({ type: 'offer', offer: require('./state').offerView(o), toSid: o.sid });
        return send(200, { ok: true, offer: require('./state').offerView(o) });
      }
      if (action === 'done') {
        return this._readJson(req, 4096).then((body) => {
          st.finishOffer(oid, true, String((body && body.detail) || '完成'));
          offer.state = 'done';
          st.pushEvent({ type: 'offer', offer: require('./state').offerView(offer), toSid: offer.sid });
          return send(200, { ok: true });
        }).catch(() => send(400, { ok: false }));
      }
      st.finishOffer(oid, false);
      offer.state = 'denied';
      st.pushEvent({ type: 'offer', offer: require('./state').offerView(offer), toSid: offer.sid });
      return send(200, { ok: true });
    }

    // ---- 收件箱 / 发件箱 / 记录
    if (p === '/api/inbox' && req.method === 'GET') {
      const jobs = [];
      for (const j of st.inbound.values()) jobs.push(require('./state').inboundView(j));
      jobs.sort((a, b) => b.createdAt - a.createdAt);
      return send(200, { ok: true, jobs });
    }
    if (p === '/api/outbox' && req.method === 'GET') {
      const jobs = [];
      for (const j of st.outbound.values()) jobs.push(require('./state').outboundView(j));
      jobs.sort((a, b) => b.createdAt - a.createdAt);
      return send(200, { ok: true, jobs });
    }
    m = p.match(/^\/api\/inbound\/([A-Za-z0-9-]+)\/(accept|deny)$/);
    if (m && req.method === 'POST') {
      const pid = m[1];
      const act = m[2];
      if (act === 'accept') {
        return this.p2p.acceptInbound(pid).then(() => send(200, { ok: true })).catch((e) => send(400, { ok: false, error: e.message }));
      }
      return this.p2p.denyInbound(pid).then((r) => send(200, { ok: r.ok }));
    }
    if (p === '/api/records' && req.method === 'GET') {
      return send(200, { ok: true, records: st.listRecords() });
    }

    // ---- QR
    if (p === '/api/qr' && req.method === 'GET') {
      const text = q.get('text') || '';
      if (!text) return send(400, { ok: false, error: '缺少 text' });
      return this._genQR(text).then((buf) => {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'no-store' });
        res.end(buf);
      }).catch((e) => send(500, { ok: false, error: e.message }));
    }

    // ---- SSE
    if (p === '/api/events' && req.method === 'GET') {
      return this._handleSSE(req, res, q.get('sid') || '');
    }

    return send(404, { ok: false, error: '接口不存在' });
  }

  // ------------------------------------------------------------ P2P 跨实例路由

  _routeP2P(req, res, p) {
    const st = this.state;
    const send = (code, obj) => this._json(res, code, obj);
    const isRemote = (r) => this.p2p._isRemotePinOk(r);

    if (p === '/api/p2p/invite' && req.method === 'POST') {
      return this._readJson(req, 4 * 1024 * 1024).then((body) => this.p2p.onRemoteInvite(body || {}, req).then((r) => send(r.ok ? 200 : 403, r)))
        .catch((e) => send(500, { ok: false, error: e.message }));
    }
    let m = p.match(/^\/api\/p2p\/in\/([A-Za-z0-9-]+)\/(chunk|complete|abort)$/);
    if (m && req.method === 'POST') {
      const pid = m[1];
      const act = m[2];
      if (!isRemote(req)) return send(403, { ok: false, error: 'PIN 校验失败' });
      if (act === 'chunk') {
        return this._readRaw(req, 64 * 1024 * 1024).then((buf) => this.p2p.writeInboundChunk(pid, req.headers, buf).then((r) => send(r.ok ? 200 : 400, r)))
          .catch(() => send(400, { ok: false, error: '读取分块失败' }));
      }
      if (act === 'complete') {
        return this._readJson(req, 16 * 1024 * 1024).then(() => this.p2p.completeInbound(pid).then((r) => send(r.ok ? 200 : 400, r)))
          .catch(() => send(400, { ok: false, error: '请求无效' }));
      }
      return this.p2p.onRemoteAbort(pid).then((r) => send(200, { ok: r.ok }));
    }
    m = p.match(/^\/api\/p2p\/([A-Za-z0-9-]+)\/(go|denied)$/);
    if (m && req.method === 'POST') {
      const pid = m[1];
      const act = m[2];
      if (!isRemote(req)) return send(403, { ok: false, error: 'PIN 校验失败' });
      if (act === 'go') {
        return this._readJson(req, 1 << 20).then((body) => this.p2p.handleGo(pid, (body && body.receiver) || {}).then((r) => send(r.ok ? 200 : 404, r)))
          .catch(() => send(400, { ok: false, error: '请求无效' }));
      }
      return this.p2p.handleDenied(pid).then((r) => send(r.ok ? 200 : 404, r));
    }
    return send(404, { ok: false, error: '接口不存在' });
  }

  // ------------------------------------------------------------ 上传

  async _handleUpload(req, res) {
    const st = this.state;
    let name = safeBaseName(decodeURIComponent(req.headers['x-name'] || ''));
    if (!name) return this._json(res, 400, { ok: false, error: '缺少文件名' });
    const declaredSize = parseInt(req.headers['x-size'], 10) || 0;
    const expectSha = String(req.headers['x-sha256'] || '').toLowerCase();

    let targetPath = path.join(st.cfg.sharedDir, name);
    // 同名文件自动重名
    for (let i = 1; fs.existsSync(targetPath); i++) {
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      targetPath = path.join(st.cfg.sharedDir, `${base} (${i})${ext}`);
    }
    const finalName = path.basename(targetPath);
    const out = fs.createWriteStream(targetPath, { flags: 'w' });
    const hasher = expectSha ? require('crypto').createHash('sha256') : null;
    let received = 0;
    req.on('data', (c) => {
      received += c.length;
      if (hasher) hasher.update(c);
      if (received > declaredSize + 1 && declaredSize > 0) req.destroy();
    });
    req.on('error', () => { out.destroy(); });
    req.pipe(out);

    await new Promise((resolve) => {
      out.on('finish', resolve);
      out.on('error', () => resolve());
    });
    const finalSize = received;
    if (declaredSize > 0 && finalSize !== declaredSize) {
      await fsp.unlink(targetPath).catch(() => {});
      return this._json(res, 400, { ok: false, error: `长度不一致: ${finalSize}/${declaredSize}` });
    }
    if (expectSha && hasher.digest('hex') !== expectSha) {
      await fsp.unlink(targetPath).catch(() => {});
      return this._json(res, 422, { ok: false, error: 'SHA-256 校验失败，文件已丢弃' });
    }
    st.invalidateFiles();
    const entry = {
      token: st.fileToken({ name: finalName, size: finalSize, mtime: Date.now() }),
      name: finalName,
      size: finalSize,
      mtime: Date.now(),
    };
    this._json(res, 200, { ok: true, file: entry });
  }

  // ------------------------------------------------------------ 分片下载（Range）

  async _handleDownload(req, res, token) {
    const st = this.state;
    const file = await st.lookupFileByToken(token);
    if (!file) return this._json(res, 404, { ok: false, error: '文件不存在' });
    const abs = path.join(st.cfg.sharedDir, file.name);
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch (_) { return this._json(res, 404, { ok: false, error: '文件不可读' }); }
    const total = stat.size;
    const mime = MIME[path.extname(file.name).toLowerCase()] || 'application/octet-stream';
    const cdName = file.name.replace(/[^\x20-\x7e]/g, (m) => `%${Buffer.from(m, 'utf8').toString('hex').toUpperCase()}`);
    const baseHeaders = {
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-type': mime,
      'content-disposition': `attachment; filename="${file.name.replace(/["\\]/g, '_')}"; filename*=UTF-8''${cdName}`,
    };
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start;
      let end;
      if (m && m[1] !== '' && m[2] !== '') { start = parseInt(m[1], 10); end = parseInt(m[2], 10); }
      else if (m && m[1] === '') { start = Math.max(0, total - parseInt(m[2], 10)); end = total - 1; }
      else if (m) { start = parseInt(m[1], 10); end = total - 1; }
      if (m && start != null && start < total && start <= end) {
        if (end >= total) end = total - 1;
        res.writeHead(206, Object.assign({}, baseHeaders, {
          'content-range': `bytes ${start}-${end}/${total}`,
          'content-length': end - start + 1,
        }));
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      res.end();
      return;
    }
    res.writeHead(200, Object.assign({}, baseHeaders, { 'content-length': total }));
    fs.createReadStream(abs).pipe(res);
  }

  // ------------------------------------------------------------ 静态

  async _serveStatic(req, res, p) {
    const map = { '/': '/index.html', '/favicon.ico': '/OpenLAN-Logo.png', '/favicon.svg': '/OpenLAN-Logo.png' };
    let rel = map[p] || p;
    if (p.startsWith('/static/')) rel = p.slice('/static/'.length) || '/index.html';
    let abs = path.join(PUB_DIR, rel);
    if (!abs.startsWith(PUB_DIR)) { this._json(res, 403, { ok: false }); return; }
    try {
      const st = await fsp.stat(abs);
      if (!st.isFile()) { this._json(res, 404, { ok: false }); return; }
      res.writeHead(200, {
        'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
        'content-length': st.size,
        'cache-control': 'no-cache',
      });
      fs.createReadStream(abs).pipe(res);
    } catch (_) {
      this._json(res, 404, { ok: false, error: '资源不存在' });
    }
  }

  // ------------------------------------------------------------ SSE

  async _handleSSE(req, res, sid) {
    const st = this.state;
    if (!st.sessions.has(sid)) { this._json(res, 400, { ok: false, error: '会话不存在' }); return; }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const replay = st.collectReplay(sid);
    this._sseSend(res, { type: 'hello', ts: Date.now(), me: { sid }, instanceName: st.instance.name });
    if (replay.offers.length || replay.inbound.length) {
      this._sseSend(res, { type: 'replay', offers: replay.offers, inbound: replay.inbound });
    }
    st.attachSse(sid, res);

    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { clearInterval(hb); } }, 15000);
    hb.unref && hb.unref();
    const onClose = () => {
      clearInterval(hb);
      st.detachSse(sid);
    };
    req.on('close', onClose);
    res.on('close', onClose);
  }

  _sseSend(res, obj) {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) { /* noop */ }
  }

  // ------------------------------------------------------------ 工具

  _shareView(share) {
    return {
      code: share.code,
      files: share.files,
      text: share.text,
      createdAt: share.createdAt,
      expireAt: share.expireAt,
      hits: share.hits,
    };
  }

  _readJson(req, limit) {
    return this._readRaw(req, limit).then((buf) => JSON.parse(buf.toString('utf8') || '{}'));
  }

  _readRaw(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let len = 0;
      req.on('data', (c) => {
        len += c.length;
        if (len > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  _json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  async _genQR(text) {
    const QR = require('qrcode');
    return QR.toBuffer(text, { type: 'png', width: 640, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#101418ff', light: '#ffffff' } });
  }
}

module.exports = { OpenLANHttp, PUB_DIR };
