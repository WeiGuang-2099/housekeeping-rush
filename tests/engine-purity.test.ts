/**
 * 引擎源码的静态检查，守住 CLAUDE.md 的两条硬约束：
 * 引擎里没有随机数，也不读系统时间（随机性只在 generate 里，用带种子的 rng.ts）；
 * 引擎不依赖界面，不导入 React，不用浏览器 API，能在 Node 里直接跑，也不用 import.meta：import.meta.glob、
 * import.meta.env 是 Vite 专有的，在 Node 里直接跑会出错，import.meta.glob 还能导入任何模块，绕开下面的依赖方向检查。
 * 另外查一条依赖方向：observe.ts 只导入 types.ts 和 layout.ts，不导入 rules.ts（observe 只做投影，
 * 按 View 判定合法动作的 legalActionsForView 在 rules.ts 里）。这一条用白名单：'./rules.js'、'./index' 这些写法
 * 也能拿到 rules.ts，按模块名列禁止的写法列不全。动态导入的参数看不出是哪个模块时（变量、拼接的表达式、
 * 带插值的模板字符串），记一个不在白名单里的占位名，同样判失败。require(...) 也按导入算，包括只引入类型的
 * import type X = require(...)。
 *
 * 为什么要读源码：tsconfig 的 lib 含 DOM，类型检查拦不住引擎代码用 window、document；
 * 性质测试只把 Math.random 和 Date.now 换成会抛错的桩，拦不住 performance.now、new Date、crypto。
 * 这里把 src/engine 下的源码当文本读进来，去掉注释以后按单词查这些名字。
 * 字符串字面量不做特别处理：引擎源码里没有含这些名字或注释符号的字符串。
 * 这些检查防的是无意中写进去的依赖和 API；故意拼出来的加载（eval、new Worker 之类）认不出，靠代码审查。
 */

import { describe, expect, it } from 'vitest';

/** src/engine 下全部源码的文本，键是相对这个文件的路径，例如 '../src/engine/rules.ts'。 */
const SOURCES = import.meta.glob<string>('../src/engine/*.ts', { query: '?raw', import: 'default', eager: true });

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

// 去掉注释：块注释（斜杠星号开头）和行注释（两个斜杠开头）。
// 用一个正则从左到右扫一遍，哪种注释先出现就按哪种算：行注释里的斜杠星号不会被当成块注释的开头，
// 一直吞到后面的代码；块注释里的两个斜杠随整段块注释一起去掉。块注释换成一个空格，免得前后的代码粘在一起。
// 除法（a / b）不是注释，不受影响。
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => (comment.startsWith('/*') ? ' ' : ''));
}

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

/** 动态导入或 require 的参数不是一个完整的字符串字面量时记下的占位名，不在任何白名单里。 */
const DYNAMIC_IMPORT = '(动态导入)';

/** import 和 export 的 from（含 import type）。 */
const FROM_IMPORT = /\bfrom\s*['"](?<from>[^'"]+)['"]/;
/** 只有副作用的 import '...'。 */
const BARE_IMPORT = /\bimport\s*['"](?<bare>[^'"]+)['"]/;
/**
 * 动态的 import(...)。参数是单引号、双引号括起来的字符串，或者反引号括起来、不含 $ 的字符串（不带插值），
 * 并且后面紧跟右括号或逗号时，取出这个模块名；否则（变量、拼接的表达式、带插值的模板字符串）只匹配到左括号，
 * 哪个分组都没有取到。
 */
const CALL_IMPORT = /\bimport\s*\(\s*(?:(?:['"](?<quoted>[^'"]+)['"]|`(?<template>[^`$]*)`)\s*[),])?/;
/**
 * require(...)，包括只引入类型的 import type X = require(...)。参数是单引号或双引号括起来的字符串，并且后面紧跟
 * 右括号时，取出这个模块名；否则只匹配到左括号，哪个分组都没有取到。
 */
const REQUIRE_CALL = /\brequire\s*\(\s*(?:['"](?<required>[^'"]+)['"]\s*\))?/;
/** 四种写法合成一个正则，从左到右扫一遍，模块名按出现的顺序取出。 */
const IMPORT_PATTERN = new RegExp(
  [FROM_IMPORT, BARE_IMPORT, CALL_IMPORT, REQUIRE_CALL].map((part) => part.source).join('|'),
  'g',
);

/**
 * 去掉注释以后，源码导入的模块名，按出现的顺序：import 和 export 的 from（含 import type），
 * 只有副作用的 import '...'，动态的 import(...)，以及 require(...)。看不出是哪个模块时，记占位名 DYNAMIC_IMPORT。
 */
function importedModules(source: string): string[] {
  const code = stripComments(source);
  return [...code.matchAll(IMPORT_PATTERN)].map(
    ({ groups }) =>
      groups?.from ?? groups?.bare ?? groups?.quoted ?? groups?.template ?? groups?.required ?? DYNAMIC_IMPORT,
  );
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

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function sourceOf(file: string): string {
  const found = Object.entries(SOURCES).find(([path]) => fileName(path) === file);
  if (found === undefined) throw new Error(`没有读到 ${file}`);
  return found[1];
}

describe('引擎源码：没有随机数和系统时间，不依赖界面', () => {
  it('读到了引擎的源码，至少有 rules.ts、generate.ts、rng.ts、types.ts、observe.ts、score.ts', () => {
    // 一个文件都没读到时，下面逐个文件的检查会空过，所以先确认读到了。
    expect(Object.keys(SOURCES).map(fileName)).toEqual(
      expect.arrayContaining(['rules.ts', 'generate.ts', 'rng.ts', 'types.ts', 'observe.ts', 'score.ts']),
    );
    for (const [path, source] of Object.entries(SOURCES)) expect(source.length, path).toBeGreaterThan(0);
  });

  it.each(Object.entries(SOURCES))('%s：去掉注释以后不出现禁用的名字，也不导入 react', (_path, source) => {
    expect(forbiddenIn(source)).toEqual([]);
  });

  it('rng.ts 是带种子的随机数，自己算伪随机数，不用 Math.random', () => {
    expect(forbiddenIn(sourceOf('rng.ts'))).toEqual([]);
  });

  it('去掉注释以后代码还在：rules.ts 的五个对外函数都还在', () => {
    const code = stripComments(sourceOf('rules.ts'));
    for (const name of ['initial', 'legalActions', 'legalActionsForView', 'apply', 'cleanMinutes']) {
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
