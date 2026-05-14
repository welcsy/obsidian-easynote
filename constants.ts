// ─── 常數（對應 EasyNote GDScript 的 COLORS / COLOR_NAMES）──────────────────
export const VIEW_TYPE        = 'easynote';
export const TOOLBAR_HEIGHT   = 52;
export const MIN_BRUSH_SIZE   = 1;
export const MAX_BRUSH_SIZE   = 60;
export const HANDLE_SIZE      = 8;   // 選取控點大小（px）

/** 測試模式：true 時顯示除錯用 UI（匯出圖層資訊等） */
export const DEV_MODE = false;

// ─── Google OAuth2 憑證（build 時由 esbuild define 注入，不在原始碼中明文）───
// 實際值來自 .env 檔案（已加入 .gitignore），CI 可設同名環境變數
declare const __GOOGLE_CLIENT_ID__:     string;
declare const __GOOGLE_CLIENT_SECRET__: string;
export const GOOGLE_CLIENT_ID     = __GOOGLE_CLIENT_ID__;
export const GOOGLE_CLIENT_SECRET = __GOOGLE_CLIENT_SECRET__;
// OAuth loopback 固定埠號；對應 Google Cloud Console 登記的 Redirect URI
export const GOOGLE_OAUTH_PORT    = 42813;
export const GOOGLE_REDIRECT_URI  = `http://localhost:${GOOGLE_OAUTH_PORT}`;

// 7 階筆刷大小（第 2 階 = 6px 為預設）
export const BRUSH_STEPS: number[] = [2, 6, 12, 20, 30, 44, 60];

/** 將筆刷 px 轉成最近的 1–7 階 */
export function brushSizeToStep(size: number): number {
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < BRUSH_STEPS.length; i++) {
        const d = Math.abs(BRUSH_STEPS[i] - size);
        if (d < bestDiff) { bestDiff = d; best = i; }
    }
    return best + 1;  // 1-based
}

// ─── Wikilink 解析 ────────────────────────────────────────────────────────────
export interface WikiSegment { text: string; isLink: boolean; noteName?: string; }

/** 將一行文字拆成普通文字段 + [[wikilink]] 段 */
export function parseWikilinks(line: string): WikiSegment[] {
    const segs: WikiSegment[] = [];
    const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
    let last = 0, m: RegExpExecArray | null;
    while ((m = regex.exec(line)) !== null) {
        if (m.index > last) segs.push({ text: line.slice(last, m.index), isLink: false });
        const noteName = m[1].trim();
        const display  = m[2]?.trim() ?? noteName;
        segs.push({ text: display, isLink: true, noteName });
        last = m.index + m[0].length;
    }
    if (last < line.length) segs.push({ text: line.slice(last), isLink: false });
    return segs;
}

export const COLORS: string[] = [
    '#0d0d0d',
    '#F13F5E',
    '#009BFF',
    '#00A75E',
    '#C89200',
];
export const COLOR_NAMES: string[] = ['黑色', '紅色', '藍色', '綠色', '橘色'];

