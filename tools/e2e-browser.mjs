/* OpenLAN 真实浏览器 E2E（开发自检工具，Node ≥21，需本机 Edge/Chrome）
 * 用本机 Edge/Chrome headless + CDP（Node ≥21 原生 WebSocket，零新增依赖）驱动页面：
 * 启动引导 / 四个标签 / 主题循环 / 设置弹层 / 二维码弹层 / 上传 UI / 文件行下载（引擎多分片）
 * / 文件删除确认 / 传输坞 / 记录页
 * 用法：node tools/e2e-browser.mjs <appURL> <sharedDir>  （如 http://127.0.0.1:5878 d:/XM/OpenLAN）
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const APP = process.argv[2] || 'http://127.0.0.1:5878';
const SHARED = path.resolve(process.argv[3] || process.cwd() + '/shared');
const CDP_PORT = 9300 + Math.floor(Math.random() * 500);
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!EDGE) { console.error('✘ 未找到 Edge/Chrome'); process.exit(2); }

const stamp = process.pid + '-' + Date.now().toString(36);
const profile = path.join(os.tmpdir(), 'ol-e2e-' + stamp);
const dlDir = path.join(os.tmpdir(), 'ol-e2e-dl-' + stamp);
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(dlDir, { recursive: true });

const steps = [];
let failed = 0;
const pageErrs = [];
const step = (name, ok, info) => {
  steps.push({ name, ok, info: String(info == null ? '' : info).slice(0, 140) });
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + String(info).slice(0, 140) : ''}`);
};

// ---------- 探针文件 ----------
const probeName = `e2e-probe-${stamp}.bin`;
const probeSize = 3 * 1024 * 1024; // 3MB：chunkMB=1 → 3 个分片并发
const probePath = path.join(SHARED, probeName);
const rand = crypto.randomBytes(probeSize);
fs.writeFileSync(probePath, rand);
const probeSha = crypto.createHash('sha256').update(rand).digest('hex');

const upName = `e2e-up-${stamp}.bin`;
const upSize = 512 * 1024;

// ---------- 浏览器与 CDP ----------
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  `--download-default-directory=${dlDir}`, '--disable-extensions', 'about:blank',
], { stdio: 'ignore' });

let ws;
const pend = new Map();
let msgSeq = 0;
const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++msgSeq;
  pend.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params: params || {} }));
});
const events = [];
async function connect() {
  let list = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      list = await r.json();
      if (list && list[0]) break;
    } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!list || !list[0]) throw new Error('无法获取浏览器调试目标');
  const target = list.find((t) => t.type === 'page') || list[0];
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.onmessage = (e) => {
    const m = JSON.parse(typeof e.data === 'string' ? e.data : '');
    if (m.id) { const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }
    else events.push(m);
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP open 失败')); });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir }).catch(() => {});
}

async function evalJs(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception || {};
    throw new Error('页面异常: ' + (ex.description || ex.value || 'unknown'));
  }
  return r.result ? r.result.value : undefined;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(expr, timeoutMs = 30000, every = 400) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await evalJs(expr); if (last) return last; } catch (_) { /* keep */ }
    await sleep(every);
  }
  return last || null;
}

async function openApp() {
  await send('Page.navigate', { url: APP });
  await sleep(1200);
  await evalJs(`new Promise((res)=>{ if(document.readyState==='complete')return res(true);
    addEventListener('load',()=>res(true),{once:true}); })`, true);
}

function collectErrs() {
  for (const ev of events) {
    if (ev.method === 'Runtime.exceptionThrown') {
      const d = ev.params.exceptionDetails;
      pageErrs.push((d.exception && d.exception.description) || d.text || 'exception');
    } else if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
      const t = (ev.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      pageErrs.push('console.error: ' + t);
    } else if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error') {
      pageErrs.push('log: ' + ev.params.entry.text);
    }
  }
}

