'use strict';

/**
 * 抖音云「函数服务」部署产物构建
 *
 * 依据：《项目说明书-月老办事处》§3.2（服务端载体为抖音云函数服务）、§8.2（基础库 ≥2.70.0）。
 * 线上函数服务文件树实测为**平铺 `<函数名>.js` + `package.json`**，调用路径即文件名（`/getMatch` 等）。
 *
 * 为什么需要打包：云端函数项目根只有平铺 `.js` 与 `package.json`，而本仓库的服务端实现是
 *   `server/functions/<name>/index.js` + `server/lib/*.js` + `miniapp/shared/client-constants.js`，
 * 三者相对位置不同，原样上传会断 require（`../../lib/...` 会跑出上传根）。
 * 这里把每个入口与其依赖打成**自包含单文件**：云端覆盖同名平铺文件即可用，
 * 且不需要在云端维护第二份目录结构（避免两处代码漂移）。
 *
 * 用法：
 *   node tools/gen-cloud-functions.js          生成 build/cloud-functions/<服务名>/
 *   node tools/gen-cloud-functions.js --check  仅校验产物与源一致（纳入 npm run verify）
 *
 * 产物目录名 = 抖音云函数服务名（见 SERVICE_NAME）。原因：`dycloud function:deploy` 强校验
 * 「--dir 指向目录的 basename 必须等于函数服务名」，且该布局与 `dycloud function:pull` 的落盘约定
 * `<dir>/<服务名>/` 对称，部署与拉取共用同一目录。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENTRY_DIR = path.join(ROOT, 'server/functions');
const LIB_DIR = path.join(ROOT, 'server/lib');
/** 入口依赖的客户端契约（与 server/lib 一起打入产物）——客户端/服务端唯一事实来源。 */
const SHARED_FILES = ['miniapp/shared/client-constants.js'];
/**
 * 抖音云函数服务名（= 云端控制台 / `dycloud function:list` 中的「函数服务名称」）。
 * 产物目录必须以该名结尾，供 `dycloud function:deploy --dir build/cloud-functions/<服务名>` 使用。
 */
const SERVICE_NAME = 'moonmatch-api';
/**
 * 云端函数项目的唯一运行时依赖：抖音云云数据库服务端 SDK。
 * 仅 `server/lib/store-cloud.js` 懒加载使用（本地/单测环境不装，故不会让 npm test 挂掉）；
 * 由平台按本 `dependencies` 在部署时安装（`yarn add @open-dy/node-server-sdk`）。
 * 升级此依赖时同步更新此处版本号。
 */
const CLOUD_DEPS = { '@open-dy/node-server-sdk': '^1.2.2' };
const OUT_DIR = path.join(ROOT, 'build/cloud-functions', SERVICE_NAME);
const CHECK_ONLY = process.argv.includes('--check');

/** 仓库根相对路径，统一用 `/` 分隔，保证产物在任何平台都可复现。 */
function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function fail(msg) {
  console.error(`[gen-cloud-functions] ${msg}`);
  process.exit(1);
}

/** 待打包模块：lib 全量 + 共享契约。体量小，全量打包比维护依赖图更稳（不会漏包）。 */
function moduleFiles() {
  const libs = fs
    .readdirSync(LIB_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => path.join(LIB_DIR, name));

  const shared = SHARED_FILES.map((file) => path.join(ROOT, file));
  for (const file of shared) {
    if (!fs.existsSync(file)) fail(`共享契约缺失：${rel(file)}`);
  }
  return libs.concat(shared);
}

/** 入口清单：`server/functions/<函数名>/index.js` 的目录名即函数名（= 调用路径）。 */
function entryFiles() {
  return fs
    .readdirSync(ENTRY_DIR)
    .filter((name) => fs.statSync(path.join(ENTRY_DIR, name)).isDirectory())
    .sort()
    .map((name) => ({ name, file: path.join(ENTRY_DIR, name, 'index.js') }));
}

/**
 * 把相对 require 重写成内部注册表调用；Node 内置（如 `node:crypto`）保持原样，由平台的 Node 运行时提供。
 * 只处理 `./` `../` 开头的字面量 require，不触碰外部依赖。
 */
