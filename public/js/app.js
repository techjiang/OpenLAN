/* OpenLAN 应用主控 */
(function () {
  const U = OLU;
  const A = OLA;
  const E = OLE;
  const T = OLUI;

  const S = {
    instance: null,
    lanUrls: [],           // 本机局域网地址列表（由 bootstrap 返回）
    files: [],
    fileMap: new Map(),
    devices: [],
    sel: new Set(),
    filter: '',
    view: 'files',
    offerMap: new Map(),   // oid -> offer
    inbound: new Map(),    // pid -> job
    outbound: new Map(),   // pid -> job
    offerGroups: new Map(),// oid -> {tasks:[ids]}
    unlocked: false,
    claimCode: new URLSearchParams(location.search).get('share'),
    lockShown: false,
    dockTimer: null,
    me: { name: U.getL('name', '') || '' },
  };

  // 优先使用当前访问地址；若当前是 localhost 或没有 lan 地址，则使用服务端报告的第一个局域网地址
  function bestOrigin() {
    const current = location.origin;
    if (S.lanUrls && S.lanUrls.includes(current)) return current;
    return (S.lanUrls && S.lanUrls[0]) || current;
  }

  // ================================================================ 主题（粉色/跟随系统/白色/黑色）
  const THEME_ORDER = ['pink', 'auto', 'light', 'black'];
  const THEME_LABELS = { pink: '粉色（默认）', auto: '跟随系统', light: '白色', black: '黑色' };
  function themeEffective(mode) {
    if (mode === 'light') return 'light';
    if (mode === 'black') return 'black';
    if (mode === 'auto') {
      const m = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
      return m && m.matches ? 'light' : 'dark';
    }
    return 'dark'; // pink（默认）
  }
  function applyTheme(mode) {
    const eff = themeEffective(mode);
    document.documentElement.dataset.theme = eff;
    const mc = document.querySelector('meta[name="theme-color"]');
    if (mc) mc.content = eff === 'light' ? '#f3eff1' : eff === 'black' ? '#000000' : '#070b14';
    U.setL('theme', mode);
    const bt = $('btnTheme');
    if (bt) bt.title = '主题切换（当前：' + THEME_LABELS[mode] + '）· 点击依次切换';
    const seg = document.getElementById('themeSeg');
    if (seg) seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.theme === mode));
  }
  function cycleTheme() {
    const cur = U.getL('theme', 'pink');
    applyTheme(THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1 + THEME_ORDER.length) % THEME_ORDER.length]);
  }
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').addEventListener) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (U.getL('theme', 'pink') === 'auto') applyTheme('auto');
    });
  }

  const $ = (id) => document.getElementById(id);

  // ================================================================ 基础

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  async function apiBootstrap() {
    const data = await A.get('/api/bootstrap');
    S.instance = data.instance;
    S.lanUrls = data.lan || [];
    $('connPill').classList.toggle('online', true);
    $('connPill').innerHTML = `<span class="dot"></span><span class="svc">${U.esc(S.instance.name)}</span>`;
    document.title = `OpenLAN · ${S.instance.name}`;
    $('sharedDirPath').textContent = S.instance.sharedDir;
  }

  async function doOpenSession(pin) {
    const body = { sid: U.sid, name: S.me.name || '' };
    if (pin) body.pin = pin;
    const r = await A.post('/api/session/open', body);
    if (!S.me.name) S.me.name = r.name;
    return r;
  }

  // 访问锁
  function showLock(err) {
    if (S.lockShown) { if (err) $('pinError').textContent = err; return; }
    S.lockShown = true;
    const ls = $('lockScreen');
    ls.classList.remove('hidden');
    if (err) $('pinError').textContent = err;
    $('pinInput').focus();
    $('pinSubmit').onclick = async () => {
      $('pinError').textContent = '';
      const pin = $('pinInput').value.trim();
      if (!pin) { $('pinError').textContent = '请输入 PIN'; return; }
      try {
        await doOpenSession(pin);
        S.unlocked = true;
        ls.classList.add('hidden');
        A.startSSE();
        refreshAll();
        if (S.claimCode) { openClaim(S.claimCode); S.claimCode = null; }
      } catch (e) {
        $('pinError').textContent = e.message || 'PIN 错误';
      }
    };
  }
  function hideLock() {
    $('lockScreen').classList.add('hidden');
    S.lockShown = false;
    S.unlocked = true;
  }

  async function ensureUnlocked() {
    try {
      await doOpenSession();
      hideLock();
      A.startSSE();
    } catch (e) {
      if (e.pinRequired) showLock('请输入访问 PIN');
      else { showLock(e.message); }
    }
  }

  // ================================================================ 标签切换

  function switchView(v) {
    S.view = v;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
    document.querySelectorAll('.view').forEach((x) => x.classList.toggle('active', x.id === 'view-' + v));
    if (v === 'files') renderFiles();
    if (v === 'devices') { loadDevices().then(renderDevices); }
    if (v === 'inbox') { loadInbox(); }
    if (v === 'records') { loadRecords(); }
  }

  function updateBadges() {
    const dev = S.devices.filter((d) => d.online && !(d.kind === 'session' && d.id === U.sid)).length;
    $('badgeDevices').textContent = dev || '';
    let pend = 0;
    for (const o of S.offerMap.values()) if (o.state === 'pending') pend++;
    for (const j of S.inbound.values()) if (j.state === 'pending') pend++;
    $('badgeInbox').textContent = pend || '';
  }

  // ================================================================ 我的文件

  async function loadFiles() {
    const d = await A.get('/api/files');
    S.files = d.files || [];
    S.fileMap.clear();
    S.files.forEach((f) => S.fileMap.set(f.token, f));
    // 清理已删除的选择
    for (const t of [...S.sel]) if (!S.fileMap.has(t)) S.sel.delete(t);
  }

  function visibleFiles() {
    if (!S.filter) return S.files;
    const q = S.filter.toLowerCase();
    return S.files.filter((f) => f.name.toLowerCase().includes(q));
  }

  let filesEmptyBase = null;
  function renderFiles() {
    const list = $('fileList');
    const empty = $('filesEmpty');
    if (filesEmptyBase === null) filesEmptyBase = empty.innerHTML;
    list.querySelectorAll('.frow').forEach((x) => x.remove());
    if (!S.files.length) {
      empty.innerHTML = filesEmptyBase;
      empty.style.display = '';
      updateSelUI();
      return;
    }
    const rows = visibleFiles();
    if (!rows.length) {
      empty.innerHTML = `<svg class="ic xxl"><use href="#i-files"/></svg><div>没有匹配「${U.esc(S.filter)}」的文件</div><span class="muted">换个关键词再试，或点击「刷新」查看最新共享目录</span>`;
      empty.style.display = '';
      updateSelUI();
      return;
    }
    empty.style.display = 'none';
    const frag = document.createDocumentFragment();
    for (const f of rows) {
      const selected = S.sel.has(f.token);
      const ic = U.fileIcon(f.name);
      const row = el(`
        <div class="frow ${selected ? 'selected' : ''}" draggable="true" data-token="${U.esc(f.token)}">
          <span class="fcheck"><input type="checkbox" class="check" ${selected ? 'checked' : ''} data-token="${U.esc(f.token)}"></span>
          <div class="ficon ${ic === 'file' ? '' : 'big'}">${U.icon(ic === 'img' ? 'download' : ic === 'file' ? 'files' : 'download')}</div>
          <div class="fname"><div class="t">${U.esc(f.name)}</div><div class="s">${U.fmtSize(f.size)}</div></div>
          <div class="fmeta">${U.fmtTime(f.mtime)}</div>
          <div class="fops">
            <button class="op" title="下载" data-act="down"><svg class="ic"><use href="#i-download"/></svg></button>
            <button class="op" title="发送到设备" data-act="send"><svg class="ic"><use href="#i-send"/></svg></button>
            <button class="op" title="生成二维码/提取码" data-act="share"><svg class="ic"><use href="#i-qr"/></svg></button>
            <button class="op" title="复制下载链接" data-act="link"><svg class="ic"><use href="#i-link"/></svg></button>
            <button class="op danger" title="删除" data-act="del"><svg class="ic"><use href="#i-trash"/></svg></button>
          </div>
        </div>`);
      frag.appendChild(row);
    }
    list.appendChild(frag);
    updateSelUI();
  }

  function fileAction(e) {
    const row = e.target.closest('.frow');
    if (!row) return;
    const token = row.dataset.token;
    const f = S.fileMap.get(token);
    const actBtn = e.target.closest('[data-act]');
    const cb = e.target.closest('input.check');
    if (cb) {
      if (S.sel.has(token)) S.sel.delete(token); else S.sel.add(token);
      updateSelUI(); renderFiles(); return;
    }
    if (actBtn) {
      e.stopPropagation();
      const act = actBtn.dataset.act;
      if (act === 'down') E.enqueueFile({ token: f.token, name: f.name, size: f.size });
      if (act === 'send') openComposer({ tokens: [token], hint: `将发送「${f.name}」` });
      if (act === 'share') openShareModal([token]);
      if (act === 'link') {
        U.copyText(bestOrigin() + '/api/down/' + token);
        T.toast('下载链接已复制', 'ok');
      }
      if (act === 'del') deleteFile(f);
      return;
    }
    if (S.sel.has(token)) S.sel.delete(token); else S.sel.add(token);
    updateSelUI();
    renderFiles();
  }

  async function reloadFileList() {
    try {
      await loadFiles();
      if (S.view === 'files') renderFiles();
    } catch (e) { T.toast('刷新文件列表失败：' + e.message, 'bad'); }
  }

  function deleteFile(f) {
    return deleteTokens([f.token]);
  }

  async function deleteTokens(tokens) {
    const list = tokens.map((t) => S.fileMap.get(t)).filter(Boolean);
    if (!list.length) { T.toast('所选文件已不存在，请刷新后重试', 'warn'); return; }
    const names = list.map((f) => f.name);
    const preview = names.slice(0, 3).map((n) => `「${U.esc(n)}」`).join('、') + (names.length > 3 ? ` 等 ${names.length} 个文件` : '');
    const ok = await T.confirmModal({
      title: names.length > 1 ? `删除 ${names.length} 个文件` : '删除文件',
      body: `确定从共享目录删除 ${preview} 吗？<br><span class="muted">删除后其它设备将无法再访问该文件。</span>`,
      okText: '删除', danger: true,
    });
    if (!ok) return;
    let done = 0;
    const failed = [];
    for (const f of list) {
      try {
        await A.del('/api/files/' + f.token);
        done++;
      } catch (e) { failed.push({ name: f.name, err: e.message }); }
    }
    if (done) {
      list.forEach((f) => S.sel.delete(f.token));
      T.toast(done === list.length ? `已删除 ${done} 个文件` : `已删除 ${done} / ${list.length} 个文件`, done === list.length ? 'ok' : 'warn');
    }
    if (failed.length) {
      T.toast('删除部分失败：' + failed.map((x) => `${x.name}（${x.err}）`).join('；'), 'bad');
    }
    await reloadFileList();
  }

  function updateSelUI() {
    const list = visibleFiles();
    const n = S.sel.size;
    $('selCount').textContent = '已选 ' + n + ' 项';
    $('btnSendSel').disabled = n === 0;
    $('btnDownSel').disabled = n === 0;
    $('btnShareSel').disabled = n === 0;
    $('btnDelSel').disabled = n === 0;
    const all = $('selAll');
    if (all) all.checked = list.length > 0 && list.every((f) => S.sel.has(f.token));
  }

  // 上传
  function bindUploads() {
    $('btnUpload').onclick = () => $('fileInput').click();
    $('btnUploadFolder').onclick = () => $('folderInput').click();
    $('fileInput').addEventListener('change', (e) => { uploadFiles([...e.target.files]); e.target.value = ''; });
    $('folderInput').addEventListener('change', (e) => {
      const files = [...e.target.files].map((f) => {
        if (f.webkitRelativePath) {
          const parts = f.webkitRelativePath.split('/');
          parts.shift();
          const copy = new File([f], parts.join('_'), { type: f.type });
          copy._olname = parts.join('_');
          return copy;
        }
        return f;
      });
      uploadFiles(files); e.target.value = '';
    });
    const dz = $('dropzone');
    dz.onclick = () => $('fileInput').click();
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault(); dz.classList.remove('over');
      if (e.dataTransfer.files && e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
    });
  }

  async function uploadFiles(files) {
    if (!files.length) return;
    let done = 0;
    const total = files.length;
    T.toast(`开始上传 ${total} 个文件`, 'ok');
    for (const f of files) {
      const nm = f._olname || f.name;
      try {
        await E.uploadFile(f);
        done++;
        T.toast(`[${done}/${total}] ${nm} 上传完成`, 'ok', 2000);
      } catch (err) {
        T.toast(`「${nm}」上传失败：${err.message}`, 'bad', 4000);
      }
    }
    await loadFiles();
    renderFiles();
  }

  // ================================================================ 设备

  async function loadDevices() {
    const d = await A.get('/api/devices');
    S.devices = (d.devices || []).filter((x) => !(x.kind === 'session' && x.id === U.sid));
  }

  function deviceIcon(d) {
    if (d.kind === 'peer') return 'monitor';
    return /iOS|Android|手机|phone/i.test(d.desc || '') ? 'phone' : 'monitor';
  }

  function renderDevices() {
    const wrap = $('deviceGroups');
    const sessions = S.devices.filter((d) => d.kind === 'session');
    const peers = S.devices.filter((d) => d.kind === 'peer');
    const cardHtml = (d) => {
      const on = d.online ? 'on' : '';
      const icon = deviceIcon(d);
      const pc = d.kind === 'peer' ? ' pc' : '';
      const sub = d.kind === 'session' ? `${d.desc || '浏览器'}${d.ip ? ' · ' + d.ip : ''}` : (d.desc || (d.manual ? '手动添加' : 'OpenLAN 实例')) + (d.version ? ` v${d.version}` : '');
      return `
      <div class="dcard ${on ? 'online' : 'offline'}" data-kind="${d.kind}" data-id="${U.esc(d.id)}">
        <div class="dhead">
          <div class="dava${pc}">${U.icon(icon)}</div>
          <div style="flex:1;min-width:0">
            <div class="dname">${U.esc(d.name)}</div>
            <div class="ddesc"><span class="dot-online ${on}"></span>${d.online ? '在线' : '离线'}${d.autoAccept ? ' · 自动接收' : ''}</div>
          </div>
        </div>
        <div class="ddesc" style="padding-left:50px">${U.esc(sub)}</div>
        <div class="dops">
          <button class="btn dark small" data-device-send>${U.icon('send')}发送文件</button>
          <button class="btn dark small" data-device-text>${U.icon('text')}文本</button>
        </div>
      </div>`;
    };
    let html = '';
    html += `<div class="dgroup"><h3>浏览器设备 · 网页会话（${sessions.length}）</h3><div class="dcards">${sessions.length ? sessions.map(cardHtml).join('') : '<div class="empty">暂无其它网页接入<br><span class="muted">让手机/另一台电脑用摄像头扫顶部「二维码」打开本机页面即可出现在这里</span></div>'}</div></div>`;
    html += `<div class="dgroup"><h3>OpenLAN 实例 · 点对点直传（${peers.length}）</h3><div class="dcards">${peers.length ? peers.map(cardHtml).join('') : '<div class="empty">尚未发现运行 OpenLAN 的其它设备<br><span class="muted">请确认设备在同一网络并已启动 OpenLAN；若网络隔离了组播，可手动添加</span></div>'}<div class="dcard dashed-add" id="manualAdd"><div class="dhead"><div class="dava pc" style="opacity:.6">＋</div><div><div class="dname">手动添加设备</div><div class="ddesc">输入 IP 与端口（如 192.168.1.20:5555）</div></div></div></div></div></div>`;
    wrap.innerHTML = html;

    wrap.querySelectorAll('.dcard[data-id]').forEach((card) => {
      const d = S.devices.find((x) => x.kind === card.dataset.kind && x.id === card.dataset.id);
      const on = d && d.online;
      card.querySelector('[data-device-send]').onclick = (e) => { e.stopPropagation(); sendToDevice(d); };
      card.querySelector('[data-device-text]').onclick = (e) => { e.stopPropagation(); openTextCompose({ presetTarget: d }); };
      // 拖放文件到设备卡片
      card.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!on) { T.toast('该设备当前离线', 'warn'); return; }
        let tokens = null;
        try { tokens = JSON.parse(e.dataTransfer.getData('text/plain') || 'null'); } catch (_) { tokens = null; }
        if (tokens && tokens.length) { sendTokensToDevice(d, tokens); return; }
        if (e.dataTransfer.files && e.dataTransfer.files.length) uploadAndSendLocal(d, [...e.dataTransfer.files]);
      });
    });
    $('manualAdd').onclick = () => openManualAdd();
  }

  async function sendToDevice(d) {
    const tokens = [...S.sel];
    if (!tokens.length) {
      const useSel = S.sel.size ? true : false;
      openComposer({ target: d, hint: '先在「我的文件」勾选文件，或到弹窗里添加' });
      return;
    }
    openComposer({ target: d, tokens });
  }

  function sendTokensToDevice(d, tokens) {
    T.confirmModal({
      title: '确认传输',
      body: `将 ${tokens.length} 个已选文件发送到「${U.esc(d.name)}」？`,
      okText: '发送',
    }).then((ok) => {
      if (ok) doSend([{ kind: d.kind, id: d.id, name: d.name }], tokens, '');
    });
  }

  async function uploadAndSendLocal(d, files) {
    T.toast(`正在上传并发送 ${files.length} 个文件到 ${d.name}`, 'ok');
    const tokens = [];
    for (const f of files) {
      try {
        const e = await E.uploadFile(f);
        tokens.push(e.token);
      } catch (err) { T.toast(f.name + ' 上传失败：' + err.message, 'bad'); }
    }
    if (tokens.length) sendTokensToDevice(d, tokens);
  }

  async function openManualAdd() {
    let ip = '';
    let port = '';
    const body = `
      <div class="field"><label>对方 IP / 主机名</label><input class="input" id="mIp" placeholder="例如 192.168.1.20" value="${U.esc(ip)}"></div>
      <div class="field"><label>端口（对方启动时显示的端口）</label><input class="input" id="mPort" type="number" placeholder="5555" value="${port}"></div>`;
    const close = T.openModal({ title: '手动添加 OpenLAN 设备', body, foot: `<button class="btn ghost" data-x>取消</button><button class="btn primary" data-ok>添加并连接</button>` });
    const doIt = async () => {
      try {
        const r = await A.post('/api/peers', { ip: $('mIp').value.trim(), port: $('mPort').value.trim() || 5555 });
        close();
        T.toast('已添加：' + (r.peer.name || $('mIp').value), 'ok');
        await loadDevices(); renderDevices();
      } catch (e) { T.toast('添加失败：' + e.message, 'bad'); }
    };
    document.querySelector('#modalRoot [data-ok]').onclick = doIt;
    document.querySelector('#modalRoot [data-x]').onclick = close;
  }

  // ================================================================ 发起传输

  function devicesForPicker() {
    return S.devices.map((d) => ({
      id: d.id,
      kind: d.kind,
      name: d.name,
      desc: (d.kind === 'peer' ? 'OpenLAN 实例 · ' : '网页会话 · ') + (d.desc || '') + (d.ip ? ' ' + d.ip : ''),
      online: d.online,
      checked: false,
      disabled: !d.online,
    }));
  }

  function openComposer(opts = {}) {
    const target = opts.target || null;
    const preTokens = new Set(opts.tokens || [...S.sel]);
    const devs = devicesForPicker();
    if (target) { const d = devs.find((x) => x.id === target.id); if (d) d.checked = true; }
    const pick = T.devicePicker(devs);
    const body = `
      <div class="field"><label>内容文件 <span class="muted" id="comFileCount"></span></label>
        <div class="list-check" id="comFiles"><div class="empty">未选择文件 —— 可添加文本一起发送</div></div>
      </div>
      <div class="field"><label>附带文本（可选，会一起推送）</label><textarea class="input" id="comText" rows="2" placeholder="输入文本，接收端可一键复制/保存"></textarea></div>
      <div class="field" id="pickSlot"></div>`;
    const close = T.openModal({ title: opts.hint ? `发起传输 · ${opts.hint}` : '发起传输', wide: true, body, foot: `<button class="btn ghost" data-x>取消</button><button class="btn primary" data-send>发送</button>` });
    document.getElementById('pickSlot').appendChild(pick.el);

    const fileBox = document.getElementById('comFiles');
    const fileCount = document.getElementById('comFileCount');
    const renderFilesBox = () => {
      if (!preTokens.size) { fileBox.innerHTML = `<div class="empty">未选择文件 —— 可添加文本一起发送</div>`; fileCount.textContent = ''; return; }
      let h = '';
      for (const t of preTokens) {
        const f = S.fileMap.get(t);
        if (f) h += `<div class="lc-item" style="cursor:default"><div class="ficon" style="width:28px;height:28px">${U.icon('files')}</div><div class="lname">${U.esc(f.name)}</div><div class="lsub">${U.fmtSize(f.size)}</div><button class="op danger" data-rm="${U.esc(t)}"><svg class="ic"><use href="#i-close"/></svg></button></div>`;
      }
      fileBox.innerHTML = h;
      fileCount.textContent = '（' + preTokens.size + '）';
      fileBox.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { preTokens.delete(b.dataset.rm); renderFilesBox(); });
    };
    renderFilesBox();

    // 文件来源：本机任意文件（上传后随本次一起发送） / 共享目录里已存在的文件
    const srcRow = document.createElement('div');
    srcRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px';
    srcRow.innerHTML = `
      <button class="btn dark small" id="comAddLocal">从本机选择文件…</button>
      <button class="btn dark small" id="comAddFiles">从「我的文件」勾选…</button>
      <span class="muted" style="align-self:center;font-size:.8rem">支持多选；先上传入共享目录，再随本次一起发送</span>`;
    document.getElementById('comFiles').after(srcRow);

    const localInput = document.createElement('input');
    localInput.type = 'file';
    localInput.multiple = true;
    localInput.hidden = true;
    document.getElementById('pickSlot').appendChild(localInput);
    document.getElementById('comAddLocal').onclick = () => localInput.click();
    document.getElementById('comAddFiles').onclick = async () => {
      const chosen = await pickFilesModal([...preTokens]);
      preTokens.clear();
      chosen.forEach((t) => preTokens.add(t));
      renderFilesBox();
    };
    localInput.addEventListener('change', async () => {
      const files = [...localInput.files];
      localInput.value = '';
      if (!files.length) return;
      T.toast(`正在把 ${files.length} 个本机文件加入发送列表（上传中…）`, 'ok');
      let okN = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        try {
          const e = await E.uploadFile(f);
          preTokens.add(e.token);
          okN++;
        } catch (err) {
          T.toast(`「${U.esc(f.name)}」加入失败：${err.message}`, 'bad', 4000);
        }
      }
      if (okN) { try { await loadFiles(); } catch (_) { /* 忽略 */ } }
      renderFilesBox();
      T.toast(okN ? `已加入 ${okN} 个文件，可直接发送` : '未能加入任何文件', okN ? 'ok' : 'warn', 2600);
    });

    const sendBtn = document.querySelector('#modalRoot [data-send]');
    sendBtn.onclick = async () => {
      const targets = pick.getChecked();
      if (!targets.length) { T.toast('请先选择目标设备', 'warn'); return; }
      if (!preTokens.size && !document.getElementById('comText').value.trim()) { T.toast('请选择文件或输入文本', 'warn'); return; }
      sendBtn.disabled = true;
      const r = await doSend(targets, [...preTokens], document.getElementById('comText').value);
      sendBtn.disabled = false;
      if (r === true) close();
    };
    document.querySelector('#modalRoot [data-x]').onclick = close;
  }

  async function doSend(targets, tokens, text) {
    try {
      const r = await A.post('/api/offers', { targets: targets.map((t) => ({ kind: t.kind, id: t.id, name: t.name })), files: tokens, text });
      const ok = r.ok !== false;
      const detail = [];
      if (r.sessionOffers && r.sessionOffers.length) detail.push(`${r.sessionOffers.length} 台网页设备`);
      if (r.outbounds && r.outbounds.length) detail.push(`${r.outbounds.length} 台实例设备`);
      if (ok) {
        T.toast('已发出' + (detail.length ? '：' + detail.join('、') : ''), 'ok');
        if (r.error && r.error.length) r.error.forEach((x) => T.toast(`→ ${x.name}: ${x.message}`, 'bad', 5000));
        return true;
      }
      (r.error || []).forEach((x) => T.toast(`→ ${x.name}: ${x.message}`, 'bad', 5000));
      return false;
    } catch (e) {
      T.toast('发送失败：' + e.message, 'bad');
      return false;
    }
  }

  function pickFilesModal(initTokens) {
    return new Promise((resolve) => {
      const chosen = new Set(initTokens || []);
      const rows = S.files.map((f) => `
        <div class="lc-item ${chosen.has(f.token) ? 'checked' : ''}" data-token="${U.esc(f.token)}">
          <input type="checkbox" class="check" ${chosen.has(f.token) ? 'checked' : ''}>
          <div class="lname">${U.esc(f.name)}</div>
          <div class="lsub">${U.fmtSize(f.size)}</div>
        </div>`).join('') || `<div class="empty">共享目录暂无文件</div>`;
      const body = `<div class="field"><label>选择文件</label><div class="list-check" id="pfList" style="max-height:300px">${rows}</div></div>`;
      const close = T.openModal({ title: '选择文件', body, foot: `<button class="btn ghost" data-x>取消</button><button class="btn primary" data-ok>确定（<span id="pfN">${chosen.size}</span>）</button>` });
      document.getElementById('pfList').addEventListener('click', (e) => {
        const row = e.target.closest('.lc-item');
        if (!row) return;
        const t = row.dataset.token;
        if (chosen.has(t)) chosen.delete(t); else chosen.add(t);
        row.classList.toggle('checked', chosen.has(t));
        row.querySelector('input.check').checked = chosen.has(t);
        document.getElementById('pfN').textContent = chosen.size;
      });
      document.querySelector('#modalRoot [data-ok]').onclick = () => { close(); resolve(chosen); };
      document.querySelector('#modalRoot [data-x]').onclick = () => { close(); resolve(chosen); };
    });
  }

  // 文本闪电传
  function openTextCompose(opts = {}) {
    const target = opts.presetTarget || null;
    const devs = devicesForPicker();
    if (target) { const d = devs.find((x) => x.id === target.id); if (d) d.checked = true; }
    const pick = T.devicePicker(devs, { title: '发送给设备' });
    const body = `
      <div class="field"><label>文本内容</label><textarea class="input" id="txtContent" rows="4" placeholder="输入要发送的文本…"></textarea></div>
      <div class="field" id="pickSlot"></div>`;
    const close = T.openModal({ title: '文本闪电传', wide: true, body, foot: `<button class="btn ghost" data-x>取消</button><button class="btn primary" data-send>发送文本</button>` });
    document.getElementById('pickSlot').appendChild(pick.el);
    document.querySelector('#modalRoot [data-send]').onclick = async () => {
      const txt = document.getElementById('txtContent').value;
      const targets = pick.getChecked();
      if (!txt.trim()) { T.toast('文本不能为空', 'warn'); return; }
      if (!targets.length) { T.toast('请选择目标设备', 'warn'); return; }
      const ok = await doSend(targets, [], txt);
      if (ok) close();
    };
    document.querySelector('#modalRoot [data-x]').onclick = close;
  }

  // ================================================================ 分享/二维码

  function openShareModal(initTokens) {
    const chosen = new Set(initTokens || [...S.sel]);
    const rows = S.files.map((f) => `
      <div class="lc-item ${chosen.has(f.token) ? 'checked' : ''}" data-token="${U.esc(f.token)}">
        <input type="checkbox" class="check" ${chosen.has(f.token) ? 'checked' : ''}>
        <div class="lname">${U.esc(f.name)}</div><div class="lsub">${U.fmtSize(f.size)}</div>
      </div>`).join('') || `<div class="empty">没有文件可选</div>`;
    const body = `
      <div class="field"><label>勾选要分享的文件</label><div class="list-check" id="shList" style="max-height:240px">${rows}</div></div>
      <div class="field"><label>有效期</label>
        <select class="input" id="shMinutes"><option value="60">1 小时</option><option value="1440" selected>24 小时</option><option value="10080">7 天</option><option value="43200">30 天</option></select></div>`;
    const close = T.openModal({ title: '二维码 / 提取码 快速分享', wide: true, body, foot: `<button class="btn ghost" data-x>取消</button><button class="btn primary" data-go>生成分享</button>` });
    document.getElementById('shList').addEventListener('click', (e) => {
      const row = e.target.closest('.lc-item'); if (!row) return;
      const t = row.dataset.token;
      if (chosen.has(t)) chosen.delete(t); else chosen.add(t);
      row.classList.toggle('checked', chosen.has(t));
      row.querySelector('input.check').checked = chosen.has(t);
    });
    document.querySelector('#modalRoot [data-go]').onclick = async () => {
      if (!chosen.size) { T.toast('至少选择一个文件', 'warn'); return; }
      try {
        const r = await A.post('/api/shares', { files: [...chosen], minutes: parseInt(document.getElementById('shMinutes').value, 10) });
        close();
        showShareResult(r.share);
      } catch (e) { T.toast('生成失败：' + e.message, 'bad'); }
    };
    document.querySelector('#modalRoot [data-x]').onclick = close;
  }

  function showShareResult(share) {
    const link = bestOrigin() + '/s/' + share.code;
    const body = `
      <div class="qr-box">
        <img class="qr-img" src="${T.qrUrl(link)}" alt="二维码" style="width:180px;height:180px">
      </div>
      <div>
        <div class="field"><label>提取码（接收方在任一页面点「领取」输入）</label>
        <div class="code-show" id="shareCode">${U.esc(share.code)}</div></div>
      </div>
      <div class="qr-url">${U.esc(link)}</div>
      <div class="muted" style="font-size:.84rem">${share.files.length} 个文件 · ${U.fmtSize(share.files.reduce((a, f) => a + f.size, 0))} · 有效期至 ${U.fmtClock(share.expireAt)}</div>`;
    const close = T.openModal({ title: '分享已创建', body, foot: `<button class="btn dark" data-again>再建一个</button><button class="btn primary" id="copyShare">复制链接</button>` });
    document.getElementById('shareCode').onclick = () => { U.copyText(share.code); T.toast('提取码已复制', 'ok'); };
    document.getElementById('copyShare').onclick = () => { U.copyText(link); T.toast('链接已复制', 'ok'); };
    document.querySelector('#modalRoot [data-again]').onclick = () => { close(); openShareModal([]); };
  }

  // 领取（输入提取码）
  function openClaim(preCode) {
    const body = `
      <div class="field"><label>输入对方提供的提取码</label>
        <input class="input" id="claimInput" maxlength="8" style="text-transform:uppercase;letter-spacing:6px;text-align:center;font-size:1.4rem" placeholder="XXXX" value="${U.esc(preCode || '')}"></div>`;
    const close = T.openModal({ title: '提取码领取', body, foot: `<button class="btn ghost" data-x>取消</button><button class="btn primary" data-go>领取</button>` });
    const input = document.getElementById('claimInput');
    const go = async () => {
      const code = (input.value || '').trim().toUpperCase();
      if (!code) { T.toast('请输入提取码', 'warn'); return; }
      try {
        const r = await A.get('/api/shares/' + code);
        close();
        renderShareReceive(r.share);
      } catch (e) { T.toast('领取失败：' + e.message, 'bad'); }
    };
    document.querySelector('#modalRoot [data-go]').onclick = go;
    document.querySelector('#modalRoot [data-x]').onclick = close;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    input.focus();
  }

  function renderShareReceive(share) {
    const items = share.files.map((f, i) => `
      <div class="jfile"><div class="jname">${i + 1}. ${U.esc(f.name)}</div><div class="jsize">${U.fmtSize(f.size)}</div></div>`).join('');
    const body = `
      <div class="jtag s-ok" style="align-self:flex-start">来自 ${U.esc(S.instance.name)} 的分享</div>
      <div class="jfiles">${items || '<div class="empty">（无文件）</div>'}</div>
      ${share.text ? `<div class="jtext">${U.esc(share.text)}</div>` : ''}`;
    const close = T.openModal({ title: `提取码 ${share.code}`, wide: true, body, foot: `<button class="btn ghost" data-x>关闭</button><button class="btn primary" data-all>全部下载</button>` });
    document.querySelector('#modalRoot [data-x]').onclick = close;
    document.querySelector('#modalRoot [data-all]').onclick = () => {
      close();
      share.files.forEach((f) => E.enqueueFile({ token: f.token, name: f.name, size: f.size }));
      switchView('files');
      T.toast('已开始下载 ' + share.files.length + ' 个文件', 'ok');
    };
  }

  // ================================================================ SSE 事件

  function bindEvents() {
    A.on('lock', (d) => showLock(d.error || ''));
    A.on('online', (on) => {
      $('connPill').innerHTML = `<span class="dot"></span><span class="svc">${U.esc(S.instance ? S.instance.name : 'OpenLAN')} · ${on ? '已连接' : '重连中…'}</span>`;
      $('connPill').classList.toggle('online', on);
      if (!on) $('connPill').innerHTML = `<span class="dot"></span><span>连接断开，重连中…</span>`;
    });
    A.on('event', (ev) => handleEvent(ev));
  }

  function handleEvent(ev) {
    if (ev.type === 'hello') return;
    if (ev.type === 'replay') {
      (ev.offers || []).forEach((o) => { S.offerMap.set(o.oid, o); });
      (ev.inbound || []).forEach((j) => { S.inbound.set(j.pid, j); });
      renderInboxIfActive();
      return;
    }
    if (ev.type === 'offer') {
      const o = ev.offer;
      const mine = ev.toSid === U.sid || ev.toSid === '*';
      S.offerMap.set(o.oid, Object.assign(S.offerMap.get(o.oid) || {}, o));
      if (mine) {
        renderInboxIfActive();
        maybeAutoAccept(o);
        if (o.state === 'done' || o.state === 'denied') T.toast(o.state === 'done' ? '推送完成' : '推送已被拒绝', o.state === 'done' ? 'ok' : 'warn');
      }
      return;
    }
    if (ev.type === 'inbound') {
      const prev = S.inbound.get(ev.job.pid);
      S.inbound.set(ev.job.pid, ev.job);
      if (!prev || prev.state !== ev.job.state) {
        if (ev.job.state === 'done') T.toast(`已接收来自 ${ev.job.sender.name} 的文件`, 'ok');
        if (ev.job.state === 'error') T.toast('接收失败：' + (ev.job.err || ''), 'bad');
      }
      renderInboxIfActive();
      return;
    }
    if (ev.type === 'outbound') {
      const prev = S.outbound.get(ev.job.pid);
      S.outbound.set(ev.job.pid, ev.job);
      if (!prev || prev.state !== ev.job.state) {
        const map = { done: ['推送完成', 'ok'], denied: ['对方拒绝', 'warn'], canceled: ['已取消', 'warn'], error: ['发送失败', 'bad'] };
        if (map[ev.job.state]) T.toast(`→ ${ev.job.peer.name}：${map[ev.job.state][0]}`, map[ev.job.state][1]);
        if (ev.job.state === 'waiting') T.toast(`已向 ${ev.job.peer.name} 发起推送，等待对方确认…`, '', 2500);
      }
      if (ev.job.state === 'waiting' || ev.job.state === 'sending') renderDock();
      return;
    }
    if (ev.type === 'record') {
      if (S.view === 'records') loadRecords();
      return;
    }
  }

  function maybeAutoAccept(o) {
    const cfg = E.settings();
    if (!cfg.autoReceive) return;
    if (o.state !== 'pending') return;
    if (o.files.length) { acceptOffer(o); }
    else { T.toast('收到文本推送（自动接收已开启）', 'ok'); }
  }

  // ================================================================ 接收箱

  function renderInboxIfActive() {
    updateBadges();
    if (S.view === 'inbox') renderInbox();
  }

  function loadInbox() {
    A.get('/api/inbox').then((r) => {
      (r.jobs || []).forEach((j) => S.inbound.set(j.pid, j));
      renderInbox();
      updateBadges();
    }).catch(() => {});
  }

  function renderInbox() {
    const wrap = $('inboxList');
    // 会话推送 offer（待我确认）
    const pendOffers = [...S.offerMap.values()].filter((o) => o.state === 'pending' || o.state === 'accepted');
    const inbJobs = [...S.inbound.values()].sort((a, b) => b.createdAt - a.createdAt);
    let html = '';
    if (pendOffers.length) {
      html += `<div class="dgroup"><h3>来自网页推送 · 待确认</h3><div class="job-list">${pendOffers.map(offerCard).join('')}</div></div>`;
    }
    if (inbJobs.length) {
      html += `<div class="dgroup"><h3>OpenLAN 实例直传</h3><div class="job-list">${inbJobs.map(inboundCard).join('')}</div></div>`;
    }
    if (!html) html = `<div class="empty">接收箱空空如也<br><span class="muted">其它设备推送给本机的文件会出现在这里</span></div>`;
    wrap.innerHTML = html;
    updateBadges();
  }

  function offerCard(o) {
    const files = o.files.length
      ? o.files.map((f, i) => `<div class="jfile"><div class="jname">${i + 1}. ${U.esc(f.name)}</div><div class="jsize">${U.fmtSize(f.size)}</div></div>`).join('')
      : '';
    const tag = o.state === 'accepted' ? '<span class="jtag s-accepted">下载中…</span>' : '<span class="jtag s-pending">等待确认</span>';
    const ops = o.state === 'pending'
      ? `<button class="btn primary small" data-acc="${o.oid}">接收并下载</button><button class="btn dark small" data-rej="${o.oid}">拒绝</button>`
      : '<span class="muted" style="font-size:.8rem">接收后自动保存到浏览器下载目录</span>';
    return `<div class="jcard">
      <div class="jtop"><span class="jtitle">${U.icon('send')} ${U.esc(o.from.name)} 发来内容</span>${tag}<span class="jtime">${U.relTime(o.createdAt)}</span></div>
      <div class="jbody"><div class="jfiles">${files}</div>${o.text ? `<div class="jtext">${U.esc(o.text)}</div>` : ''}
      <div class="jops">${ops}</div></div>
    </div>`;
  }

  function inboundCard(j) {
    const files = j.files.length
      ? j.files.map((f, i) => `<div class="jfile"><div class="jname">${i + 1}. ${U.esc(f.name)}</div><div class="jsize">${U.fmtSize(f.size)}</div></div>`).join('')
      : '';
    const tag = `<span class="jtag s-${j.state}">${stateName(j.state)}</span>`;
    let ops = '';
    let extra = '';
    if (j.state === 'pending') {
      ops = `<button class="btn primary small" data-iaccept="${j.pid}">接收</button><button class="btn dark small" data-ideny="${j.pid}">拒绝</button>`;
    } else if (j.state === 'receiving') {
      const pct = j.totalBytes ? Math.round((j.receivedBytes / j.totalBytes) * 100) : 0;
      extra = `<div class="pbar"><i style="width:${pct}%"></i></div><span class="muted" style="font-size:.8rem">${U.fmtSize(j.receivedBytes)} / ${U.fmtSize(j.totalBytes)}</span>`;
    } else if (j.state === 'done') {
      extra = j.text && !j.files.length ? `<div class="jtext">${U.esc(j.text)}</div>` : '';
      ops = `<span class="muted" style="font-size:.8rem">已保存到接收目录</span>`;
    } else if (j.state === 'denied' || j.state === 'error') {
      ops = `<span class="muted" style="font-size:.8rem">${U.esc(j.err || (j.state === 'denied' ? '已拒绝' : ''))}</span>`;
    }
    return `<div class="jcard">
      <div class="jtop"><span class="jtitle">${U.icon('inbox')} ${U.esc(j.sender.name)} 推送到本机</span>${tag}<span class="jtime">${U.relTime(j.createdAt)}</span></div>
      <div class="jbody"><div class="jfiles">${files}</div>${j.text && j.files.length ? `<div class="jtext">${U.esc(j.text)}</div>` : ''}${extra}
      <div class="jops">${ops}</div></div>
    </div>`;
  }

  function stateName(s) {
    return { pending: '待确认', receiving: '接收中', done: '已完成', denied: '已拒绝', error: '失败', sending: '发送中', waiting: '等待确认', accepted: '处理中', canceled: '已取消' }[s] || s;
  }

  async function acceptOffer(o) {
    const cached = S.offerMap.get(o.oid);
    if (!cached) return;
    try {
      const r = await A.post(`/api/offers/${o.oid}/accept`, {});
      cached.state = 'accepted';
      renderInboxIfActive();
      const offer = r.offer || cached;
      if (offer.files && offer.files.length) {
        const group = 'of-' + o.oid;
        const tasks = [];
        for (const f of offer.files) {
          const t = E.enqueueFile(Object.assign({ group }, f));
          tasks.push(t.id);
        }
        S.offerGroups.set(o.oid, { tasks: new Set(tasks), files: offer.files.length });
        T.toast('开始下载 ' + offer.files.length + ' 个文件', 'ok');
      } else if (offer.text) {
        showReceivedText(offer.text, offer.from.name, () => A.post(`/api/offers/${o.oid}/done`, { detail: '文本已查看' }));
      } else {
        A.post(`/api/offers/${o.oid}/done`, {}).catch(() => {});
      }
    } catch (e) {
      if (e.status === 409) { cached.state = 'done'; renderInboxIfActive(); }
      else T.toast('接收失败：' + e.message, 'bad');
    }
  }

  function showReceivedText(text, fromName, onDone) {
    const body = `
      <div class="jtag s-ok" style="align-self:flex-start">文本推送 · ${U.esc(fromName || '')}</div>
      <div class="jtext" style="max-height:260px">${U.esc(text)}</div>`;
    const close = T.openModal({
      title: '收到文本', wide: true, body,
      foot: `<button class="btn dark" data-copy>复制文本</button><button class="btn dark" data-save>保存为 .txt</button><button class="btn primary" data-done>完成</button>`,
    });
    document.querySelector('#modalRoot [data-copy]').onclick = () => { U.copyText(text); T.toast('已复制', 'ok'); };
    document.querySelector('#modalRoot [data-save]').onclick = () => { U.saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'openlan-text.txt'); T.toast('已保存', 'ok'); };
    const finish = () => { close(); onDone && onDone(); };
    document.querySelector('#modalRoot [data-done]').onclick = finish;
  }

  async function rejectOffer(oid) {
    try {
      await A.post(`/api/offers/${oid}/reject`, {});
      const o = S.offerMap.get(oid);
      if (o) o.state = 'denied';
      renderInboxIfActive();
      T.toast('已拒绝', 'warn');
    } catch (e) { T.toast('操作失败：' + e.message, 'bad'); }
  }

  // ================================================================ 接收箱操作（按钮事件委托）

  function inboxAction(e) {
    const acc = e.target.closest('[data-acc]');
    if (acc) { const o = S.offerMap.get(acc.dataset.acc); if (o) acceptOffer(o); return; }
    const rej = e.target.closest('[data-rej]');
    if (rej) { rejectOffer(rej.dataset.rej); return; }
    const ia = e.target.closest('[data-iaccept]');
    if (ia) { acceptInbound(ia.dataset.iaccept); return; }
    const idn = e.target.closest('[data-ideny]');
    if (idn) { denyInbound(idn.dataset.ideny); return; }
  }

  async function acceptInbound(pid) {
    try {
      await A.post(`/api/inbound/${pid}/accept`, {});
      T.toast('已确认接收，开始传输', 'ok');
    } catch (e) { T.toast('接收失败：' + e.message, 'bad'); }
    loadInbox();
  }

  async function denyInbound(pid) {
    try {
      await A.post(`/api/inbound/${pid}/deny`, {});
      T.toast('已拒绝该推送', 'warn');
    } catch (e) { T.toast('操作失败：' + e.message, 'bad'); }
    loadInbox();
  }

  // ================================================================ 记录

  function loadRecords() {
    A.get('/api/records').then((r) => {
      const list = $('recordList');
      const rows = (r.records || []).map((rec) => {
        const ic = { p2p: 'devices', session: 'send', share: 'share', sys: 'wifi', text: 'text' }[rec.kind] || 'records';
        const dirIcon = rec.dir === 'in' ? 'inbox' : rec.dir === 'out' ? 'send' : ic;
        const stateTag = rec.state === 'ok' ? '<span class="jtag s-done">成功</span>' : rec.state === 'denied' ? '<span class="jtag s-denied">拒绝</span>' : '<span class="jtag s-error">异常</span>';
        return `<div class="jcard">
          <div class="jtop"><span class="jtitle">${U.icon(dirIcon)} ${U.esc(rec.title)}</span>${stateTag}<span class="jtime">${U.fmtClock(rec.ts)}</span></div>
          <div class="jbody"><div class="muted" style="font-size:.9rem">${U.esc(rec.detail)}</div>${rec.bytes ? `<div class="muted" style="font-size:.8rem">${U.fmtSize(rec.bytes)}</div>` : ''}</div>
        </div>`;
      }).join('') || '<div class="empty">暂无记录</div>';
      list.innerHTML = rows;
    }).catch(() => {});
  }

  // ================================================================ 全局进度坞

  function renderDock() {
    const body = $('dockBody');
    const active = [];
    for (const t of E.getTasks()) {
      if (t.state === 'done' || t.state === 'error' || t.state === 'canceled') continue;
      const pct = t.size ? Math.round((t.doneBytes / t.size) * 100) : 0;
      active.push({ id: 't' + t.id, label: '下载 ' + t.name, sub: `${U.fmtSize(t.doneBytes)} / ${U.fmtSize(t.size)} · ${U.fmtSpeed(t.speed)}`, pct, state: t.state, cancel: () => E.cancelTask(t.id) });
    }
    for (const [pid, j] of S.outbound) {
      if (j.state === 'done' || j.state === 'error' || j.state === 'denied' || j.state === 'canceled') continue;
      const pct = j.totalBytes ? Math.round((j.sentBytes / j.totalBytes) * 100) : 0;
      active.push({ id: 'o' + pid, label: '推送 → ' + (j.peer.name || ''), sub: j.state === 'waiting' ? '等待对方确认…' : `${U.fmtSize(j.sentBytes)} / ${U.fmtSize(j.totalBytes)}`, pct: j.state === 'waiting' ? 0 : pct, state: j.state });
    }
    for (const [pid, j] of S.inbound) {
      if (j.state === 'receiving') {
        const pct = j.totalBytes ? Math.round((j.receivedBytes / j.totalBytes) * 100) : 0;
        active.push({ id: 'i' + pid, label: '接收 ← ' + (j.sender.name || ''), sub: `${U.fmtSize(j.receivedBytes)} / ${U.fmtSize(j.totalBytes)}`, pct, state: 'receiving' });
      }
    }
    $('dock').classList.toggle('hidden', !active.length);
    if (!active.length) { body.innerHTML = ''; return; }
    body.innerHTML = active.map((a) => `
      <div class="jfile"><span class="jname">${U.esc(a.label)}</span><span class="pbar"><i style="width:${a.pct}%"></i></span>
      <span class="jsize">${a.pct}%</span></div>`).join('');
  }

  function bindEngine() {
    E.subscribe((t) => {
      renderDock();
      // offer 分组完成检测
      for (const [oid, g] of S.offerGroups) {
        const list = E.getTasks();
        const tasks = list.filter((x) => g.tasks.has(x.id));
        if (!tasks.length) { S.offerGroups.delete(oid); continue; }
        const settled = tasks.filter((x) => x.state === 'done' || x.state === 'error' || x.state === 'canceled');
        if (settled.length === g.tasks.size) {
          const ok = settled.every((x) => x.state === 'done');
          S.offerGroups.delete(oid);
          const o = S.offerMap.get(oid);
          if (o) {
            o.state = ok ? 'done' : 'error';
            A.post(`/api/offers/${oid}/done`, { detail: ok ? `${g.files} 个文件` : '部分下载失败' }).catch(() => {});
            renderInboxIfActive();
            if (ok) T.toast('推送内容接收完成', 'ok');
            else T.toast('部分文件下载失败', 'bad');
          }
        }
      }
      updateBadges();
    });
  }

  // ================================================================ 设置

  function openSettings() {
    const cfg = E.settings();
    const body = `
      <div class="setting-line"><div class="slabel">下载并发线程数<small>同时向主机拉取的分片数量，值越大越快（建议 4~12）</small></div>
        <div style="display:flex;gap:8px;align-items:center"><input type="range" min="1" max="24" value="${cfg.threads}" id="setThreads" style="width:120px"><b id="setThreadsV">${cfg.threads}</b></div></div>
      <div class="setting-line"><div class="slabel">分片大小<small>单个分片的体积，大文件推荐 4~8 MB</small></div>
        <select class="input" id="setChunk" style="width:130px">
          ${[0.5, 1, 2, 4, 8, 16].map((v) => `<option value="${v}" ${cfg.chunkMB === v ? 'selected' : ''}>${v} MB</option>`).join('')}
        </select></div>
      <div class="setting-line"><div class="slabel">自动接收网页推送<small>开启后，收到网页推送自动确认并开始下载</small></div><div class="switch ${cfg.autoReceive ? 'on' : ''}" id="setAuto"></div></div>
      <div class="setting-line"><div class="slabel">主题外观<small>粉色(默认) · 跟随系统 · 白色 · 黑色</small></div>
        <div class="seg" id="themeSeg">${THEME_ORDER.map((m) => `<button type="button" data-theme="${m}" class="${(U.getL('theme', 'pink') === m) ? 'on' : ''}">${THEME_LABELS[m]}</button>`).join('')}</div></div>
      <div class="setting-line"><div class="slabel">本页设备名称<small>其它设备列表里看到的名字</small></div><input class="input" id="setName" style="width:150px" value="${U.esc(S.me.name || '')}" placeholder="设备名"></div>
      <div class="setting-line"><div class="slabel">关于 OpenLAN<small>作者：科技酱 · v${U.esc(S.instance ? S.instance.version : '')} · 分片并发 · 设备直推 · 扫码即达</small></div></div>`;
    const close = T.openModal({ title: '设置', body, foot: `<button class="btn ghost" data-x>关闭</button><button class="btn primary" data-ok>保存</button>` });
    const th = document.getElementById('setThreads');
    th.addEventListener('input', () => { document.getElementById('setThreadsV').textContent = th.value; });
    const auto = document.getElementById('setAuto');
    auto.onclick = () => { auto.classList.toggle('on'); };
    const seg = document.getElementById('themeSeg');
    if (seg) {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      });
    }
    document.querySelector('#modalRoot [data-ok]').onclick = async () => {
      E.setSettings({ threads: parseInt(th.value, 10), chunkMB: parseFloat(document.getElementById('setChunk').value), autoReceive: auto.classList.contains('on') });
      const nm = document.getElementById('setName').value.trim();
      if (nm && nm !== S.me.name) {
        S.me.name = nm;
        U.setL('name', nm);
        try { await A.post('/api/session/name', { sid: U.sid, name: nm }); } catch (_) { /* noop */ }
      }
      const chosenTheme = seg ? (seg.querySelector('.on') || {}).dataset : null;
      if (chosenTheme && chosenTheme.theme) applyTheme(chosenTheme.theme);
      T.toast('设置已保存', 'ok');
      close();
    };
    document.querySelector('#modalRoot [data-x]').onclick = close;
  }

  // ================================================================ 汇总刷新

  function refreshAll() {
    apiBootstrap().then(() => {
      loadFiles().then(() => renderFiles());
      loadDevices().then(() => { renderDevices(); updateBadges(); });
    }).catch((e) => {
      if (e.pinRequired) showLock();
    });
  }

  // ================================================================ 初始化

  function init() {
    bindEvents();
    bindEngine();
    bindUploads();

    // 标签
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

    // 顶部
    $('btnQrHome').onclick = () => {
      const urls = S.lanUrls.length ? S.lanUrls : [location.origin];
      T.qrModal('扫码连接本机', urls, `<div class="muted" style="font-size:.84rem;text-align:center">同一 Wi-Fi 下手机用相机/微信扫码即可打开网页<br>（若某个 IP 无法打开，请尝试切换上方地址）</div>`);
    };
    $('btnShareBar').onclick = () => openShareModal([]);
    $('btnClaim').onclick = () => openClaim('');
    $('btnTheme').onclick = () => cycleTheme();
    $('btnSettings').onclick = () => openSettings();
    applyTheme(U.getL('theme', 'pink'));

    // 文件操作
    $('fileList').addEventListener('click', fileAction);
    $('fileList').addEventListener('dragstart', (e) => {
      const row = e.target.closest('.frow');
      if (!row) return;
      const tokens = S.sel.has(row.dataset.token) ? [...S.sel] : [row.dataset.token];
      e.dataTransfer.setData('text/plain', JSON.stringify(tokens));
      e.dataTransfer.effectAllowed = 'copy';
    });
    $('btnSendSel').onclick = () => openComposer({ tokens: [...S.sel] });
    $('btnDownSel').onclick = () => { [...S.sel].forEach((t) => { const f = S.fileMap.get(t); if (f) E.enqueueFile(f); }); };
    $('btnShareSel').onclick = () => openShareModal([...S.sel]);
    $('btnDelSel').onclick = () => deleteTokens([...S.sel]);
    $('btnRefreshFiles').onclick = () => reloadFileList();
    $('selAll').addEventListener('click', () => {
      const rows = visibleFiles();
      const allOn = rows.length > 0 && rows.every((f) => S.sel.has(f.token));
      rows.forEach((f) => { if (allOn) S.sel.delete(f.token); else S.sel.add(f.token); });
      renderFiles();
    });
    $('fileFilter').addEventListener('input', (e) => {
      S.filter = e.target.value.trim();
      renderFiles();
    });

    // 设备
    $('btnCompose').onclick = () => openComposer({});
    $('btnSendText').onclick = () => openTextCompose({});

    // 接收箱按钮（网页推送 / 实例直传）
    $('inboxList').addEventListener('click', inboxAction);

    // 记录
    $('btnClearRecords').onclick = async () => { /* 记录存内存，刷新即空，仅提示 */ T.toast('记录为本次运行内存数据', 'warn'); };

    // 进度坞
    $('dockToggle').onclick = () => $('dockBody').classList.toggle('hidden');
    $('dockBody').classList.remove('hidden');

    // 轮询
    setInterval(() => {
      loadDevices().then(() => { if (S.view === 'devices') renderDevices(); updateBadges(); }).catch(() => {});
    }, 4000);

    // 回到前台自动刷新文件列表（其它设备可能刚上传 / 删除过文件）
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reloadFileList();
    });

    // 启动
    apiBootstrap().catch(() => {});
    ensureUnlocked().then(() => {
      refreshAll();
      if (S.claimCode) { openClaim(S.claimCode); S.claimCode = null; }
    });
    A.startHeartbeat();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
