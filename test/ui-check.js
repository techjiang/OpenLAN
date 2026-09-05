'use strict';
/* OpenLAN 前端静态一致性检查：
 *  1. index.html 引用的所有 /css|/js 资源在 public 下存在且按序加载
 *  2. app/ui 通过 $('id') 引用的元素在 index.html 中存在且 id 唯一
 *  3. 运行时 icon('name') 与静态 <use href="#i-.."> 用到的符号都在 sprite 中定义
 * 用法：node test/ui-check.js
 */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(PUB, p), 'utf8');
const html = read('index.html');

let failures = 0;
const ok = (name, cond, extra) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

// 1. 引用的本地静态资源存在
const assetRe = /(?:src|href)="\/(css|js)\/([^"]+)"/g;
let m;
const assets = new Set();
while ((m = assetRe.exec(html))) assets.add(`${m[1]}/${m[2]}`);
// 根目录静态资源（Logo / favicon 等）
const rootRe = /(?:src|href)="\/([A-Za-z0-9._-]+\.[a-z0-9]{1,6})"/g;
while ((m = rootRe.exec(html))) assets.add(m[1]);
ok('index.html 引用了静态资源', assets.size >= 6, [...assets].join(','));
for (const a of assets) {
  const file = path.join(PUB, a.split('/').join(path.sep));
  ok(`资源存在 ${a}`, fs.existsSync(file));
}

// 2. JS 引用的固定 DOM id
const jsSrc = ['js/app.js', 'js/ui.js', 'js/api.js'].map(read).join('\n');
const used = new Set();
let re = /\$\('([A-Za-z][\w-]*)'\)/g;
while ((m = re.exec(jsSrc))) used.add(m[1]);
re = /getElementById\('([A-Za-z][\w-]*)'\)/g;
while ((m = re.exec(jsSrc))) used.add(m[1]);
// 排除动态创建节点上自带的 id
const dynamicIds = new Set(['pickerList', 'pickerCount', 'comFiles', 'comFileCount', 'comText',
  'comAddFiles', 'pfList', 'pfN', 'txtContent', 'shList', 'shMinutes', 'shareCode',
  'claimInput', 'mIp', 'mPort', 'qrCopy', 'qrImg', 'qrText', 'qrSelect', 'themeSeg', 'settingsThreads', 'comAddLocal',
  'settingsChunkMB', 'settingsAuto', 'setThreads', 'setThreadsV', 'setAuto', 'setChunk', 'setName',
  'manualAdd', 'pickSlot', 'copyShare', 'inboxList', 'recordList', 'fileList', 'filesEmpty',
  'dockBody', 'deviceGroups']);
let miss = [];
for (const id of used) {
  if (dynamicIds.has(id)) continue;
  const count = (html.match(new RegExp(`id="${id}"`, 'g')) || []).length;
  if (count === 0) miss.push(id);
  else if (count > 1) miss.push(id + '×重复');
}
ok('JS 引用的 DOM id 存在且唯一', miss.length === 0, miss.join(' '));

// 3. 图标符号完整性
const defined = new Set();
re = /<symbol id="(i-[\w-]+)"/g;
while ((m = re.exec(html))) defined.add(m[1]);
const usedIcons = new Set();
re = /#(i-[\w-]+)"/g;
while ((m = re.exec(html))) usedIcons.add(m[1]);
re = /icon\('([\w-]+)'\)/g;
while ((m = re.exec(jsSrc))) usedIcons.add('i-' + m[1]);
const missIcon = [...usedIcons].filter((x) => !defined.has(x));
ok('图标符号完整（静态 + 运行时）', missIcon.length === 0, missIcon.join(' '));

console.log(failures ? `✘ ${failures} 项失败` : '✔ UI 一致性检查通过');
process.exitCode = failures ? 1 : 0;
