import { COLORS } from './constants';

// ─── 設定 ──────────────────────────────────────────────────────────────────────
export interface EasyNoteSettings {
    defaultColorIdx:  number;
    defaultBrushSize: number;
    saveFolder:       string;
    defaultColors:    string[];
    brushMode:        'pixel' | 'stroke-layer'; // 單點模式（pixel）| 圖片模式（stroke-layer）
    brushSizeMode:   'steps' | 'continuous';   // 7階 | 連續（兩種筆刷模式共用）
    startupMode:      'previous' | 'new';
    defaultCanvasWidth:  number;
    defaultCanvasHeight: number;
    paintScale:          number; // 1.0=全解析度 0.5=半解析度（效能模式）
    timezone:            string; // IANA 時區，例如 'Asia/Taipei'
    autoSyncEnabled:          boolean; // 定時 auto-reload 開關
    autoSyncPeriodMs:         number;  // 定時 auto-reload 間隔（毫秒）
    autoPeriodicSaveEnabled:  boolean; // 定時 auto-save 開關
    autoPeriodicSavePeriodMs: number;  // 定時 auto-save 間隔（毫秒）
    // Google Drive 同步
    googleDriveEnabled:    boolean;
    googleRefreshToken:    string;
    googleAccessToken:     string;
    googleTokenExpiry:     number;
    googleDriveFolderId:   string;
    // 介面語言
    language?: 'zh' | 'en';
}
export const DEFAULT_SETTINGS: EasyNoteSettings = {
    defaultColorIdx:  0,
    defaultBrushSize: 6,
    saveFolder:       'EasyNote',
    defaultColors:    [...COLORS],
    brushMode:        'stroke-layer',
    brushSizeMode:   'steps',
    startupMode:      'new',
    defaultCanvasWidth:  1920,
    defaultCanvasHeight: 1080,
    paintScale:          1.0,
    timezone:            'Asia/Taipei',
    autoSyncEnabled:          false,
    autoSyncPeriodMs:         5000,
    autoPeriodicSaveEnabled:  false,
    autoPeriodicSavePeriodMs: 60000,
    googleDriveEnabled:    false,
    googleRefreshToken:    '',
    googleAccessToken:     '',
    googleTokenExpiry:     0,
    googleDriveFolderId:   '',
    language:              'zh',
};

// ─── .enote 專案格式 ──────────────────────────────────────────────────────────
export interface ENoteImageLayer    { src: string; x: number; y: number; w: number; h: number; rotation?: number; strokeName?: string; }
export interface ENoteTextLayer     { text: string; x: number; y: number; fontSize: number; color: string; linkedNotePath?: string; rotation?: number; }
export interface ENoteMarkdownLayer { text: string; x: number; y: number; fontSize: number; color: string; width: number; linkedNotePath?: string; rotation?: number; }
export interface ENote {
    version:        number;
    canvasWidth:    number;
    canvasHeight:   number;
    paintLayer:     string;            // data:image/png;base64,...
    imageLayers:    ENoteImageLayer[];
    markdownLayers: ENoteMarkdownLayer[];
    textLayers:     ENoteTextLayer[];
}

export interface ImageLayer {
    img: HTMLImageElement;
    x: number;
    y: number;
    w: number;
    h: number;
    rotation?: number;
    strokeName?: string;  // 設定時若為 stroke-layer 模式，每一筆自動命名
}

export type HandleType = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'rotate';

export interface DragState {
    handle:        HandleType;
    startMX:       number;
    startMY:       number;
    startX:        number;
    startY:        number;
    startW:        number;
    startH:        number;
    startRotation?: number;  // 旋轉用
    centerX?:       number;
    centerY?:       number;
    startAngle?:    number;
}

export interface TextLayer {
    text:            string;
    x:               number;
    y:               number;
    fontSize:        number;
    color:           string;
    linkedNotePath?: string;  // 連結到 Vault .md 筆記的路徑（開啟時自動更新內容）
    rotation?:       number;
}

export interface TextDragState {
    handle:         HandleType;
    startMX:        number;
    startMY:        number;
    startX:         number;
    startY:         number;
    startFontSize:  number;
    startW:         number;
    startH:         number;
    startRotation?: number;
    centerX?:       number;
    centerY?:       number;
    startAngle?:    number;
}

/** 一小塊被「擷起」的繪畫內容，可經導動、縮放後再合并回繪畫層 */
export interface PaintFragment {
    offscreen: HTMLCanvasElement;  // 提取的原始畫素
    x:  number;                    // 目前畫布上 X
    y:  number;
    w:  number;                    // 目前寬度（可被縮放）
    h:  number;
    rotation?: number;
}

/** 行內 Markdown 片段（用於 MarkdownLayer 渲染） */
export interface InlineSeg {
    text:     string;
    bold?:    boolean;
    italic?:  boolean;
    code?:    boolean;
    link?:    boolean;
    url?:     string;    // set for [text](url) markdown links
    noteName?: string;   // set for [[wikilink]] segments
}

/** MarkdownLayer：以 Markdown 語法渲染的內容圖層 */
export interface MarkdownLayer {
    text:            string;
    x:               number;
    y:               number;
    fontSize:        number;
    color:           string;
    width:           number;           // 最大內容寬度（自動換行）
    linkedNotePath?: string;           // 連結 Vault .md 路徑
    rotation?:       number;
    _cachedH?:       number;           // 執行期快取高度，不序列化
}

export interface MdDragState {
    handle:         HandleType;
    startMX:        number;
    startMY:        number;
    startX:         number;
    startY:         number;
    startFontSize:  number;
    startWidth:     number;
    startH:         number;
    startRotation?: number;
    centerX?:       number;
    centerY?:       number;
    startAngle?:    number;
}

/** 畫布歷史快照（用於 Undo/Redo） */
export interface HistoryEntry {
    label:          string;
    paintData:      ImageData;
    imageLayers:    { img: HTMLImageElement; x: number; y: number; w: number; h: number; rotation?: number }[];
    markdownLayers: { text: string; x: number; y: number; fontSize: number; color: string; width: number; linkedNotePath?: string; rotation?: number }[];
    textLayers:     { text: string; x: number; y: number; fontSize: number; color: string; linkedNotePath?: string; rotation?: number }[];
    canvasW:        number;
    canvasH:        number;
}
