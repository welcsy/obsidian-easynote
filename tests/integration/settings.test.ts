/**
 * 整合測試：模擬 Plugin 的設定讀寫流程
 *
 * 這類測試使用 Obsidian API mock，測試的是「多個模組協作」的邏輯，
 * 而非只測單一純函式。測試對象是插件的資料層邏輯（不涉及 UI/Canvas）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS, type EasyNoteSettings } from '../../types';
import { setLang, t }                              from '../../i18n';
import { normalizePath }                           from 'obsidian';

// ─── DEFAULT_SETTINGS 結構完整性 ──────────────────────────────────────────────
describe('DEFAULT_SETTINGS 完整性', () => {
    it('所有必要欄位都應存在且有合理預設值', () => {
        const s = DEFAULT_SETTINGS;

        expect(s.saveFolder).toBeTruthy();
        expect(s.defaultBrushSize).toBeGreaterThan(0);
        expect(s.defaultColorIdx).toBeGreaterThanOrEqual(0);
        expect(s.defaultColors).toBeInstanceOf(Array);
        expect(s.defaultColors.length).toBeGreaterThan(0);
        expect(['pixel', 'stroke-layer']).toContain(s.brushMode);
        expect(['steps', 'continuous']).toContain(s.brushSizeMode);
        expect(['previous', 'new']).toContain(s.startupMode);
    });

    it('canvasWidth/Height 應為合理的正整數', () => {
        expect(s.defaultCanvasWidth).toBeGreaterThan(0);
        expect(s.defaultCanvasHeight).toBeGreaterThan(0);
        expect(Number.isInteger(s.defaultCanvasWidth)).toBe(true);
        expect(Number.isInteger(s.defaultCanvasHeight)).toBe(true);
    });

    it('paintScale 應在 0 < x <= 1 範圍內', () => {
        expect(s.paintScale).toBeGreaterThan(0);
        expect(s.paintScale).toBeLessThanOrEqual(1);
    });

    it('googleDrive 預設應為關閉且 token 為空', () => {
        expect(s.googleDriveEnabled).toBe(false);
        expect(s.googleRefreshToken).toBe('');
        expect(s.googleAccessToken).toBe('');
        expect(s.googleTokenExpiry).toBe(0);
    });

    it('toolbarShortcuts 預設應為 8 個', () => {
        expect(s.toolbarShortcuts).toHaveLength(8);
    });

    it('toolbarLayout 預設應為 full', () => {
        expect(s.toolbarLayout).toBe('full');
    });
});

const s = DEFAULT_SETTINGS;

// ─── 設定合併邏輯（模擬 loadData + Object.assign 流程） ─────────────────────
describe('設定合併邏輯', () => {
    function mergeSettings(saved: Partial<EasyNoteSettings>): EasyNoteSettings {
        return Object.assign({}, DEFAULT_SETTINGS, saved);
    }

    it('空的 saved 資料應完全使用預設值', () => {
        const merged = mergeSettings({});
        expect(merged).toEqual(DEFAULT_SETTINGS);
    });

    it('部分覆蓋應保留未指定欄位的預設值', () => {
        const merged = mergeSettings({ saveFolder: 'MyDrawings', defaultBrushSize: 10 });
        expect(merged.saveFolder).toBe('MyDrawings');
        expect(merged.defaultBrushSize).toBe(10);
        // 其餘保持預設
        expect(merged.brushMode).toBe(DEFAULT_SETTINGS.brushMode);
        expect(merged.paintScale).toBe(DEFAULT_SETTINGS.paintScale);
    });

    it('語系設定覆蓋後應正確切換 i18n', () => {
        const merged = mergeSettings({ language: 'en' });
        setLang(merged.language!);
        expect(t('tb.group.draw')).toBe('Drawing');

        // 還原
        setLang('zh');
    });
});

// ─── normalizePath（Obsidian mock 驗證） ──────────────────────────────────────
describe('normalizePath（Obsidian mock）', () => {
    it('應將反斜線轉為正斜線', () => {
        expect(normalizePath('EasyNote\\project.enote')).toBe('EasyNote/project.enote');
    });

    it('應合併多重斜線', () => {
        expect(normalizePath('a//b///c')).toBe('a/b/c');
    });

    it('純正斜線路徑應保持不變', () => {
        expect(normalizePath('folder/sub/file.enote')).toBe('folder/sub/file.enote');
    });
});

// ─── VectorStroke 資料結構驗證 ────────────────────────────────────────────────
import type { VectorStroke } from '../../types';

describe('VectorStroke 資料結構', () => {
    it('合法的筆刷筆觸應通過結構檢查', () => {
        const stroke: VectorStroke = {
            t: 's',
            c: '#ff0000',
            o: 1.0,
            z: 6,
            p: [[0, 0], [10, 10], [20, 5]],
            b: [0, 0, 20, 10],
        };
        expect(stroke.t).toBe('s');
        expect(stroke.b).toHaveLength(4);
        expect(stroke.p!.every(pt => pt.length === 2)).toBe(true);
    });

    it('橡皮擦矩形筆觸應有正確 t 欄位', () => {
        const eraser: VectorStroke = {
            t: 'r',
            r: [10, 10, 50, 50],
            b: [10, 10, 60, 60],
        };
        expect(eraser.t).toBe('r');
        expect(eraser.r).toHaveLength(4);
    });

    it('邊界框 b 的格式應為 [x1, y1, x2, y2]，且 x2>x1, y2>y1', () => {
        const stroke: VectorStroke = {
            t: 's',
            b: [5, 10, 100, 200],
        };
        const [x1, y1, x2, y2] = stroke.b;
        expect(x2).toBeGreaterThanOrEqual(x1);
        expect(y2).toBeGreaterThanOrEqual(y1);
    });
});
