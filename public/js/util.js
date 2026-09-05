/* OpenLAN 前端工具 */
(function () {
  const U = window.OLU = {
    sid: null,
    genSid() {
      const c = crypto.getRandomValues(new Uint8Array(16));
      let s = '';
      c.forEach((b) => { s += 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]; });
      return 's-' + s;
    },
    esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    fmtSize(n) {
      if (!Number.isFinite(n) || n <= 0) return '0 B';
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0; let v = n;
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      const s = v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
      return s + ' ' + u[i];
    },
    fmtSpeed(bps) {
      if (!bps) return '';
      return U.fmtSize(bps) + '/s';
    },
    fmtTime(ts) {
      const d = new Date(ts);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },
    fmtClock(ts) {
      const d = new Date(ts);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    },
    relTime(ts) {
      const diff = Date.now() - ts;
      if (diff < 60 * 1000) return '刚刚';
      if (diff < 3600 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
      return U.fmtTime(ts);
    },
    ext(name) {
      const i = String(name).lastIndexOf('.');
      if (i <= 0) return '';
      return String(name).slice(i + 1).toLowerCase();
    },
    fileIcon(name) {
      const e = U.ext(name);
      const img = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic'];
      const video = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv'];
      const audio = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'];
      const zip = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'];
      const doc = ['pdf'];
      if (img.includes(e)) return 'img';
      if (video.includes(e)) return 'video';
      if (audio.includes(e)) return 'audio';
      if (zip.includes(e)) return 'zip';
      if (doc.includes(e)) return 'doc';
      return 'file';
    },
    icon(name) {
      return '<svg class="ic"><use href="#i-' + name + '"/></svg>';
    },
    getL(name, def) {
      try {
        const v = localStorage.getItem('ol_' + name);
        return v == null ? def : JSON.parse(v);
      } catch (_) { return def; }
    },
    setL(name, val) {
      try { localStorage.setItem('ol_' + name, JSON.stringify(val)); } catch (_) { /* noop */ }
    },
    on(el, ev, fn, opt) {
      if (!el) return;
      el.addEventListener(ev, fn, opt || false);
    },
    debounce(fn, ms) {
      let t;
      return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    },
    throttle(fn, ms) {
      let last = 0; let trailing = null;
      return (...a) => {
        const now = Date.now();
        if (now - last >= ms) { last = now; fn(...a); }
        else { clearTimeout(trailing); trailing = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (now - last)); }
      };
    },
    saveBlob(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
    },
    copyText(text) {
      if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).catch(() => U.copyFallback(text));
      return Promise.resolve(U.copyFallback(text));
    },
    copyFallback(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) { /* noop */ }
      ta.remove();
    },
    sha256Blob(blob) {
      return blob.arrayBuffer().then((buf) => crypto.subtle.digest('SHA-256', buf)).then((h) => {
        return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
      });
    },
    uid() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); },
    deviceLabel() {
      const ua = navigator.userAgent;
      if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS 设备';
      if (/Android/i.test(ua)) return 'Android 设备';
      if (/Windows/i.test(ua)) return 'Windows 设备';
      if (/Macintosh/i.test(ua)) return 'Mac';
      return '浏览器';
    },
  };

  // 初始化 sid
  U.sid = U.getL('sid', null) || (function () { const s = U.genSid(); U.setL('sid', s); return s; })();
})();
