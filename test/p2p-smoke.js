'use strict';
/**
 * OpenLAN 双实例 P2P 端到端冒烟测试
 * 场景：
 *   1. A 实例（发送方）经「手动添加对端」把 B 注册为 peer
 *   2. A 向 B 推送 2 个文件（含 >3MB 非对齐二进制 + 小文本）＋附带文本
 *   3. B 以 --auto-accept 无人值守自动接收，落盘到接收目录
 *   4. 校验 B 磁盘文件 SHA-256 与 A 原始文件一致、接收状态 done
 *   5. 纯文本推送：B 应落盘一个 .txt 文本文件
 * 用法：node test/p2p-smoke.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const BASE_PORT = 17000 + Math.floor(Math.random() * 4000) * 2; // 偶数为 A，+1 为 B

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openlan-p2p-'));
const mk = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };
const dirA = { shared: mk(path.join(tmp, 'a-shared')), down: mk(path.join(tmp, 'a-down')), data: mk(path.join(tmp, 'a-data')) };
const dirB = { shared: mk(path.join(tmp, 'b-shared')), down: mk(path.join(tmp, 'b-down')), data: mk(path.join(tmp, 'b-data')) };

// A 侧原始文件：>3MB 的“非对齐”二进制 + 小文本
const BLOB = Buffer.alloc(3 * 1024 * 1024 + 333);
{
  const seed = crypto.randomBytes(64 * 1024);
  for (let o = 0; o < BLOB.length; o += seed.length) seed.copy(BLOB, o);
}
const SMALL = Buffer.from('small text 你好 OpenLAN\n');
fs.writeFileSync(path.join(dirA.shared, 'blob.bin'), BLOB);
fs.writeFileSync(path.join(dirA.shared, 'small.txt'), SMALL);

let failures = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.log('  FAIL  ' + name + (extra !== undefined ? '  ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch(label, port, extraArgs) {
  const args = ['server/index.js', '--port', String(port), '--no-discovery', '--no-open', '--quiet',
    '--dir', extraArgs.dir.shared, '--download-dir', extraArgs.dir.down, '--data-dir', extraArgs.dir.data];
  if (extraArgs.name) args.push('--name', extraArgs.name);
  if (extraArgs.autoAccept) args.push('--auto-accept');
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return { label, port, child, base: `http://127.0.0.1:${port}` };
}

async function waitUp(inst, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(inst.base + '/api/bootstrap');
      if (r.ok) { await r.json(); return true; }
    } catch (_) { /* retry */ }
    await sleep(250);
  }
  return false;
}

