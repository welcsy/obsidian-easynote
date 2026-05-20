/**
 * globals.ts — 必須最先被 require，且本檔案不可有任何 import 語句。
 *
 * 原因：TypeScript 的 import 在編譯為 CJS 後會被提升到檔案頂端（hoisted）。
 * 若此處有 import，constants.ts 會在全域常數設定前就被載入，
 * 導致 ReferenceError: __GOOGLE_CLIENT_ID__ is not defined。
 *
 * esbuild 在 build 時透過 define 注入這兩個常數；
 * cucumber 執行時需在這裡手動提供空字串。
 */
(globalThis as any).__GOOGLE_CLIENT_ID__ = '';
(globalThis as any).__GOOGLE_CLIENT_SECRET__ = '';
