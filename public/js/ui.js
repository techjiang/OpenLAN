/* OpenLAN UI 组件：toast / modal / 二维码 / 选择列表 */
(function () {
  const U = OLU;
  let modalClose = null;
  const MODAL_TYPES = new Set();

  function toast(msg, type, ms) {
    const root = document.getElementById('toastRoot');
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, (ms || 3600) - 300);
    setTimeout(() => el.remove(), ms || 3600);
  }

  function openModal({ title = '', body = '', foot = '', wide = false, onClose }) {
    closeModal();
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}">
        <div class="modal-head">
          <h3>${U.esc(title)}</h3>
          <button class="close" data-close><svg class="ic"><use href="#i-close"/></svg></button>
        </div>
        <div class="modal-body">${body}</div>
        ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
      </div>`;
    const close = () => {
      if (modalClose === close) modalClose = null;
      MODAL_TYPES.delete(mask);
      mask.remove();
      onClose && onClose();
    };
    modalClose = close;
    MODAL_TYPES.add(mask);
    mask.addEventListener('click', (e) => { if (e.target === mask || e.target.closest('[data-close]')) close(); });
    document.getElementById('modalRoot').appendChild(mask);
    return close;
  }

  function closeModal() { if (modalClose) modalClose(); }

  function confirmModal({ title, body, okText = '确定', danger = false }) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const foot = `<button class="btn ghost" data-no>取消</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${U.esc(okText)}</button>`;
      // 注意：onClose 在关闭时也会触发，必须保证只以用户首次选择为准
      const close = openModal({ title, body, foot, onClose: () => finish(false) });
      document.querySelector('#modalRoot .modal-foot [data-yes]').addEventListener('click', () => { finish(true); close(); });
      document.querySelector('#modalRoot .modal-foot [data-no]').addEventListener('click', () => { finish(false); close(); });
    });
  }

  function qrUrl(text) { return '/api/qr?text=' + encodeURIComponent(text); }

  function qrModal(title, text, extra) {
    const urls = Array.isArray(text) && text.length ? text : [text];
    let current = urls[0];
    const select = urls.length > 1 ? `<div class="field" style="width:100%;max-width:320px"><label>选择本机地址（同一 Wi-Fi 下可访问的 IP）</label><select class="input" id="qrSelect">${urls.map((u, i) => `<option value="${U.esc(u)}" ${i === 0 ? 'selected' : ''}>${U.esc(u)}</option>`).join('')}</select></div>` : '';
    openModal({
      title,
      wide: true,
      body: `
        <div class="qr-box">
          ${select}
          <img class="qr-img" id="qrImg" src="${qrUrl(current)}" alt="二维码" />
          <div class="qr-url" id="qrText">${U.esc(current)}</div>
          ${extra || ''}
        </div>`,
      foot: `<button class="btn primary" id="qrCopy">复制链接</button>`,
    });
    const img = document.getElementById('qrImg');
    const txt = document.getElementById('qrText');
    const sel = document.getElementById('qrSelect');
    if (sel) {
      sel.addEventListener('change', () => {
        current = sel.value;
        img.src = qrUrl(current);
        txt.textContent = current;
      });
    }
    const b = document.getElementById('qrCopy');
    if (b) b.addEventListener('click', () => { U.copyText(current); toast('链接已复制', 'ok'); });
  }

  /** 设备多选列表。items: [{id,name,desc,checked,disabled,kind}] */
  function devicePicker(items, { title = '目标设备', empty = '暂无可选设备' } = {}) {
    const changed = [];
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="field">
        <label>${U.esc(title)} <span class="muted" id="pickerCount"></span></label>
        <div class="list-check" id="pickerList"></div>
        <div class="muted" style="font-size:.8rem">浏览器设备：对方网页上确认接收；OpenLAN 实例：直接推送存盘</div>
      </div>`;
    const list = wrap.querySelector('#pickerList');
    const count = wrap.querySelector('#pickerCount');
    const byId = new Map();
    const render = () => {
      list.innerHTML = items.map((it) => {
        const s = it.checked ? 'checked' : '';
        return `<div class="lc-item ${s}" data-id="${U.esc(it.id)}" ${it.disabled ? 'style="opacity:.4;pointer-events:none"' : ''}>
          <input type="checkbox" class="check" ${s}>
          <div style="flex:1"><div class="lname">${U.esc(it.name)}</div>
            <div class="lsub">${U.esc(it.desc || '')} ${it.online === false ? '· 离线' : ''}</div></div>
          ${it.kind === 'peer' ? '<span class="jtag s-ok">实例</span>' : '<span class="jtag s-accepted">网页</span>'}
        </div>`;
      }).join('') || `<div class="empty">${U.esc(empty)}</div>`;
      const n = items.filter((x) => x.checked).length;
      count.textContent = '已选 ' + n;
    };
    list.addEventListener('click', (e) => {
      const item = e.target.closest('.lc-item');
      if (!item) return;
      const it = byId.get(item.dataset.id);
      if (!it || it.disabled) return;
      it.checked = !it.checked;
      item.classList.toggle('checked', it.checked);
      const cb = item.querySelector('input.check');
      if (cb) cb.checked = it.checked;
      changed.forEach((f) => f());
      render();
    });
    items.forEach((it) => { byId.set(it.id, it); });
    const getChecked = () => items.filter((x) => x.checked);
    const onChange = (f) => changed.push(f);
    render();
    return { el: wrap, getChecked, onChange };
  }

  window.OLU = U; // 共享
  window.OLUI = { toast, openModal, closeModal, confirmModal, qrUrl, qrModal, devicePicker };
})();