async function api(inst, method, p, body, headers = {}) {
  const res = await fetch(inst.base + p, {
    method,
    headers: Object.assign({ 'content-type': 'application/json', 'x-sid': 's-p2p-test' }, headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  return { status: res.status, data };
}

async function sha(file) {
  const buf = await fsp.readFile(file);
  return { size: buf.length, sha: crypto.createHash('sha256').update(buf).digest('hex') };
}

async function waitState(inst, p, pid, doneStates, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await api(inst, 'GET', p);
    if (r.data && r.data.jobs) {
      const j = r.data.jobs.find((x) => x.pid === pid);
      if (j && doneStates.includes(j.state)) return j;
    }
    await sleep(300);
  }
  return null;
}

(async () => {
  let A = null;
  let B = null;
  try {
    console.log('OpenLAN 双实例 P2P 冒烟测试  ports:', BASE_PORT, '/', BASE_PORT + 1);
    A = launch('A', BASE_PORT, { name: 'Sender A', dir: dirA });
    B = launch('B', BASE_PORT + 1, { name: 'Receiver B', autoAccept: true, dir: dirB });

    const up = await Promise.all([waitUp(A), waitUp(B)]);
    ok('双实例启动', up[0] && up[1], `A=${up[0]} B=${up[1]}`);

    console.log('[1] 发送方共享文件');
    let r = await api(A, 'GET', '/api/files');
    ok('A 列出 2 个文件', r.data && r.data.files.length === 2);
    const fBlob = r.data.files.find((f) => f.name === 'blob.bin');
    const fSmall = r.data.files.find((f) => f.name === 'small.txt');
    ok('文件令牌有效', !!fBlob && !!fSmall && fBlob.token.length === 24);

    console.log('[2] A 手动登记对端 B');
    r = await api(A, 'POST', '/api/peers', { ip: '127.0.0.1', port: BASE_PORT + 1, name: 'Receiver B' });
    ok('手动添加 B', r.status === 200 && r.data.peer && r.data.peer.manual, JSON.stringify(r.data));
    const peerId = r.data.peer.id;

    console.log('[3] A 向 B 推送文件（B 自动接受）');
    r = await api(A, 'POST', '/api/offers', {
      targets: [{ kind: 'peer', id: peerId }],
      files: [fBlob.token, fSmall.token],
      text: '附带说明文本 hello',
    });
    ok('发起邀请成功', r.status === 200 && r.data.ok === true, JSON.stringify(r.data).slice(0, 200));
    const pid = r.data.outbounds[0];

    const outJob = await waitState(A, '/api/outbox', pid, ['done', 'error', 'denied', 'canceled'], 40000);
    ok('发送方状态 done', outJob && outJob.state === 'done', JSON.stringify(outJob && outJob.err));
    const inJob = await waitState(B, '/api/inbox', pid, ['done', 'error'], 10000);
    ok('接收方状态 done', inJob && inJob.state === 'done', JSON.stringify(inJob && inJob.err));

    console.log('[4] 磁盘哈希一致性校验');
    const filesB = [];
    const walk = async (d) => {
      for (const it of await fsp.readdir(d, { withFileTypes: true })) {
        const abs = path.join(d, it.name);
        if (it.isDirectory()) await walk(abs); else filesB.push(abs);
      }
    };
    await walk(dirB.down);
    const gotBlob = filesB.find((f) => path.basename(f) === 'blob.bin');
    const gotSmall = filesB.find((f) => path.basename(f) === 'small.txt');
    ok('B 落盘 2 个文件', !!gotBlob && !!gotSmall, JSON.stringify(filesB.map((f) => path.basename(f))));
    if (gotBlob) {
      const h = await sha(gotBlob);
      ok('blob.bin 字节数与 SHA-256 一致',
        h.size === BLOB.length && h.sha === crypto.createHash('sha256').update(BLOB).digest('hex'),
        `size=${h.size}/${BLOB.length} sha=${h.sha.slice(0, 12)}`);
    }
    if (gotSmall) {
      const h = await sha(gotSmall);
      ok('small.txt 内容一致', h.sha === crypto.createHash('sha256').update(SMALL).digest('hex'));
    }

    console.log('[5] 纯文本推送落盘');
    const textMsg = '仅文本消息：明天十点开会 123';
    r = await api(A, 'POST', '/api/offers', {
      targets: [{ kind: 'peer', id: peerId }],
      files: [],
      text: textMsg,
    });
    ok('文本邀请成功', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
    const tpid = r.data.outbounds[0];
    const tOut = await waitState(A, '/api/outbox', tpid, ['done', 'error'], 15000);
    ok('文本发送完成', tOut && tOut.state === 'done');
    filesB.length = 0;
    await walk(dirB.down);
    const txtCands = filesB.filter((f) => f.endsWith('.txt'));
    let txtFile = null;
    let content = null;
    for (const f of txtCands) {
      const c = await fsp.readFile(f, 'utf8').catch(() => '');
      if (c.includes(textMsg)) { txtFile = f; content = c; break; }
    }
    ok('B 落盘文本文件', !!txtFile, JSON.stringify(txtCands.map((f) => path.basename(f))));
    ok('文本内容一致', !!txtFile && content.includes(textMsg), content && JSON.stringify(content.slice(0, 80)));

    console.log('');
    console.log(failures === 0 ? '✔ P2P 冒烟测试全部通过' : `✘ ${failures} 项失败`);
    process.exitCode = failures ? 1 : 0;
  } catch (e) {
    console.error('测试异常：', e);
    process.exitCode = 1;
  } finally {
    for (const inst of [A, B]) { if (inst) inst.child.kill(); }
    setTimeout(() => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* noop */ }
    }, 400);
  }
})();
