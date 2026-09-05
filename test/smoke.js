'use strict';
/* OpenLAN 端到端冒烟测试（临时脚本，验证后删除） */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = 5599;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openlan-smoke-'));
const sharedDir = path.join(tmp, 'shared');
const downDir = path.join(tmp, 'down');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(sharedDir, { recursive: true });
fs.mkdirSync(downDir, { recursive: true });
fs.writeFileSync(path.join(sharedDir, 'hello.txt'), 'Hello OpenLAN 世界');
fs.writeFileSync(path.join(sharedDir, 'second.txt'), 'second file content 内容');

const child = spawn(process.execPath, ['server/index.js', '--port', String(PORT), '--dir', sharedDir, '--download-dir', downDir, '--data-dir', dataDir, '--no-discovery', '--no-open', '--quiet'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', () => {});
let out = '';
child.stdout.on('data', (d) => { out += d; });

const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
async function j(method, p, body, headers) {
  const res = await fetch(BASE + p, {
    method, headers: Object.assign({ 'content-type': 'application/json', 'x-sid': sid }, headers),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  return { status: res.status, data };
}

let sid = 's-smoke-' + Math.random().toString(36).slice(2, 8);

(async () => {
  try {
    // 等待启动
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(BASE + '/api/bootstrap'); if (r.ok) break; } catch (_) { /* retry */ }
      await sleep(250);
    }
    console.log('[1] 基础信息');
    let r = await j('GET', '/api/bootstrap');
    ok('bootstrap 返回实例', r.status === 200 && r.data && r.data.ok && r.data.instance.name.length > 0, JSON.stringify(r.data));
    ok('features 含 p2p/qr', r.data && r.data.features && r.data.features.includes('p2p'));

    console.log('[2] 会话');
    r = await j('POST', '/api/session/open', { sid, name: '测试设备' });
    ok('会话注册', r.status === 200 && r.data.ok && r.data.sid === sid);
    r = await j('GET', '/api/sessions');
    ok('会话列表包含自己', r.status === 200 && r.data.sessions.some((s) => s.sid === sid));

    console.log('[3] 文件与下载');
    r = await j('GET', '/api/files');
    ok('列出 2 个文件', r.data.files.length === 2, JSON.stringify(r.data.files));
    const hello = r.data.files.find((f) => f.name === 'hello.txt');
    ok('文件令牌生成', !!hello && hello.token.length === 24);
    const res = await fetch(`${BASE}/api/down/${hello.token}`, { headers: { Range: 'bytes=0-7' } });
    const body = await res.arrayBuffer();
    const text = Buffer.from(body).toString('utf8');
    ok('Range 206 且内容正确', res.status === 206 && text === 'Hello Op', `status=${res.status} body=${text}`);
    const res2 = await fetch(`${BASE}/api/down/${hello.token}`);
    const body2 = Buffer.from(await res2.arrayBuffer()).toString('utf8');
    ok('整文件下载完整', res2.status === 200 && body2 === 'Hello OpenLAN 世界');

    console.log('[4] 上传');
    const uploadBody = '内容-1234';
    const upRes = await fetch(BASE + '/api/upload', {
      method: 'POST',
      headers: {
        'x-sid': sid,
        'x-name': encodeURIComponent('上传测试.txt'),
        'x-size': String(Buffer.byteLength(uploadBody)),
        'x-sha256': require('crypto').createHash('sha256').update(uploadBody).digest('hex'),
      },
      body: uploadBody,
    });
    const up = await upRes.json();
    ok('上传并校验成功', upRes.status === 200 && up.ok && up.file.name === '上传测试.txt', JSON.stringify(up));
    r = await j('GET', '/api/files');
    ok('文件数=3', r.data.files.length === 3);

    console.log('[5] 快速分享 / 提取码 / QR');
    r = await j('POST', '/api/shares', { files: [hello.token], minutes: 60 });
    const code = r.data.share.code;
    ok('创建分享(4位提取码)', r.status === 200 && r.data.share && /^[A-Z0-9]{4}$/.test(code), code);
    r = await j('GET', '/api/shares/' + code);
    ok('提取码可领取', r.status === 200 && r.data.share.files.length === 1);
    const qr = await fetch(BASE + '/api/qr?text=' + encodeURIComponent('hello'));
    ok('QR PNG 生成', qr.status === 200 && (qr.headers.get('content-type') || '').includes('image/png'));

    console.log('[6] 会话推送(offer)');
    r = await j('POST', '/api/offers', { targets: [{ kind: 'session', id: sid }], files: [hello.token], text: '测试附言' });
    ok('发起会话推送', r.status === 200 && r.data.sessionOffers.length === 1, JSON.stringify(r.data));
    const oid = r.data.sessionOffers[0];
    r = await j('POST', `/api/offers/${oid}/accept`, {});
    ok('接受推送可拿到令牌', r.status === 200 && r.data.offer.files.length === 1 && !!r.data.offer.files[0].token);
    r = await j('POST', `/api/offers/${oid}/done`, { detail: 'ok' });
    ok('完成推送记录', r.status === 200);

    console.log('[7] 手动设备 + 记录');
    r = await j('POST', '/api/peers', { ip: '192.168.1.20', port: 5555, name: '客厅电脑' });
    ok('手动添加对端', r.status === 200 && r.data.peer && r.data.peer.manual);
    r = await j('GET', '/api/records');
    ok('传输记录存在', r.status === 200 && r.data.records.length >= 3, 'len=' + r.data.records.length);

    console.log('[8] 无效输入保护');
    r = await j('GET', '/api/shares/XXXX');
    ok('错误提取码返回404', r.status === 404);
    r = await j('POST', '/api/offers', { targets: [], files: [], text: '' });
    ok('空推送被拒绝', r.status === 400);

    console.log('');
    console.log(failures === 0 ? '✔ 冒烟测试全部通过' : `✘ ${failures} 项失败`);
    console.log('--- server stdout ---');
    console.log(out.slice(0, 800));
    process.exitCode = failures ? 1 : 0;
  } catch (e) {
    console.error('测试异常：', e);
    process.exitCode = 1;
  } finally {
    child.kill();
    setTimeout(() => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* noop */ }
    }, 300);
  }
})();
