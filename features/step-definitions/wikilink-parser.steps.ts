import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { parseWikilinks } from '../../constants';
import type { WikiSegment } from '../../constants';

let inputText: string;
let segments: WikiSegment[];

Given('文字內容為 {string}', function (text: string) {
    inputText = text;
});

When('進行 Wikilink 解析', function () {
    segments = parseWikilinks(inputText);
});

Then('解析結果共有 {int} 段', function (count: number) {
    assert.strictEqual(segments.length, count);
});

Then('第 {int} 段是連結', function (n: number) {
    assert.ok(segments[n - 1].isLink, `第 ${n} 段應為連結，但 isLink = false`);
});

Then('第 {int} 段不是連結', function (n: number) {
    assert.ok(!segments[n - 1].isLink, `第 ${n} 段不應為連結，但 isLink = true`);
});

Then('第 {int} 段的筆記名稱為 {string}', function (n: number, name: string) {
    assert.strictEqual(segments[n - 1].noteName, name);
});

Then('第 {int} 段的顯示文字為 {string}', function (n: number, text: string) {
    assert.strictEqual(segments[n - 1].text, text);
});
