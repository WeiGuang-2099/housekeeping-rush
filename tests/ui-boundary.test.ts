/**
 * 界面和语言包源码的静态检查，守住 CLAUDE.md 的硬约束和 docs/DESIGN.md 技术选型里的边界：
 *
 * 1. 界面文字放语言包（硬约束 8）：src/ui 下的源码和 src/App.tsx、src/main.tsx 去掉注释以后不出现中文（汉字、中文标点
 *    和全角符号）。给开发者看的报错（new Error 的参数是一个字符串字面量）照项目的约定用中文写，不是界面文字，查之前去掉。
 *    只认中文：现在的界面只有中文，英文的界面文字写死在组件里查不出来，靠代码审查。
 * 2. 引擎一律从对外入口导入：src/ui、src/content、src/App.tsx 和 src/main.tsx 导入的模块，按路径解析后落在 src/engine 下的，
 *    只能是 src/engine 本身（或者写全的 src/engine/index），'../engine/rules' 这类写法都会被拦下。看不出模块名的动态导入也算违规。
 * 3. 班次进行中界面只读 View：src/ui 下除了 reducer（shift.ts）以外的文件，导入子句里不出现拿得到 World、State 的名字
 *    （World、State、observe、generate、apply 这些，以及 reducer 的 ShiftModel、startShift 等），也不整体导入、不动态导入、
 *    不用 require（整体导入以后用 engine.World，按名字就查不到了）。shift.ts 持有 World 和 State，是现在唯一的例外；
 *    结算页和回放读 World，到那几项再把它们的文件加进例外。
 * 4. 语言包不依赖界面和 React：src/content 只从引擎的对外入口和 src/content 自己的文件导入。
 *
 * 和 tests/engine-purity.test.ts 一样把源码当文本读进来查，共用的去注释、找导入的函数在 tests/helpers/source.ts。
 * 这些检查防的是无意中写进去的文字和依赖；故意绕开的写法（例如把中文写成转义序列）认不出，靠代码审查。
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

/** src/ui 下（含子目录）的源码，键是相对这个文件的路径，例如 '../src/ui/TaskSheet.tsx'。 */
const UI_SOURCES = import.meta.glob<string>('../src/ui/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true });
/** src/content 下（含子目录）的源码。 */
const CONTENT_SOURCES = import.meta.glob<string>('../src/content/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});
/** 应用的入口。 */
const ROOT_SOURCES = import.meta.glob<string>(['../src/App.tsx', '../src/main.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** 引擎的对外入口，按 resolveFrom 的写法：目录本身，或者写全的 index。 */
const ENGINE_ENTRY: readonly string[] = ['../src/engine', '../src/engine/index'];
const ENGINE_DIR = '../src/engine/';
const CONTENT_DIR = '../src/content/';

/** 汉字（含扩展 A）、中文标点和全角符号。 */
const CHINESE = /[　-〿㐀-䶿一-鿿＀-￯]+/g;

/** new Error(...) 的参数是一个字符串字面量（单引号、双引号或反引号括起来）时的整个调用。 */
const ERROR_CALL = /\bnew\s+Error\s*\(\s*(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)\s*\)/g;

/** 去掉注释和报错消息以后，源码里出现的每一段中文，按出现的顺序。 */
function uiTextIn(source: string): string[] {
  const code = stripComments(source).replace(ERROR_CALL, 'new Error()');
  return [...code.matchAll(CHINESE)].map((match) => match[0]);
}

/**
 * 把 path（相对这个测试文件的路径，例如 '../src/ui/TaskSheet.tsx'）导入的相对模块名解析成同样写法的路径，
 * 例如 '../engine' 解析成 '../src/engine'。包名（react 之类）不是相对路径，返回 null。
 */
function resolveFrom(path: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const parts = path.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/** path 的源码里绕开引擎对外入口的导入（第 2 条），按出现的顺序，写成导入时的模块名。 */
function engineBypasses(path: string, source: string): string[] {
  return importedModules(source).filter((specifier) => {
    if (specifier === DYNAMIC_IMPORT) return true;
    const resolved = resolveFrom(path, specifier);
    return resolved !== null && resolved.startsWith(ENGINE_DIR) && !ENGINE_ENTRY.includes(resolved);
  });
}

/** 拿得到 World 或 State 的名字（第 3 条）。 */
const WORLD_NAMES: readonly string[] = [
  'World',
  'State',
  'RoomTruth',
  'RoomProgress',
  'ScheduledEvent',
  'EventPrompt',
  'OraclePolicy',
  'generate',
  'initial',
  'apply',
  'observe',
  'legalActions',
  'score',
  'runShift',
  'ShiftRun',
  'Ghost',
  'ShiftModel',
  'ShiftMessage',
  'startShift',
  'shiftReducer',
  'screenProps',
];
const WHOLE_MODULE = '整体导入';
const DYNAMIC_LOAD = '动态导入';

/** 只读 View 的文件里不许出现的写法（第 3 条）：导入子句里拿得到 World、State 的名字，整体导入，动态导入。 */
function worldAccessIn(source: string): string[] {
  const code = stripComments(source);
  const clauses = importClauses(source);
  const found = WORLD_NAMES.filter((name) => clauses.some((clause) => new RegExp(`\\b${name}\\b`).test(clause)));
  if (clauses.some((clause) => clause.includes('*')) || /\brequire\b/.test(code)) found.push(WHOLE_MODULE);
  if (DYNAMIC_PATTERN.test(code)) found.push(DYNAMIC_LOAD);
  return found;
}

/** 语言包的文件导入的、不在 src/content 里也不是引擎对外入口的模块（第 4 条）。 */
function contentImportsOutside(path: string, source: string): string[] {
  return importedModules(source).filter((specifier) => {
    const resolved = resolveFrom(path, specifier);
    return resolved === null || !(resolved.startsWith(CONTENT_DIR) || ENGINE_ENTRY.includes(resolved));
  });
}

/** 只读 View 的规定的例外：reducer 持有 World 和 State。 */
const HOLDS_WORLD: readonly string[] = ['shift.ts'];

describe('读到了源码', () => {
  it('界面、语言包和入口的文件都读到了，内容不是空的', () => {
    // 一个文件都没读到时，下面逐个文件的检查会空过，所以先确认读到了。
    expect(Object.keys(UI_SOURCES).map(fileName)).toEqual(
      expect.arrayContaining(['ShiftScreen.tsx', 'FloorPlan.tsx', 'Timeline.tsx', 'TaskSheet.tsx', 'Cart.tsx', 'shift.ts']),
    );
    expect(Object.keys(CONTENT_SOURCES)).toEqual(
      expect.arrayContaining(['../src/content/index.ts', '../src/content/types.ts', '../src/content/zh/ui.ts']),
    );
    expect(Object.keys(ROOT_SOURCES).map(fileName)).toEqual(['App.tsx', 'main.tsx']);
    for (const [path, source] of Object.entries({ ...UI_SOURCES, ...CONTENT_SOURCES, ...ROOT_SOURCES })) {
      expect(source.length, path).toBeGreaterThan(0);
    }
  });
});

describe('界面文字放语言包', () => {
  it.each(Object.entries({ ...UI_SOURCES, ...ROOT_SOURCES }))('%s：去掉注释和报错消息以后没有中文', (_path, source) => {
    expect(uiTextIn(source)).toEqual([]);
  });

  it('语言包里确实有中文：中文的文案表在 src/content/zh/ui.ts', () => {
    expect(uiTextIn(CONTENT_SOURCES['../src/content/zh/ui.ts'] ?? '').length).toBeGreaterThan(0);
  });
});

describe('引擎一律从对外入口导入', () => {
  it.each(Object.entries({ ...UI_SOURCES, ...CONTENT_SOURCES, ...ROOT_SOURCES }))(
    '%s：导入的引擎模块都是 src/engine/index.ts',
    (path, source) => {
      expect(engineBypasses(path, source)).toEqual([]);
    },
  );
});

describe('班次进行中界面只读 View', () => {
  const viewOnly = Object.entries(UI_SOURCES).filter(([path]) => !HOLDS_WORLD.includes(fileName(path)));

  it('除了 reducer 以外的文件都在查：至少有四个部件和主界面', () => {
    expect(viewOnly.map(([path]) => fileName(path))).toEqual(
      expect.arrayContaining(['ShiftScreen.tsx', 'FloorPlan.tsx', 'Timeline.tsx', 'TaskSheet.tsx', 'Cart.tsx']),
    );
  });

  it.each(viewOnly)('%s：导入子句里没有拿得到 World、State 的名字，不整体导入，不动态导入', (_path, source) => {
    expect(worldAccessIn(source)).toEqual([]);
  });

  it('reducer 确实导入了 World 和 State：例外名单写的是对的文件', () => {
    const shift = Object.entries(UI_SOURCES).find(([path]) => fileName(path) === 'shift.ts')?.[1] ?? '';
    expect(worldAccessIn(shift)).toEqual(expect.arrayContaining(['World', 'State', 'observe']));
  });
});

describe('语言包不依赖界面和 React', () => {
  it.each(Object.entries(CONTENT_SOURCES))('%s：只从引擎的对外入口和语言包自己的文件导入', (path, source) => {
    expect(contentImportsOutside(path, source)).toEqual([]);
  });
});

describe('检测函数自检', () => {
  it('JSX 里的字、字符串和模板字符串里的中文都会被抓到；注释和报错消息里的不算', () => {
    expect(uiTextIn('const a = <h1>任务单</h1>;')).toEqual(['任务单']);
    expect(uiTextIn("const label = '现在';")).toEqual(['现在']);
    expect(uiTextIn('const label = `${clock} 后可进`;')).toEqual(['后可进']);
    expect(uiTextIn('const sep = "，";')).toEqual(['，']);
    expect(uiTextIn('// 任务单\n/* 平面图 */\nconst kept = 1;')).toEqual([]);
    expect(uiTextIn("throw new Error('平面图：没有房间');")).toEqual([]);
    expect(uiTextIn('throw new Error(`平面图：没有房间 ${id}`);')).toEqual([]);
    expect(uiTextIn("throw new Error(label + '平面图');")).toEqual(['平面图']);
    expect(uiTextIn("const message = new Error('坏了'); const text = '好了';")).toEqual(['好了']);
  });

  it('解析相对路径：../engine 从 src/ui 解析到 src/engine，./engine 从 src 也是；包名不解析', () => {
    expect(resolveFrom('../src/ui/TaskSheet.tsx', '../engine')).toBe('../src/engine');
    expect(resolveFrom('../src/App.tsx', './engine')).toBe('../src/engine');
    expect(resolveFrom('../src/content/zh/ui.ts', '../types')).toBe('../src/content/types');
    expect(resolveFrom('../src/ui/TaskSheet.tsx', './shift')).toBe('../src/ui/shift');
    expect(resolveFrom('../src/ui/TaskSheet.tsx', 'react')).toBeNull();
  });

  it('绕开引擎对外入口的导入：内部文件、看不出模块名的动态导入都会被抓到；对外入口、别的目录和包名不算', () => {
    const source = [
      "import { recall } from '../engine';",
      "import { apply } from '../engine/rules';",
      "import type { View } from '../engine/types';",
      "import { observe } from '../engine/index';",
      "import { useId } from 'react';",
      "import { useText } from '../content';",
      'const engine = await import(name);',
    ].join('\n');
    expect(engineBypasses('../src/ui/TaskSheet.tsx', source)).toEqual(['../engine/rules', '../engine/types', DYNAMIC_IMPORT]);
    expect(engineBypasses('../src/App.tsx', "import { PARAMS } from './engine/params';")).toEqual(['./engine/params']);
  });

  it('只读 View 的检查：导入子句里的名字（含类型、别名）、整体导入和动态导入都会被抓到；更长的名字和注释里的不算', () => {
    expect(worldAccessIn("import { observe, type World } from '../engine';")).toEqual(['World', 'observe']);
    expect(worldAccessIn("import type { State as S } from '../engine';")).toEqual(['State']);
    expect(worldAccessIn("import { startShift } from './shift';")).toEqual(['startShift']);
    expect(worldAccessIn("import * as engine from '../engine';")).toEqual([WHOLE_MODULE]);
    expect(worldAccessIn("const engine = await import('../engine');")).toEqual([DYNAMIC_LOAD]);
    expect(worldAccessIn("const engine = require('../engine');")).toEqual([WHOLE_MODULE]);
    expect(worldAccessIn("import { type RoomStatus, type ScreenProps } from './rooms';")).toEqual([]);
    expect(worldAccessIn("// import { World } from '../engine';\nimport type { View } from '../engine';")).toEqual([]);
  });

  it('语言包的检查：React、界面和引擎内部文件都会被抓到；引擎对外入口和语言包自己的文件不算', () => {
    const source = [
      "import type { Tier } from '../engine';",
      "import type { UiText } from './types';",
      "import { useState } from 'react';",
      "import type { RoomStatus } from '../ui/rooms';",
      "import type { Params } from '../engine/params';",
    ].join('\n');
    expect(contentImportsOutside('../src/content/index.ts', source)).toEqual(['react', '../ui/rooms', '../engine/params']);
    expect(contentImportsOutside('../src/content/zh/ui.ts', "import type { UiText } from '../types';")).toEqual([]);
  });
});
