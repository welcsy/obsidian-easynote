import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { brushSizeToStep } from '../../constants';

let currentStep: number;

Given('標準筆刷共有 7 個階段', function () {
    // 說明性步驟：實際值由 constants.ts 中的 BRUSH_STEPS = [2,6,12,20,30,44,60] 決定
});

When('我設定筆刷大小為 {int} px', function (px: number) {
    currentStep = brushSizeToStep(px);
});

Then('筆刷階數應為 {int}', function (expected: number) {
    assert.strictEqual(currentStep, expected);
});

Then('筆刷階數應介於 {int} 到 {int} 之間', function (min: number, max: number) {
    assert.ok(
        currentStep >= min && currentStep <= max,
        `期望筆刷階數介於 ${min}–${max}，實際為 ${currentStep}`,
    );
});
