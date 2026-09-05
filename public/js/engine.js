/* OpenLAN 传输引擎：多线程分片下载 / 断点队列 / SHA-256 上传
 * 暴露 OLE：{ enqueueFile, cancelTask, getTasks, uploadFile, subscribe, settings, setSettings }
 */
(function () {
  const U = window.OLU;

  // ---------------------------------------------------------------- 设置
  const DEFAULTS = { threads: 6, chunkMB: 4, autoReceive: false };
  function loadSettings() {
    return Object.assign({}, DEFAULTS, U.getL('engine', {}));
  }
  let settings = loadSettings();

  function getSettings() { return Object.assign({}, settings); }
  function setSettings(patch) {
    if (patch && typeof patch === 'object') {
      if (patch.threads != null) settings.threads = Math.max(1, Math.min(24, parseInt(patch.threads, 10) || 1));
      if (patch.chunkMB != null) settings.chunkMB = Math.max(0.5, Math.min(64, parseFloat(patch.chunkMB) || 1));
      if (typeof patch.autoReceive === 'boolean') settings.autoReceive = patch.autoReceive;
      U.setL('engine', settings);
    }
    return getSettings();
  }

  // ---------------------------------------------------------------- 任务登记
  const tasks = new Map();
  const subs = new Set();
  let seq = 0;
  const MAX_RUN = 2;          // 同时活动的整文件下载数
  const ACTIVE = new Set();   // 正在下载的任务 id
  const WAIT = [];            // 排队任务 id

  function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
  function notify(task) { for (const fn of subs) { try { fn(task); } catch (_) { /* noop */ } } }
  function getTasks() { return [...tasks.values()]; }

  function throttleNotify(task) {
    const now = Date.now();
    if (!task._last || now - task._last > 120) {
      task._last = now;
      notify(task);
    }
  }

  // ---------------------------------------------------------------- 下载任务
  function enqueueFile(info) {
    const task = {
      id: ++seq,
      token: info.token,
      name: info.name,
      size: Number(info.size) || 0,
      doneBytes: 0,
      speed: 0,
      state: 'queued',
      err: '',
      group: info.group || null,
      created: Date.now(),
      _speedLast: { t: 0, b: 0 },
    };
    tasks.set(task.id, task);
    notify(task);
    WAIT.push(task.id);
    pump();
    return task;
  }

  function cancelTask(id) {
    const t = tasks.get(id);
    if (!t) return;
    if (t.state === 'queued') {
      t.state = 'canceled';
      const i = WAIT.indexOf(id);
      if (i >= 0) WAIT.splice(i, 1);
      notify(t);
      return;
    }
    if (t.state !== 'active') return;
    t._wantCancel = true;
    if (t._abort) t._abort.abort();
    t.state = 'canceled';
    notify(t);
  }

  function pump() {
    while (ACTIVE.size < MAX_RUN && WAIT.length) {
      const id = WAIT.shift();
      const t = tasks.get(id);
      if (!t) continue;
      if (t.state === 'canceled') continue;
      ACTIVE.add(id);
      runDownload(t).finally(() => { ACTIVE.delete(id); pump(); });
    }
  }

  async function runDownload(task) {
    task.state = 'active';
    notify(task);
    const chunk = settings.chunkMB * 1024 * 1024;
    try {
      if (task.size > 0) {
        const partCount = Math.max(1, Math.ceil(task.size / chunk));
        const parts = new Array(partCount);
        const ac = new AbortController();
        task._abort = ac;
        let next = 0;

        const grab = async () => {
          while (!ac.signal.aborted) {
            const idx = next++;
            if (idx >= partCount) return;
            const start = Math.floor(idx * chunk);
            const end = Math.min(task.size - 1, start + chunk - 1);
            const res = await fetch('/api/down/' + task.token, {
              headers: { Range: `bytes=${start}-${end}` },
              signal: ac.signal,
            });
            if (res.status === 416) {
              // 文件可能已被替换/截断：跳过该空区间
              parts[idx] = new Blob([]);
              continue;
            }
            if (!res.ok) throw new Error(`分片请求失败 HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            parts[idx] = new Blob([buf]);
            task.doneBytes += buf.byteLength;
            touchSpeed(task);
            throttleNotify(task);
          }
        };

        const threads = Math.max(1, Math.min(settings.threads, partCount, task.size > 0 ? settings.threads : 1));
        const workers = [];
        for (let i = 0; i < threads; i++) workers.push(grab());
        await Promise.all(workers);
        if (ac.signal.aborted) throw abortErr();
        const blob = new Blob(parts, {});
        U.saveBlob(blob, task.name);
        task.doneBytes = task.size;
      } else {
        const res = await fetch('/api/down/' + task.token);
        if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
        const blob = await res.blob();
        U.saveBlob(blob, task.name);
      }
      task.state = 'done';
      notify(task);
    } catch (e) {
      if (task._wantCancel || (e && e.name === 'AbortError')) {
        task.state = 'canceled';
      } else {
        task.state = 'error';
        task.err = e && e.message ? e.message : String(e);
      }
      notify(task);
    } finally {
      task._abort = null;
    }
  }

  function abortErr() {
    const e = new Error('aborted');
    e.name = 'AbortError';
    return e;
  }

  function touchSpeed(task) {
    const now = Date.now();
    const s = task._speedLast;
    if (s.t && now - s.t > 250) {
      const inst = ((task.doneBytes - s.b) / (now - s.t)) * 1000;
      task.speed = s.t ? (task.speed * 0.4 + inst * 0.6) : inst;
      s.t = now; s.b = task.doneBytes;
    } else if (!s.t) {
      s.t = now; s.b = task.doneBytes;
    }
  }

  // ---------------------------------------------------------------- SHA-256（纯 JS 增量版，兼容 http 局域网非安全上下文）
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  function rrot(x, n) { return (x >>> n) | (x << (32 - n)); }
  function shaInit() {
    return {
      h: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19],
      len: 0, buf: new Uint8Array(64), buflen: 0,
    };
  }
  function shaBlock(h, p) {
    const w = new Array(64);
    for (let i = 0; i < 16; i++) w[i] = (p[i * 4] << 24) | (p[i * 4 + 1] << 16) | (p[i * 4 + 2] << 8) | p[i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rrot(w[i - 15], 7) ^ rrot(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rrot(w[i - 2], 17) ^ rrot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rrot(e, 6) ^ rrot(e, 11) ^ rrot(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rrot(a, 2) ^ rrot(a, 13) ^ rrot(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  function shaUpdate(st, bytes) {
    st.len += bytes.length;
    let off = 0;
    if (st.buflen) {
      const need = 64 - st.buflen;
      const take = Math.min(need, bytes.length);
      st.buf.set(bytes.subarray(0, take), st.buflen);
      st.buflen += take;
      off += take;
      if (st.buflen === 64) { shaBlock(st.h, st.buf); st.buflen = 0; }
    }
    while (off + 64 <= bytes.length) {
      shaBlock(st.h, bytes.subarray(off, off + 64));
      off += 64;
    }
    if (off < bytes.length) {
      st.buf.set(bytes.subarray(off));
      st.buflen = bytes.length - off;
    }
  }
  function shaFinal(st) {
    const bitsHi = Math.floor(st.len / 0x20000000);
    const bitsLo = (st.len << 3) >>> 0;
    const pad = [0x80];
    const need = (st.buflen < 56) ? 56 - st.buflen : 120 - st.buflen;
    for (let i = 1; i < need; i++) pad.push(0);
    const tail = new Uint8Array(need + 8);
    tail.set(pad);
    const dv = new DataView(tail.buffer);
    dv.setUint32(need, bitsHi);
    dv.setUint32(need + 4, bitsLo);
    shaUpdate(st, tail);
    const out = [];
    for (let i = 0; i < 8; i++) {
      out.push(('00000000' + (st.h[i] >>> 0).toString(16)).slice(-8));
    }
    return out.join('');
  }
  function shaBytes(bytes) { const s = shaInit(); shaUpdate(s, bytes); return shaFinal(s); }
  /** Blob 流式哈希（不整读文件，兼容大文件与无 crypto.subtle 的环境） */
  async function shaBlob(blob) {
    const CH = 4 * 1024 * 1024;
    const st = shaInit();
    for (let o = 0; o < blob.size; o += CH) {
      const buf = await blob.slice(o, Math.min(blob.size, o + CH)).arrayBuffer();
      shaUpdate(st, new Uint8Array(buf));
    }
    return shaFinal(st);
  }

  // ---------------------------------------------------------------- 上传
  async function uploadFile(file) {
    const name = file._olname || file.name || 'unnamed';
    if (!file || typeof file.size !== 'number') throw new Error('无效文件');
    const sha = await shaBlob(file);
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('x-sid', U.sid);
      xhr.setRequestHeader('x-name', encodeURIComponent(name));
      xhr.setRequestHeader('x-size', String(file.size));
      xhr.setRequestHeader('x-sha256', sha);
      xhr.timeout = 10 * 60 * 1000;
      xhr.onload = () => {
        let obj = null;
        try { obj = JSON.parse(xhr.responseText || '{}'); } catch (_) { obj = null; }
        if (xhr.status >= 200 && xhr.status < 300 && obj && obj.ok) resolve(obj.file);
        else reject(new Error((obj && (obj.error || obj.message)) || ('HTTP ' + xhr.status)));
      };
      xhr.onerror = () => reject(new Error('网络错误，上传失败'));
      xhr.ontimeout = () => reject(new Error('上传超时'));
      xhr.send(file);
    });
    return data;
  }

  window.OLE = {
    enqueueFile, cancelTask, getTasks, uploadFile,
    subscribe, settings: getSettings, setSettings,
    _shaBytes: shaBytes, // 供测试
  };
})();
