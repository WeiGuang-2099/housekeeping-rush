/**
 * 引擎源码的静态检查，守住 CLAUDE.md 的两条硬约束：
 * 引擎里没有随机数，也不读系统时间（随机性只在 generate 里，用带种子的 rng.ts）；
 * 引擎不依赖界面，不导入 React，不用浏览器 API，能在 Node 里直接跑。
 *
 * 为什么要读源码：tsconfig 的 lib 含 DOM，类型检查拦不住引擎代码用 window、document；
 * 性质测试只把 Math.random 和 Date.now 换成会抛错的桩，拦不住 performance.now、new Date、crypto。
 * 这里把 src/engine 下的源码当文本读进来，去掉注释以后按单词查这些名字。
 * 字符串字面量不做特别处理：引擎源码里没有含这些名字或注释符号的字符串。
 */

import { describe, expect, it } from 'vitest';

/** src/engine 下全部源码的文本，键是相对这个文件的路径，例如 '../src/engine/rules.ts'。 */
const SOURCES = import.meta.glob<string>('../src/engine/*.ts', { query: '?raw', import: 'default', eager: true });

/**
 * 引擎代码里不能出现的名字：随机数、系统时间、浏览器 API。按整个单词匹配，
 * 名字只是更长的标识符的一部分时不算（例如 windows、updateDates）。
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

// 去掉注释：块注释（斜杠星号开头）和行注释（两个斜杠开头）。
// 用一个正则从左到右扫一遍，哪种注释先出现就按哪种算：行注释里的斜杠星号不会被当成块注释的开头，
// 一直吞到后面的代码；块注释里的两个斜杠随整段块注释一起去掉。块注释换成一个空格，免得前后的代码粘在一起。
// 除法（a / b）不是注释，不受影响。
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => (comment.startsWith('/*') ? ' ' : ''));
}

/** 去掉注释以后出现的禁用名字；导入了 react 或 react-dom 时再加一项 'react'。 */
function forbiddenIn(source: string): string[] {
  const code = stripComments(source);
  const hits = FORBIDDEN_NAMES.filter((name) => new RegExp(`\\b${name.replace('.', '\\.')}\\b`).test(code));
  if (REACT_MODULE.test(code)) hits.push('react');
  return hits;
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
  it('读到了引擎的源码，至少有 rules.ts、generate.ts、rng.ts、types.ts', () => {
    // 一个文件都没读到时，下面逐个文件的检查会空过，所以先确认读到了。
    expect(Object.keys(SOURCES).map(fileName)).toEqual(
      expect.arrayContaining(['rules.ts', 'generate.ts', 'rng.ts', 'types.ts']),
    );
    for (const [path, source] of Object.entries(SOURCES)) expect(source.length, path).toBeGreaterThan(0);
  });

  it.each(Object.entries(SOURCES))('%s：去掉注释以后不出现禁用的名字，也不导入 react', (_path, source) => {
    expect(forbiddenIn(source)).toEqual([]);
  });

  it('rng.ts 是带种子的随机数，自己算伪随机数，不用 Math.random', () => {
    expect(forbiddenIn(sourceOf('rng.ts'))).toEqual([]);
  });

  it('去掉注释以后代码还在：rules.ts 的四个对外函数都还在', () => {
    const code = stripComments(sourceOf('rules.ts'));
    for (const name of ['initial', 'legalActions', 'apply', 'cleanMinutes']) {
      expect(code, name).toMatch(new RegExp(`export function ${name}\\(`));
    }
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

  it('每个禁用的名字在代码里都会被抓到；只是更长的标识符的一部分时不算', () => {
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
    expect(forbiddenIn('const windows = updateDates(documentation, prefetch, MathRandom);')).toEqual([]);
  });

  it('导入 react 或 react-dom 会被抓到，导入别的模块不算', () => {
    expect(forbiddenIn("import { useState } from 'react';")).toEqual(['react']);
    expect(forbiddenIn('import { createRoot } from "react-dom/client";')).toEqual(['react']);
    expect(forbiddenIn("import { walkPath } from './layout';")).toEqual([]);
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