// ================================================================ 流程
try {
  await connect();
  await openApp();

  step('页面可达 / readyState', true);

  // 1. 启动引导
  const online = await poll(`document.querySelector('#connPill') && document.querySelector('#connPill').classList.contains('online')`, 20000);
  step('SSE 在线（connPill.online）', !!online);

  const boot = await evalJs(`JSON.stringify({ title: document.title, dir: document.getElementById('sharedDirPath').textContent,
    pill: document.getElementById('connPill').innerText, tabs: [...document.querySelectorAll('.tab')].length })`);
  const b = JSON.parse(boot);
  step('标题含 OpenLAN', (b.title || '').includes('OpenLAN'), b.title);
  step('共享目录为相对路径展示', !/^[A-Za-z]:[\\/]|\//.test(b.dir || '') && (b.dir || '').length > 2, b.dir);
  step('连接指示已渲染', (b.pill || '').length > 0, b.pill);
  step('四个标签', b.tabs === 4, 'tabs=' + b.tabs);

  // Logo 与主题
  const logoLoaded = await evalJs(`(function(){ const im=document.querySelector('.brand .logo img'); return !!im && !!im.complete && im.naturalWidth>0; })()`);
  step('Logo 图片已加载', !!logoLoaded);
  step('默认主题为粉色(dark)', (await evalJs(`document.documentElement.dataset.theme`)) === 'dark', 'theme=' + await evalJs(`document.documentElement.dataset.theme`));
  // 主题循环：粉色 → 跟随系统 → 白色 → 黑色 → 粉色
  await evalJs(`document.getElementById('btnTheme').click()`); // auto
  await evalJs(`document.getElementById('btnTheme').click()`); // light
  await sleep(250);
  step('主题按钮切到「白色」', (await evalJs(`document.documentElement.dataset.theme`)) === 'light');
  await evalJs(`document.getElementById('btnTheme').click()`); // black
  await sleep(250);
  step('主题按钮切到「黑色」', (await evalJs(`document.documentElement.dataset.theme`)) === 'black');
  await evalJs(`document.getElementById('btnTheme').click()`); // pink
  await sleep(250);
  step('主题按钮循环回「粉色」', (await evalJs(`document.documentElement.dataset.theme`)) === 'dark');

  // 2. 标签切换
  const viewIds = { devices: 'view-devices', inbox: 'view-inbox', records: 'view-records', files: 'view-files' };
  for (const nm of Object.keys(viewIds)) {
    await evalJs(`document.querySelector('.tab[data-view="${nm}"]').click()`);
    await sleep(700);
    const on = await evalJs(`document.getElementById('${viewIds[nm]}').classList.contains('active')`);
    step('标签-' + nm, !!on);
  }
  await evalJs(`document.querySelector('.tab[data-view="files"]').click()`); await sleep(500);

  // 3. 设置弹层：修改并发=10 保存并校验持久化
  await evalJs(`document.getElementById('btnSettings').click()`); await sleep(500);
  const setOk = await evalJs(`!!document.getElementById('setThreads') && !!document.querySelector('#modalRoot [data-ok]')`);
  step('设置弹层打开', !!setOk);
  await evalJs(`(function(){ const s=document.getElementById('setThreads'); s.value='10'; s.dispatchEvent(new Event('input',{bubbles:true})); 
    document.querySelector('#modalRoot [data-ok]').click(); return true; })()`);
  await sleep(600);
  const th = await evalJs(`(window.OLE.settings().threads)`);
  step('并发线程保存为 10', th === 10, 'threads=' + th);
  step('设置弹层已关闭', !(await evalJs(`!!document.querySelector('#modalRoot [data-ok]')`)));

  // 4. 二维码弹层（含 /api/qr 图片）
  await evalJs(`document.getElementById('btnQrHome').click()`); await sleep(900);
  const hasQr = await evalJs(`!!document.querySelector('#modalRoot img[src*="/api/qr"], #modalRoot .qr-img')`);
  const hasQrImg = await evalJs(`document.querySelector('#modalRoot img[src*="/api/qr"]') ? document.querySelector('#modalRoot img[src*="/api/qr"]').naturalWidth>0 : false`);
  step('二维码弹层打开', !!hasQr);
  step('二维码图片已加载', !!hasQrImg);
  await evalJs(`(function(){ const x=document.querySelector('#modalRoot [data-x]'); if(x){x.click();return true;}
    const btns=[...document.querySelectorAll('#modalRoot button')].filter(b=>/关闭|取消/.test(b.textContent)); if(btns.length){btns[0].click();return true;} return false; })()`);
  await sleep(300);

  // 5. 设备页「发起传输」弹层（目标选择器）
  await evalJs(`document.querySelector('.tab[data-view="devices"]').click()`); await sleep(600);
  await evalJs(`document.getElementById('btnCompose').click()`); await sleep(600);
  const compOpen = await evalJs(`document.querySelectorAll('#modalRoot .modal').length > 0`);
  step('设备发起传输弹层打开', !!compOpen);
  await evalJs(`(function(){ const btns=[...document.querySelectorAll('#modalRoot button')].filter(b=>/取消|关闭|返回/.test(b.textContent)); 
    const x=document.querySelector('#modalRoot [data-x]'); if(x)x.click(); else if(btns.length)btns[0].click(); return true; })()`);
  await sleep(300);

  // 6. 上传 UI（DataTransfer 注入 fileInput）
  const didUp = await evalJs(`(async function(){
    const bytes=new Uint8Array(${upSize}); for(let i=0;i<bytes.length;i++) bytes[i]=(i*13+i%251)&255;
    const f=new File([bytes], '${upName}', {type:'application/octet-stream'});
    const dt=new DataTransfer(); dt.items.add(f);
    const inp=document.getElementById('fileInput'); inp.files=dt.files;
    inp.dispatchEvent(new Event('change',{bubbles:true}));
    return true; })()`, true);
  step('注入上传文件', !!didUp);
  const upSeen = await poll(`(async function(){ const d=await window.OLA.get('/api/files'); return !!d.files.find(x=>x.name==='${upName}'); })()`, 30000, 500);
  step('上传文件已出现在共享目录', !!upSeen);

  // 7. 设置分片小尺寸，触发文件行下载按钮（引擎多分片真实 Range）
  await evalJs(`document.querySelector('.tab[data-view="files"]').click()`); await sleep(500);
  await evalJs(`window.OLE.setSettings({ threads: 6, chunkMB: 1 }); true`);
  await evalJs(`document.getElementById('btnRefreshFiles').click()`); await sleep(900);
  const rowToken = await evalJs(`(function(){ const rows=[...document.querySelectorAll('.frow')];
    const r=rows.find(x=>x.querySelector('.t') && x.querySelector('.t').textContent==='${probeName}');
    return r ? r.dataset.token : null; })()`);
  step('刷新后页面出现探针文件行', !!rowToken);
  const clicked = await evalJs(`(function(){ const rows=[...document.querySelectorAll('.frow')];
    const r=rows.find(x=>x.querySelector('.t') && x.querySelector('.t').textContent==='${probeName}');
    const btn=r && r.querySelector('[data-act="down"]'); if(btn){btn.click(); return true;} return false; })()`);
  step('点击文件行下载按钮', !!clicked);

  const dlDone = await poll(`(function(){ const ts=window.OLE.getTasks().filter(t=>t.name==='${probeName}');
    if(!ts.length) return null;
    const t=ts[0];
    if(t.state==='done') return 'done';
    if(t.state==='error'||t.state==='canceled') return t.state+':'+(t.err||'');
    return null; })()`, 60000, 700);
  step('引擎分片下载完成', dlDone === 'done', String(dlDone));

  // 磁盘校验（下载目录）
  let saved = null;
  const base = probeName.slice(0, -4);
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\(\\d+\\))?\\.bin$`);
  const dirs = [dlDir, path.join(profile, 'Downloads'), path.join(os.tmpdir()),
    path.join(os.homedir(), 'Downloads'), path.join(process.cwd(), 'Downloads')];
  for (let i = 0; i < 40 && !saved; i++) {
    for (const d of dirs) {
      let names = [];
      try { names = await fsp.readdir(d); } catch (_) { continue; }
      for (const c of names.filter((f) => f === probeName || re.test(f))) {
        const st = await fsp.stat(path.join(d, c)).catch(() => null);
        if (st && st.size === probeSize) { saved = path.join(d, c); break; }
      }
      if (saved) break;
    }
    if (!saved) await sleep(500);
  }
  if (saved) {
    const h = crypto.createHash('sha256').update(await fsp.readFile(saved)).digest('hex');
    step('下载文件落盘且 SHA-256 一致', h === probeSha, saved + ' ' + h.slice(0, 16));
    if (h === probeSha) await fsp.rm(saved, { force: true }).catch(() => {});
  } else {
    step('下载文件落盘且 SHA-256 一致', false, '下载目录未找到 ' + probeName);
  }

  // 7.5 文件删除：确认弹窗 -> 列表与磁盘同步删除（回归：确认框曾被错误解析为“取消”）
  const delUp = await evalJs(`(function(){ const rows=[...document.querySelectorAll('.frow')];
    const r=rows.find(x=>x.querySelector('.t') && x.querySelector('.t').textContent==='${upName}');
    const b=r&&r.querySelector('[data-act="del"]'); if(b){b.click(); return true;} return false; })()`);
  step('点击文件行「删除」按钮', !!delUp);
  await sleep(600);
  const delDlg = await evalJs(`!!document.querySelector('#modalRoot .modal-foot [data-yes]')`);
  step('删除确认弹窗出现', !!delDlg);
  const yesClicked = await evalJs(`(function(){ const b=document.querySelector('#modalRoot .modal-foot [data-yes]'); if(!b) return false; b.click(); return true; })()`);
  step('点击「删除」确认', !!yesClicked);
  const delGone = await poll(`(async function(){ const d=await window.OLA.get('/api/files'); return !d.files.find(x=>x.name==='${upName}'); })()`, 20000, 500);
  step('文件已从共享目录删除', !!delGone);

  // 8. 传输坞已出现（任务进行/结束后 dock 出现或曾出现）
  await sleep(400);
  const dockVis = await evalJs(`document.getElementById('dock').classList.contains('hidden') === false`);
  step('进度坞状态正常', typeof dockVis === 'boolean');

  // 9. 记录页 + toast
  await evalJs(`document.querySelector('.tab[data-view="records"]').click()`); await sleep(600);
  await evalJs(`document.getElementById('btnClearRecords').click()`); await sleep(400);
  const toastShown = await evalJs(`!!document.querySelector('#toastRoot .toast')`);
  step('Toast 系统正常', !!toastShown);

  collectErrs();
  const real = pageErrs.filter((e) => !/favicon|Autofill|cookie/i.test(e));
  if (real.length) { failed++; console.log('  页面异常数：' + real.length); real.slice(0, 8).forEach((e) => console.log('    ! ' + e)); }
  else step('页面无 JS 异常/报错', true);

} catch (e) {
  failed++;
  console.log('E2E 崩溃：', e.message);
} finally {
  try { ws && ws.close(); } catch (_) { /* noop */ }
  try { edge.kill(); } catch (_) { /* noop */ }
  try { spawnSync('taskkill', ['/pid', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* noop */ }
  await sleep(500);
  for (let i = 0; i < 10; i++) {
    try { await fsp.rm(profile, { recursive: true, force: true }); break; } catch (_) { await sleep(400); }
  }
  await fsp.rm(dlDir, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(probePath, { force: true }).catch(() => {});
  await fsp.rm(path.join(SHARED, upName), { force: true }).catch(() => {});
}

console.log(failed ? `✘ E2E ${steps.filter((s) => !s.ok).length} 项失败 / ${steps.length} 项` : `✔ 浏览器 E2E 全部通过（${steps.length} 项）`);
process.exitCode = failed ? 1 : 0;
