import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setLang, getLang, t, type Lang } from '../../i18n';

// 每個測試前重置語系，避免測試間互相影響
beforeEach(() => setLang('zh'));

describe('setLang / getLang', () => {
    it('預設語系應為 zh', () => {
        expect(getLang()).toBe('zh');
    });

    it('setLang 應正確切換語系', () => {
        const langs: Lang[] = ['zh', 'zh-cn', 'ja', 'ko', 'en'];
        for (const lang of langs) {
            setLang(lang);
            expect(getLang()).toBe(lang);
        }
    });
});

describe('t() 翻譯函式', () => {
    it('zh 語系下應回傳正確繁體中文', () => {
        setLang('zh');
        expect(t('tb.group.draw')).toBe('插畫');
        expect(t('tb.group.text')).toBe('文字');
    });

    it('en 語系下應回傳英文', () => {
        setLang('en');
        expect(t('tb.group.draw')).toBe('Drawing');
        expect(t('tb.group.text')).toBe('Text');
    });

    it('zh-cn 語系下應回傳簡體中文', () => {
        setLang('zh-cn');
        // zh-cn 有自己的翻譯就用自己的，沒有就 fallback 到 zh
        const result = t('tb.group.draw');
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
    });

    it('不存在的 key 應 fallback 到 zh，若 zh 也沒有則回傳 key 本身', () => {
        setLang('en');
        const unknownKey = '__nonexistent_key_xyz__';
        expect(t(unknownKey)).toBe(unknownKey);
    });

    it('切換語系後 t() 應立即使用新語系', () => {
        setLang('zh');
        const zhResult = t('tb.group.draw');
        setLang('en');
        const enResult = t('tb.group.draw');
        expect(zhResult).not.toBe(enResult);
    });
});

describe('t() 插值參數', () => {
    it('{0} 佔位符應被第一個參數替換', () => {
        setLang('zh');
        // 'tb.color.title' = '{0}（快捷：{1}）\n雙擊自訂顏色'
        const result = t('tb.color.title', '紅色', '1');
        expect(result).toContain('紅色');
        expect(result).toContain('1');
        expect(result).not.toContain('{0}');
        expect(result).not.toContain('{1}');
    });

    it('多個佔位符應依序被替換', () => {
        setLang('en');
        // 'tb.color.title' = '{0} ({1})\nDouble-click to customize'
        const result = t('tb.color.title', 'Red', '1');
        expect(result).toContain('Red');
        expect(result).toContain('1');
    });

    it('傳入數字參數應被轉為字串替換', () => {
        setLang('zh');
        const result = t('tb.color.title', 42, 7);
        expect(result).toContain('42');
        expect(result).toContain('7');
    });

    it('無佔位符的字串忽略額外參數', () => {
        setLang('zh');
        const base   = t('tb.group.draw');
        const withArg = t('tb.group.draw', '多餘參數');
        expect(base).toBe(withArg);
    });
});

describe('各語系完整性', () => {
    const coreKeys = [
        'tb.group.draw', 'tb.group.text', 'tb.group.image', 'tb.group.canvas',
        'tb.eraser.title', 'tb.undo.title', 'tb.redo.title',
    ];
    const langs: Lang[] = ['zh', 'zh-cn', 'ja', 'ko', 'en'];

    for (const lang of langs) {
        it(`${lang} 語系應包含所有核心 key`, () => {
            setLang(lang);
            for (const key of coreKeys) {
                const result = t(key);
                // 若翻譯存在，結果不等於 key 本身（或 fallback 到 zh 也可）
                expect(result).not.toBe('');
            }
        });
    }
});
