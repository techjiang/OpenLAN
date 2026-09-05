/* OpenLAN API 客户端 + SSE 通道 */
(function () {
  const U = OLU;
  const handlers = {};
  let online = false;
  let reconnectTimer = null;
  let es = null;
  let heartbeatTimer = null;
  let pinned = false;

  async function call(method, path, body) {
    const headers = { 'x-sid': U.sid };
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(path, { method, headers, body: payload });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (res.status === 401 && data && data.pinRequired) {
      emit('lock', data);
      const err = new Error(data.error || '需要 PIN');
      err.pinRequired = true;
      throw err;
    }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function get(p) { return call('GET', p); }
  function post(p, body) { return call('POST', p, body); }
  function del(p) { return call('DELETE', p); }

  function on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); }
  function emit(type, data) { (handlers[type] || []).forEach((fn) => { try { fn(data); } catch (_) { /* noop */ } }); }

  function startSSE() {
    if (es) { try { es.close(); } catch (_) { /* noop */ } }
    es = new EventSource('/api/events?sid=' + encodeURIComponent(U.sid));
    es.onopen = () => { online = true; emit('online', true); };
    es.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch (_) { return; }
      emit('event', ev);
    };
    es.onerror = () => {
      online = false;
      emit('online', false);
      try { es.close(); } catch (_) { /* noop */ }
      es = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(startSSE, 2200);
    };
  }

  function startHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => { post('/api/session/heartbeat?sid=' + encodeURIComponent(U.sid), {}).catch(() => {}); }, 20000);
  }

  function isOnline() { return online; }
  function setPinState(v) { pinned = !!v; }
  function isPinned() { return pinned; }

  window.OLA = { call, get, post, del, on, emit, startSSE, startHeartbeat, isOnline, setPinState, isPinned };
})();