function rewrite(code, fromFile) {
  return code.replace(/require\((['"])(\.\.?\/[^'"]+)\1\)/g, (_all, quote, id) => {
    const target = rel(path.resolve(path.dirname(fromFile), id));
    return `__req(${quote}${target}${quote})`;
  });
}

function header(entry, sources) {
  return [
    '/**',
    ` * 抖音云函数服务产物：${entry.name}.js`,
    ' *',
    ' * **构建期生成，禁止手改**。源：' + sources.join(' / '),
    ' * 改完源后重跑 `node tools/gen-cloud-functions.js`（生成脚本：tools/gen-cloud-functions.js）。',
    ' *',
    ' * 平台契约：入口 `module.exports = async function (params, context)`，`params` 即 HTTP 请求体本身，',
    ' * 返回值作为 Response Body；调用路径 = 文件名，即 `/' + entry.name + '`。',
    ' * 身份：从请求头 `X-TT-OPENID` 直读，无需 login 置换（见 lib/identity.js）。',
    ' */',
  ].join('\n');
}

/** 生成一个自包含函数文件：模块注册表 + 实例缓存 + 入口导出。 */
function renderBundle(entry, modules) {
  const sources = modules.map(rel);
  const lines = [];

  lines.push(header(entry, sources.concat([rel(entry.file)])));
  lines.push("'use strict';");
  lines.push('');
  lines.push('(function () {');
  lines.push('  var __registry = {};');
  lines.push('  var __cache = {};');
  lines.push('');
  lines.push('  /** 内部模块解析：命中注册表用打包实现，未命中回落 Node 内置（如 node:crypto）。 */');
  lines.push('  function __req(id) {');
  lines.push('    if (!Object.prototype.hasOwnProperty.call(__registry, id)) return require(id);');
  lines.push('    if (!__cache[id]) {');
  lines.push('      var m = { exports: {} };');
  lines.push('      __registry[id](m, m.exports, __req);');
  lines.push('      __cache[id] = m.exports;');
  lines.push('    }');
  lines.push('    return __cache[id];');
  lines.push('  }');
  lines.push('');

  for (const file of modules.concat([entry.file])) {
    lines.push(`  // ── ${rel(file)}`);
    lines.push(`  __registry[${JSON.stringify(rel(file))}] = function (module, exports, require) {`);
    lines.push(rewrite(String(fs.readFileSync(file, 'utf8')), file).replace(/\s+$/, ''));
    lines.push('  };');
    lines.push('');
  }

  lines.push(`  module.exports = __req(${JSON.stringify(rel(entry.file))});`);
  lines.push('})();');
  return `${lines.join('\n')}\n`;
}

/** 云端函数项目所需的 `package.json`（声明云数据库 SDK 依赖；版本跟随 CLOUD_DEPS）。 */
function renderPackageJson() {
  const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const pkg = {
    name: 'moonmatch-cloud-functions',
    version: root.version,
    private: true,
    description: '抖音云函数服务部署产物（由 tools/gen-cloud-functions.js 生成，禁止手改）',
    dependencies: CLOUD_DEPS,
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function checkSame(file, content, label) {
  if (!fs.existsSync(file)) {
    console.error(`[gen-cloud-functions] --check 失败：产物缺失 ${label}，请先运行 node tools/gen-cloud-functions.js`);
    process.exit(1);
  }
  if (fs.readFileSync(file, 'utf8') !== content) {
    console.error(`[gen-cloud-functions] --check 失败：${label} 与源不一致（发生漂移）`);
    console.error('  处置：重新运行 node tools/gen-cloud-functions.js 覆盖产物，并确认源改动是预期的。');
    process.exit(1);
  }
}

function main() {
  const modules = moduleFiles();
  const entries = entryFiles();
  if (entries.length === 0) fail('未找到函数入口：server/functions/<函数名>/index.js');

  const products = entries.map((entry) => ({
    file: path.join(OUT_DIR, `${entry.name}.js`),
    content: renderBundle(entry, modules),
    label: `${entry.name}.js`,
  }));
  products.push({ file: path.join(OUT_DIR, 'package.json'), content: renderPackageJson(), label: 'package.json' });

  if (CHECK_ONLY) {
    for (const product of products) checkSame(product.file, product.content, product.label);
    console.log(`[gen-cloud-functions] --check 通过：${products.length} 个产物与源一致`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let bytes = 0;
  for (const product of products) {
    fs.writeFileSync(product.file, product.content);
    bytes += Buffer.byteLength(product.content);
  }
  console.log(
    `[gen-cloud-functions] 已生成 ${products.length} 个产物 → ${rel(OUT_DIR)}（合计 ${(bytes / 1024).toFixed(1)} KB）`
  );
  console.log(`  函数清单：${entries.map((entry) => `/${entry.name}`).join('、')}`);
  console.log(
    `  部署：dycloud function:deploy --dir ${rel(OUT_DIR)} --service-name ${SERVICE_NAME} -n "<发布备注>"` +
      '（--dir 目录名须等于服务名；覆盖线上草稿加 --coverOnlineDraft --draftSaveNote "<草稿名>"）。'
  );
}

main();
