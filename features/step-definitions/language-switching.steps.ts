import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { setLang, t } from '../../i18n';
import type { Lang } from '../../i18n';

let lastTranslation: string;

// ─── Given ────────────────────────────────────────────────────────────────────

Given('目前語系為 {string}', function (lang: string) {
    setLang(lang as Lang);
});

// ─── When ─────────────────────────────────────────────────────────────────────

When('我將語系切換為 {string}', function (lang: string) {
    setLang(lang as Lang);
});

When('我查詢翻譯 {string}', function (key: string) {
    lastTranslation = t(key);
});

When('我以參數 {string} 和 {string} 查詢翻譯 {string}', function (arg0: string, arg1: string, key: string) {
    lastTranslation = t(key, arg0, arg1);
});

// ─── Then ─────────────────────────────────────────────────────────────────────

Then('工具列繪圖群組名稱應為 {string}', function (expected: string) {
    assert.strictEqual(t('tb.group.draw'), expected);
});

Then('翻譯 {string} 的結果應為非空字串', function (key: string) {
    const result = t(key);
    assert.ok(result.length > 0, `翻譯 key "${key}" 不應為空字串`);
});

Then('翻譯結果應等於 {string}', function (expected: string) {
    assert.strictEqual(lastTranslation, expected);
});

Then('翻譯結果應包含 {string}', function (text: string) {
    assert.ok(
        lastTranslation.includes(text),
        `翻譯結果 "${lastTranslation}" 應包含 "${text}"`,
    );
});

Then('翻譯結果不應包含 {string}', function (text: string) {
    assert.ok(
        !lastTranslation.includes(text),
        `翻譯結果 "${lastTranslation}" 不應包含 "${text}"`,
    );
});
