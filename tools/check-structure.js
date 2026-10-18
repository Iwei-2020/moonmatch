'use strict';

/**
 * 工程结构门禁
 *
 * 依据：《项目说明书-月老办事处》§3.2（工程约定）、§4（原型页面清单）、§6.4（联系方式三态渲染）。
 * 目的：把「目录存在但文件缺失」「页面清单与 app.json 不一致」「云函数薄壳缺件」这类
 * 只在 IDE 编译期才暴露的问题提前拦在本地门禁。
 *
 * 校验项：
 *   ① app.json 可解析，页面清单与说明书 P-01…P-07 一一对应；
 *   ② 每个页面 / 组件具备 index.js|json|ttml|ttss 四件套；
 *   ③ 页面与组件 json 中 usingComponents 指向的组件真实存在；
 *   ④ 服务端云函数薄壳目录齐全（与客户端调用名一致）；
 *   ⑤ 客户端不出现明文联系方式常量（示例号码只允许以掩码形态存在）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINIAPP = path.join(ROOT, 'miniapp');
const SERVER = path.join(ROOT, 'server');

/** 页面清单（说明书 §4）：路由 → 页面名，作为页数基线（取签流程已内联到 P-01，不再单设取签页） */
const PAGE_BASELINE = {
  'pages/home/index': 'P-01 首页',
  'pages/register/index': 'P-02 登记',
  'pages/profile/index': 'P-03 我的档案',
  'pages/unlocks/index': 'P-05 缘签簿',
  'pages/report/index': 'P-06 举报与反馈',
  'pages/legal/index': 'P-07 协议与隐私',
};

/** 组件基线：说明书 §4「关键交互组件」 */
const COMPONENT_BASELINE = ['match-card', 'unlock-popup', 'contact-field', 'audit-badge'];

/** 云函数基线：说明书 §2 / §5 接口契约（客户端 core/cloud.js 按同名路径调用） */
const FUNCTION_BASELINE = [
  'submitProfile',
  'getProfile',
  'offlineProfile',
  'getMatch',
  'createAdTask',
  'claimTicket',
  'revealContact',
  'listUnlocked',
  'reportProfile',
  'reportEvents',
];

const QUARTET = ['.js', '.json', '.ttml', '.ttss'];
const errors = [];
const notes = [];

function fail(msg) {
  errors.push(msg);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`${label} 无法解析：${err.message}`);
    return null;
  }
}

/* ① app.json 与页面清单 */
const appJsonFile = path.join(MINIAPP, 'app.json');
if (!fs.existsSync(appJsonFile)) {
  fail('miniapp/app.json 缺失');
} else {
  const app = readJson(appJsonFile, 'miniapp/app.json');
  if (app) {
    const pages = Array.isArray(app.pages) ? app.pages : [];
    if (!pages.length) fail('app.json pages 为空（抖音小程序要求非空）');

    for (const route of Object.keys(PAGE_BASELINE)) {
      if (!pages.includes(route)) fail(`页面清单缺少 ${route}（${PAGE_BASELINE[route]}）`);
    }
    for (const route of pages) {
      if (!PAGE_BASELINE[route]) notes.push(`app.json 多出未登记页面 ${route}`);
    }

    // ② 页面四件套
    for (const route of pages) {
      for (const ext of QUARTET) {
        const f = path.join(MINIAPP, route + ext);
        if (!fs.existsSync(f)) fail(`页面缺件：${route}${ext}`);
      }
    }

    // ③ 页面 usingComponents
    for (const route of pages) {
      const jsonFile = path.join(MINIAPP, route + '.json');
      if (!fs.existsSync(jsonFile)) continue;
      const conf = readJson(jsonFile, `${route}.json`);
      const using = (conf && conf.usingComponents) || {};
      for (const [name, target] of Object.entries(using)) {
        const rel = target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(route), target);
        if (!fs.existsSync(path.join(MINIAPP, rel + '.ttml'))) {
          fail(`${route}.json 的组件 ${name} 指向不存在：${target}`);
        }
      }
    }

    // 分包非空校验（说明书 §3.2：短视频平台分包 pages 不可为空）
    for (const pkg of Array.isArray(app.subPackages) ? app.subPackages : []) {
      if (!Array.isArray(pkg.pages) || !pkg.pages.length) {
        fail(`分包 ${pkg.root} 的 pages 为空（抖音小程序会编译报错）`);
      }
    }
  }
}

/* ② 组件四件套 */
for (const name of COMPONENT_BASELINE) {
  const base = path.join(MINIAPP, 'components', name, 'index');
  for (const ext of QUARTET) {
    if (!fs.existsSync(base + ext)) fail(`组件缺件：components/${name}/index${ext}`);
  }
}

/* ④ 云函数薄壳 */
for (const fn of FUNCTION_BASELINE) {
  const entry = path.join(SERVER, 'functions', fn, 'index.js');
  if (!fs.existsSync(entry)) fail(`云函数薄壳缺失：server/functions/${fn}/index.js`);
}

/* ⑤ 明文联系方式守卫：客户端源码中不得出现连续 11 位手机号明文 */
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const offenders = [];
(function scan(dir) {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, item.name);
    if (item.isDirectory()) {
      scan(p);
      continue;
    }
    if (!/\.(js|json|ttml|ttss)$/.test(item.name)) continue;
    const text = fs.readFileSync(p, 'utf8');
    // 掩码形态 138****8888 / 138**** 属于合规写法，不以明文计
    const stripped = text.replace(/1\d{2}\*{2,}\d{0,4}/g, '');
    if (PHONE.test(stripped)) offenders.push(path.relative(ROOT, p));
  }
})(MINIAPP);
for (const f of offenders) fail(`疑似明文联系方式出现在客户端：${f}（应改为掩码下发 + 复制）`);

/* 输出 */
for (const n of notes) console.log(`[结构门禁] 提示：${n}`);
if (errors.length) {
  for (const e of errors) console.error(`[结构门禁] 失败：${e}`);
  console.error(`[结构门禁] 未通过，共 ${errors.length} 项`);
  process.exit(1);
}
console.log(`[结构门禁] 通过：页面 ${Object.keys(PAGE_BASELINE).length} 个、组件 ${COMPONENT_BASELINE.length} 个、云函数 ${FUNCTION_BASELINE.length} 个`);
