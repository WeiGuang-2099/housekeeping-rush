/**
 * 源码静态检查共用的小工具：去掉注释、找出导入的模块名和导入子句、认出动态导入、取文件名。
 * tests/engine-purity.test.ts（引擎和策略）和 tests/ui-boundary.test.ts（界面和语言包）都用，
 * 自检在 tests/engine-purity.test.ts 的"检测函数自检"里。
 */

// 去掉注释：块注释（斜杠星号开头）和行注释（两个斜杠开头）。
// 用一个正则从左到右扫一遍，哪种注释先出现就按哪种算：行注释里的斜杠星号不会被当成块注释的开头，
// 一直吞到后面的代码；块注释里的两个斜杠随整段块注释一起去掉。块注释换成一个空格，免得前后的代码粘在一起。
// 除法（a / b）不是注释，不受影响。
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => (comment.startsWith('/*') ? ' ' : ''));
}

/** 动态导入或 require 的参数不是一个完整的字符串字面量时记下的占位名，不在任何白名单里。 */
export const DYNAMIC_IMPORT = '(动态导入)';

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
export function importedModules(source: string): string[] {
  const code = stripComments(source);
  return [...code.matchAll(IMPORT_PATTERN)].map(
    ({ groups }) =>
      groups?.from ?? groups?.bare ?? groups?.quoted ?? groups?.template ?? groups?.required ?? DYNAMIC_IMPORT,
  );
}

/**
 * 静态的 import 和 export ... from（含 import type、export type）里，关键字和 from 之间的导入子句，
 * 例如 ' { legalActionsForView, type View } '、' * as engine '、' type { Policy } '、' * '。子句可以跨行，
 * 但不跨分号、引号、反引号和括号，所以不会从 export const 一路吞到后面某条导入的 from。
 */
const IMPORT_CLAUSE = /\b(?:import|export)\b(?<clause>[^;'"`()]*?)\bfrom\s*['"]/g;

/** 去掉注释以后，源码里每条静态导入、转出的导入子句，按出现的顺序。 */
export function importClauses(source: string): string[] {
  return [...stripComments(source).matchAll(IMPORT_CLAUSE)].map(({ groups }) => groups?.clause ?? '');
}

/** 动态导入：import(...)，以及 Vite 的 import.meta.glob。import 和括号、点之间夹着空白、换行或注释也算。 */
export const DYNAMIC_PATTERN = /\bimport\s*\(|\bimport\s*\.\s*meta\s*\.\s*glob\b/;

/** 路径里最后一个斜杠后面的文件名。 */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
