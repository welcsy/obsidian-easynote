import { type Lang } from '../i18n';
import { zhFontConfig } from './zh';
import { enFontConfig } from './en';

/** 語系對應的字型配置 */
export interface FontConfig {
    /** 正文字型堆疊（含 CJK fallback） */
    body: string;
    /** 程式碼字型堆疊（等寬） */
    code: string;
}

const FONT_MAP: Record<Lang, FontConfig> = {
    zh:      zhFontConfig,
    'zh-cn': zhFontConfig,
    ja:      zhFontConfig,
    ko:      zhFontConfig,
    en:      enFontConfig,
};

/** 取得指定語系的字型配置 */
export function getFontConfig(lang: Lang): FontConfig {
    return FONT_MAP[lang] ?? zhFontConfig;
}

/**
 * 建立 canvas font 字串，供 ctx.font 直接使用。
 * @param size    字型大小（px）
 * @param lang    目前語系（由 getLang() 取得）
 * @param bold    是否粗體
 * @param italic  是否斜體
 */
export function canvasFont(size: number, lang: Lang, bold = false, italic = false): string {
    const prefix = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}`;
    return `${prefix}${size}px ${getFontConfig(lang).body}`;
}

/**
 * 建立等寬字型的 canvas font 字串（用於 code block）。
 * @param size  字型大小（px）
 * @param lang  目前語系
 */
export function codeFont(size: number, lang: Lang): string {
    return `${size}px ${getFontConfig(lang).code}`;
}
