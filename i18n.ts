// ─── i18n ─────────────────────────────────────────────────────────────────────
// 各語系翻譯獨立放在 locales/ 資料夾。修改語系文字請編輯對應的語系檔案。
// esbuild 打包時會自動合併進 main.js，插件發布仍只有 3 個檔案。

import { translations as zh }   from './locales/zh';
import { translations as zhCn } from './locales/zh-cn';
import { translations as ja }   from './locales/ja';
import { translations as ko }   from './locales/ko';
import { translations as en }   from './locales/en';

export type Lang = 'zh' | 'zh-cn' | 'ja' | 'ko' | 'en';

const LOCALES: Record<Lang, Record<string, string>> = {
    'zh':    zh,
    'zh-cn': zhCn,
    'ja':    ja,
    'ko':    ko,
    'en':    en,
};

let _currentLang: Lang = 'zh';
export function setLang(l: Lang): void { _currentLang = l; }
export function getLang(): Lang        { return _currentLang; }

export function t(key: string, ...args: (string | number)[]): string {
    let s = LOCALES[_currentLang]?.[key] ?? LOCALES['zh']?.[key] ?? key;
    args.forEach((a, i) => { s = s.replace(`{${i}}`, String(a)); });
    return s;
}