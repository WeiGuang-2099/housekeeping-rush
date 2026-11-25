/**
 * 引擎源码的静态检查，守住 CLAUDE.md 的两条硬约束：
 * 引擎里没有随机数，也不读系统时间（随机性只在 generate 里，用带种子的 rng.ts）；
 * 引擎不依赖界面，不导入 React，不用浏览器 API，能在 Node 里直接跑，也不用 import.meta：import.meta.glob、
 * import.meta.env 是 Vite 专有的，在 Node 里直接跑会出错，import.meta.glob 还能导入任何模块，绕开下面的依赖方向检查。
 * 另外查一条依赖方向：observe.ts 只导入 types.ts 和 layout.ts，不导入 rules.ts（observe 只做投影，
 * 按 View 判定合法动作的 legalActionsForView 在 rules.ts 里）。这一条用白名单：'./rules.js'、'./index' 这些写法
 * 也能拿到 rules.ts，按模块名列禁止的写法列不全。动态导入的参数看不出是哪个模块时（变量、拼接的表达式、
 * 带插值的模板字符串），记一个不在白名单里的占位名，同样判失败。require(...) 也按导入算，包括只引入类型的
 * import type X = require(...)。recall.ts 同样用白名单，只导入 types.ts、params.ts（参数的类型）和 layout.ts：
 * 它只从 View 和 params 推出关键事实，用得着的只有几何，用不着规则和生成器。
 *
 * 为什么要读源码：tsconfig 的 lib 含 DOM，类型检查拦不住引擎代码用 window、document；
 * 性质测试只把 Math.random 和 Date.now 换成会抛错的桩，拦不住 performance.now、new Date、crypto。
 * 这里把 src/engine 下的源码当文本读进来，去掉注释以后按单词查这些名字。
 * 字符串字面量不做特别处理：引擎源码里没有含这些名字或注释符号的字符串。
 * 这些检查防的是无意中写进去的依赖和 API；故意拼出来的加载（eval、new Worker 之类）认不出，靠代码审查。
 *
 * 策略（src/policies 下的源码，含子目录）做同样的禁用名字检查：策略也不依赖界面，能在 Node 里直接跑（硬约束 7），
 * 也不用 Math.random、系统时间和 import.meta。另外守住 docs/DESIGN.md 公平性约束的第 3 道里的静态检查：
 * 只看 View 的策略拿不到 World，可是引擎公开的 generate 能按种子重建整个世界。策略按约定从 src/engine/index.ts 导入，
 * generate 也经它转出，所以按导入的名字查，不按模块路径查：
 * - import 和 export ... from 的导入子句（关键字和 from 之间的部分）里不许出现 generate 这个名字，别名、转出也算；
 * - 不许对模块整体导入（import * as、export * from、require）：整体导入以后用 engine.generate，按名字就查不到了；
 * - 不许动态导入（import(...)，含 import.meta.glob），理由同上；
 * - 不许读 .seed，['seed'] 的写法也算。
 * 解构出种子（const { seed } = world）这类写法认不出，故意不调用 generate、照着生成过程重写一遍也认不出，都靠代码审查。
 * 新手另有一条：只从引擎的对外入口导入（模块名是 '../engine'）。全知直接拿 World，同样不导入 generate、不读种子
 * （它用不着），只从引擎的对外入口和新手（'./novice'，新手的走法是它的候选）导入。
 */

import { describe, expect, it } from 'vitest';
import {
  DYNAMIC_IMPORT,
  DYNAMIC_PATTERN,
  fileName,
  importClauses,
  importedModules,
  stripComments,
} from './helpers/source';

/** src/engine 下全部源码的文本，键是相对这个文件的路径，例如 '../src/engine/rules.ts'。 */
const SOURCES = import.meta.glob<string>('../src/engine/*.ts', { query: '?raw', import: 'default', eager: true });

