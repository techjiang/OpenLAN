'use strict';
/**
 * 局域网设备发现：UDP 组播信标
 * 每台 OpenLAN 实例周期性向组播组广播自己的身份与访问地址，
 * 收到信标的实例即可在「设备」列表中看到对方并直接发起 P2P 推送。
 */
const dgram = require('dgram');
const { lanIPv4s, logg, APP_VERSION } = require('./util');

const log = logg.tag('discovery');

const MULTICAST_GROUP = '239.76.66.66';
const MULTICAST_PORT = 46233;
const BEACON_INTERVAL = 2500;
const TTL = 4;

class Discovery {
  constructor(state) {
    this.state = state;
    this.socket = null;
    this.timer = null;
    this.bases = [];
  }

  start() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (err) => {
      log.warn('组播监听错误', err.code || err.message);
    });

    socket.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    socket.on('listening', () => {
      try {
        socket.addMembership(MULTICAST_GROUP);
        socket.setMulticastTTL(TTL);
        socket.setMulticastLoopback(true);
      } catch (e) {
        log.warn('加入组播失败（可能网络限制），将回退为仅本机', e.message);
      }
      log.info(`设备发现已启动 ${MULTICAST_GROUP}:${MULTICAST_PORT}`);
    });

    socket.bind(MULTICAST_PORT, () => {
      this._announce();
      this.timer = setInterval(() => this._announce(), BEACON_INTERVAL);
      this.timer.unref && this.timer.unref();
    });
  }

  _myUrls() {
    const port = this.state.cfg.port;
    const addrs = lanIPv4s().map((i) => i.addr);
    if (!addrs.length) return [];
    // 优先非虚拟网卡；给出全部地址
    return [...new Set(addrs)].map((a) => `http://${a}:${port}`);
  }

  _announce() {
    if (!this.socket) return;
    const urls = this._myUrls();
    if (!urls.length) return;
    this.bases = urls;
    const inst = this.state.instance;
    const beacon = Buffer.from(JSON.stringify({
      t: 'openlan',
      v: 1,
      id: inst.id,
      name: inst.name,
      host: inst.host,
      os: inst.os,
      version: APP_VERSION || inst.version,
      autoAccept: !!inst.autoAccept,
      urls,
    }));
    try {
      this.socket.send(beacon, 0, beacon.length, MULTICAST_PORT, MULTICAST_GROUP);
    } catch (_) { /* noop */ }
  }

  _onMessage(msg, rinfo) {
    if (!this.state) return;
    let data;
    try { data = JSON.parse(msg.toString('utf8')); } catch (_) { return; }
    if (!data || data.t !== 'openlan' || data.id === this.state.instance.id) return;
    if (data.v !== 1) return;
    const peer = {
      id: data.id,
      name: data.name,
      host: data.host,
      os: data.os,
      version: data.version,
      autoAccept: data.autoAccept,
      urls: Array.isArray(data.urls) ? data.urls : [],
      url: (Array.isArray(data.urls) && data.urls[0]) || '',
    };
    // 记录最后来源 IP（供日志/诊断）
    peer.srcIp = rinfo.address;
    this.state.upsertPeer(peer);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.socket) {
      try { this.socket.close(); } catch (_) { /* noop */ }
    }
    this.socket = null;
  }
}

module.exports = { Discovery, MULTICAST_GROUP, MULTICAST_PORT };
