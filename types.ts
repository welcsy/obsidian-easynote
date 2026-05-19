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
    language?: 'zh' | 'zh-cn' | 'ja' | 'ko' | 'en';
    // 工具列縮放比例（1.0 = 不縮放）
    toolbarZoom?: number;
    // 工具列排列模式
    toolbarLayout?: 'full' | 'compact';
    // 精簡模式快捷列（最多 8 個捷徑 ID 或 'none'）
    toolbarShortcuts?: string[];
}
export const DEFAULT_SETTINGS: EasyNoteSettings = {
    defaultColorIdx:  0,
    defaultBrushSize: 2,
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
    toolbarZoom:           1.0,
    toolbarLayout:         'full',
    toolbarShortcuts:      ['eraser', 'colors', 'undo', 'redo', 'pan', 'saveProject', 'export', 'none'],
};

// ─── 向量筆觸 ─────────────────────────────────────────────────────────────────
/**
 * 向量筆觸資料。字段名稱縮短以減小 JSON 大小。
 * t='s' → 筆刷筆觸；t='r' → 橡皮擦矩形
 */
export interface VectorStroke {
    /** type: 's'=筆刷 'r'=橡皮擦矩形 */
    t: 's' | 'r';
    /** 顏色（t='s'，非橡皮擦時） */
    c?: string;
    /** 不透明度 0~1 */
    o?: number;
    /** 筆刷大小 px */
    z?: number;
    /** true = 橡皮擦筆觸 */
    e?: boolean;
    /** 點陣列 [[x0,y0],[x1,y1],...] */
    p?: [number, number][];
    /** 橡皮擦矩形 [x, y, w, h]（t='r' 時使用） */
    r?: [number, number, number, number];
    /** 邊界框 [x1, y1, x2, y2]（世界座標） */
    b: [number, number, number, number];
}

// ─── .enote 專案格式 ──────────────────────────────────────────────────────────
export interface ENoteImageLayer    { src: string; x: number; y: number; w: number; h: number; rotation?: number; strokeName?: string; }
export interface ENoteTextLayer     { text: string; x: number; y: number; fontSize: number; color: string; linkedNotePath?: string; rotation?: number; }
export interface ENoteMarkdownLayer { text: string; x: number; y: number; fontSize: number; color: string; width: number; linkedNotePath?: string; rotation?: number; }
export interface ENote {
    version:         number;
    canvasWidth:     number;
    canvasHeight:    number;
    /** v2+：向量筆觸陣列（取代 paintLayer） */
    strokePaths?:    VectorStroke[];
    /** v1 舊格式：data:image/png;base64 (向後兼容，載入時轉為圖片圖層) */
    paintLayer?:     string;
    imageLayers:     ENoteImageLayer[];
    markdownLayers:  ENoteMarkdownLayer[];
    textLayers:      ENoteTextLayer[];
}

export interface ImageLayer {
    img: HTMLImageElement | ImageBitmap;
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
    removedStrokes?: VectorStroke[];  // 圈選時從 strokePaths 移出的筆觸（cancel 時放回）
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
    /** v2+：向量筆觸快照（取代 paintData ImageData） */
    strokePaths:    VectorStroke[];
    imageLayers:    { img: HTMLImageElement | ImageBitmap; x: number; y: number; w: number; h: number; rotation?: number }[];
    markdownLayers: { text: string; x: number; y: number; fontSize: number; color: string; width: number; linkedNotePath?: string; rotation?: number }[];
    textLayers:     { text: string; x: number; y: number; fontSize: number; color: string; linkedNotePath?: string; rotation?: number }[];
    canvasW:        number;
    canvasH:        number;
}