/** src/policies 下（含子目录）全部源码的文本，键是相对这个文件的路径，例如 '../src/policies/novice.ts'。 */
const POLICY_SOURCES = import.meta.glob<string>('../src/policies/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * 引擎代码里不能出现的名字：随机数、系统时间、浏览器 API。按整个单词匹配，名字只是更长的标识符的一部分时
 * 不算（例如 windows、updateDates）。名字里的点两边有空白或换行也算（例如 Math .random）。
 */
const FORBIDDEN_NAMES = [
  'Math.random',
  'Date',
  'performance',
  'crypto',
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'navigator',
  'fetch',
];

/** 导入 react 或 react-dom（含子路径，例如 react-dom/client）时出现的模块名。 */
const REACT_MODULE = /['"]react(?:-dom)?(?:\/[^'"]*)?['"]/;

/**
 * import 后面跟点的写法：import.meta（理由见文件开头），以及 import.defer(...)、import.source(...) 这类导入。
 * 点的两边有空白、换行或注释也算：Vite 照样展开 import .meta.glob(...)。reimport.meta 这类更长的标识符不算；
 * 属性访问 obj.import.x 和 $import.meta 会多拦，引擎里没有这种写法。
 */
const IMPORT_DOT = /\bimport\s*\.\s*(?<property>[A-Za-z_$][\w$]*)/;

/**
 * 去掉注释以后出现的禁用名字；导入了 react 或 react-dom 时再加一项 'react'；
 * 用了 import 后面跟点的写法时再加一项，写成 import 加点再加后面的名字，例如 'import.meta'。
 */
function forbiddenIn(source: string): string[] {
  const code = stripComments(source);
  const hits = FORBIDDEN_NAMES.filter((name) => new RegExp(`\\b${name.replace('.', '\\s*\\.\\s*')}\\b`).test(code));
  if (REACT_MODULE.test(code)) hits.push('react');
  const property = IMPORT_DOT.exec(code)?.groups?.property;
  if (property !== undefined) hits.push(`import.${property}`);
  return hits;
}

/**
 * observe.ts 只能导入这两个模块：类型，以及用得着时的几何（layout.ts）。用白名单，不列指向 rules.ts 的写法：
 * 带后缀的 './rules.js'、经由 index.ts 转导出的 './index'、'.'、'../engine' 都能拿到 rules.ts，列不全。
 * 模块名要逐字相同：'./types.js' 这类带后缀的写法也会被拦下（仓库里的导入都不带后缀）。
 */
const OBSERVE_IMPORTS: readonly string[] = ['./types', './layout'];

/** 不在 observe.ts 白名单里的模块名，按出现的顺序。 */
function notAllowedInObserve(modules: readonly string[]): string[] {
  return modules.filter((name) => !OBSERVE_IMPORTS.includes(name));
}

/** recall.ts 只能导入这三个模块：类型、参数的类型和几何（理由见文件开头）。模块名同样要逐字相同。 */
const RECALL_IMPORTS: readonly string[] = ['./types', './params', './layout'];

/** 不在 recall.ts 白名单里的模块名，按出现的顺序。 */
function notAllowedInRecall(modules: readonly string[]): string[] {
  return modules.filter((name) => !RECALL_IMPORTS.includes(name));
}

/** policyViolations 查的四种写法，也是它们在结果里的顺序。 */
const IMPORTS_GENERATE = '导入 generate';
const WHOLE_MODULE = '整体导入';
const DYNAMIC_LOAD = '动态导入';
const READS_SEED = '读 .seed';

/**
 * 读 .seed：属性访问 .seed（含 ?.seed，点的两边有空白或换行也算），以及用字符串下标 ['seed']。
 * 更长的名字（.seeds、.seedFromView）不算；展开运算符 ...seed 不是属性访问，也不算。
 */
const SEED_PATTERN = /(?<!\.)\.\s*seed\b|\[\s*(['"`])seed\1\s*\]/;

/**
 * 只看 View 的策略不许出现的写法（见文件开头），去掉注释以后查，按上面四种的顺序，每种最多列一次：
 * 导入子句里有 generate 这个名字；对模块整体导入（导入子句里有星号，或者用了 require，含 import x = require(...)）；
 * 动态导入；读 .seed。
 */
function policyViolations(source: string): string[] {
  const code = stripComments(source);
  const clauses = importClauses(source);
  const found: string[] = [];
  if (clauses.some((clause) => /\bgenerate\b/.test(clause))) found.push(IMPORTS_GENERATE);
  if (clauses.some((clause) => clause.includes('*')) || /\brequire\b/.test(code)) found.push(WHOLE_MODULE);
  if (DYNAMIC_PATTERN.test(code)) found.push(DYNAMIC_LOAD);
  if (SEED_PATTERN.test(code)) found.push(READS_SEED);
  return found;
}

/** sources 里文件名是 file 的那份源码，默认在引擎的源码里找。 */
function sourceOf(file: string, sources: Record<string, string> = SOURCES): string {
  const found = Object.entries(sources).find(([path]) => fileName(path) === file);
  if (found === undefined) throw new Error(`没有读到 ${file}`);
  return found[1];
}

describe('引擎源码：没有随机数和系统时间，不依赖界面', () => {
  it('读到了引擎的源码，至少有 rules.ts、generate.ts、rng.ts、types.ts、observe.ts、score.ts、recall.ts', () => {
    // 一个文件都没读到时，下面逐个文件的检查会空过，所以先确认读到了。
    expect(Object.keys(SOURCES).map(fileName)).toEqual(
      expect.arrayContaining(['rules.ts', 'generate.ts', 'rng.ts', 'types.ts', 'observe.ts', 'score.ts', 'recall.ts']),
    );
    for (const [path, source] of Object.entries(SOURCES)) expect(source.length, path).toBeGreaterThan(0);
  });

  it.each(Object.entries(SOURCES))('%s：去掉注释以后不出现禁用的名字，也不导入 react', (_path, source) => {
    expect(forbiddenIn(source)).toEqual([]);
  });

  it('rng.ts 是带种子的随机数，自己算伪随机数，不用 Math.random', () => {
    expect(forbiddenIn(sourceOf('rng.ts'))).toEqual([]);
  });

  it('去掉注释以后代码还在：rules.ts 的六个对外函数都还在', () => {
    const code = stripComments(sourceOf('rules.ts'));
    for (const name of ['initial', 'legalActions', 'legalActionsForView', 'illegalReasonForView', 'apply', 'cleanMinutes']) {
      expect(code, name).toMatch(new RegExp(`export function ${name}\\(`));
    }
  });
});

describe('引擎源码：依赖方向', () => {
  it('observe.ts 只导入 types 和 layout，不导入 rules.ts', () => {
    const modules = importedModules(sourceOf('observe.ts'));
    // 先确认确实找到了导入（observe.ts 至少从 types.ts 导入类型），免得一个都没找到时空过。
    expect(modules).toContain('./types');
    expect(notAllowedInObserve(modules)).toEqual([]);
  });

  it('recall.ts 只导入 types、params 和 layout，不导入 rules.ts 和 generate.ts', () => {
    const modules = importedModules(sourceOf('recall.ts'));
    // 先确认确实找到了导入（recall.ts 要从 layout.ts 导入 walkPath），免得一个都没找到时空过。
    expect(modules).toContain('./layout');
    expect(notAllowedInRecall(modules)).toEqual([]);
  });
});

describe('策略源码：没有随机数和系统时间，不依赖界面，拿不到真实世界', () => {
  it('读到了策略的源码，至少有 novice.ts 和 oracle.ts；去掉注释以后代码还在：两个文件导出各自的策略，导入子句也找得到', () => {
    // 一个文件都没读到，或者去注释误删了代码时，下面逐个文件的检查会空过，所以先确认。
    expect(Object.keys(POLICY_SOURCES).map(fileName)).toEqual(expect.arrayContaining(['novice.ts', 'oracle.ts']));
    for (const [path, source] of Object.entries(POLICY_SOURCES)) expect(source.length, path).toBeGreaterThan(0);
    const novice = sourceOf('novice.ts', POLICY_SOURCES);
    expect(stripComments(novice)).toMatch(/export const novice\b/);
    const clauses = importClauses(novice);
    expect(clauses).toHaveLength(1);
    expect(clauses.join()).toContain('legalActionsForView');
    const oracle = sourceOf('oracle.ts', POLICY_SOURCES);
    expect(stripComments(oracle)).toMatch(/export const oracle\b/);
    const oracleClauses = importClauses(oracle);
    expect(oracleClauses).toHaveLength(2);
    expect(oracleClauses.join()).toContain('legalActions');
  });

  it.each(Object.entries(POLICY_SOURCES))('%s：去掉注释以后不出现禁用的名字（含 import.meta），也不导入 react', (_path, source) => {
    expect(forbiddenIn(source)).toEqual([]);
  });

  it.each(Object.entries(POLICY_SOURCES))(
    '%s：不导入 generate 这个名字，不对模块整体导入，不动态导入，不读 .seed',
    (_path, source) => {
      expect(policyViolations(source)).toEqual([]);
    },
  );

  it('novice.ts 只从引擎的对外入口 src/engine/index.ts 导入', () => {
    expect(importedModules(sourceOf('novice.ts', POLICY_SOURCES))).toEqual(['../engine']);
  });

  it('oracle.ts 只从引擎的对外入口 src/engine/index.ts 和新手导入', () => {
    expect(importedModules(sourceOf('oracle.ts', POLICY_SOURCES))).toEqual(['../engine', './novice']);
  });
});

describe('检测函数自检', () => {
  it('代码里的 Date.now() 会被抓到，注释里的 Date.getDay() 不会', () => {
    expect(forbiddenIn('const now = Date.now();')).toEqual(['Date']);
    expect(forbiddenIn('// weekday 用 Date.getDay() 的约定\nconst weekday = 0;')).toEqual([]);
    expect(forbiddenIn('/**\n * weekday 用 Date.getDay() 的约定\n */\nconst weekday = 0;')).toEqual([]);
    // 代码后面跟着注释：只看代码部分。
    expect(forbiddenIn('const now = Date.now(); // 读系统时间')).toEqual(['Date']);
  });

  it('每个禁用的名字在代码里都会被抓到，名字里的点两边有空白或换行也一样；只是更长的标识符的一部分时不算', () => {
    const samples: [string, string][] = [
      ['Math.random', 'const roll = Math.random();'],
      ['Date', 'const today = new Date();'],
      ['performance', 'const started = performance.now();'],
      ['crypto', 'crypto.getRandomValues(buffer);'],
      ['window', 'const width = window.innerWidth;'],
      ['document', 'const title = document.title;'],
      ['localStorage', 'localStorage.setItem(key, value);'],
      ['sessionStorage', 'sessionStorage.clear();'],
      ['navigator', 'const language = navigator.language;'],
      ['fetch', 'const response = await fetch(url);'],
    ];
    for (const [name, code] of samples) expect(forbiddenIn(code), code).toEqual([name]);
    expect(forbiddenIn('const roll = Math\n  .random();')).toEqual(['Math.random']);
    expect(forbiddenIn('const roll = Math.\n  random();')).toEqual(['Math.random']);
    expect(forbiddenIn('const windows = updateDates(documentation, prefetch, MathRandom);')).toEqual([]);
  });

  it('import 后面跟点的写法会被抓到，import 和点之间夹着空白、换行或注释也一样；注释里的和 reimport.meta 不算', () => {
    const samples: [string, string][] = [
      ['import.meta', "const rules = import.meta.glob('./rules.ts', { eager: true });"],
      ['import.meta', "const rules = import .meta.glob('./rules.ts');"],
      ['import.meta', "const rules = import\n  .meta.glob('./rules.ts', { eager: true });"],
      ['import.meta', "const rules = import/* 注释 */.meta.glob('./rules.ts');"],
      ['import.meta', 'const mode = import. meta.env.MODE;'],
      ['import.defer', "const rules = await import.defer('./rules');"],
    ];
    for (const [hit, code] of samples) expect(forbiddenIn(code), code).toEqual([hit]);
    expect(forbiddenIn('// 不要用 import.meta.glob\n/* import.meta.env */\nconst kept = reimport.meta;')).toEqual([]);
  });

  it('导入 react 或 react-dom 会被抓到，导入别的模块不算', () => {
    expect(forbiddenIn("import { useState } from 'react';")).toEqual(['react']);
    expect(forbiddenIn('import { createRoot } from "react-dom/client";')).toEqual(['react']);
    expect(forbiddenIn("import { walkPath } from './layout';")).toEqual([]);
  });

  it('导入的模块名：import、import type、export from、副作用导入、动态导入、require 都能找到，注释里的不算；看不出模块名时记占位名', () => {
    expect(importedModules("import { legalActions } from './rules';")).toEqual(['./rules']);
    expect(importedModules("import type {\n  View,\n  World,\n} from './types';")).toEqual(['./types']);
    expect(importedModules("export { apply } from './rules.ts';\nexport * from './observe';")).toEqual([
      './rules.ts',
      './observe',
    ]);
    expect(importedModules("import './rules';")).toEqual(['./rules']);
    expect(importedModules("const rules = await import('./rules');")).toEqual(['./rules']);
    expect(
      importedModules("// import { apply } from './rules';\n/* import './rules' */\nimport type { View } from './types';"),
    ).toEqual(['./types']);
    // 动态导入：反引号括起来、不带插值的模块名照样取出来，跨行、带第二个参数也一样。
    expect(importedModules('const rules = await import(`./rules`);')).toEqual(['./rules']);
    expect(
      importedModules("const table = await import(\n  './table.json',\n  { with: { type: 'json' } },\n);"),
    ).toEqual(['./table.json']);
    // 参数是变量、拼接的表达式或带插值的模板字符串：看不出是哪个模块，记占位名。
    // 拼接时开头那段即使在白名单里（'./layout' 加上 '/../rules' 就是 rules.ts），也不取它。
    expect(importedModules("const name = './rules';\nconst rules = await import(name);")).toEqual([DYNAMIC_IMPORT]);
    expect(importedModules("const rules = await import('./layout' + suffix);")).toEqual([DYNAMIC_IMPORT]);
    expect(importedModules('const rules = await import(`./${name}`);')).toEqual([DYNAMIC_IMPORT]);
    // require 也算导入，包括只引入类型的 import type X = require(...)；require 和括号之间、括号里面有空白也一样。
    // 参数不是单引号或双引号括起来的字符串（变量、反引号）时记占位名。
    expect(importedModules("import type Rules = require('./rules');")).toEqual(['./rules']);
    expect(importedModules("const rules = require ('./rules');")).toEqual(['./rules']);
    expect(importedModules("const rules = require( './rules' );")).toEqual(['./rules']);
    expect(importedModules('const rules = require(`./rules`);')).toEqual([DYNAMIC_IMPORT]);
    expect(
      importedModules('declare const require: (name: string) => unknown;\nconst rules = require(name);'),
    ).toEqual([DYNAMIC_IMPORT]);
  });

  it('observe.ts 的白名单：能拿到 rules.ts 的写法和看不出模块名的动态导入都不在白名单里，types 和 layout 在', () => {
    // 直接导入 rules.ts（不带后缀，带 .ts 或 .js 后缀），或者经由 index.ts 的转导出（'./index'、'./index.js'、'.'、'../engine'）。
    const reachRules = ['./rules', './rules.ts', './rules.js', './index', './index.js', '.', '../engine'];
    expect(notAllowedInObserve([...reachRules, DYNAMIC_IMPORT, './types', './layout'])).toEqual([
      ...reachRules,
      DYNAMIC_IMPORT,
    ]);
    // 从源码文本到判定连起来：注释里的导入不算，代码里的静态导入和动态导入都按白名单判，
    // 包括反引号括起来的模块名、用变量写的动态导入，以及只引入类型的 import type X = require(...)。
    const source = [
      "import type { View } from './types';",
      "import { walkPath } from './layout';",
      "// import { apply } from './rules';",
      "import { legalActionsForView } from './rules.js';",
      "const engine = await import('./index');",
      'export const lazyRules = () => import(`./rules`);',
      "const rulesModule = './rules';",
      'export const lazyByName = () => import(rulesModule);',
      "import type Rules = require('./rules');",
    ].join('\n');
    expect(notAllowedInObserve(importedModules(source))).toEqual([
      './rules.js',
      './index',
      './rules',
      DYNAMIC_IMPORT,
      './rules',
    ]);
  });

  it('recall.ts 的白名单：types、params、layout 在；rules、generate、经由 index.ts 的写法和看不出模块名的动态导入都不在', () => {
    expect(notAllowedInRecall(['./types', './params', './layout'])).toEqual([]);
    const reach = ['./rules', './generate', './rules.js', './index', '.', '../engine', DYNAMIC_IMPORT];
    expect(notAllowedInRecall(reach)).toEqual(reach);
  });

  it('策略的检查：导入子句里的 generate 按名字查，别名、跨行、带类型修饰、从别的模块导入、转出都算；注释里的、更长的名字不算', () => {
    const samples: [string, string[]][] = [
      ["import { generate } from '../engine';", [IMPORTS_GENERATE]],
      ["import { generate as makeWorld } from '../engine';", [IMPORTS_GENERATE]],
      ["import {\n  legalActionsForView,\n  generate,\n  type View,\n} from '../engine';", [IMPORTS_GENERATE]],
      // 按名字查，不按模块路径查：直接从 generate.ts 导入也一样。
      ["import { generate } from '../engine/generate';", [IMPORTS_GENERATE]],
      ["import { type generate } from '../engine';", [IMPORTS_GENERATE]],
      ["export { generate } from '../engine';", [IMPORTS_GENERATE]],
      ["import { generateRoutes } from './routes';", []],
      ["// import { generate } from '../engine';\n/* import { generate } from '../engine'; */", []],
      ["import { legalActionsForView, walkMinutes, type Policy } from '../engine';", []],
    ];
    for (const [code, expected] of samples) expect(policyViolations(code), code).toEqual(expected);
  });

  it('策略的检查：整体导入、动态导入（含 import.meta.glob）和读 .seed 的各种写法都会被抓到；更长的名字、展开运算符、注释里的不算', () => {
    const samples: [string, string[]][] = [
      ["import * as engine from '../engine';", [WHOLE_MODULE]],
      ["import type * as Engine from '../engine';", [WHOLE_MODULE]],
      ["export * from '../engine';", [WHOLE_MODULE]],
      ["export * as engine from '../engine';", [WHOLE_MODULE]],
      ["import engine = require('../engine');", [WHOLE_MODULE]],
      ["const engine = require('../engine');", [WHOLE_MODULE]],
      ["const engine = await import('../engine');", [DYNAMIC_LOAD]],
      ["const engine = await import /* 注释 */ (\n  '../engine'\n);", [DYNAMIC_LOAD]],
      ["const modules = import.meta.glob('../engine/*.ts', { eager: true });", [DYNAMIC_LOAD]],
      ['const seed = world.seed;', [READS_SEED]],
      ['const seed = world?.seed;', [READS_SEED]],
      ['const seed = world\n  .seed;', [READS_SEED]],
      ["const seed = world['seed'];", [READS_SEED]],
      ['const seed = world[ "seed" ];', [READS_SEED]],
      ['const seeds = view.seedFromView + view.seeds;', []],
      ['const copy = { ...seed };', []],
      ["// const seed = world.seed;\n/* const engine = await import('../engine'); */", []],
    ];
    for (const [code, expected] of samples) expect(policyViolations(code), code).toEqual(expected);
  });

  it('策略的检查：几种写法同时出现时都列出来，顺序固定；导入子句不会从 export const 一路吞到后面的 from', () => {
    const source = [
      "import { legalActionsForView, generate } from '../engine';",
      "import * as engine from '../engine';",
      'export const peek = (world: World) => world.seed;',
      "export const later = () => import('../engine');",
    ].join('\n');
    expect(policyViolations(source)).toEqual([IMPORTS_GENERATE, WHOLE_MODULE, DYNAMIC_LOAD, READS_SEED]);
    // export const 后面遇到括号就停下：找到的子句只有两条导入的。
    expect(importClauses(source).map((clause) => clause.trim())).toEqual([
      '{ legalActionsForView, generate }',
      '* as engine',
    ]);
  });

  it('去注释对块注释和行注释都有效，不误删正常代码', () => {
    expect(stripComments('a /* x */ b // y\nc')).toBe('a   b \nc');
    // 除法不是注释。
    expect(stripComments('const half = total / 2 / count;')).toBe('const half = total / 2 / count;');
    // 块注释可以跨行，里面的两个斜杠随整段去掉。
    expect(stripComments('a/* 第一行\n // 第二行 */b')).toBe('a b');
    // 行注释里的斜杠星号不会被当成块注释的开头，后面的代码保留。
    expect(stripComments('// 例如 /* 这样\nconst kept = 1; /* 注释 */')).toBe('\nconst kept = 1;  ');
    expect(forbiddenIn('// 例如 /* 这样\nconst now = Date.now(); /* 注释 */')).toEqual(['Date']);
  });
});
