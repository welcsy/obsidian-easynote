import { describe, it, expect } from 'vitest';
import {
    brushSizeToStep,
    parseWikilinks,
    BRUSH_STEPS,
    MIN_BRUSH_SIZE,
    MAX_BRUSH_SIZE,
    TOOLBAR_HEIGHT,
    VIEW_TYPE,
} from '../../constants';

// ─── brushSizeToStep ──────────────────────────────────────────────────────────
describe('brushSizeToStep', () => {
    it('完全符合的階數應直接對應（BRUSH_STEPS = [2,6,12,20,30,44,60]）', () => {
        expect(brushSizeToStep(2)).toBe(1);
        expect(brushSizeToStep(6)).toBe(2);
        expect(brushSizeToStep(12)).toBe(3);
        expect(brushSizeToStep(20)).toBe(4);
        expect(brushSizeToStep(30)).toBe(5);
        expect(brushSizeToStep(44)).toBe(6);
        expect(brushSizeToStep(60)).toBe(7);
    });

    it('不完全符合時應取最近的階數', () => {
        expect(brushSizeToStep(1)).toBe(1);   // 最近 2（差1）
        expect(brushSizeToStep(4)).toBe(1);   // 距離 2（差2）與 6（差2）相等，取先掃到的 step 1
        expect(brushSizeToStep(9)).toBe(2);   // 最近 6（差3）與 12（差3）相等，取先掃到的 step 2
        expect(brushSizeToStep(15)).toBe(3);  // 最近 12（差3）vs 20（差5）
        expect(brushSizeToStep(55)).toBe(7);  // 最近 60（差5）vs 44（差11）
    });

    it('極端值不應超出 1–7 範圍', () => {
        const s0   = brushSizeToStep(0);
        const s100 = brushSizeToStep(100);
        expect(s0).toBeGreaterThanOrEqual(1);
        expect(s0).toBeLessThanOrEqual(7);
        expect(s100).toBeGreaterThanOrEqual(1);
        expect(s100).toBeLessThanOrEqual(7);
    });

    it('回傳值必須是 1-based（>=1）', () => {
        for (const size of BRUSH_STEPS) {
            expect(brushSizeToStep(size)).toBeGreaterThanOrEqual(1);
        }
    });
});

// ─── parseWikilinks ───────────────────────────────────────────────────────────
describe('parseWikilinks', () => {
    it('純文字行應只回傳一個 isLink=false 段', () => {
        const segs = parseWikilinks('hello world');
        expect(segs).toHaveLength(1);
        expect(segs[0]).toMatchObject({ text: 'hello world', isLink: false });
    });

    it('只有 [[link]] 時應回傳一個 isLink=true 段', () => {
        const segs = parseWikilinks('[[MyNote]]');
        expect(segs).toHaveLength(1);
        expect(segs[0]).toMatchObject({ text: 'MyNote', isLink: true, noteName: 'MyNote' });
    });

    it('[[link|alias]] 應使用 alias 作為顯示文字，noteName 為原始連結', () => {
        const segs = parseWikilinks('[[ProjectNote|顯示名稱]]');
        expect(segs).toHaveLength(1);
        expect(segs[0]).toMatchObject({ text: '顯示名稱', isLink: true, noteName: 'ProjectNote' });
    });

    it('前後夾純文字的 wikilink 應產生三段', () => {
        const segs = parseWikilinks('前面 [[Note1]] 後面');
        expect(segs).toHaveLength(3);
        expect(segs[0]).toMatchObject({ text: '前面 ', isLink: false });
        expect(segs[1]).toMatchObject({ text: 'Note1', isLink: true });
        expect(segs[2]).toMatchObject({ text: ' 後面', isLink: false });
    });

    it('多個連續 wikilink 應各自產生獨立段', () => {
        const segs = parseWikilinks('[[A]][[B]]');
        expect(segs).toHaveLength(2);
        expect(segs[0].noteName).toBe('A');
        expect(segs[1].noteName).toBe('B');
    });

    it('空字串應回傳空陣列', () => {
        expect(parseWikilinks('')).toHaveLength(0);
    });

    it('連結名稱前後空白應被 trim', () => {
        const segs = parseWikilinks('[[ SpacedNote ]]');
        expect(segs[0].noteName).toBe('SpacedNote');
    });

    it('不完整的括號不應被解析為 wikilink', () => {
        const segs = parseWikilinks('[NotALink]');
        expect(segs).toHaveLength(1);
        expect(segs[0].isLink).toBe(false);
    });
});

// ─── 常數合理性驗證 ────────────────────────────────────────────────────────────
describe('常數值', () => {
    it('VIEW_TYPE 應為非空字串', () => {
        expect(typeof VIEW_TYPE).toBe('string');
        expect(VIEW_TYPE.length).toBeGreaterThan(0);
    });

    it('TOOLBAR_HEIGHT 應為正整數', () => {
        expect(TOOLBAR_HEIGHT).toBeGreaterThan(0);
        expect(Number.isInteger(TOOLBAR_HEIGHT)).toBe(true);
    });

    it('MIN_BRUSH_SIZE < MAX_BRUSH_SIZE', () => {
        expect(MIN_BRUSH_SIZE).toBeLessThan(MAX_BRUSH_SIZE);
    });

    it('BRUSH_STEPS 應為 7 個遞增的正整數', () => {
        expect(BRUSH_STEPS).toHaveLength(7);
        for (let i = 1; i < BRUSH_STEPS.length; i++) {
            expect(BRUSH_STEPS[i]).toBeGreaterThan(BRUSH_STEPS[i - 1]);
        }
    });

    it('BRUSH_STEPS 的最小值 >= MIN_BRUSH_SIZE，最大值 <= MAX_BRUSH_SIZE', () => {
        expect(Math.min(...BRUSH_STEPS)).toBeGreaterThanOrEqual(MIN_BRUSH_SIZE);
        expect(Math.max(...BRUSH_STEPS)).toBeLessThanOrEqual(MAX_BRUSH_SIZE);
    });
});
