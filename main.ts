import {
    App,
    ItemView,
    Modal,
    Notice,
    Platform,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    WorkspaceLeaf,
    normalizePath,
    requestUrl,
    setIcon,
} from 'obsidian';

// ─── 常數（對應 EasyNote GDScript 的 COLORS / COLOR_NAMES）──────────────────
const VIEW_TYPE        = 'godot-easynote';
const TOOLBAR_HEIGHT   = 52;
const MIN_BRUSH_SIZE   = 1;

// ─── Google OAuth2 憑證（build 時由 esbuild define 注入，不在原始碼中明文）───
// 實際值來自 .env 檔案（已加入 .gitignore），CI 可設同名環境變數
declare const __GOOGLE_CLIENT_ID__:     string;
declare const __GOOGLE_CLIENT_SECRET__: string;
const GOOGLE_CLIENT_ID     = __GOOGLE_CLIENT_ID__;
const GOOGLE_CLIENT_SECRET = __GOOGLE_CLIENT_SECRET__;
// OAuth loopback 固定埠號；對應 Google Cloud Console 登記的 Redirect URI
const GOOGLE_OAUTH_PORT    = 42813;
const GOOGLE_REDIRECT_URI  = `http://localhost:${GOOGLE_OAUTH_PORT}`;
const MAX_BRUSH_SIZE   = 60;
const HANDLE_SIZE      = 8;   // 選取控點大小（px）
// 7 階筆刷大小（第 2 階 = 6px 為預設）
const BRUSH_STEPS: number[] = [2, 6, 12, 20, 30, 44, 60];

/** 將筆刷 px 轉成最近的 1–7 階 */
function brushSizeToStep(size: number): number {
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < BRUSH_STEPS.length; i++) {
        const d = Math.abs(BRUSH_STEPS[i] - size);
        if (d < bestDiff) { bestDiff = d; best = i; }
    }
    return best + 1;  // 1-based
}

// ─── Wikilink 解析 ────────────────────────────────────────────────────────────
interface WikiSegment { text: string; isLink: boolean; noteName?: string; }

/** 將一行文字拆成普通文字段 + [[wikilink]] 段 */
function parseWikilinks(line: string): WikiSegment[] {
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

const COLORS: string[] = [
    '#0d0d0d',
    '#F13F5E',
    '#009BFF',
    '#00A75E',
    '#C89200',
];
const COLOR_NAMES: string[] = ['黑色', '紅色', '藍色', '綠色', '橘色'];

// ─── 型別 ─────────────────────────────────────────────────────────────────────
interface EasyNoteSettings {
    defaultColorIdx:  number;
    defaultBrushSize: number;
    saveFolder:       string;
    defaultColors:    string[];
    brushMode:        'steps' | 'continuous';
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
}
const DEFAULT_SETTINGS: EasyNoteSettings = {
    defaultColorIdx:  0,
    defaultBrushSize: 6,
    saveFolder:       'EasyNote',
    defaultColors:    [...COLORS],
    brushMode:        'steps',
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
};

// ─── .enote 專案格式 ──────────────────────────────────────────────────────────
interface ENoteImageLayer    { src: string; x: number; y: number; w: number; h: number; rotation?: number; }
interface ENoteTextLayer     { text: string; x: number; y: number; fontSize: number; color: string; linkedNotePath?: string; rotation?: number; }
interface ENoteMarkdownLayer { text: string; x: number; y: number; fontSize: number; color: string; width: number; linkedNotePath?: string; rotation?: number; }
interface ENote {
    version:        number;
    canvasWidth:    number;
    canvasHeight:   number;
    paintLayer:     string;            // data:image/png;base64,...
    imageLayers:    ENoteImageLayer[];
    markdownLayers: ENoteMarkdownLayer[];
    textLayers:     ENoteTextLayer[];
}

interface ImageLayer {
    img: HTMLImageElement;
    x: number;
    y: number;
    w: number;
    h: number;
    rotation?: number;
}

type HandleType = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'rotate';

interface DragState {
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

interface TextLayer {
    text:            string;
    x:               number;
    y:               number;
    fontSize:        number;
    color:           string;
    linkedNotePath?: string;  // 連結到 Vault .md 筆記的路徑（開啟時自動更新內容）
    rotation?:       number;
}

interface TextDragState {
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
interface PaintFragment {
    offscreen: HTMLCanvasElement;  // 提取的原始畫素
    x:  number;                    // 目前畫布上 X
    y:  number;
    w:  number;                    // 目前寬度（可被縮放）
    h:  number;
    rotation?: number;
}

/** 行內 Markdown 片段（用於 MarkdownLayer 渲染） */
interface InlineSeg {
    text:     string;
    bold?:    boolean;
    italic?:  boolean;
    code?:    boolean;
    link?:    boolean;
    url?:     string;    // set for [text](url) markdown links
    noteName?: string;   // set for [[wikilink]] segments
}

/** MarkdownLayer：以 Markdown 語法渲染的內容圖層 */
interface MarkdownLayer {
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

interface MdDragState {
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
interface HistoryEntry {
    label:          string;
    paintData:      ImageData;
    imageLayers:    { img: HTMLImageElement; x: number; y: number; w: number; h: number; rotation?: number }[];
    markdownLayers: { text: string; x: number; y: number; fontSize: number; color: string; width: number; linkedNotePath?: string; rotation?: number }[];
    textLayers:     { text: string; x: number; y: number; fontSize: number; color: string; linkedNotePath?: string; rotation?: number }[];
    canvasW:        number;
    canvasH:        number;
}

// ─── 繪圖面板（ItemView）──────────────────────────────────────────────────────
class EasyNoteView extends ItemView {
    private settings: EasyNoteSettings;
    private saveSettings: () => Promise<void>;

    // 可見 canvas（顯示合成結果）
    private canvas!:        HTMLCanvasElement;
    private ctx!:           CanvasRenderingContext2D;
    private canvasWrapper!: HTMLElement;
    private manualWidth     = 0;
    private manualHeight    = 0;

    // 筆畫 canvas（offscreen，儲存手繪筆觸）
    private paintCanvas!: HTMLCanvasElement;
    private paintCtx!:    CanvasRenderingContext2D;

    // 匯出
    private lastSaveName    = '';
    private lastProjectName = '';

    // 圖片圖層
    private imageLayers: ImageLayer[]  = [];
    private selectedIdx = -1;
    private dragState:   DragState | null = null;

    // Markdown 圖層（介於圖片層與文字層之間）
    private markdownLayers:  MarkdownLayer[]    = [];
    private selectedMdIdx    = -1;
    private mdDragState:     MdDragState | null  = null;

    // 文字圖層
    private textLayers:      TextLayer[]        = [];
    private selectedTextIdx  = -1;
    private textDragState:   TextDragState | null = null;
    private textFontSize     = 24;
    private _textEditing: {
        el: HTMLTextAreaElement; layerIdx: number; x: number; y: number;
    } | null = null;
    private _mdEditing: {
        el: HTMLTextAreaElement; layerIdx: number;
    } | null = null;

    // 繪畫選取（paintselect）
    private paintFragment:    PaintFragment | null = null;
    private paintFragDrag:    DragState     | null = null;
    private selStart:         { x: number; y: number } | null = null;
    private selCurrent:       { x: number; y: number } | null = null;
    private paintSelectBtn!:  HTMLButtonElement;
    private panLockBtn!:       HTMLButtonElement;

    // 圖層圈選（select mode rubber-band + multi-select）
    private imgSelStart:   { x: number; y: number } | null = null;
    private imgSelCurrent: { x: number; y: number } | null = null;
    private multiSel: { imageIdxs: number[]; textIdxs: number[]; mdIdxs: number[] } | null = null;
    private multiSelDrag: {
        handle:     HandleType;
        startMX:    number;
        startMY:    number;
        startBBox:  { x: number; y: number; w: number; h: number };
        snapImages: { x: number; y: number; w: number; h: number }[];
        snapTexts:  { x: number; y: number; fontSize: number }[];
        snapMds:    { x: number; y: number; fontSize: number; width: number }[];
    } | null = null;

    // 工具模式
    private tool:       'draw' | 'select' | 'text' | 'paintselect' | 'pan' = 'pan';
    private drawing     = false;
    private prevX       = 0;
    private prevY       = 0;
    private brushSize   = 6;
    private brushOpacity = 1.0;  // 0.01 ~ 1.0
    private colorIdx    = 0;
    private eraser      = false;
    // 小調色盤（實例独立，可自訂）
    private colors:     string[] = [...COLORS];
    private colorNames: string[] = [...COLOR_NAMES];

    // 工具列 DOM
    private statusLabel!:     HTMLSpanElement;
    private eraserBtn!:        HTMLButtonElement;
    private selectBtn!:        HTMLButtonElement;
    private textBtn!:          HTMLButtonElement;
    private fontSizeInput!:    HTMLInputElement;
    private textColorInput!:   HTMLInputElement;
    private sizeSlider!:       HTMLInputElement;
    private sizeValueLabel!:   HTMLSpanElement;
    private opacitySlider!:    HTMLInputElement;
    private opacityValueLabel!: HTMLSpanElement;
    private colorBtns:    HTMLElement[] = [];
    private fileInput!:   HTMLInputElement;
    private activeLayerLabel!: HTMLSpanElement;
    private undoBtn!:     HTMLButtonElement;
    private redoBtn!:     HTMLButtonElement;

    // 縮放 & 平移（滾輪縮放，中鍵 / 雙指拖曳平移）
    private zoom          = 1.0;
    private isPanning     = false;
    private panStartX     = 0;
    private panStartY     = 0;
    private panScrollLeft = 0;
    private panScrollTop  = 0;

    // 觸控多指追蹤（Pointer Events）
    private activePointers: Map<number, { x: number; y: number }> = new Map();
    private pinchStartDist: number | null = null;
    private pinchStartZoom: number | null = null;
    private pinchCenterX:   number | null = null;
    private pinchCenterY:   number | null = null;
    private gestureActive:  boolean = false; // 雙指手勢結束後，殘餘單指應被忽略
    private _rafId:         number | null = null; // rAF throttle for render during drawing
    /** 筆觸解析度縮放（1.0 = 全解析度；0.5 = 半解析 → paintCanvas 1/4 大小） */
    private paintScale = 1.0;
    /** Viewport paint cache：畫筆期間避免上傳大畫布紋理 */
    private _vpCache:  HTMLCanvasElement | null = null;
    private _vpCacheX = 0;  // viewport 左上角（畫布邏輯座標）
    private _vpCacheY = 0;

    // 長按偵測（Android 觸控選單）
    private longPressTimer:    ReturnType<typeof setTimeout> | null = null;
    private longPressStartX:   number = 0;
    private longPressStartY:   number = 0;
    private proportionalScale: boolean = false;   // 等比例縮放鎖定（觸控用，等同 Shift）
    private static readonly LONG_PRESS_MS    = 500;   // 長按觸發時間（ms）
    private static readonly LONG_PRESS_SLOP  = 10;    // 允許移動距離（px）

    // 自動儲存
    private autoSaveTimer:   ReturnType<typeof setTimeout> | null = null;
    private lastAutoSaveTime: Date | null = null;
    private static readonly AUTOSAVE_DEBOUNCE_MS = 3000;   // 最後一次變更後 3 秒觸發
    private _autoSyncTimer:          ReturnType<typeof setInterval> | null = null; // 定時 auto-sync
    private autoSyncBtn!:             HTMLButtonElement;
    private _autoPeriodicSaveTimer:   ReturnType<typeof setInterval> | null = null; // 定時 auto-save
    private autoPeriodicSaveBtn!:     HTMLButtonElement;
    private static readonly AUTOSAVE_FILENAME    = 'EasyNote-autosave.enote';

    // 歷史記錄（Undo/Redo）
    private history:   HistoryEntry[] = [];
    private historyIdx = -1;
    private static readonly MAX_HISTORY = 20;

    // 內部剪貼簿（Ctrl+C / Ctrl+X）
    private clipboard: { type: 'image';    img: HTMLImageElement; w: number; h: number }
                     | { type: 'text';     layer: TextLayer }
                     | { type: 'markdown'; layer: MarkdownLayer }
                     | { type: 'paint';    offscreen: HTMLCanvasElement; w: number; h: number }
                     | null = null;

    // 事件繫結
    private _onKeyDown!: (e: KeyboardEvent)  => void;
    private _onPaste!:   (e: ClipboardEvent) => void;
    private _onResize!:  ()                  => void;
    // Vault 檔案變更監聽（雙向同步）
    private _vaultModifyRef:      import('obsidian').EventRef | null = null;
    private _suppressVaultModify  = false;
    // Google Drive 回呼
    private driveUpload:   ((filename: string, content: Uint8Array) => Promise<void>) | null = null;
    private driveDownload: ((filename: string) => Promise<Uint8Array | null>) | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        settings: EasyNoteSettings,
        saveSettings: () => Promise<void>,
        driveUpload: ((filename: string, content: Uint8Array) => Promise<void>) | null = null,
        driveDownload: ((filename: string) => Promise<Uint8Array | null>) | null = null,
    ) {
        super(leaf);
        this.settings      = settings;
        this.saveSettings  = saveSettings;
        this.driveUpload   = driveUpload;
        this.driveDownload = driveDownload;
    }

    getViewType():    string { return VIEW_TYPE;  }
    getDisplayText(): string { return 'EasyNote'; }
    getIcon():        string { return 'pencil';   }

    // ── 開啟 ─────────────────────────────────────────────────────────────────
    async onOpen(): Promise<void> {
        this.brushSize        = this.settings.defaultBrushSize;
        this.colorIdx           = this.settings.defaultColorIdx;
        this.colors             = [...(this.settings.defaultColors ?? COLORS)];
        this.colorNames         = [...COLOR_NAMES];
        this.eraser             = false;
        this.tool               = 'pan';
        this.paintScale         = this.settings.paintScale ?? 1.0;
        // 從設定啟動定時 auto-sync
        if (this.settings.autoSyncEnabled) this.startAutoSync();
        if (this.settings.autoPeriodicSaveEnabled) this.startPeriodicSave();
        this.imageLayers        = [];
        this.textLayers         = [];
        this.selectedIdx        = -1;
        this.selectedTextIdx    = -1;
        this.dragState          = null;
        this.textDragState      = null;
        this._textEditing       = null;
        this.manualWidth        = this.settings.defaultCanvasWidth  ?? 1920;
        this.manualHeight       = this.settings.defaultCanvasHeight ?? 1080;

        const root = this.containerEl.children[1] as HTMLElement;
        root.empty();
        root.addClass('easynote-root');

        this.buildToolbar(root);
        this.buildCanvas(root);

        this._onKeyDown = this.handleKeyDown.bind(this);
        this._onPaste   = this.handlePaste.bind(this);
        this._onResize  = () => this.resizeCanvas(true);
        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('paste',   this._onPaste);
        window.addEventListener('resize',    this._onResize);

        // Vault 檔案變更 → 更新連結圖層（Vault → EasyNote 雙向同步）
        this._vaultModifyRef = this.app.vault.on('modify', async (file) => {
            if (this._suppressVaultModify) return;
            if (!(file instanceof TFile)) return;
            let changed = false;
            for (const ml of this.markdownLayers) {
                if (ml.linkedNotePath === file.path) {
                    ml.text     = await this.app.vault.read(file);
                    ml._cachedH = undefined;
                    changed = true;
                }
            }
            for (const tl of this.textLayers) {
                if (tl.linkedNotePath === file.path) {
                    tl.text = await this.app.vault.read(file);
                    changed = true;
                }
            }
            if (changed) this.render();
        });

        this.refreshColorBtns();
        this.refreshStatus();

        // 啟動模式：載入自動暗存 or 新畫布
        const autosavePath = normalizePath(
            `${this.settings.saveFolder}/${EasyNoteView.AUTOSAVE_FILENAME}`
        );
        const autosaveFile = this.app.vault.getAbstractFileByPath(autosavePath);
        if ((this.settings.startupMode ?? 'new') === 'previous' && autosaveFile instanceof TFile) {
            await this.loadProject(autosaveFile);
            // loadProject 裡的 render() 會排程 autosave，取消避免立即覆寫
            if (this.autoSaveTimer !== null) {
                clearTimeout(this.autoSaveTimer);
                this.autoSaveTimer = null;
            }
        } else {
            // 新畫布：推入空白起始狀態
            this.pushHistory('初始狀態');
        }
    }

    async onClose(): Promise<void> {
        if (this._textEditing) { this._textEditing.el.remove(); this._textEditing = null; }
        if (this._mdEditing)   { this._mdEditing.el.remove();   this._mdEditing   = null; }
        if (this._vaultModifyRef) { this.app.vault.offref(this._vaultModifyRef); this._vaultModifyRef = null; }
        if (this.paintFragment) this.commitFragment();
        // 取消 debounce 和定時 auto-sync
        if (this.autoSaveTimer !== null) {
            clearTimeout(this.autoSaveTimer);
            this.autoSaveTimer = null;
        }
        this.stopAutoSync();
        this.stopPeriodicSave();
        if ((this.settings.startupMode ?? 'new') === 'previous') {
            // 打開前一次模式：寫出最新暫存
            this.autoSaveDirect();
        } else {
            // 新畫布模式：刪除 autosave檔避免下次啟動載入
            const autosavePath = normalizePath(
                `${this.settings.saveFolder}/${EasyNoteView.AUTOSAVE_FILENAME}`
            );
            const autosaveFile = this.app.vault.getAbstractFileByPath(autosavePath);
            if (autosaveFile instanceof TFile) {
                try { await this.app.vault.delete(autosaveFile); } catch (_) {}
            }
        }
        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener('paste',   this._onPaste);
        window.removeEventListener('resize',    this._onResize);
    }

    // ── 工具列建構 ────────────────────────────────────────────────────────────
    private buildToolbar(root: HTMLElement): void {
        const bar  = root.createEl('div', { cls: 'easynote-toolbar' });
        const row1 = bar.createEl('div',  { cls: 'easynote-toolbar-row' });
        const row2 = bar.createEl('div',  { cls: 'easynote-toolbar-row' });

        // ── 插畫 群組 ────────────────────────────────────────────────────────
        row1.createEl('span', { cls: 'easynote-group-label', text: '插畫' });

        // 橡皮擦（快捷 E）
        this.eraserBtn = row1.createEl('button', {
            cls:   'easynote-btn easynote-btn-icon',
            title: '橡皮擦（快捷：E）',
        });
        setIcon(this.eraserBtn, 'eraser');
        this.eraserBtn.addEventListener('click', () => this.toggleEraser());

        // 繪畫選取工具（快捷 M）
        this.paintSelectBtn = row1.createEl('button', {
            cls:   'easynote-btn easynote-btn-icon',
            title: '框選繪畫層區塊，可移動/縮放後再合併（快捷：M）\nEnter 確認　Esc 取消　Del 刪除選取區塊',
        });
        setIcon(this.paintSelectBtn, 'move');
        this.paintSelectBtn.addEventListener('click', () => this.setTool('paintselect'));

        row1.createEl('div', { cls: 'easynote-sep' });

        // 色彩按鈕（單擊選色 / 雙擊開啟顏色選擇器 快捷 1~5）
        row1.createEl('span', { cls: 'easynote-label', text: '顏色:' });
        this.colorBtns = [];
        for (let i = 0; i < this.colors.length; i++) {
            const wrapper = row1.createEl('div', { cls: 'easynote-color-wrapper' });

            const btn = wrapper.createEl('div', {
                cls:   'easynote-color-btn',
                title: `${this.colorNames[i]}（快捷：${i + 1}）
雙擊自訂顏色`,
            });
            (btn as HTMLElement).style.background = this.colors[i];
            // 單擊 / 單點 → 選色
            let colorBtnLongPressTimer: ReturnType<typeof setTimeout> | null = null;
            let colorBtnLongPressFired = false;
            let colorBtnStartX = 0, colorBtnStartY = 0;

            const openColorPanel = () => {
                // 關閉其他已開啟的面板
                document.querySelectorAll('.easynote-color-panel').forEach(el => el.remove());

                const panel = document.createElement('div');
                panel.className = 'easynote-color-panel';

                const native = document.createElement('input');
                native.type  = 'color';
                native.value = this.colors[i];
                panel.appendChild(native);

                // 定位到 wrapper 正下方
                const rect = wrapper.getBoundingClientRect();
                panel.style.top  = `${rect.bottom + window.scrollY + 4}px`;
                panel.style.left = `${rect.left   + window.scrollX}px`;
                document.body.appendChild(panel);
                native.focus();

                native.addEventListener('input', () => {
                    this.colors[i] = native.value;
                    (btn as HTMLElement).style.background = native.value;
                    if (this.colorIdx === i) this.refreshStatus();
                    this.refreshColorBtns();
                });

                // 點擊面板外側關閉
                const close = (ev: MouseEvent) => {
                    if (!panel.contains(ev.target as Node)) {
                        panel.remove();
                        document.removeEventListener('mousedown', close, true);
                    }
                };
                requestAnimationFrame(() =>
                    document.addEventListener('mousedown', close, true)
                );
            };

            btn.addEventListener('click', (e) => {
                if (colorBtnLongPressFired) { colorBtnLongPressFired = false; return; }
                this.setColor(i);
            });

            // 長按 → 開啟顏色選擇面板（支援 Android 觸控與桌面滑鼠）
            btn.addEventListener('pointerdown', (e) => {
                colorBtnLongPressFired = false;
                colorBtnStartX = e.clientX;
                colorBtnStartY = e.clientY;
                colorBtnLongPressTimer = setTimeout(() => {
                    colorBtnLongPressFired = true;
                    colorBtnLongPressTimer = null;
                    openColorPanel();
                }, EasyNoteView.LONG_PRESS_MS);
            });
            btn.addEventListener('pointermove', (e) => {
                if (!colorBtnLongPressTimer) return;
                const dx = e.clientX - colorBtnStartX, dy = e.clientY - colorBtnStartY;
                if (Math.hypot(dx, dy) > EasyNoteView.LONG_PRESS_SLOP) {
                    clearTimeout(colorBtnLongPressTimer);
                    colorBtnLongPressTimer = null;
                }
            });
            const cancelColorLongPress = () => {
                if (colorBtnLongPressTimer) { clearTimeout(colorBtnLongPressTimer); colorBtnLongPressTimer = null; }
            };
            btn.addEventListener('pointerup',     cancelColorLongPress);
            btn.addEventListener('pointercancel', cancelColorLongPress);

            // 桌面雙擊仍可開啟（保留習慣）
            btn.addEventListener('dblclick', (e) => { e.stopPropagation(); openColorPanel(); });

            this.colorBtns.push(btn);
        }
        row1.createEl('div', { cls: 'easynote-sep' });

        // ── 文字 群組 ────────────────────────────────────────────────────────
        row1.createEl('span', { cls: 'easynote-group-label', text: '文字' });

        // 文字工具（快捷 T）
        this.textBtn = row1.createEl('button', {
            cls:   'easynote-btn easynote-btn-icon',
            title: '新增 / 編輯文字（快捷：T）',
        });
        setIcon(this.textBtn, 'type');
        this.textBtn.addEventListener('click', () => this.setTool('text'));

        // 字體大小
        row1.createEl('span', { cls: 'easynote-label', text: '字體:' });
        this.fontSizeInput           = row1.createEl('input');
        this.fontSizeInput.type      = 'number';
        this.fontSizeInput.min       = '8';
        this.fontSizeInput.max       = '200';
        this.fontSizeInput.value     = String(this.textFontSize);
        this.fontSizeInput.title     = '文字字體大小';
        this.fontSizeInput.className = 'easynote-font-size-input';
        this.fontSizeInput.addEventListener('input', () => {
            const v = parseInt(this.fontSizeInput.value);
            if (v >= 8 && v <= 200) {
                this.textFontSize = v;
                // 如果有選中的文字圖層，同步更新字體
                if (this.selectedTextIdx >= 0 && this.selectedTextIdx < this.textLayers.length) {
                    this.textLayers[this.selectedTextIdx].fontSize = v;
                    this.render();
                }
            }
        });

        // 文字顏色
        row1.createEl('span', { cls: 'easynote-label', text: '顏色:' });
        this.textColorInput          = row1.createEl('input');
        this.textColorInput.type     = 'color';
        this.textColorInput.value    = this.colors[0];
        this.textColorInput.title    = '文字顏色';
        this.textColorInput.className = 'easynote-text-color-toolbar';
        this.textColorInput.addEventListener('input', () => {
            // 即時更新已選中的文字圖層顏色
            if (this.selectedTextIdx >= 0 && this.selectedTextIdx < this.textLayers.length) {
                this.textLayers[this.selectedTextIdx].color = this.textColorInput.value;
                this.render();
            }
        });

        row1.createEl('div', { cls: 'easynote-sep' });

        // ── 圖片 群組 ────────────────────────────────────────────────────────
        const imageGroup = row1.createEl('div', { cls: 'easynote-image-group-wrap' });
        imageGroup.createEl('span', { cls: 'easynote-group-label', text: '圖片' });

        // 選取工具（快捷 S）
        this.selectBtn = imageGroup.createEl('button', {
            cls:   'easynote-btn easynote-btn-icon',
            title: '選取並移動/縮放圖片（快捷：S）\nDel 刪除選取圖片',
        });
        setIcon(this.selectBtn, 'move');
        this.selectBtn.addEventListener('click', () => this.setTool('select'));

        // 載入本機圖片
        const loadBtn = imageGroup.createEl('button', {
            cls:   'easynote-btn',
            text:  '載入本機圖片',
            title: '從本機載入圖片（也可拖曳或 Ctrl+V）',
        });
        loadBtn.addEventListener('click', () => this.fileInput.click());

        this.fileInput        = imageGroup.createEl('input');
        this.fileInput.type   = 'file';
        this.fileInput.accept = 'image/*';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', () => {
            const file = this.fileInput.files?.[0];
            if (file) this.loadImageFromBlob(file);
            this.fileInput.value = '';
        });

        // 載入Obsidian圖片
        const vaultBtn = imageGroup.createEl('button', {
            cls:   'easynote-btn',
            text:  '載入Obsidian圖片',
            title: '從 Vault 中選取圖片',
        });
        vaultBtn.addEventListener('click', () => {
            new VaultImagePickerModal(this.app, (file) => this.loadImageFromVault(file)).open();
        });

        // 載入筆記
        const loadNoteBtn = imageGroup.createEl('button', {
            cls:   'easynote-btn',
            text:  '載入筆記',
            title: '將 Vault .md 筆記以 Markdown 圖層載入（每次開啟自動更新）',
        });
        loadNoteBtn.addEventListener('click', () => {
            new VaultNotePickerModal(this.app, (file) => this.addLinkedMarkdownLayer(file)).open();
        });

        // 平移鎖定工具（安全瀏覽，不會誤觸任何圖層）
        this.panLockBtn = imageGroup.createEl('button', {
            cls:   'easynote-btn easynote-btn-icon',
            title: '平移鎖定：拖曳與縮放畫布，不會誤觸任何圖層',
        });
        setIcon(this.panLockBtn, 'hand');
        this.panLockBtn.addEventListener('click', () => this.setTool('pan'));

        // 目前圕層類型標示（右側，已隱藏）
        imageGroup.createEl('div', { cls: 'easynote-spacer' });
        this.activeLayerLabel = imageGroup.createEl('span', { cls: 'easynote-active-layer' });
        this.activeLayerLabel.style.display = 'none';

        // ── 第二行 ──────────────────────────────────────────────────────────
        // Undo / Redo 組合按鈕（左側）
        const undoGroup = row2.createEl('div', { cls: 'easynote-history-group' });
        this.undoBtn = undoGroup.createEl('button', {
            cls:   'easynote-btn easynote-btn-icon',
            title: '上一步 (Ctrl+Z)',
        });
        setIcon(this.undoBtn, 'undo-2');
        this.undoBtn.addEventListener('click', () => { this.undo(); this.refreshUndoRedo(); });
        const undoArrow = undoGroup.createEl('button', { cls: 'easynote-history-arrow', title: '選擇要回到哪一步' });
        undoArrow.textContent = '▾';
        undoArrow.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showHistoryDropdown(undoArrow, 'undo');
        });

        const redoGroup = row2.createEl('div', { cls: 'easynote-history-group' });
        this.redoBtn = redoGroup.createEl('button', {
            cls:   'easynote-btn easynote-btn-icon',
            title: '下一步 (Ctrl+Y)',
        });
        setIcon(this.redoBtn, 'redo-2');
        this.redoBtn.addEventListener('click', () => { this.redo(); this.refreshUndoRedo(); });
        const redoArrow = redoGroup.createEl('button', { cls: 'easynote-history-arrow', title: '選擇要唤復哪一步' });
        redoArrow.textContent = '▾';
        redoArrow.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showHistoryDropdown(redoArrow, 'redo');
        });

        row2.createEl('div', { cls: 'easynote-sep' });

        // 筆刷滑桿
        row2.createEl('span', { cls: 'easynote-label', text: '筆刷:' });
        this.sizeSlider           = row2.createEl('input');
        this.sizeSlider.type      = 'range';
        this.sizeSlider.step      = '1';
        if ((this.settings.brushMode ?? 'steps') === 'steps') {
            this.sizeSlider.min   = '1';
            this.sizeSlider.max   = '7';
            this.sizeSlider.value = String(brushSizeToStep(this.brushSize));
            this.sizeSlider.title = '筆刷大小（7 階）';
        } else {
            this.sizeSlider.min   = String(MIN_BRUSH_SIZE);
            this.sizeSlider.max   = String(MAX_BRUSH_SIZE);
            this.sizeSlider.value = String(this.brushSize);
            this.sizeSlider.title = '筆刷大小';
        }
        this.sizeSlider.className = 'easynote-slider';
        this.sizeValueLabel = row2.createEl('span', { cls: 'easynote-slider-value' });
        this.sizeSlider.addEventListener('input', () => {
            if ((this.settings.brushMode ?? 'steps') === 'steps') {
                this.brushSize = BRUSH_STEPS[parseInt(this.sizeSlider.value) - 1];
            } else {
                this.brushSize = parseInt(this.sizeSlider.value);
            }
            this.refreshStatus();
        });

        // 透明度滑桿
        row2.createEl('span', { cls: 'easynote-label', text: '透明度:' });
        this.opacitySlider           = row2.createEl('input');
        this.opacitySlider.type      = 'range';
        this.opacitySlider.min       = '1';
        this.opacitySlider.max       = '100';
        this.opacitySlider.value     = '100';
        this.opacitySlider.title     = '筆刷透明度（1% 最透明，100% 不透明）';
        this.opacitySlider.className = 'easynote-slider';
        this.opacityValueLabel = row2.createEl('span', { cls: 'easynote-slider-value' });
        this.opacitySlider.addEventListener('input', () => {
            this.brushOpacity = parseInt(this.opacitySlider.value) / 100;
            this.refreshStatus();
        });
        row2.createEl('div', { cls: 'easynote-sep' });

        const canvasActions = row2.createEl('div', { cls: 'easynote-canvas-actions-wrap' });

        // 畫布大小（直立模式下與儲存/載入/匯出同列）
        const canvasSizeBtn = canvasActions.createEl('button', {
            cls:   'easynote-btn',
            text:  '畫布大小',
            title: '調整畫布尺寸（現有內容保留）',
        });
        canvasSizeBtn.addEventListener('click', () => {
            new CanvasSizeModal(this.app, this.canvas.width, this.canvas.height,
                (w, h) => this.setCanvasSize(w, h)).open();
        });
        canvasActions.createEl('div', { cls: 'easynote-sep' });

        // 儲存專案 (.enote)
        const saveProjectBtn = canvasActions.createEl('button', {
            cls:   'easynote-btn',
            text:  '儲存畫布',
            title: '儲存可繼續編輯的 .enote 專案檔',
        });
        saveProjectBtn.addEventListener('click', () => {
            const ts = this.localTimestamp();
            const defaultName = this.lastProjectName || `EasyNote-${ts}`;
            new ProjectNameModal(this.app, defaultName, (name) => this.saveProject(name)).open();
        });

        // 載入專案 (.enote)
        const loadProjectBtn = canvasActions.createEl('button', {
            cls:   'easynote-btn',
            text:  '載入畫布',
            title: '從 Vault 載入 .enote 專案檔',
        });
        loadProjectBtn.addEventListener('click', () => {
            new VaultProjectPickerModal(this.app, (file) => this.loadProject(file)).open();
        });

        // 儲存檔案
        const saveBtn = canvasActions.createEl('button', {
            cls:   'easynote-btn easynote-btn-save',
            text:  '匯出',
            title: '將手繪圖儲存到 Vault',
        });
        saveBtn.addEventListener('click', () => {
            const ts = this.localTimestamp();
            const defaultName = this.lastSaveName || `EasyNote-${ts}`;
            new SaveModal(this.app, defaultName, (name, fmt) => this.saveDrawing(name, fmt)).open();
        });

        canvasActions.createEl('div', { cls: 'easynote-spacer' });

        // 定時 auto-sync 開關按鈕
        this.autoSyncBtn = canvasActions.createEl('button', {
            cls:   'easynote-btn easynote-btn-icon',
            title: '定時自動重新載入開關',
        });
        setIcon(this.autoSyncBtn, 'refresh-cw');
        this.autoSyncBtn.addEventListener('click', () => {
            this.settings.autoSyncEnabled = !this.settings.autoSyncEnabled;
            this.saveSettings();
            if (this.settings.autoSyncEnabled) {
                this.startAutoSync();
            } else {
                this.stopAutoSync();
            }
            this.refreshStatus();
        });

        // 定時 auto-save 開關按鈕
        this.autoPeriodicSaveBtn = canvasActions.createEl('button', {
            cls:   'easynote-btn easynote-btn-icon',
            title: '定時自動儲存開關',
        });
        setIcon(this.autoPeriodicSaveBtn, 'clock');
        this.autoPeriodicSaveBtn.addEventListener('click', () => {
            this.settings.autoPeriodicSaveEnabled = !this.settings.autoPeriodicSaveEnabled;
            this.saveSettings();
            if (this.settings.autoPeriodicSaveEnabled) {
                this.startPeriodicSave();
            } else {
                this.stopPeriodicSave();
            }
            this.refreshStatus();
        });

        this.statusLabel = canvasActions.createEl('span', { cls: 'easynote-status' });
    }

    // ── Canvas 建構 ───────────────────────────────────────────────────────────
    private buildCanvas(root: HTMLElement): void {
        this.canvasWrapper = root.createEl('div', { cls: 'easynote-canvas-wrapper' });
        this.canvas = this.canvasWrapper.createEl('canvas', { cls: 'easynote-canvas' });
        const ctx = this.canvas.getContext('2d');
        if (!ctx) { new Notice('EasyNote：無法取得 Canvas 2D context'); return; }
        this.ctx = ctx;

        // offscreen 筆畫 canvas
        this.paintCanvas = document.createElement('canvas');
        const pctx = this.paintCanvas.getContext('2d');
        if (!pctx) { new Notice('EasyNote：無法取得 paint canvas context'); return; }
        this.paintCtx = pctx;

        this.resizeCanvas();

        // ── 滑鼠事件 ──────────────────────────────────────────────────────────
        this.canvas.addEventListener('pointerdown', (e) => {
            this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            // 雙指觸控 → 切換到平移 / 縮放模式，不執行繪圖
            // 三指以上：只記錄位置，其餘忽略（避免觸發繪圖 / 跳位）
            if (this.activePointers.size >= 3) {
                this.canvas.setPointerCapture(e.pointerId);
                return;
            }
            if (this.activePointers.size === 2) {
                // 中止任何進行中的繪圖 / 拖曳
                this.gestureActive = false; // 重新開始雙指手勢，清除殘餘旗標
                this.drawing       = false;
                this.dragState     = null;
                this.textDragState = null;
                this.mdDragState   = null;
                this.paintFragDrag = null;
                this.multiSelDrag  = null;
                this.imgSelStart   = null;
                this.imgSelCurrent = null;
                // 記錄 pinch 起始距離與畫面中心
                const ptrs = [...this.activePointers.values()];
                const dx   = ptrs[1].x - ptrs[0].x;
                const dy   = ptrs[1].y - ptrs[0].y;
                this.pinchStartDist = Math.hypot(dx, dy);
                this.pinchStartZoom = this.zoom;
                this.pinchCenterX   = (ptrs[0].x + ptrs[1].x) / 2;
                this.pinchCenterY   = (ptrs[0].y + ptrs[1].y) / 2;
                // 以雙指中心開始平移（增量模式，每幀更新 panStartX/Y）
                this.isPanning  = true;
                this.panStartX  = this.pinchCenterX;
                this.panStartY  = this.pinchCenterY;
                // 確保第二根手指的 pointermove 也能送到 canvas
                this.canvas.setPointerCapture(e.pointerId);
                return;
            }

            // 中鍵 → 開始平移
            if (e.button === 1) {
                e.preventDefault();
                this.isPanning     = true;
                this.panStartX     = e.clientX;
                this.panStartY     = e.clientY;
                this.panScrollLeft = this.canvasWrapper.scrollLeft;
                this.panScrollTop  = this.canvasWrapper.scrollTop;
                this.canvas.style.cursor = 'grabbing';
                return;
            }
            if (e.button !== 0) return;
            if (!e.isPrimary) return;

            // 觸控長按偵測（僅 touch / pen）
            if (e.pointerType !== 'mouse') {
                if (this.longPressTimer) clearTimeout(this.longPressTimer);
                this.longPressStartX = e.clientX;
                this.longPressStartY = e.clientY;
                this.longPressTimer  = setTimeout(() => {
                    this.longPressTimer = null;
                    const { x: lmx, y: lmy } = this.toCanvasCoords(
                        { clientX: this.longPressStartX, clientY: this.longPressStartY } as PointerEvent);
                    this.handleLongPress(lmx, lmy, this.longPressStartX, this.longPressStartY);
                }, EasyNoteView.LONG_PRESS_MS);
            }

            this.canvas.setPointerCapture(e.pointerId);
            const { x: mx, y: my } = this.toCanvasCoords(e);

            // 平移鎖定模式：單指單點也當作平移，不觸發任何圖層操作
            if (this.tool === 'pan') {
                this.isPanning     = true;
                this.panStartX     = e.clientX;
                this.panStartY     = e.clientY;
                this.panScrollLeft = this.canvasWrapper.scrollLeft;
                this.panScrollTop  = this.canvasWrapper.scrollTop;
                this.canvas.style.cursor = 'grabbing';
                return;
            }

            if (this.tool === 'text') {
                // Android：阻止瀏覽器預設的觸控焦點行為，避免與手動 focus() 競爭
                e.preventDefault();
                // 文字工具：搜尋是否點到已有文字圖層
                let hitTextIdx = -1;
                for (let i = this.textLayers.length - 1; i >= 0; i--) {
                    if (this.pointInText(mx, my, this.textLayers[i])) { hitTextIdx = i; break; }
                }
                this.openTextEditor(mx, my, hitTextIdx);
                return;
            } else if (this.tool === 'paintselect') {
                if (this.paintFragment) {
                    // 有 fragment：檢查控點 / 內部變鑑 / 外部 confirm
                    const h = this.hitFragHandle(mx, my);
                    if (h) {
                        const frag = this.paintFragment;
                        const rot  = frag.rotation || 0;
                        if (h === 'rotate') {
                            const cx = frag.x + frag.w / 2, cy = frag.y + frag.h / 2;
                            this.paintFragDrag = {
                                handle: 'rotate', startMX: mx, startMY: my,
                                startX: frag.x, startY: frag.y,
                                startW: frag.w, startH: frag.h,
                                startRotation: rot, centerX: cx, centerY: cy,
                                startAngle: Math.atan2(my - cy, mx - cx),
                            };
                        } else {
                            this.paintFragDrag = {
                                handle: h, startMX: mx, startMY: my,
                                startX: frag.x, startY: frag.y,
                                startW: frag.w, startH: frag.h,
                            };
                        }
                    } else if (this.pointInFrag(mx, my)) {
                        this.paintFragDrag = {
                            handle: 'move', startMX: mx, startMY: my,
                            startX: this.paintFragment.x, startY: this.paintFragment.y,
                            startW: this.paintFragment.w, startH: this.paintFragment.h,
                        };
                    } else {
                        // 點選外部 → 先確認当前再開始新選框
                        this.commitFragment();
                        this.selStart   = { x: mx, y: my };
                        this.selCurrent = { x: mx, y: my };
                    }
                } else {
                    // 開始拖曳新選框
                    this.selStart   = { x: mx, y: my };
                    this.selCurrent = { x: mx, y: my };
                }
            } else if (this.tool === 'select') {
                // ── 多圖層選取（multi-select group）優先處理 ────────────────
                if (this.multiSel) {
                    const mh = this.hitMultiSelHandle(mx, my);
                    if (mh) {
                        this.pushHistory('縮放群組圖層');
                        const bbox = this.getMultiSelBBox()!;
                        this.multiSelDrag = {
                            handle: mh, startMX: mx, startMY: my, startBBox: { ...bbox },
                            snapImages: this.multiSel.imageIdxs.map(i => ({ ...this.imageLayers[i] })),
                            snapTexts:  this.multiSel.textIdxs.map(i => ({ x: this.textLayers[i].x, y: this.textLayers[i].y, fontSize: this.textLayers[i].fontSize })),
                            snapMds:    this.multiSel.mdIdxs.map(i => ({ x: this.markdownLayers[i].x, y: this.markdownLayers[i].y, fontSize: this.markdownLayers[i].fontSize, width: this.markdownLayers[i].width })),
                        };
                        return;
                    }
                    if (this.pointInMultiSelBBox(mx, my)) {
                        this.pushHistory('移動群組圖層');
                        const bbox = this.getMultiSelBBox()!;
                        this.multiSelDrag = {
                            handle: 'move', startMX: mx, startMY: my, startBBox: { ...bbox },
                            snapImages: this.multiSel.imageIdxs.map(i => ({ ...this.imageLayers[i] })),
                            snapTexts:  this.multiSel.textIdxs.map(i => ({ x: this.textLayers[i].x, y: this.textLayers[i].y, fontSize: this.textLayers[i].fontSize })),
                            snapMds:    this.multiSel.mdIdxs.map(i => ({ x: this.markdownLayers[i].x, y: this.markdownLayers[i].y, fontSize: this.markdownLayers[i].fontSize, width: this.markdownLayers[i].width })),
                        };
                        return;
                    }
                    // 點擊群組外 → 解除群組選取，繼續後續判斷
                    this.multiSel = null;
                    this.multiSelDrag = null;
                }
                // ── [[Wikilink]] 點擊 → 在 Obsidian 開啟筆記 ──────────────────
                const wikilinkHit = this.getWikilinkAt(mx, my);
                if (wikilinkHit) {
                    this.app.workspace.openLinkText(wikilinkHit, '');
                    return;
                }
                // 先檢查文字圖層（文字層在繪畫層下方）
                let hitText = -1;
                for (let i = this.textLayers.length - 1; i >= 0; i--) {
                    if (this.pointInText(mx, my, this.textLayers[i])) { hitText = i; break; }
                }
                // 如已選取文字圖層，先檢查控點是否被點擊
                if (this.selectedTextIdx >= 0) {
                    const h = this.hitTextHandle(mx, my, this.textLayers[this.selectedTextIdx]);
                    if (h) {
                        const tl = this.textLayers[this.selectedTextIdx];
                        const b  = this.textBBox(tl);
                        this.pushHistory('縮放文字圖層');  // 拖曳彈物層前先存快照
                        this.textDragState = {
                            handle: h, startMX: mx, startMY: my,
                            startX: tl.x, startY: tl.y,
                            startFontSize: tl.fontSize, startW: b.w, startH: b.h,
                        };
                        return;
                    }
                }
                if (hitText >= 0) {
                    this.selectedTextIdx = hitText;
                    this.selectedIdx     = -1;
                    this.selectedMdIdx   = -1;
                    this.dragState       = null;
                    this.mdDragState     = null;
                    const tl = this.textLayers[hitText];
                    this.textColorInput.value = tl.color;
                    const b  = this.textBBox(tl);
                    this.pushHistory('移動文字圖層');  // 移動文字圖層前先存快照
                    this.textDragState = {
                        handle: 'move', startMX: mx, startMY: my,
                        startX: tl.x, startY: tl.y,
                        startFontSize: tl.fontSize, startW: b.w, startH: b.h,
                    };
                    this.render();
                    return;
                }
                // 檢查 Markdown 圖層（已選取的先檢查控點）
                if (this.selectedMdIdx >= 0 && this.selectedMdIdx < this.markdownLayers.length) {
                    const h = this.hitMdHandle(mx, my, this.markdownLayers[this.selectedMdIdx]);
                    if (h) {
                        const ml  = this.markdownLayers[this.selectedMdIdx];
                        const b   = this.mdBBox(ml);
                        const rot = ml.rotation || 0;
                        if (h === 'rotate') {
                            this.pushHistory('旋轉 Markdown 圖層');
                            const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
                            this.mdDragState = {
                                handle: 'rotate', startMX: mx, startMY: my,
                                startX: ml.x, startY: ml.y,
                                startFontSize: ml.fontSize, startWidth: ml.width, startH: b.h,
                                startRotation: rot, centerX: cx, centerY: cy,
                                startAngle: Math.atan2(my - cy, mx - cx),
                            };
                        } else {
                            this.pushHistory('縮放 Markdown 圖層');
                            this.mdDragState = {
                                handle: h, startMX: mx, startMY: my,
                                startX: ml.x, startY: ml.y,
                                startFontSize: ml.fontSize, startWidth: ml.width, startH: b.h,
                            };
                        }
                        return;
                    }
                }
                let hitMd = -1;
                for (let i = this.markdownLayers.length - 1; i >= 0; i--) {
                    if (this.pointInMd(mx, my, this.markdownLayers[i])) { hitMd = i; break; }
                }
                if (hitMd >= 0) {
                    // [[Wikilink]] 點擊 → 在 Obsidian 開啟筆記
                    const mdWikilink = this.getMdWikilinkAt(mx, my);
                    if (mdWikilink) {
                        this.app.workspace.openLinkText(mdWikilink, '');
                        return;
                    }
                    // [text](url) 超連結點擊 → 在瀏覽器開啟
                    const mdUrl = this.getMdUrlAt(mx, my);
                    if (mdUrl) {
                        (this.app as any).openUrl
                            ? (this.app as any).openUrl(mdUrl)
                            : window.open(mdUrl, '_blank');
                        return;
                    }
                    this.selectedMdIdx   = hitMd;
                    this.selectedIdx     = -1;
                    this.selectedTextIdx = -1;
                    this.dragState       = null;
                    this.textDragState   = null;
                    const ml = this.markdownLayers[hitMd];
                    const b  = this.mdBBox(ml);
                    this.pushHistory('移動 Markdown 圖層');
                    this.mdDragState = {
                        handle: 'move', startMX: mx, startMY: my,
                        startX: ml.x, startY: ml.y,
                        startFontSize: ml.fontSize, startWidth: ml.width, startH: b.h,
                    };
                    this.render();
                    return;
                }
                // 先檢查是否點到控點
                if (this.selectedIdx >= 0) {
                    const h = this.hitHandle(mx, my, this.imageLayers[this.selectedIdx]);
                    if (h) {
                        const lay = this.imageLayers[this.selectedIdx];
                        const rot = lay.rotation || 0;
                        if (h === 'rotate') {
                            this.pushHistory('旋轉圖片圖層');
                            const cx = lay.x + lay.w / 2, cy = lay.y + lay.h / 2;
                            this.dragState = {
                                handle: 'rotate', startMX: mx, startMY: my,
                                startX: lay.x, startY: lay.y, startW: lay.w, startH: lay.h,
                                startRotation: rot, centerX: cx, centerY: cy,
                                startAngle: Math.atan2(my - cy, mx - cx),
                            };
                        } else {
                            this.pushHistory('縮放圖片圖層');  // 縮放圖片層前先存快照
                            this.dragState = { handle: h, startMX: mx, startMY: my,
                                startX: lay.x, startY: lay.y, startW: lay.w, startH: lay.h };
                        }
                        return;
                    }
                }
                // 點到哪個圖片圖層？（由上到下）
                let hit = -1;
                for (let i = this.imageLayers.length - 1; i >= 0; i--) {
                    if (this.pointInLayer(mx, my, this.imageLayers[i])) { hit = i; break; }
                }
                if (hit >= 0) {
                    this.selectedIdx     = hit;
                    this.selectedTextIdx = -1;
                    this.selectedMdIdx   = -1;
                    const lay = this.imageLayers[hit];
                    this.pushHistory('移動圖片圖層');  // 移動圖片層前先存快照
                    this.dragState = { handle: 'move', startMX: mx, startMY: my,
                        startX: lay.x, startY: lay.y, startW: lay.w, startH: lay.h };
                } else {
                    // 空白處 → 開始圈選拖曳框
                    this.selectedIdx     = -1;
                    this.selectedTextIdx = -1;
                    this.selectedMdIdx   = -1;
                    this.imgSelStart   = { x: mx, y: my };
                    this.imgSelCurrent = { x: mx, y: my };
                }
                this.render();
            } else {
                // 畫筆 / 橡皮擦
                this.pushHistory(this.eraser ? '橡皮擦' : '筆觸');  // 每次筆觸開始前保存快照
                this.drawing = true;
                this.prevX = mx; this.prevY = my;
                this.initViewportCache();  // 初始化 viewport paint cache
                this.paintDot(mx, my);
            }
        });

        this.canvas.addEventListener('pointermove', (e) => {
            // 更新此 pointer 的位置
            if (this.activePointers.has(e.pointerId)) {
                this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            }

            // 雙指（含）以上：pinch-to-zoom + 平移
            if (this.activePointers.size >= 2) {
                const ptrs = [...this.activePointers.values()];
                const cx = (ptrs[0].x + ptrs[1].x) / 2;
                const cy = (ptrs[0].y + ptrs[1].y) / 2;
                // 縮放（以當前雙指中心為 pivot，每幀重算，避免跳動）
                if (this.pinchStartDist && this.pinchStartZoom !== null) {
                    const ddx  = ptrs[1].x - ptrs[0].x;
                    const ddy  = ptrs[1].y - ptrs[0].y;
                    const dist = Math.hypot(ddx, ddy);
                    const MIN_ZOOM = 0.1, MAX_ZOOM = 8.0;
                    const newZoom  = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM,
                        this.pinchStartZoom * (dist / this.pinchStartDist)));
                    const wRect  = this.canvasWrapper.getBoundingClientRect();
                    const pivotX = cx - wRect.left;
                    const pivotY = cy - wRect.top;
                    const ratio  = newZoom / this.zoom;
                    // 在 applyZoom 前先快照 scroll，避免瀏覽器 resize 後自動修改 scrollLeft
                    const prevSL = this.canvasWrapper.scrollLeft;
                    const prevST = this.canvasWrapper.scrollTop;
                    this.zoom = newZoom;
                    this.applyZoom();
                    this.canvasWrapper.scrollLeft = (prevSL + pivotX) * ratio - pivotX;
                    this.canvasWrapper.scrollTop  = (prevST + pivotY) * ratio - pivotY;
                    this.refreshStatus();
                }
                // 雙指平移：增量方式，疊加在縮放後的 scroll 上，避免互相覆蓋
                this.canvasWrapper.scrollLeft -= (cx - this.panStartX);
                this.canvasWrapper.scrollTop  -= (cy - this.panStartY);
                // 更新基準點供下一幀使用
                this.panStartX = cx;
                this.panStartY = cy;
                return;
            }

            // 中鍵 / 單指平移
            if (this.isPanning) {
                this.canvasWrapper.scrollLeft = this.panScrollLeft - (e.clientX - this.panStartX);
                this.canvasWrapper.scrollTop  = this.panScrollTop  - (e.clientY - this.panStartY);
                return;
            }
            // 雙指手勢結束後殘餘單指 → 忽略，避免跳位或誤觸
            if (this.gestureActive) return;
            if (!e.isPrimary) return;

            // 手指移動超出 slop → 取消長按
            if (this.longPressTimer) {
                const dx = e.clientX - this.longPressStartX;
                const dy = e.clientY - this.longPressStartY;
                if (Math.hypot(dx, dy) > EasyNoteView.LONG_PRESS_SLOP) {
                    clearTimeout(this.longPressTimer);
                    this.longPressTimer = null;
                }
            }

            const { x: mx, y: my } = this.toCanvasCoords(e);

            if (this.tool === 'select') {
                // 更新游標
                this.updateCursor(mx, my);

                // 多圖層群組拖曳 / 縮放
                if (this.multiSelDrag && this.multiSel) {
                    const ds  = this.multiSelDrag;
                    const dx  = mx - ds.startMX;
                    const dy  = my - ds.startMY;
                    if (ds.handle === 'move') {
                        for (let k = 0; k < this.multiSel.imageIdxs.length; k++) {
                            const i = this.multiSel.imageIdxs[k];
                            this.imageLayers[i].x = ds.snapImages[k].x + dx;
                            this.imageLayers[i].y = ds.snapImages[k].y + dy;
                        }
                        for (let k = 0; k < this.multiSel.textIdxs.length; k++) {
                            const i = this.multiSel.textIdxs[k];
                            this.textLayers[i].x = ds.snapTexts[k].x + dx;
                            this.textLayers[i].y = ds.snapTexts[k].y + dy;
                        }
                        for (let k = 0; k < this.multiSel.mdIdxs.length; k++) {
                            const i = this.multiSel.mdIdxs[k];
                            this.markdownLayers[i].x = ds.snapMds[k].x + dx;
                            this.markdownLayers[i].y = ds.snapMds[k].y + dy;
                            this.markdownLayers[i]._cachedH = undefined;
                        }
                    } else {
                        // 縮放：以對角為錨點，等比例縮放所有圖層
                        const b = ds.startBBox;
                        let anchorX: number, anchorY: number, newW: number, newH: number;
                        if (ds.handle === 'nw') {
                            anchorX = b.x + b.w; anchorY = b.y + b.h;
                            newW = Math.max(10, anchorX - mx); newH = Math.max(10, anchorY - my);
                        } else if (ds.handle === 'ne') {
                            anchorX = b.x; anchorY = b.y + b.h;
                            newW = Math.max(10, mx - anchorX); newH = Math.max(10, anchorY - my);
                        } else if (ds.handle === 'sw') {
                            anchorX = b.x + b.w; anchorY = b.y;
                            newW = Math.max(10, anchorX - mx); newH = Math.max(10, my - anchorY);
                        } else { // se
                            anchorX = b.x; anchorY = b.y;
                            newW = Math.max(10, mx - anchorX); newH = Math.max(10, my - anchorY);
                        }
                        if (e.shiftKey) {
                            const sc = Math.min(newW / b.w, newH / b.h);
                            newW = sc * b.w; newH = sc * b.h;
                        }
                        const sx = newW / b.w, sy = newH / b.h;
                        for (let k = 0; k < this.multiSel.imageIdxs.length; k++) {
                            const i  = this.multiSel.imageIdxs[k];
                            const s  = ds.snapImages[k];
                            this.imageLayers[i].x = anchorX + (s.x - anchorX) * sx;
                            this.imageLayers[i].y = anchorY + (s.y - anchorY) * sy;
                            this.imageLayers[i].w = Math.max(1, s.w * sx);
                            this.imageLayers[i].h = Math.max(1, s.h * sy);
                        }
                        for (let k = 0; k < this.multiSel.textIdxs.length; k++) {
                            const i = this.multiSel.textIdxs[k];
                            const s = ds.snapTexts[k];
                            this.textLayers[i].x = anchorX + (s.x - anchorX) * sx;
                            this.textLayers[i].y = anchorY + (s.y - anchorY) * sy;
                            this.textLayers[i].fontSize = Math.max(8, s.fontSize * (sx + sy) / 2);
                        }
                        for (let k = 0; k < this.multiSel.mdIdxs.length; k++) {
                            const i = this.multiSel.mdIdxs[k];
                            const s = ds.snapMds[k];
                            this.markdownLayers[i].x = anchorX + (s.x - anchorX) * sx;
                            this.markdownLayers[i].y = anchorY + (s.y - anchorY) * sy;
                            this.markdownLayers[i].fontSize = Math.max(8, s.fontSize * sx);
                            this.markdownLayers[i].width    = Math.max(40, s.width * sx);
                            this.markdownLayers[i]._cachedH = undefined;
                        }
                    }
                    this.render();
                    return;
                }

                // 圈選橡皮筋框更新
                if (this.imgSelStart) {
                    this.imgSelCurrent = { x: mx, y: my };
                    this.render();
                    return;
                }

                // Markdown 拖曳 / 縮放
                if (this.mdDragState && this.selectedMdIdx >= 0) {
                    const md  = this.mdDragState;
                    const ml  = this.markdownLayers[this.selectedMdIdx];
                    const dx  = mx - md.startMX;
                    const MIN_FONT  = 8;
                    const MIN_WIDTH = 40;
                    if (md.handle === 'rotate') {
                        const angle = Math.atan2(my - md.centerY!, mx - md.centerX!);
                        let rot = md.startRotation! + (angle - md.startAngle!);
                        if (e.shiftKey) { const snap = Math.PI / 12; rot = Math.round(rot / snap) * snap; }
                        ml.rotation = rot;
                        ml._cachedH = undefined;
                        this.render(); return;
                    } else if (md.handle === 'move') {
                        ml.x = md.startX + dx;
                        ml.y = md.startY + (my - md.startMY);
                    } else if (md.handle === 'se') {
                        const nw    = Math.max(MIN_WIDTH, md.startWidth + dx);
                        const scale = nw / md.startWidth;
                        ml.fontSize = Math.max(MIN_FONT, md.startFontSize * scale);
                        ml.width    = nw;
                    } else if (md.handle === 'ne') {
                        const nw    = Math.max(MIN_WIDTH, md.startWidth + dx);
                        const scale = nw / md.startWidth;
                        ml.fontSize = Math.max(MIN_FONT, md.startFontSize * scale);
                        ml.width    = nw;
                        ml.y        = md.startY + (md.startH - md.startH * scale);
                    } else if (md.handle === 'sw') {
                        const nw    = Math.max(MIN_WIDTH, md.startWidth - dx);
                        const scale = nw / md.startWidth;
                        ml.fontSize = Math.max(MIN_FONT, md.startFontSize * scale);
                        ml.width    = nw;
                        ml.x        = md.startX + (md.startWidth - nw);
                    } else { // nw
                        const nw    = Math.max(MIN_WIDTH, md.startWidth - dx);
                        const scale = nw / md.startWidth;
                        ml.fontSize = Math.max(MIN_FONT, md.startFontSize * scale);
                        ml.width    = nw;
                        ml.x        = md.startX + (md.startWidth - nw);
                        ml.y        = md.startY + (md.startH - md.startH * scale);
                    }
                    ml._cachedH = undefined;
                    this.render();
                    return;
                }

                // 文字拖曳 / 縮放
                if (this.textDragState && this.selectedTextIdx >= 0) {
                    const td  = this.textDragState;
                    const tl  = this.textLayers[this.selectedTextIdx];
                    const dx  = mx - td.startMX;
                    const dy  = my - td.startMY;
                    const MIN_FONT = 8;
                    const minW     = td.startW * (MIN_FONT / td.startFontSize);

                    if (td.handle === 'rotate') {
                        const angle = Math.atan2(my - td.centerY!, mx - td.centerX!);
                        let rot = td.startRotation! + (angle - td.startAngle!);
                        if (e.shiftKey || this.proportionalScale) { const snap = Math.PI / 12; rot = Math.round(rot / snap) * snap; }
                        tl.rotation = rot;
                        this.render(); return;
                    } else if (td.handle === 'move') {
                        tl.x = td.startX + dx;
                        tl.y = td.startY + dy;
                    } else if (td.handle === 'nw') {
                        const nw    = Math.max(minW, td.startW - dx);
                        const scale = nw / td.startW;
                        tl.fontSize = Math.max(MIN_FONT, td.startFontSize * scale);
                        tl.x = td.startX + (td.startW - nw);
                        tl.y = td.startY + (td.startH - td.startH * scale);
                    } else if (td.handle === 'ne') {
                        const nw    = Math.max(minW, td.startW + dx);
                        const scale = nw / td.startW;
                        tl.fontSize = Math.max(MIN_FONT, td.startFontSize * scale);
                        tl.y = td.startY + (td.startH - td.startH * scale);
                    } else if (td.handle === 'sw') {
                        const nw    = Math.max(minW, td.startW - dx);
                        const scale = nw / td.startW;
                        tl.fontSize = Math.max(MIN_FONT, td.startFontSize * scale);
                        tl.x = td.startX + (td.startW - nw);
                    } else { // se
                        const nw    = Math.max(minW, td.startW + dx);
                        const scale = nw / td.startW;
                        tl.fontSize = Math.max(MIN_FONT, td.startFontSize * scale);
                    }
                    this.render();
                    return;
                }

                if (this.dragState) {
                    const ds    = this.dragState;
                    const dx    = mx - ds.startMX;
                    const dy    = my - ds.startMY;
                    const lay   = this.imageLayers[this.selectedIdx];
                    const ratio = ds.startW / ds.startH;  // 原始長寬比

                    if (ds.handle === 'rotate') {
                        const angle = Math.atan2(my - ds.centerY!, mx - ds.centerX!);
                        let rot = ds.startRotation! + (angle - ds.startAngle!);
                        if (e.shiftKey || this.proportionalScale) { const snap = Math.PI / 12; rot = Math.round(rot / snap) * snap; }
                        lay.rotation = rot;
                        this.render(); return;
                    } else if (ds.handle === 'move') {
                        lay.x = ds.startX + dx;
                        lay.y = ds.startY + dy;
                    } else {
                        // 縮放：各角拖曳改變 x/y/w/h
                        const MIN = 20;
                        if (ds.handle === 'nw') {
                            let nw = Math.max(MIN, ds.startW - dx);
                            let nh = Math.max(MIN, ds.startH - dy);
                            if (e.shiftKey || this.proportionalScale) {
                                const scale = Math.max((ds.startW - dx) / ds.startW, (ds.startH - dy) / ds.startH);
                                nw = Math.max(MIN, ds.startW * scale);
                                nh = Math.max(MIN, nw / ratio);
                            }
                            lay.x = ds.startX + (ds.startW - nw);
                            lay.y = ds.startY + (ds.startH - nh);
                            lay.w = nw; lay.h = nh;
                        } else if (ds.handle === 'ne') {
                            let nw = Math.max(MIN, ds.startW + dx);
                            let nh = Math.max(MIN, ds.startH - dy);
                            if (e.shiftKey || this.proportionalScale) {
                                const scale = Math.max((ds.startW + dx) / ds.startW, (ds.startH - dy) / ds.startH);
                                nw = Math.max(MIN, ds.startW * scale);
                                nh = Math.max(MIN, nw / ratio);
                            }
                            lay.w = nw;
                            lay.y = ds.startY + (ds.startH - nh);
                            lay.h = nh;
                        } else if (ds.handle === 'sw') {
                            let nw = Math.max(MIN, ds.startW - dx);
                            let nh = Math.max(MIN, ds.startH + dy);
                            if (e.shiftKey || this.proportionalScale) {
                                const scale = Math.max((ds.startW - dx) / ds.startW, (ds.startH + dy) / ds.startH);
                                nw = Math.max(MIN, ds.startW * scale);
                                nh = Math.max(MIN, nw / ratio);
                            }
                            lay.x = ds.startX + (ds.startW - nw);
                            lay.w = nw; lay.h = nh;
                        } else { // se
                            let nw = Math.max(MIN, ds.startW + dx);
                            let nh = Math.max(MIN, ds.startH + dy);
                            if (e.shiftKey || this.proportionalScale) {
                                const scale = Math.max((ds.startW + dx) / ds.startW, (ds.startH + dy) / ds.startH);
                                nw = Math.max(MIN, ds.startW * scale);
                                nh = Math.max(MIN, nw / ratio);
                            }
                            lay.w = nw; lay.h = nh;
                        }
                    }
                    this.render();
                }
            } else if (this.drawing) {
                // 使用 getCoalescedEvents 取回所有被合併的中間點，
                // 避免大畫布在 Android 上因事件節流導致曲線退化成直線
                const coalesced = (e as PointerEvent).getCoalescedEvents?.() ?? [e];
                for (const ce of coalesced) {
                    const { x: cpx, y: cpy } = this.toCanvasCoords(ce as PointerEvent);
                    this.paintStroke(this.prevX, this.prevY, cpx, cpy);
                    this.prevX = cpx; this.prevY = cpy;
                }
            } else if (this.tool === 'paintselect') {
                if (this.paintFragDrag && this.paintFragment) {
                    const ds    = this.paintFragDrag;
                    const dx    = mx - ds.startMX;
                    const dy    = my - ds.startMY;
                    const frag  = this.paintFragment;
                    const ratio = ds.startW / ds.startH;
                    const MIN   = 10;
                    if (ds.handle === 'rotate') {
                        const angle = Math.atan2(my - ds.centerY!, mx - ds.centerX!);
                        let rot = ds.startRotation! + (angle - ds.startAngle!);
                        if (e.shiftKey || this.proportionalScale) { const snap = Math.PI / 12; rot = Math.round(rot / snap) * snap; }
                        frag.rotation = rot;
                    } else if (ds.handle === 'move') {
                        frag.x = ds.startX + dx;
                        frag.y = ds.startY + dy;
                    } else if (ds.handle === 'nw') {
                        let nw = Math.max(MIN, ds.startW - dx);
                        let nh = Math.max(MIN, ds.startH - dy);
                        if (e.shiftKey || this.proportionalScale) { const sc = Math.max((ds.startW-dx)/ds.startW,(ds.startH-dy)/ds.startH); nw=Math.max(MIN,ds.startW*sc); nh=nw/ratio; }
                        frag.x = ds.startX + (ds.startW - nw); frag.y = ds.startY + (ds.startH - nh); frag.w = nw; frag.h = nh;
                    } else if (ds.handle === 'ne') {
                        let nw = Math.max(MIN, ds.startW + dx);
                        let nh = Math.max(MIN, ds.startH - dy);
                        if (e.shiftKey || this.proportionalScale) { const sc = Math.max((ds.startW+dx)/ds.startW,(ds.startH-dy)/ds.startH); nw=Math.max(MIN,ds.startW*sc); nh=nw/ratio; }
                        frag.w = nw; frag.y = ds.startY + (ds.startH - nh); frag.h = nh;
                    } else if (ds.handle === 'sw') {
                        let nw = Math.max(MIN, ds.startW - dx);
                        let nh = Math.max(MIN, ds.startH + dy);
                        if (e.shiftKey || this.proportionalScale) { const sc = Math.max((ds.startW-dx)/ds.startW,(ds.startH+dy)/ds.startH); nw=Math.max(MIN,ds.startW*sc); nh=nw/ratio; }
                        frag.x = ds.startX + (ds.startW - nw); frag.w = nw; frag.h = nh;
                    } else { // se
                        let nw = Math.max(MIN, ds.startW + dx);
                        let nh = Math.max(MIN, ds.startH + dy);
                        if (e.shiftKey || this.proportionalScale) { const sc = Math.max((ds.startW+dx)/ds.startW,(ds.startH+dy)/ds.startH); nw=Math.max(MIN,ds.startW*sc); nh=nw/ratio; }
                        frag.w = nw; frag.h = nh;
                    }
                    this.render();
                } else if (this.selStart) {
                    this.selCurrent = { x: mx, y: my };
                    this.render();
                } else {
                    // 更新游標
                    if (this.hitFragHandle(mx, my)) {
                        this.canvas.style.cursor = 'nwse-resize';
                    } else if (this.pointInFrag(mx, my)) {
                        this.canvas.style.cursor = 'move';
                    } else {
                        this.canvas.style.cursor = 'crosshair';
                    }
                }
            }

        });

        this.canvas.addEventListener('pointerup', (e) => {
            this.activePointers.delete(e.pointerId);
            // 手指抬起 → 取消長按計時器
            if (this.longPressTimer) {
                clearTimeout(this.longPressTimer);
                this.longPressTimer = null;
            }
            // 雙指結束 → 重設 pinch 狀態
            if (this.activePointers.size < 2) {
                this.pinchStartDist = null;
                this.pinchStartZoom = null;
                this.pinchCenterX   = null;
                this.pinchCenterY   = null;
                // 中止雙指平移，殘餘單指不應觸發單指平移（panScrollLeft 已過期）
                this.isPanning = false;
            }
            // 三指→雙指：以剩餘兩指重新初始化 pinch 基準，避免跳動
            if (this.activePointers.size === 2) {
                const ptrs2 = [...this.activePointers.values()];
                const dx2   = ptrs2[1].x - ptrs2[0].x;
                const dy2   = ptrs2[1].y - ptrs2[0].y;
                this.pinchStartDist = Math.hypot(dx2, dy2);
                this.pinchStartZoom = this.zoom;
                this.panStartX = (ptrs2[0].x + ptrs2[1].x) / 2;
                this.panStartY = (ptrs2[0].y + ptrs2[1].y) / 2;
            }
            if (this.activePointers.size === 1) {
                // 有殘餘手指 → 標記手勢仍活躍，pointermove 將忽略它
                this.gestureActive = true;
            }
            if (this.activePointers.size === 0) {
                this.gestureActive = false;
            }
            if (e.button === 1) {
                this.isPanning = false;
                this.canvas.style.cursor = this.tool === 'draw' ? 'crosshair' : (this.tool === 'text' ? 'text' : (this.tool === 'paintselect' ? 'crosshair' : (this.tool === 'pan' ? 'grab' : 'default')));
                return;
            }
            if (this.tool === 'paintselect') {
                if (this.selStart) {
                    const rect = this.getSelRect();
                    if (rect) this.extractFragment(rect);
                    this.selStart   = null;
                    this.selCurrent = null;
                    if (!rect) this.render();
                }
                this.paintFragDrag = null;
                return;
            }
            // 圖層圈選（rubber-band）結束 → 計算 multiSel
            if (this.tool === 'select' && this.imgSelStart && this.imgSelCurrent) {
                const x1 = Math.min(this.imgSelStart.x, this.imgSelCurrent.x);
                const y1 = Math.min(this.imgSelStart.y, this.imgSelCurrent.y);
                const x2 = Math.max(this.imgSelStart.x, this.imgSelCurrent.x);
                const y2 = Math.max(this.imgSelStart.y, this.imgSelCurrent.y);
                this.imgSelStart   = null;
                this.imgSelCurrent = null;
                if (x2 - x1 > 5 && y2 - y1 > 5) {
                    const imageIdxs = this.imageLayers.reduce((acc, l, i) => {
                        if (l.x + l.w > x1 && l.x < x2 && l.y + l.h > y1 && l.y < y2) acc.push(i);
                        return acc;
                    }, [] as number[]);
                    const textIdxs = this.textLayers.reduce((acc, tl, i) => {
                        const b = this.textBBox(tl);
                        if (b.x + b.w > x1 && b.x < x2 && b.y + b.h > y1 && b.y < y2) acc.push(i);
                        return acc;
                    }, [] as number[]);
                    const mdIdxs = this.markdownLayers.reduce((acc, ml, i) => {
                        const b = this.mdBBox(ml);
                        if (b.x + b.w > x1 && b.x < x2 && b.y + b.h > y1 && b.y < y2) acc.push(i);
                        return acc;
                    }, [] as number[]);
                    const total = imageIdxs.length + textIdxs.length + mdIdxs.length;
                    if (total > 1) {
                        this.multiSel = { imageIdxs, textIdxs, mdIdxs };
                        this.selectedIdx = -1; this.selectedTextIdx = -1; this.selectedMdIdx = -1;
                    } else if (imageIdxs.length === 1) {
                        this.selectedIdx = imageIdxs[0];
                    } else if (textIdxs.length === 1) {
                        this.selectedTextIdx = textIdxs[0];
                    } else if (mdIdxs.length === 1) {
                        this.selectedMdIdx = mdIdxs[0];
                    }
                }
                this.multiSelDrag = null;
                this.render();
                return;
            }
            this.multiSelDrag  = null;
            this.drawing       = false;
            this._vpCache      = null;  // 清除 viewport cache，觸發下一次完整渲染
            this.dragState     = null;
            this.textDragState = null;
            this.mdDragState   = null;
            this.scheduleRender();  // 筆觸結束後確保以完整畫布合成一次, (e) => {
            this.activePointers.delete(e.pointerId);
            if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; }
            if (this.activePointers.size === 0) {
                this.isPanning     = false;
                this.pinchStartDist = null;
                this.pinchStartZoom = null;
            }
        });
        this.canvas.addEventListener('pointerleave', (e) => {
            if (e.pointerType !== 'mouse') return;  // 觸控滑出由 pointerup/cancel 處理
            this.isPanning     = false;
            this.drawing       = false;
            this._vpCache      = null;
            this.dragState     = null;
            this.textDragState = null;
            this.mdDragState   = null;
            this.paintFragDrag = null;
            if (this.selStart) { this.selStart = null; this.selCurrent = null; this.render(); }
            this.multiSelDrag = null;
            if (this.imgSelStart) { this.imgSelStart = null; this.imgSelCurrent = null; this.render(); }
        });

        // 雙擊選取模式下編輯文字 / Markdown
        this.canvas.addEventListener('dblclick', (e) => {
            if (this.tool !== 'select') return;
            const { x: mx, y: my } = this.toCanvasCoords(e);
            for (let i = this.markdownLayers.length - 1; i >= 0; i--) {
                if (this.pointInMd(mx, my, this.markdownLayers[i])) {
                    this.openMarkdownEditor(i);
                    return;
                }
            }
            for (let i = this.textLayers.length - 1; i >= 0; i--) {
                if (this.pointInText(mx, my, this.textLayers[i])) {
                    this.openTextEditor(this.textLayers[i].x, this.textLayers[i].y, i);
                    return;
                }
            }
        });

        // 滾輪縮放（Canva 風格，以游標位置為錨點）
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const ZOOM_STEP = 0.1;
            const MIN_ZOOM  = 0.1;
            const MAX_ZOOM  = 8.0;
            const oldZoom   = this.zoom;
            this.zoom = e.deltaY < 0
                ? Math.min(MAX_ZOOM, this.zoom + ZOOM_STEP)
                : Math.max(MIN_ZOOM, this.zoom - ZOOM_STEP);

            // 以游標為縮放錨點，調整捲軸使游標下方畫布點保持不動
            const wRect  = this.canvasWrapper.getBoundingClientRect();
            const cx     = e.clientX - wRect.left;
            const cy     = e.clientY - wRect.top;
            const ratio  = this.zoom / oldZoom;
            // 在 applyZoom 前先快照 scroll，避免瀏覽器 resize 後自動修改 scrollLeft
            const prevSL = this.canvasWrapper.scrollLeft;
            const prevST = this.canvasWrapper.scrollTop;
            this.applyZoom();
            this.canvasWrapper.scrollLeft = (prevSL + cx) * ratio - cx;
            this.canvasWrapper.scrollTop  = (prevST + cy) * ratio - cy;
            this.refreshStatus();
        }, { passive: false });

        // 拖曳圖片進入
        this.canvas.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.canvas.addClass('easynote-drag-over');
        });
        this.canvas.addEventListener('dragleave', () => this.canvas.removeClass('easynote-drag-over'));
        this.canvas.addEventListener('drop', (e) => {
            e.preventDefault();
            this.canvas.removeClass('easynote-drag-over');
            const file = e.dataTransfer?.files?.[0];
            if (file && file.type.startsWith('image/')) { this.loadImageFromBlob(file); return; }
            const text = e.dataTransfer?.getData('text/plain').trim();
            if (text) {
                const vf = this.app.vault.getFileByPath(normalizePath(text));
                if (vf) this.loadImageFromVault(vf);
                else new Notice(`EasyNote：找不到 Vault 檔案「${text}」`);
            }
        });
    }

    // ── Canvas 大小調整 ───────────────────────────────────────────────────────

    private applyCanvasSize(w: number, h: number): void {
        const PS  = this.paintScale;
        const pw  = Math.max(1, Math.round(w * PS));
        const ph  = Math.max(1, Math.round(h * PS));
        // 備份 paintCanvas（保留原始 PS 尺寸內容）
        const tmp = document.createElement('canvas');
        tmp.width  = this.paintCanvas.width  || pw;
        tmp.height = this.paintCanvas.height || ph;
        tmp.getContext('2d')!.drawImage(this.paintCanvas, 0, 0);

        this.paintCanvas.width  = pw;
        this.paintCanvas.height = ph;
        // 不填白底，讓繪畫層保持透明（舊內容由 tmp 還原）
        this.paintCtx.drawImage(tmp, 0, 0);

        this.canvas.width  = w;
        this.canvas.height = h;
        this.render();
        this.applyZoom();
    }

    private resizeCanvas(fromWindowResize = false): void {
        if (this.manualWidth > 0 && this.manualHeight > 0) {
            // 視窗縮放事件不重設手動尺寸（避免清空畫布），只在初始化時套用
            if (!fromWindowResize) {
                this.applyCanvasSize(this.manualWidth, this.manualHeight);
            }
            return;
        }
        const w = Math.max(1, this.canvasWrapper.clientWidth);
        const h = Math.max(1, this.canvasWrapper.clientHeight);
        this.applyCanvasSize(w, h);
    }

    setCanvasSize(w: number, h: number): void {
        this.pushHistory('調整畫布大小');                 // 調整畫布前先存快照
        this.manualWidth  = w;
        this.manualHeight = h;
        this.applyCanvasSize(w, h);
    }

    /** 套用目前縮放比例到 canvas CSS 尺寸 */
    private applyZoom(): void {
        this.canvas.style.width  = `${this.canvas.width  * this.zoom}px`;
        this.canvas.style.height = `${this.canvas.height * this.zoom}px`;
    }

    /** 將滑鼠 offsetX/offsetY (CSS px) 轉換為畫布邏輯座標 */
    private toCanvasCoords(e: MouseEvent | PointerEvent): { x: number; y: number } {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) / this.zoom,
            y: (e.clientY - rect.top)  / this.zoom,
        };
    }

    // ── 合成渲染 ──────────────────────────────────────────────────────────────

    private render(clip?: { x: number; y: number; w: number; h: number }): void {
        if (clip) {
            // 項目區域渲染：僅清除 + 重繪可見 viewport，其餘區域像素不動
            const { x, y, w, h } = clip;
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(x, y, w, h);
            this.ctx.clip();
            this.ctx.clearRect(x, y, w, h);
            this.ctx.fillStyle = '#ffffff';
            this.ctx.fillRect(x, y, w, h);
        } else {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            // 1. 白底
            this.ctx.fillStyle = '#ffffff';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }
        // 2. 圖片層（底部）
        for (const lay of this.imageLayers) {
            const rot = lay.rotation || 0;
            this.ctx.save();
            const cx = lay.x + lay.w / 2, cy = lay.y + lay.h / 2;
            this.ctx.translate(cx, cy);
            this.ctx.rotate(rot);
            this.ctx.drawImage(lay.img, -lay.w / 2, -lay.h / 2, lay.w, lay.h);
            this.ctx.restore();
        }
        // 2b. Markdown 圖層（圖片層上方）
        for (const ml of this.markdownLayers) {
            const rot = ml.rotation || 0;
            if (rot !== 0) {
                const b  = this.mdBBox(ml);
                const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
                this.ctx.save();
                this.ctx.translate(cx, cy);
                this.ctx.rotate(rot);
                this.ctx.translate(-cx, -cy);
                ml._cachedH = this.drawMarkdownContent(this.ctx, ml);
                this.ctx.restore();
            } else {
                ml._cachedH = this.drawMarkdownContent(this.ctx, ml);
            }
        }
        // 3. 文字層（圖片上方，繪畫層下方）
        for (const tl of this.textLayers) {
            this.ctx.save();
            const rot = tl.rotation || 0;
            if (rot !== 0) {
                const b  = this.textBBox(tl);
                const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
                this.ctx.translate(cx, cy);
                this.ctx.rotate(rot);
                this.ctx.translate(-cx, -cy);
            }
            this.ctx.font         = `${tl.fontSize}px sans-serif`;
            this.ctx.textBaseline = 'top';
            const lines = tl.text.split('\n');
            const lineH = tl.fontSize * 1.3;
            for (let li = 0; li < lines.length; li++) {
                let cx = tl.x;
                const cy = tl.y + li * lineH;
                for (const seg of parseWikilinks(lines[li])) {
                    const w = this.ctx.measureText(seg.text).width;
                    if (seg.isLink) {
                        this.ctx.fillStyle = '#4a9eff';
                        this.ctx.fillText(seg.text, cx, cy);
                        // underline
                        this.ctx.strokeStyle = '#4a9eff';
                        this.ctx.lineWidth   = Math.max(1, tl.fontSize * 0.06);
                        this.ctx.beginPath();
                        this.ctx.moveTo(cx,     cy + tl.fontSize + 1);
                        this.ctx.lineTo(cx + w, cy + tl.fontSize + 1);
                        this.ctx.stroke();
                    } else {
                        this.ctx.fillStyle = tl.color;
                        this.ctx.fillText(seg.text, cx, cy);
                    }
                    cx += w;
                }
            }
            this.ctx.restore();
        }
        // 4. 繪畫層（最上方）
        // 筆觸期間：使用小型 viewport cache 避免上傳 128MB+ 大畫布紋理
        if (this.drawing && this._vpCache) {
            this.ctx.drawImage(this._vpCache, this._vpCacheX, this._vpCacheY);
        } else {
            // 一般情況：完整畫布合成（paintScale < 1 時自動拉伸回全畫布尺寸）
            this.ctx.drawImage(this.paintCanvas, 0, 0, this.canvas.width, this.canvas.height);
        }
        // 4a. 繪畫選取 fragment（繪畫層上方）
        if (this.paintFragment) {
            const f   = this.paintFragment;
            const rot = f.rotation || 0;
            const cx  = f.x + f.w / 2, cy = f.y + f.h / 2;
            this.ctx.save();
            this.ctx.translate(cx, cy);
            this.ctx.rotate(rot);
            this.ctx.drawImage(f.offscreen, 0, 0, f.offscreen.width, f.offscreen.height, -f.w / 2, -f.h / 2, f.w, f.h);
            this.ctx.restore();
        }
        // 5. 選取框 & 控點
        if (this.tool === 'select') {
            if (this.selectedIdx >= 0) {
                this.drawSelectionHandles(this.imageLayers[this.selectedIdx]);
            }
            if (this.selectedMdIdx >= 0 && this.selectedMdIdx < this.markdownLayers.length) {
                this.drawMdSelectionBox(this.markdownLayers[this.selectedMdIdx]);
            }
            if (this.selectedTextIdx >= 0 && this.selectedTextIdx < this.textLayers.length) {
                this.drawTextSelectionBox(this.textLayers[this.selectedTextIdx]);
            }
            // 圈選橡皮筋框
            if (this.imgSelStart && this.imgSelCurrent) {
                const x1 = Math.min(this.imgSelStart.x, this.imgSelCurrent.x);
                const y1 = Math.min(this.imgSelStart.y, this.imgSelCurrent.y);
                const x2 = Math.max(this.imgSelStart.x, this.imgSelCurrent.x);
                const y2 = Math.max(this.imgSelStart.y, this.imgSelCurrent.y);
                this.ctx.save();
                this.ctx.strokeStyle = '#0088ff';
                this.ctx.lineWidth   = 1.5;
                this.ctx.setLineDash([5, 3]);
                this.ctx.fillStyle   = 'rgba(0,136,255,0.06)';
                this.ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
                this.ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
                this.ctx.restore();
            }
            // 多圖層選取框
            if (this.multiSel) {
                this.drawMultiSelBox();
            }
        }
        // 6. 繪畫選取工具的選框 / fragment 控點
        if (this.tool === 'paintselect') {
            if (this.selStart && this.selCurrent) {
                const r = this.getSelRect();
                if (r) {
                    this.ctx.save();
                    this.ctx.strokeStyle = '#ff6600';
                    this.ctx.lineWidth   = 1.5;
                    this.ctx.setLineDash([5, 3]);
                    this.ctx.fillStyle   = 'rgba(255,102,0,0.08)';
                    this.ctx.fillRect(r.x, r.y, r.w, r.h);
                    this.ctx.strokeRect(r.x, r.y, r.w, r.h);
                    this.ctx.restore();
                }
            }
            if (this.paintFragment) {
                this.drawFragmentHandles(this.paintFragment);
            }
        }
        // 每次畫面更新後排程自動儲存（debounce）
        if (clip) this.ctx.restore();
        this.scheduleAutosave();
    }

    private cornerPositions(lay: ImageLayer): [number, number][] {
        return this.rotatedCorners(lay.x, lay.y, lay.w, lay.h, lay.rotation || 0);
    }

    // ── 旋轉 helpers ──────────────────────────────────────────────────────────
    private static readonly ROTATE_HANDLE_OFFSET = 28; // px above top edge

    /** 旋轉控點（圓形）在世界座標中的位置 */
    private rotateHandleWorldPos(x: number, y: number, w: number, h: number, rot: number): [number, number] {
        const cx = x + w / 2, cy = y + h / 2;
        const offset = h / 2 + EasyNoteView.ROTATE_HANDLE_OFFSET;
        const c = Math.cos(rot), s = Math.sin(rot);
        // local: (0, -offset) 旋轉到世界空間
        return [cx + 0 * c - (-offset) * s, cy + 0 * s + (-offset) * c];
    }

    /** 回傳旋轉後的四個角落世界座標（順序：nw, ne, sw, se） */
    private rotatedCorners(x: number, y: number, w: number, h: number, rot: number): [number, number][] {
        const cx = x + w / 2, cy = y + h / 2;
        const hw = w / 2, hh = h / 2;
        const c = Math.cos(rot), s = Math.sin(rot);
        return ([ [-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh] ] as [number, number][]).map(
            ([lx, ly]) => [cx + lx * c - ly * s, cy + lx * s + ly * c] as [number, number]);
    }

    /** 點擊測試：考慮旋轉的矩形 */
    private pointInRotatedRect(mx: number, my: number, x: number, y: number, w: number, h: number, rot: number): boolean {
        const cx = x + w / 2, cy = y + h / 2;
        const c = Math.cos(-rot), s = Math.sin(-rot);
        const dx = mx - cx, dy = my - cy;
        const lx = dx * c - dy * s, ly = dx * s + dy * c;
        return Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2;
    }

    /** 繪製旋轉控點（圓形 + 連接線） */
    private drawRotateHandle(topCx: number, topCy: number, rhx: number, rhy: number, color: string): void {
        // 連線
        this.ctx.save();
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth   = 1.5;
        this.ctx.setLineDash([3, 2]);
        this.ctx.beginPath();
        this.ctx.moveTo(topCx, topCy);
        this.ctx.lineTo(rhx, rhy);
        this.ctx.stroke();
        // 圓形控點
        this.ctx.setLineDash([]);
        this.ctx.fillStyle   = '#ffffff';
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth   = 1.5;
        this.ctx.beginPath();
        this.ctx.arc(rhx, rhy, HANDLE_SIZE * 1.275, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.stroke();
        // 旋轉箭頭指示符
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth   = 1.2;
        this.ctx.beginPath();
        this.ctx.arc(rhx, rhy, HANDLE_SIZE * 0.63, 0.3, Math.PI * 1.7);
        this.ctx.stroke();
        this.ctx.restore();
    }

    private drawSelectionHandles(lay: ImageLayer): void {
        const rot     = lay.rotation || 0;
        const corners = this.rotatedCorners(lay.x, lay.y, lay.w, lay.h, rot);
        const [cnw, cne, csw, cse] = corners; // nw, ne, sw, se
        // 虛線框（四點連線）
        this.ctx.save();
        this.ctx.strokeStyle = '#0066ff';
        this.ctx.lineWidth   = 1.5;
        this.ctx.setLineDash([5, 3]);
        this.ctx.beginPath();
        this.ctx.moveTo(cnw[0], cnw[1]);
        this.ctx.lineTo(cne[0], cne[1]);
        this.ctx.lineTo(cse[0], cse[1]);
        this.ctx.lineTo(csw[0], csw[1]);
        this.ctx.closePath();
        this.ctx.stroke();
        this.ctx.restore();
        // 四個角控點
        const hs = HANDLE_SIZE / 2;
        for (const [cx, cy] of corners) {
            this.ctx.save();
            this.ctx.setLineDash([]);
            this.ctx.fillStyle   = '#ffffff';
            this.ctx.strokeStyle = '#0066ff';
            this.ctx.lineWidth   = 1.5;
            this.ctx.fillRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.strokeRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.restore();
        }
        // 旋轉控點
        const [rhx, rhy] = this.rotateHandleWorldPos(lay.x, lay.y, lay.w, lay.h, rot);
        const topCx = (cnw[0] + cne[0]) / 2, topCy = (cnw[1] + cne[1]) / 2;
        this.drawRotateHandle(topCx, topCy, rhx, rhy, '#0066ff');
    }

    private hitHandle(mx: number, my: number, lay: ImageLayer): HandleType | null {
        const rot     = lay.rotation || 0;
        const corners = this.rotatedCorners(lay.x, lay.y, lay.w, lay.h, rot);
        const names: HandleType[] = ['nw', 'ne', 'sw', 'se'];
        // 旋轉控點優先
        const [rhx, rhy] = this.rotateHandleWorldPos(lay.x, lay.y, lay.w, lay.h, rot);
        if (Math.hypot(mx - rhx, my - rhy) <= HANDLE_SIZE * 2.4) return 'rotate';
        const hs = HANDLE_SIZE;
        for (let i = 0; i < 4; i++) {
            const [cx, cy] = corners[i];
            if (mx >= cx - hs && mx <= cx + hs && my >= cy - hs && my <= cy + hs) return names[i];
        }
        return null;
    }

    private pointInLayer(mx: number, my: number, lay: ImageLayer): boolean {
        return this.pointInRotatedRect(mx, my, lay.x, lay.y, lay.w, lay.h, lay.rotation || 0);
    }

    /** 回傳文字圖層的近似包圍矩形 */
    private textBBox(tl: TextLayer): { x: number; y: number; w: number; h: number } {
        const lines  = tl.text.split('\n');
        const maxLen = Math.max(...lines.map(l => l.length), 1);
        const w      = maxLen * tl.fontSize * 0.6;
        const h      = lines.length * tl.fontSize * 1.3;
        return { x: tl.x, y: tl.y, w, h };
    }

    private pointInText(mx: number, my: number, tl: TextLayer): boolean {
        const b = this.textBBox(tl);
        return this.pointInRotatedRect(mx, my, b.x, b.y, b.w, b.h, tl.rotation || 0);
    }

    private drawTextSelectionBox(tl: TextLayer): void {
        const b       = this.textBBox(tl);
        const rot     = tl.rotation || 0;
        const linked  = !!tl.linkedNotePath;
        const color   = linked ? '#22aa44' : '#0066ff';
        const corners = this.rotatedCorners(b.x - 2, b.y - 2, b.w + 4, b.h + 4, rot);
        const [cnw, cne, csw, cse] = corners;
        this.ctx.save();
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth   = 1.5;
        this.ctx.setLineDash([5, 3]);
        this.ctx.beginPath();
        this.ctx.moveTo(cnw[0], cnw[1]);
        this.ctx.lineTo(cne[0], cne[1]);
        this.ctx.lineTo(cse[0], cse[1]);
        this.ctx.lineTo(csw[0], csw[1]);
        this.ctx.closePath();
        this.ctx.stroke();
        this.ctx.restore();
        const hs = HANDLE_SIZE / 2;
        for (const [cx, cy] of corners) {
            this.ctx.save();
            this.ctx.setLineDash([]);
            this.ctx.fillStyle   = '#ffffff';
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth   = 1.5;
            this.ctx.fillRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.strokeRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.restore();
        }
        const [rhx, rhy] = this.rotateHandleWorldPos(b.x - 2, b.y - 2, b.w + 4, b.h + 4, rot);
        const topCx = (cnw[0] + cne[0]) / 2, topCy = (cnw[1] + cne[1]) / 2;
        this.drawRotateHandle(topCx, topCy, rhx, rhy, color);
    }

    private hitTextHandle(mx: number, my: number, tl: TextLayer): HandleType | null {
        const b       = this.textBBox(tl);
        const rot     = tl.rotation || 0;
        const corners = this.rotatedCorners(b.x, b.y, b.w, b.h, rot);
        const names: HandleType[] = ['nw', 'ne', 'sw', 'se'];
        const [rhx, rhy] = this.rotateHandleWorldPos(b.x, b.y, b.w, b.h, rot);
        if (Math.hypot(mx - rhx, my - rhy) <= HANDLE_SIZE * 2.4) return 'rotate';
        const hs = HANDLE_SIZE;
        for (let i = 0; i < 4; i++) {
            const [cx, cy] = corners[i];
            if (mx >= cx - hs && mx <= cx + hs && my >= cy - hs && my <= cy + hs) return names[i];
        }
        return null;
    }

    // ── 繪畫選取 helpers ──────────────────────────────────────────────────────

    private getSelRect(): { x: number; y: number; w: number; h: number } | null {
        if (!this.selStart || !this.selCurrent) return null;
        const x = Math.round(Math.min(this.selStart.x, this.selCurrent.x));
        const y = Math.round(Math.min(this.selStart.y, this.selCurrent.y));
        const w = Math.round(Math.abs(this.selCurrent.x - this.selStart.x));
        const h = Math.round(Math.abs(this.selCurrent.y - this.selStart.y));
        return w > 2 && h > 2 ? { x, y, w, h } : null;
    }

    private extractFragment(r: { x: number; y: number; w: number; h: number }): void {
        const PS             = this.paintScale;
        const offscreen      = document.createElement('canvas');
        offscreen.width      = r.w;
        offscreen.height     = r.h;
        // paintCanvas 儲存於 PS 縮放尺寸，讀取時需乘以 PS
        offscreen.getContext('2d')!.drawImage(
            this.paintCanvas,
            r.x * PS, r.y * PS, r.w * PS, r.h * PS,
            0, 0, r.w, r.h,
        );
        // 從 paintCanvas 挖除選取區
        this.paintCtx.save();
        this.paintCtx.globalCompositeOperation = 'destination-out';
        this.paintCtx.fillStyle = 'rgba(0,0,0,1)';
        this.paintCtx.fillRect(r.x * PS, r.y * PS, r.w * PS, r.h * PS);
        this.paintCtx.restore();
        this.paintFragment = { offscreen, x: r.x, y: r.y, w: r.w, h: r.h };
        this.render();
    }

    private commitFragment(): void {
        if (!this.paintFragment) return;
        this.pushHistory('合併繪畫區塊');                 // 合併繪畫區塊前先存快照
        const PS  = this.paintScale;
        const f   = this.paintFragment;
        const rot = f.rotation || 0;
        if (rot !== 0) {
            const cx = (f.x + f.w / 2) * PS, cy = (f.y + f.h / 2) * PS;
            this.paintCtx.save();
            this.paintCtx.translate(cx, cy);
            this.paintCtx.rotate(rot);
            this.paintCtx.drawImage(f.offscreen, 0, 0, f.offscreen.width, f.offscreen.height, -f.w * PS / 2, -f.h * PS / 2, f.w * PS, f.h * PS);
            this.paintCtx.restore();
        } else {
            this.paintCtx.drawImage(f.offscreen, 0, 0, f.offscreen.width, f.offscreen.height, f.x * PS, f.y * PS, f.w * PS, f.h * PS);
        }
        this.paintFragment    = null;
        this.paintFragDrag    = null;
        this.proportionalScale = false;   // 離開 fragment 時重設等比例鎖定
        this.render();
    }

    private cancelFragment(): void {
        // 將 fragment 放回目前位置（不保留浮動狀態）
        this.commitFragment();
    }

    private hitFragHandle(mx: number, my: number): HandleType | null {
        if (!this.paintFragment) return null;
        const { x, y, w, h } = this.paintFragment;
        const rot     = this.paintFragment.rotation || 0;
        const corners = this.rotatedCorners(x, y, w, h, rot);
        const names: HandleType[] = ['nw', 'ne', 'sw', 'se'];
        // 旋轉控點優先
        const [rhx, rhy] = this.rotateHandleWorldPos(x, y, w, h, rot);
        if (Math.hypot(mx - rhx, my - rhy) <= HANDLE_SIZE * 2.4) return 'rotate';
        const hs = HANDLE_SIZE;
        for (let i = 0; i < 4; i++) {
            const [cx, cy] = corners[i];
            if (mx >= cx - hs && mx <= cx + hs && my >= cy - hs && my <= cy + hs) return names[i];
        }
        return null;
    }

    private pointInFrag(mx: number, my: number): boolean {
        if (!this.paintFragment) return false;
        const { x, y, w, h } = this.paintFragment;
        return this.pointInRotatedRect(mx, my, x, y, w, h, this.paintFragment.rotation || 0);
    }

    private drawFragmentHandles(frag: PaintFragment): void {
        const { x, y, w, h } = frag;
        const rot     = frag.rotation || 0;
        const corners = this.rotatedCorners(x, y, w, h, rot);
        const [cnw, cne, csw, cse] = corners;
        this.ctx.save();
        this.ctx.strokeStyle = '#ff6600';
        this.ctx.lineWidth   = 1.5;
        this.ctx.setLineDash([5, 3]);
        this.ctx.beginPath();
        this.ctx.moveTo(cnw[0], cnw[1]);
        this.ctx.lineTo(cne[0], cne[1]);
        this.ctx.lineTo(cse[0], cse[1]);
        this.ctx.lineTo(csw[0], csw[1]);
        this.ctx.closePath();
        this.ctx.stroke();
        this.ctx.restore();
        const hs = HANDLE_SIZE / 2;
        for (const [cx, cy] of corners) {
            this.ctx.save();
            this.ctx.setLineDash([]);
            this.ctx.fillStyle   = '#ffffff';
            this.ctx.strokeStyle = '#ff6600';
            this.ctx.lineWidth   = 1.5;
            this.ctx.fillRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.strokeRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.restore();
        }
        const [rhx, rhy] = this.rotateHandleWorldPos(x, y, w, h, rot);
        const topCx = (cnw[0] + cne[0]) / 2, topCy = (cnw[1] + cne[1]) / 2;
        this.drawRotateHandle(topCx, topCy, rhx, rhy, '#ff6600');
    }

    // ── 多圖層選取 helpers ────────────────────────────────────────────────────

    private getMultiSelBBox(): { x: number; y: number; w: number; h: number } | null {
        if (!this.multiSel) return null;
        const rects: { x: number; y: number; r: number; b: number }[] = [];
        for (const i of this.multiSel.imageIdxs) {
            const l = this.imageLayers[i];
            rects.push({ x: l.x, y: l.y, r: l.x + l.w, b: l.y + l.h });
        }
        for (const i of this.multiSel.textIdxs) {
            const bb = this.textBBox(this.textLayers[i]);
            rects.push({ x: bb.x, y: bb.y, r: bb.x + bb.w, b: bb.y + bb.h });
        }
        for (const i of this.multiSel.mdIdxs) {
            const bb = this.mdBBox(this.markdownLayers[i]);
            rects.push({ x: bb.x, y: bb.y, r: bb.x + bb.w, b: bb.y + bb.h });
        }
        if (rects.length === 0) return null;
        const x = Math.min(...rects.map(r => r.x));
        const y = Math.min(...rects.map(r => r.y));
        const rx = Math.max(...rects.map(r => r.r));
        const by = Math.max(...rects.map(r => r.b));
        return { x, y, w: rx - x, h: by - y };
    }

    private hitMultiSelHandle(mx: number, my: number): HandleType | null {
        const bbox = this.getMultiSelBBox();
        if (!bbox) return null;
        const { x, y, w, h } = bbox;
        const hs = HANDLE_SIZE;
        const corners: [HandleType, number, number][] = [
            ['nw', x,     y    ],
            ['ne', x + w, y    ],
            ['sw', x,     y + h],
            ['se', x + w, y + h],
        ];
        for (const [type, cx, cy] of corners) {
            if (mx >= cx - hs && mx <= cx + hs && my >= cy - hs && my <= cy + hs) return type;
        }
        return null;
    }

    private pointInMultiSelBBox(mx: number, my: number): boolean {
        const bbox = this.getMultiSelBBox();
        if (!bbox) return false;
        return mx >= bbox.x && mx <= bbox.x + bbox.w && my >= bbox.y && my <= bbox.y + bbox.h;
    }

    private drawMultiSelBox(): void {
        const bbox = this.getMultiSelBBox();
        if (!bbox) return;
        const { x, y, w, h } = bbox;
        const pad = 6;
        const bx = x - pad, by = y - pad, bw = w + pad * 2, bh = h + pad * 2;
        this.ctx.save();
        this.ctx.strokeStyle = '#aa33ff';
        this.ctx.lineWidth   = 1.5;
        this.ctx.setLineDash([6, 3]);
        this.ctx.fillStyle   = 'rgba(170,51,255,0.04)';
        this.ctx.fillRect(bx, by, bw, bh);
        this.ctx.strokeRect(bx, by, bw, bh);
        this.ctx.restore();
        const hs = HANDLE_SIZE / 2;
        for (const [cx, cy] of [[bx, by], [bx + bw, by], [bx, by + bh], [bx + bw, by + bh]] as [number, number][]) {
            this.ctx.save();
            this.ctx.setLineDash([]);
            this.ctx.fillStyle   = '#ffffff';
            this.ctx.strokeStyle = '#aa33ff';
            this.ctx.lineWidth   = 1.5;
            this.ctx.fillRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.strokeRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.restore();
        }
    }

    private updateCursor(mx: number, my: number): void {
        if (this.dragState || this.textDragState || this.mdDragState || this.multiSelDrag) return;
        // 多圖層群組控點
        if (this.multiSel) {
            const mh = this.hitMultiSelHandle(mx, my);
            if (mh === 'nw' || mh === 'se') { this.canvas.style.cursor = 'nwse-resize'; return; }
            if (mh === 'ne' || mh === 'sw') { this.canvas.style.cursor = 'nesw-resize'; return; }
            if (this.pointInMultiSelBBox(mx, my)) { this.canvas.style.cursor = 'move'; return; }
        }
        if (this.selectedIdx >= 0) {
            const h = this.hitHandle(mx, my, this.imageLayers[this.selectedIdx]);
            if (h === 'nw' || h === 'se') { this.canvas.style.cursor = 'nwse-resize'; return; }
            if (h === 'ne' || h === 'sw') { this.canvas.style.cursor = 'nesw-resize'; return; }
        }
        // 文字層控點
        if (this.selectedTextIdx >= 0 && this.selectedTextIdx < this.textLayers.length) {
            const h = this.hitTextHandle(mx, my, this.textLayers[this.selectedTextIdx]);
            if (h === 'nw' || h === 'se') { this.canvas.style.cursor = 'nwse-resize'; return; }
            if (h === 'ne' || h === 'sw') { this.canvas.style.cursor = 'nesw-resize'; return; }
        }
        // Markdown 層控點
        if (this.selectedMdIdx >= 0 && this.selectedMdIdx < this.markdownLayers.length) {
            const h = this.hitMdHandle(mx, my, this.markdownLayers[this.selectedMdIdx]);
            if (h === 'nw' || h === 'se') { this.canvas.style.cursor = 'nwse-resize'; return; }
            if (h === 'ne' || h === 'sw') { this.canvas.style.cursor = 'nesw-resize'; return; }
        }
        // 文字層
        for (let i = this.textLayers.length - 1; i >= 0; i--) {
            if (this.pointInText(mx, my, this.textLayers[i])) {
                // 若游標在 [[wikilink]] 上，顯示 pointer
                if (this.getWikilinkAt(mx, my)) {
                    this.canvas.style.cursor = 'pointer'; return;
                }
                this.canvas.style.cursor = 'move'; return;
            }
        }
        // Markdown 層
        for (let i = this.markdownLayers.length - 1; i >= 0; i--) {
            if (this.pointInMd(mx, my, this.markdownLayers[i])) {
                if (this.getMdWikilinkAt(mx, my)) {
                    this.canvas.style.cursor = 'pointer'; return;
                }
                this.canvas.style.cursor = 'move'; return;
            }
        }
        for (let i = this.imageLayers.length - 1; i >= 0; i--) {
            if (this.pointInLayer(mx, my, this.imageLayers[i])) {
                this.canvas.style.cursor = 'move'; return;
            }
        }
        this.canvas.style.cursor = 'default';
    }

    // ── Wikilink 點擊偵測 ──────────────────────────────────────────────────────
    /** 回傳 (mx,my) 位置下的 [[wikilink]] noteName，無則 null */
    private getWikilinkAt(mx: number, my: number): string | null {
        this.ctx.save();
        for (const tl of this.textLayers) {
            this.ctx.font = `${tl.fontSize}px sans-serif`;
            const lines = tl.text.split('\n');
            const lineH = tl.fontSize * 1.3;
            for (let li = 0; li < lines.length; li++) {
                const cy = tl.y + li * lineH;
                if (my < cy || my > cy + tl.fontSize * 1.3) continue;
                let cx = tl.x;
                for (const seg of parseWikilinks(lines[li])) {
                    const w = this.ctx.measureText(seg.text).width;
                    if (seg.isLink && mx >= cx && mx <= cx + w) {
                        this.ctx.restore();
                        return seg.noteName!;
                    }
                    cx += w;
                }
            }
        }
        this.ctx.restore();
        return null;
    }

    /** 回傳 (mx,my) 位置下的 Markdown 圖層 [[wikilink]] noteName，無則 null */
    private getMdWikilinkAt(mx: number, my: number): string | null {
        const ctx = this.ctx;
        ctx.save();
        for (const ml of this.markdownLayers) {
            if (!this.pointInMd(mx, my, ml)) continue;

            const base = ml.fontSize;
            const LH   = base * 1.4;
            const HSZ  = [base * 1.9, base * 1.5, base * 1.2];
            const x0   = ml.x;
            let y = ml.y;

            // Skip linked-note title header
            if (ml.linkedNotePath) {
                y += base * 1.0;   // title text line
                y += base * 0.45;  // separator gap
            }

            const lines    = ml.text.split('\n');
            let inFence    = false;
            let fenceCount = 0;

            for (const rawLine of lines) {
                if (rawLine.trimStart().startsWith('```')) {
                    if (!inFence) { inFence = true; fenceCount = 0; }
                    else { inFence = false; y += fenceCount * LH * 0.85 + base * 0.4; }
                    continue;
                }
                if (inFence) { fenceCount++; continue; }
                if (rawLine.trim() === '') { y += LH * 0.5; continue; }
                if (/^[-*_]{3,}\s*$/.test(rawLine.trim())) { y += LH; continue; }

                // heading — simulate height, no wikilink hit-test inside headings
                const hm = rawLine.match(/^(#{1,3})\s+(.*)/);
                if (hm) {
                    const lvl = Math.min(3, hm[1].length) - 1;
                    const hSz = HSZ[lvl];
                    const hLH = hSz * 1.35;
                    y += base * 0.2;
                    ctx.font = `bold ${hSz}px sans-serif`;
                    let hx = x0, hy = y;
                    for (const w of hm[2].split(' ')) {
                        if (!w) continue;
                        const ww = ctx.measureText(w + ' ').width;
                        if (hx > x0 && hx + ww > x0 + ml.width) { hy += hLH; hx = x0; }
                        hx += ww;
                    }
                    y = hy + hLH + base * 0.2;
                    continue;
                }

                // blockquote / bullet / numbered list / paragraph → inline line
                let text = rawLine, lineX = x0, lineMaxW = ml.width;
                const qm = rawLine.match(/^>\s?(.*)/);
                const bm = rawLine.match(/^(\s*)[-*+]\s+(.*)/);
                const nm = rawLine.match(/^(\s*)(\d+)\.\s+(.*)/);
                if (qm) {
                    text = qm[1]; lineX = x0 + 10; lineMaxW = ml.width - 10;
                } else if (bm) {
                    const ind = Math.floor(bm[1].length / 2) * (base * 1.2);
                    lineX = x0 + ind + base * 1.2; lineMaxW = ml.width - (lineX - x0); text = bm[2];
                } else if (nm) {
                    const ind = Math.floor(nm[1].length / 2) * (base * 1.2);
                    lineX = x0 + ind + base * 1.5; lineMaxW = ml.width - (lineX - x0); text = nm[3];
                }

                // Simulate drawInlineLine word-wrap to find link token positions
                const segs = this.parseInline(text);
                type Tok = { t: string; bold: boolean; italic: boolean; code: boolean; link: boolean; noteName?: string };
                const tokens: Tok[] = [];
                for (const seg of segs) {
                    for (const p of seg.text.split(/(\s+)/)) {
                        if (p.length > 0) tokens.push({
                            t: p, bold: !!seg.bold, italic: !!seg.italic,
                            code: !!seg.code, link: !!seg.link, noteName: seg.noteName,
                        });
                    }
                }
                let cx = lineX, cy = y, lineStart = true;
                for (const tok of tokens) {
                    const isSpace = /^\s+$/.test(tok.t);
                    if (lineStart && isSpace) continue;
                    const font = tok.code
                        ? `${base * 0.85}px monospace`
                        : `${tok.italic ? 'italic ' : ''}${tok.bold ? 'bold ' : ''}${base}px sans-serif`;
                    ctx.font = font;
                    const tw = ctx.measureText(tok.t).width;
                    if (!lineStart && cx + tw > lineX + lineMaxW) {
                        cy += LH; cx = lineX; lineStart = true;
                        if (isSpace) continue;
                    }
                    if (!isSpace && tok.link && tok.noteName) {
                        if (mx >= cx && mx <= cx + tw && my >= cy && my <= cy + base) {
                            ctx.restore();
                            return tok.noteName;
                        }
                    }
                    cx += tw;
                    lineStart = false;
                }
                y = cy + LH;
            }
        }
        ctx.restore();
        return null;
    }

    /** 回傳 (mx,my) 位置下的 Markdown 圖層 [text](url) 連結 URL，無則 null */
    private getMdUrlAt(mx: number, my: number): string | null {
        const ctx = this.ctx;
        ctx.save();
        for (const ml of this.markdownLayers) {
            if (!this.pointInMd(mx, my, ml)) continue;

            const base = ml.fontSize;
            const LH   = base * 1.4;
            const HSZ  = [base * 1.9, base * 1.5, base * 1.2];
            const x0   = ml.x;
            let y = ml.y;

            if (ml.linkedNotePath) { y += base * 1.0; y += base * 0.45; }

            const lines    = ml.text.split('\n');
            let inFence    = false;
            let fenceCount = 0;

            for (const rawLine of lines) {
                if (rawLine.trimStart().startsWith('```')) {
                    if (!inFence) { inFence = true; fenceCount = 0; }
                    else { inFence = false; y += fenceCount * LH * 0.85 + base * 0.4; }
                    continue;
                }
                if (inFence) { fenceCount++; continue; }
                if (rawLine.trim() === '') { y += LH * 0.5; continue; }
                if (/^[-*_]{3,}\s*$/.test(rawLine.trim())) { y += LH; continue; }

                const hm = rawLine.match(/^(#{1,3})\s+(.*)/);
                if (hm) {
                    const lvl = Math.min(3, hm[1].length) - 1;
                    const hSz = HSZ[lvl];
                    const hLH = hSz * 1.35;
                    y += base * 0.2;
                    ctx.font = `bold ${hSz}px sans-serif`;
                    let hx = x0, hy = y;
                    for (const w of hm[2].split(' ')) {
                        if (!w) continue;
                        const ww = ctx.measureText(w + ' ').width;
                        if (hx > x0 && hx + ww > x0 + ml.width) { hy += hLH; hx = x0; }
                        hx += ww;
                    }
                    y = hy + hLH + base * 0.2;
                    continue;
                }

                let text = rawLine, lineX = x0, lineMaxW = ml.width;
                const qm = rawLine.match(/^>\s?(.*)/);
                const bm = rawLine.match(/^(\s*)[-*+]\s+(.*)/);
                const nm = rawLine.match(/^(\s*)(\d+)\.\s+(.*)/);
                if (qm) {
                    text = qm[1]; lineX = x0 + 10; lineMaxW = ml.width - 10;
                } else if (bm) {
                    const ind = Math.floor(bm[1].length / 2) * (base * 1.2);
                    lineX = x0 + ind + base * 1.2; lineMaxW = ml.width - (lineX - x0); text = bm[2];
                } else if (nm) {
                    const ind = Math.floor(nm[1].length / 2) * (base * 1.2);
                    lineX = x0 + ind + base * 1.5; lineMaxW = ml.width - (lineX - x0); text = nm[3];
                }

                const segs = this.parseInline(text);
                type Tok = { t: string; bold: boolean; italic: boolean; code: boolean; link: boolean; url?: string };
                const tokens: Tok[] = [];
                for (const seg of segs) {
                    for (const p of seg.text.split(/(\s+)/)) {
                        if (p.length > 0) tokens.push({
                            t: p, bold: !!seg.bold, italic: !!seg.italic,
                            code: !!seg.code, link: !!seg.link, url: seg.url,
                        });
                    }
                }
                let cx = lineX, cy = y, lineStart = true;
                for (const tok of tokens) {
                    const isSpace = /^\s+$/.test(tok.t);
                    if (lineStart && isSpace) continue;
                    const font = tok.code
                        ? `${base * 0.85}px monospace`
                        : `${tok.italic ? 'italic ' : ''}${tok.bold ? 'bold ' : ''}${base}px sans-serif`;
                    ctx.font = font;
                    const tw = ctx.measureText(tok.t).width;
                    if (!lineStart && cx + tw > lineX + lineMaxW) {
                        cy += LH; cx = lineX; lineStart = true;
                        if (isSpace) continue;
                    }
                    if (!isSpace && tok.link && tok.url) {
                        if (mx >= cx && mx <= cx + tw && my >= cy && my <= cy + base) {
                            ctx.restore();
                            return tok.url;
                        }
                    }
                    cx += tw;
                    lineStart = false;
                }
                y = cy + LH;
            }
        }
        ctx.restore();
        return null;
    }

    private activeColor(): string {
        return this.eraser ? '#000000' : this.colors[this.colorIdx];
    }

    /** 依設定時區產生本地時間戳記字串，格式 YYYY-MM-DDTHH-MM-SS */
    private localTimestamp(): string {
        const tz = this.settings.timezone || 'Asia/Taipei';
        const now = new Date();
        // Intl.DateTimeFormat 輸出本地時間各欄位，再組成檔名安全字串
        const fmt = new Intl.DateTimeFormat('sv-SE', {
            timeZone: tz,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
        });
        // sv-SE locale 輸出格式接近 ISO：2026-05-09 14-30-00
        return fmt.format(now).replace(' ', 'T').replace(/:/g, '-');
    }

    /** rAF-throttled render：繪畫期間每幀最多 composite 一次，避免大畫布卡頓 */
    private scheduleRender(): void {
        if (this._rafId !== null) return;
        this._rafId = requestAnimationFrame(() => {
            this._rafId = null;
            if (this.drawing) {
                // 繪畫中只重繪可見的 viewport 區域，避免 composite 整個大畫布
                const sl = this.canvasWrapper.scrollLeft;
                const st = this.canvasWrapper.scrollTop;
                this.render({
                    x: sl / this.zoom,
                    y: st / this.zoom,
                    w: this.canvasWrapper.clientWidth  / this.zoom,
                    h: this.canvasWrapper.clientHeight / this.zoom,
                });
            } else {
                this.render();
            }
        });
    }

    /** 在筆觸開始時初始化 viewport 畫布快取，畫筆期間 composite 這個小畫布而非全域大畫布 */
    private initViewportCache(): void {
        const sl = this.canvasWrapper.scrollLeft;
        const st = this.canvasWrapper.scrollTop;
        this._vpCacheX = sl / this.zoom;
        this._vpCacheY = st / this.zoom;
        const vw = Math.ceil(this.canvasWrapper.clientWidth  / this.zoom) + 2;
        const vh = Math.ceil(this.canvasWrapper.clientHeight / this.zoom) + 2;
        if (!this._vpCache || this._vpCache.width !== vw || this._vpCache.height !== vh) {
            this._vpCache = document.createElement('canvas');
            this._vpCache.width  = vw;
            this._vpCache.height = vh;
        }
        const ctx = this._vpCache.getContext('2d')!;
        ctx.clearRect(0, 0, vw, vh);
        const PS = this.paintScale;
        // 從 paintCanvas（PS 縮放）讀取 viewport 區域，拉伸回畫布座標
        ctx.drawImage(
            this.paintCanvas,
            this._vpCacheX * PS, this._vpCacheY * PS, vw * PS, vh * PS,
            0, 0, vw, vh,
        );
    }

    /** 將同一筆觸同步寫入 viewport cache（canvas 座標，無 PS 縮放） */
    private syncStrokeToCache(x1: number, y1: number, x2: number, y2: number): void {
        if (!this._vpCache) return;
        const ctx = this._vpCache.getContext('2d')!;
        ctx.save();
        ctx.translate(-this._vpCacheX, -this._vpCacheY);
        if (this.eraser) {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0,0,0,1)';
        } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = this.brushOpacity;
            ctx.strokeStyle = this.colors[this.colorIdx];
        }
        ctx.lineWidth = this.brushSize;
        ctx.lineCap   = 'round';
        ctx.lineJoin  = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
    }

    private paintDot(x: number, y: number): void {
        const PS = this.paintScale;
        this.paintCtx.save();
        if (this.eraser) {
            this.paintCtx.globalCompositeOperation = 'destination-out';
            this.paintCtx.strokeStyle = 'rgba(0,0,0,1)';
        } else {
            this.paintCtx.globalCompositeOperation = 'source-over';
            this.paintCtx.globalAlpha = this.brushOpacity;
            this.paintCtx.strokeStyle = this.colors[this.colorIdx];
        }
        this.paintCtx.lineWidth  = this.brushSize * PS;
        this.paintCtx.lineCap    = 'round';
        this.paintCtx.beginPath();
        // dot：moveTo 與 lineTo 同點，lineCap=round 會畫出圓點
        this.paintCtx.moveTo(x * PS, y * PS);
        this.paintCtx.lineTo(x * PS, y * PS);
        this.paintCtx.stroke();
        this.paintCtx.restore();
        this.syncStrokeToCache(x, y, x, y);
        this.scheduleRender();
    }

    private paintStroke(x1: number, y1: number, x2: number, y2: number): void {
        const PS = this.paintScale;
        this.paintCtx.save();
        if (this.eraser) {
            this.paintCtx.globalCompositeOperation = 'destination-out';
            this.paintCtx.strokeStyle = 'rgba(0,0,0,1)';
        } else {
            this.paintCtx.globalCompositeOperation = 'source-over';
            this.paintCtx.globalAlpha = this.brushOpacity;
            this.paintCtx.strokeStyle = this.colors[this.colorIdx];
        }
        // lineCap/lineJoin=round 產生圓頭筆觸，單一 path stroke 取代多個 arc fill
        this.paintCtx.lineWidth  = this.brushSize * PS;
        this.paintCtx.lineCap    = 'round';
        this.paintCtx.lineJoin   = 'round';
        this.paintCtx.beginPath();
        this.paintCtx.moveTo(x1 * PS, y1 * PS);
        this.paintCtx.lineTo(x2 * PS, y2 * PS);
        this.paintCtx.stroke();
        this.paintCtx.restore();
        this.syncStrokeToCache(x1, y1, x2, y2);
        this.scheduleRender();
    }

    private clearCanvas(): void {
        this.pushHistory('清除畫布');                 // 清除前先存快照
        this.paintCtx.clearRect(0, 0, this.paintCanvas.width, this.paintCanvas.height);
        this.imageLayers     = [];
        this.markdownLayers  = [];
        this.textLayers      = [];
        this.selectedIdx     = -1;
        this.selectedMdIdx   = -1;
        this.selectedTextIdx = -1;
        this.mdDragState     = null;
        this.paintFragment   = null;
        this.paintFragDrag   = null;
        this.selStart        = null;
        this.selCurrent      = null;
        this.render();
    }

    // ── 文字編輯器 ────────────────────────────────────────────────────────────

    /** 在畫布上方顯示浮動 textarea，讓使用者輸入文字 */
    private openTextEditor(canvasX: number, canvasY: number, layerIdx = -1): void {
        // 若已有開啟的編輯器，先提交再開新的
        if (this._textEditing) this.commitTextEdit(this._textEditing);

        // 解析目標位置（編輯現有 → 用舊座標，新增 → 用點擊座標）
        const posX = layerIdx >= 0 ? this.textLayers[layerIdx].x : canvasX;
        const posY = layerIdx >= 0 ? this.textLayers[layerIdx].y : canvasY;

        const canvasRect = this.canvas.getBoundingClientRect();
        const screenX    = canvasRect.left + posX * this.zoom;
        const screenY    = canvasRect.top  + posY * this.zoom;

        const fontSize = layerIdx >= 0 ? this.textLayers[layerIdx].fontSize : this.textFontSize;

        // 同步工具列顏色選擇器
        if (layerIdx >= 0) {
            this.textColorInput.value = this.textLayers[layerIdx].color;
        }

        const ta             = document.createElement('textarea');
        ta.className         = 'easynote-text-editor';
        ta.style.left        = `${screenX}px`;
        ta.style.top         = `${screenY}px`;
        ta.style.fontSize    = `${fontSize * this.zoom}px`;
        ta.rows              = 3;
        if (layerIdx >= 0) ta.value = this.textLayers[layerIdx].text;

        document.body.appendChild(ta);
        setTimeout(() => { ta.focus(); if (layerIdx >= 0) ta.select(); }, 10);

        const state = { el: ta, layerIdx, x: posX, y: posY };
        this._textEditing = state;

        // Android 軟鍵盤彈出時會縮放 viewport → 觸發假的 blur
        // 600ms 內的 blur 視為 spurious（鍵盤動畫），立即 refocus
        let blurGuardUntil = 0;
        ta.addEventListener('focus', () => { blurGuardUntil = Date.now() + 600; });
        ta.addEventListener('blur', () => {
            if (Date.now() < blurGuardUntil) {
                requestAnimationFrame(() => { if (this._textEditing === state) ta.focus(); });
                return;
            }
            if (this._textEditing === state) this.commitTextEdit(state);
        });
        ta.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                if (this._textEditing === state) {
                    this._textEditing = null;
                    ta.remove();
                }
            }
            e.stopPropagation(); // 防止快捷鍵
        });
    }

    private commitTextEdit(state: { el: HTMLTextAreaElement; layerIdx: number; x: number; y: number }): void {
        this._textEditing = null;
        const text = state.el.value;
        state.el.remove();
        this.pushHistory('編輯文字');                 // 文字確認前先存快照

        if (text.trim()) {
            const fontSize = state.layerIdx >= 0 ? this.textLayers[state.layerIdx].fontSize : this.textFontSize;
            const color    = this.textColorInput.value;
            if (state.layerIdx >= 0) {
                // 手動編輯 → 解除筆記連結
                if (this.textLayers[state.layerIdx].linkedNotePath) {
                    this.textLayers[state.layerIdx].linkedNotePath = undefined;
                    new Notice('已解除筆記連結（文字已手動編輯）');
                }
                this.textLayers[state.layerIdx].text  = text;
                this.textLayers[state.layerIdx].color = color;
            } else {
                this.textLayers.push({ text, x: state.x, y: state.y, fontSize, color });
            }
        } else if (state.layerIdx >= 0) {
            // 清空內容 → 刪除此文字圖層
            this.textLayers.splice(state.layerIdx, 1);
            if (this.selectedTextIdx >= state.layerIdx) {
                this.selectedTextIdx = Math.max(-1, this.selectedTextIdx - 1);
            }
        }
        this.render();
    }

    // ── Markdown 圖層編輯器 ────────────────────────────────────────────────────

    private openMarkdownEditor(layerIdx: number): void {
        if (this._mdEditing)   this.commitMarkdownEdit(this._mdEditing);
        if (this._textEditing) this.commitTextEdit(this._textEditing);

        const ml          = this.markdownLayers[layerIdx];
        const canvasRect  = this.canvas.getBoundingClientRect();
        const screenX     = canvasRect.left + ml.x * this.zoom;
        const screenY     = canvasRect.top  + ml.y * this.zoom;

        const ta             = document.createElement('textarea');
        ta.className         = 'easynote-text-editor easynote-md-editor';
        ta.style.left        = `${screenX}px`;
        ta.style.top         = `${screenY}px`;
        ta.style.fontSize    = `${ml.fontSize * this.zoom}px`;
        ta.style.width       = `${ml.width * this.zoom}px`;
        if (ml._cachedH) ta.style.height = `${ml._cachedH * this.zoom}px`;
        ta.value             = ml.text;

        document.body.appendChild(ta);
        setTimeout(() => { ta.focus(); ta.select(); }, 10);

        const state = { el: ta, layerIdx };
        this._mdEditing = state;

        ta.addEventListener('blur', () => {
            if (this._mdEditing === state) this.commitMarkdownEdit(state);
        });
        ta.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                if (this._mdEditing === state) {
                    this._mdEditing = null;
                    ta.remove();
                }
            }
            e.stopPropagation();
        });
    }

    private commitMarkdownEdit(state: { el: HTMLTextAreaElement; layerIdx: number }): void {
        this._mdEditing = null;
        const text = state.el.value;
        state.el.remove();
        this.pushHistory('編輯 Markdown');

        if (text.trim()) {
            const ml = this.markdownLayers[state.layerIdx];
            ml.text     = text;
            ml._cachedH = undefined;
            // 如果有連結路徑，寫回 Vault 檔案（EasyNote → Vault 雙向同步）
            if (ml.linkedNotePath) {
                const f = this.app.vault.getAbstractFileByPath(ml.linkedNotePath);
                if (f instanceof TFile) {
                    this._suppressVaultModify = true;
                    this.app.vault.modify(f, text).finally(() => {
                        this._suppressVaultModify = false;
                    });
                }
            }
        } else {
            this.markdownLayers.splice(state.layerIdx, 1);
            if (this.selectedMdIdx >= state.layerIdx) {
                this.selectedMdIdx = Math.max(-1, this.selectedMdIdx - 1);
            }
        }
        this.render();
    }

    // ── 圖片載入（改為建立 ImageLayer）──────────────────────────────────────

    private loadImageFromBlob(blob: Blob): void {
        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target?.result as string | null;
            if (dataUrl) this.loadImageFromUrl(dataUrl);
            else new Notice('EasyNote：圖片載入失敗');
        };
        reader.onerror = () => new Notice('EasyNote：圖片讀取失敗');
        reader.readAsDataURL(blob);
    }

    private loadImageFromVault(file: TFile): void {
        this.loadImageFromUrl(this.app.vault.getResourcePath(file));
    }

    private loadImageFromUrl(url: string): void {
        const img = new Image();
        img.onload = () => {
            const cw = this.canvas.width;
            const ch = this.canvas.height;
            const scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight, 1);
            const w = Math.round(img.naturalWidth  * scale);
            const h = Math.round(img.naturalHeight * scale);
            const x = Math.round((cw - w) / 2);
            const y = Math.round((ch - h) / 2);
            this.pushHistory('載入圖片');             // 圖片對入前先存快照
            this.imageLayers.push({ img, x, y, w, h });
            this.selectedIdx = this.imageLayers.length - 1;
            this.setTool('select');   // 載入後自動切到選取模式
            this.render();
        };
        img.onerror = () => new Notice('EasyNote：圖片載入失敗');
        img.src = url;
    }

    // ── 工具切換 ──────────────────────────────────────────────────────────────

    private setTool(t: 'draw' | 'select' | 'text' | 'paintselect' | 'pan'): void {
        // 離開 paintselect 時先 commit fragment
        if (this.tool === 'paintselect' && t !== 'paintselect') {
            this.commitFragment();
        }
        // 清除圈選狀態
        this.multiSel      = null;
        this.multiSelDrag  = null;
        this.imgSelStart   = null;
        this.imgSelCurrent = null;
        this.tool = t;
        this.paintSelectBtn.toggleClass('active', t === 'paintselect');
        this.panLockBtn.toggleClass('active', t === 'pan');
        if (t === 'draw') {
            this.canvas.style.cursor = 'crosshair';
            this.selectBtn.removeClass('active');
            this.textBtn.removeClass('active');
            this.eraserBtn.toggleClass('active', this.eraser);
        } else if (t === 'select') {
            this.canvas.style.cursor = 'default';
            this.selectBtn.addClass('active');
            this.textBtn.removeClass('active');
            this.eraserBtn.removeClass('active');
        } else if (t === 'text') {
            this.canvas.style.cursor = 'text';
            this.textBtn.addClass('active');
            this.selectBtn.removeClass('active');
            this.eraserBtn.removeClass('active');
        } else { // paintselect
            this.canvas.style.cursor = 'crosshair';
            this.selectBtn.removeClass('active');
            this.textBtn.removeClass('active');
            this.eraserBtn.removeClass('active');
        }
        if (t === 'pan') {
            this.canvas.style.cursor = 'grab';
            this.selectBtn.removeClass('active');
            this.textBtn.removeClass('active');
            this.eraserBtn.removeClass('active');
        }
        this.refreshStatus();
    }

    private setColor(idx: number): void {
        this.colorIdx = idx;
        this.eraser   = false;
        this.setTool('draw');
        this.refreshColorBtns();
        this.refreshStatus();
    }

    private toggleEraser(): void {
        this.eraser = !this.eraser;
        this.setTool('draw');
        this.eraserBtn.toggleClass('active', this.eraser);
        this.refreshColorBtns();
        this.refreshStatus();
    }

    // ── UI 刷新 ───────────────────────────────────────────────────────────────

    private refreshColorBtns(): void {
        this.colorBtns.forEach((btn, i) => {
            btn.toggleClass('active', i === this.colorIdx && !this.eraser && this.tool === 'draw');
        });
    }

    private refreshStatus(): void {
        // 筆刷 & 透明度 toolbar 數值標籤
        if (this.sizeValueLabel) {
            if ((this.settings.brushMode ?? 'steps') === 'steps') {
                const step = brushSizeToStep(this.brushSize);
                this.sizeValueLabel.textContent = `第${step}階(${this.brushSize}px)`;
            } else {
                this.sizeValueLabel.textContent = `${this.brushSize}px`;
            }
        }
        if (this.opacityValueLabel) {
            this.opacityValueLabel.textContent = `${Math.round(this.brushOpacity * 100)}%`;
        }

        // 目前圕層類型
        if (this.activeLayerLabel) {
            let layerName: string;
            if (this.tool === 'text') {
                layerName = '文字層';
            } else if (this.tool === 'select') {
                layerName = '圖片層';
            } else {
                layerName = '插畫層';
            }
            this.activeLayerLabel.textContent = layerName;
            this.activeLayerLabel.setAttribute('data-layer', this.tool === 'text' ? 'text' : this.tool === 'select' ? 'image' : 'paint');
        }

        // auto-sync 按鈕外觀
        if (this.autoSyncBtn) {
            this.autoSyncBtn.toggleClass('easynote-btn-active', this.settings.autoSyncEnabled ?? false);
            this.autoSyncBtn.title = this.settings.autoSyncEnabled
                ? `定時重新載入：開啟（每 ${(this.settings.autoSyncPeriodMs ?? 1000) / 1000} 秒）`
                : '定時重新載入：關閉';
        }
        if (this.autoPeriodicSaveBtn) {
            this.autoPeriodicSaveBtn.toggleClass('easynote-btn-active', this.settings.autoPeriodicSaveEnabled ?? false);
            this.autoPeriodicSaveBtn.title = this.settings.autoPeriodicSaveEnabled
                ? `定時儲存：開啟（每 ${(this.settings.autoPeriodicSavePeriodMs ?? 60000) / 1000} 秒）`
                : '定時儲存：關閉';
        }

        const zoomStr = `縮放: ${Math.round(this.zoom * 100)}%`;
        const saveStr = this.lastAutoSaveTime
            ? `暫存: ${this.lastAutoSaveTime.toLocaleTimeString()}`
            : '暫存: 等待中';
        if (this.tool === 'select') {
            const ni = this.imageLayers.length;
            const nm = this.markdownLayers.length;
            const nt = this.textLayers.length;
            this.statusLabel.textContent = `選取模式 | 圖片: ${ni} 張 | MD: ${nm} 個 | 文字: ${nt} 個 | ${zoomStr} | ${saveStr}`;
        } else if (this.tool === 'text') {
            this.statusLabel.textContent = `工具: 文字 | 字體: ${this.textFontSize}px | ${zoomStr} | ${saveStr}`;
        } else if (this.tool === 'paintselect') {
            const fragStr = this.paintFragment ? ' | 已選取區塊' : '';
            this.statusLabel.textContent = `工具: 繪畫選取${fragStr} | Enter 確認　Esc 取消　Del 棄用 | ${zoomStr} | ${saveStr}`;
        } else {
            const toolName = this.eraser ? '橡皮擦' : `${this.colorNames[this.colorIdx]} 鉛筆`;
            const opPct    = Math.round(this.brushOpacity * 100);
            this.statusLabel.textContent = `工具: ${toolName} | 大小: ${this.brushSize} | 透明度: ${opPct}% | ${zoomStr} | ${saveStr}`;
        }
    }

    // ── 鍵盤快捷鍵 ───────────────────────────────────────────────────────────
    private handleKeyDown(e: KeyboardEvent): void {
        if (this.app.workspace.getActiveViewOfType(EasyNoteView) !== this) return;
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        // ── Ctrl / Meta 組合鍵 ────────────────────────────────────────────────
        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'z':
                    e.preventDefault();
                    this.undo();
                    return;
                case 'y':
                    e.preventDefault();
                    this.redo();
                    return;
                case 'c':
                    e.preventDefault();
                    this.copySelection();
                    return;
                case 'x':
                    e.preventDefault();
                    this.cutSelection();
                    return;
                case 'v':
                    // 內部剪貼簿貼上（系統剪貼簿圖片由 handlePaste 處理）
                    if (this.clipboard) {
                        e.preventDefault();
                        this.pasteClipboard();
                    }
                    return;
            }
        }

        switch (e.key) {
            case 's': case 'S':
                this.setTool(this.tool === 'select' ? 'draw' : 'select');
                break;
            case 't': case 'T':
                this.setTool(this.tool === 'text' ? 'draw' : 'text');
                break;
            case 'm': case 'M':
                this.setTool(this.tool === 'paintselect' ? 'draw' : 'paintselect');
                break;
            case 'Enter':
                if (this.tool === 'paintselect') { this.commitFragment(); this.refreshStatus(); }
                break;
            case 'Escape':
                if (this.tool === 'select') {
                    if (this.imgSelStart) {
                        this.imgSelStart = null; this.imgSelCurrent = null; this.render();
                    } else if (this.multiSel) {
                        this.multiSel = null; this.multiSelDrag = null; this.render();
                    }
                } else if (this.tool === 'paintselect') {
                    if (this.selStart) {
                        this.selStart = null; this.selCurrent = null; this.render();
                    } else {
                        this.cancelFragment(); this.refreshStatus();
                    }
                }
                break;
            case 'c': case 'C':
                if (this.tool !== 'select') this.clearCanvas();
                break;
            case 'e': case 'E':
                this.toggleEraser();
                break;
            case 'Delete': case 'Backspace':
                if (this.tool === 'select') {
                    if (this.multiSel && (this.multiSel.imageIdxs.length + this.multiSel.textIdxs.length + this.multiSel.mdIdxs.length > 0)) {
                        this.pushHistory('刪除群組圖層');
                        for (const i of [...this.multiSel.imageIdxs].sort((a, b) => b - a)) this.imageLayers.splice(i, 1);
                        for (const i of [...this.multiSel.textIdxs].sort((a, b) => b - a)) this.textLayers.splice(i, 1);
                        for (const i of [...this.multiSel.mdIdxs].sort((a, b) => b - a)) this.markdownLayers.splice(i, 1);
                        this.multiSel = null;
                        this.selectedIdx = -1; this.selectedTextIdx = -1; this.selectedMdIdx = -1;
                        this.render(); this.refreshStatus();
                    } else if (this.selectedIdx >= 0) {
                        this.pushHistory('刪除圖片圖層');
                        this.imageLayers.splice(this.selectedIdx, 1);
                        this.selectedIdx = -1;
                        this.render();
                        this.refreshStatus();
                    } else if (this.selectedMdIdx >= 0) {
                        this.pushHistory('刪除 Markdown 圖層');
                        this.markdownLayers.splice(this.selectedMdIdx, 1);
                        this.selectedMdIdx = -1;
                        this.render();
                        this.refreshStatus();
                    } else if (this.selectedTextIdx >= 0) {
                        this.pushHistory('刪除文字圖層');
                        this.textLayers.splice(this.selectedTextIdx, 1);
                        this.selectedTextIdx = -1;
                        this.render();
                        this.refreshStatus();
                    }
                } else if (this.tool === 'paintselect' && this.paintFragment) {
                    // 棄用 fragment（不還原到畫布）
                    this.pushHistory('刪除繪畫選取');
                    this.paintFragment = null;
                    this.paintFragDrag = null;
                    this.render();
                    this.refreshStatus();
                }
                break;
            case '1': this.setColor(0); break;
            case '2': this.setColor(1); break;
            case '3': this.setColor(2); break;
            case '4': this.setColor(3); break;
            case '5': this.setColor(4); break;
            case '+': case '=':
                if ((this.settings.brushMode ?? 'steps') === 'steps') {
                    const ns = Math.min(7, brushSizeToStep(this.brushSize) + 1);
                    this.brushSize        = BRUSH_STEPS[ns - 1];
                    this.sizeSlider.value = String(ns);
                } else {
                    this.brushSize        = Math.min(MAX_BRUSH_SIZE, this.brushSize + 2);
                    this.sizeSlider.value = String(this.brushSize);
                }
                this.refreshStatus();
                break;
            case '-':
                if ((this.settings.brushMode ?? 'steps') === 'steps') {
                    const ps = Math.max(1, brushSizeToStep(this.brushSize) - 1);
                    this.brushSize        = BRUSH_STEPS[ps - 1];
                    this.sizeSlider.value = String(ps);
                } else {
                    this.brushSize        = Math.max(MIN_BRUSH_SIZE, this.brushSize - 2);
                    this.sizeSlider.value = String(this.brushSize);
                }
                this.refreshStatus();
                break;
            case '0':   // 重設縮放至 100%
                this.zoom = 1.0;
                this.applyZoom();
                this.refreshStatus();
                break;
        }
    }

    // ── 剪貼簿貼上 ───────────────────────────────────────────────────────────
    private handlePaste(e: ClipboardEvent): void {
        if (this.app.workspace.getActiveViewOfType(EasyNoteView) !== this) return;
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        const items = e.clipboardData?.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
                const blob = items[i].getAsFile();
                if (blob) { e.preventDefault(); this.loadImageFromBlob(blob); }
                return;
            }
        }
    }

    // ── 歷史記錄（Undo / Redo）────────────────────────────────────────────────
    private refreshUndoRedo(): void {
        if (!this.undoBtn || !this.redoBtn) return;
        this.undoBtn.disabled = this.historyIdx <= 0;
        this.redoBtn.disabled = this.historyIdx >= this.history.length - 1;
    }

    private showHistoryDropdown(anchor: HTMLElement, direction: 'undo' | 'redo'): void {
        // 關閉已開启的 dropdown
        document.querySelectorAll('.easynote-history-dropdown').forEach(el => el.remove());

        // 建立可用步驟列表
        const items: { label: string; idx: number }[] = [];
        if (direction === 'undo') {
            // 從目前位置往左（最近 → 最遠）
            for (let i = this.historyIdx - 1; i >= 0; i--) {
                items.push({ label: `↩ ${this.history[i + 1].label}`, idx: i });
            }
        } else {
            // 從目前位置往右
            for (let i = this.historyIdx + 1; i < this.history.length; i++) {
                items.push({ label: `↪ ${this.history[i].label}`, idx: i });
            }
        }
        if (items.length === 0) return;

        const menu       = document.createElement('div');
        menu.className   = 'easynote-history-dropdown';
        const anchorRect = anchor.getBoundingClientRect();
        menu.style.top   = `${anchorRect.bottom + window.scrollY + 2}px`;
        menu.style.left  = `${anchorRect.left   + window.scrollX}px`;

        for (const item of items) {
            const row = menu.createEl('div', { cls: 'easynote-history-item', text: item.label });
            row.addEventListener('mousedown', (e) => {
                e.preventDefault();
                menu.remove();
                this.historyIdx = item.idx;
                this.restoreHistory(this.history[item.idx]);
                this.refreshUndoRedo();
            });
        }

        document.body.appendChild(menu);
        const close = (e: MouseEvent) => {
            if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener('mousedown', close, true); }
        };
        requestAnimationFrame(() => document.addEventListener('mousedown', close, true));
    }

    private pushHistory(label = '操作'): void {
        // 截斷 redo 分支
        this.history.splice(this.historyIdx + 1);
        const entry: HistoryEntry = {
            label,
            paintData:      this.paintCtx.getImageData(0, 0, this.paintCanvas.width, this.paintCanvas.height),
            imageLayers:    this.imageLayers.map(l => ({ img: l.img, x: l.x, y: l.y, w: l.w, h: l.h, rotation: l.rotation })),
            markdownLayers: this.markdownLayers.map(ml => ({
                text: ml.text, x: ml.x, y: ml.y, fontSize: ml.fontSize,
                color: ml.color, width: ml.width, linkedNotePath: ml.linkedNotePath, rotation: ml.rotation,
            })),
            textLayers:     this.textLayers.map(tl => ({ ...tl })),
            canvasW:        this.canvas.width,
            canvasH:        this.canvas.height,
        };
        this.history.push(entry);
        if (this.history.length > EasyNoteView.MAX_HISTORY) {
            this.history.shift();   // 超過上限，丟棄最舊的（idx 不變，指向末尾）
        } else {
            this.historyIdx = this.history.length - 1;
        }
        this.refreshUndoRedo();
    }

    private restoreHistory(entry: HistoryEntry): void {
        const PS = this.paintScale;
        const pw = Math.max(1, Math.round(entry.canvasW * PS));
        const ph = Math.max(1, Math.round(entry.canvasH * PS));
        // 若畫布尺寸不同需先調整
        if (this.canvas.width !== entry.canvasW || this.canvas.height !== entry.canvasH) {
            this.canvas.width       = entry.canvasW;
            this.canvas.height      = entry.canvasH;
            this.paintCanvas.width  = pw;
            this.paintCanvas.height = ph;
            this.manualWidth        = entry.canvasW;
            this.manualHeight       = entry.canvasH;
        }
        this.paintCtx.clearRect(0, 0, this.paintCanvas.width, this.paintCanvas.height);
        this.paintCtx.putImageData(entry.paintData, 0, 0);
        this.imageLayers     = entry.imageLayers.map(l => ({ ...l }));
        this.markdownLayers  = entry.markdownLayers.map(ml => ({ ...ml }));
        this.textLayers      = entry.textLayers.map(tl => ({ ...tl }));
        this.selectedIdx     = -1;
        this.selectedMdIdx   = -1;
        this.selectedTextIdx = -1;
        this.mdDragState     = null;
        this.paintFragment   = null;
        this.paintFragDrag   = null;
        this.render();
    }

    undo(): void {
        if (this.historyIdx <= 0) return;
        this.historyIdx--;
        this.restoreHistory(this.history[this.historyIdx]);
        this.refreshUndoRedo();
    }

    redo(): void {
        if (this.historyIdx >= this.history.length - 1) return;
        this.historyIdx++;
        this.restoreHistory(this.history[this.historyIdx]);
        this.refreshUndoRedo();
    }

    // ── 長按選單（Android 觸控）────────────────────────────────────────────
    /** 在 (clientX, clientY) 顯示浮動選單，items: [{ label, action }] */
    private showContextMenu(clientX: number, clientY: number,
                            items: { label: string; action: () => void }[]): void {
        // 移除舊選單
        document.querySelectorAll('.easynote-ctx-menu').forEach(el => el.remove());

        const menu = document.createElement('div');
        menu.className = 'easynote-ctx-menu';
        menu.style.cssText = [
            'position:fixed',
            `left:${Math.min(clientX, window.innerWidth - 160)}px`,
            `top:${Math.min(clientY + 4, window.innerHeight - items.length * 44 - 8)}px`,
            'z-index:9999',
            'background:var(--background-primary)',
            'border:1px solid var(--background-modifier-border)',
            'border-radius:8px',
            'box-shadow:0 4px 16px rgba(0,0,0,0.25)',
            'overflow:hidden',
            'min-width:140px',
        ].join(';');

        for (const item of items) {
            const btn = menu.createEl('button');
            btn.textContent = item.label;
            btn.style.cssText = [
                'display:block', 'width:100%', 'padding:10px 16px',
                'text-align:left', 'background:none', 'border:none',
                'color:var(--text-normal)', 'font-size:15px', 'cursor:pointer',
            ].join(';');
            btn.addEventListener('pointerdown', (ev) => {
                ev.stopPropagation();
                menu.remove();
                item.action();
            });
        }

        document.body.appendChild(menu);

        // 點擊選單外關閉
        const close = (ev: PointerEvent) => {
            if (!menu.contains(ev.target as Node)) {
                menu.remove();
                document.removeEventListener('pointerdown', close, true);
            }
        };
        // 稍微延遲，避免觸發當次 pointerdown 立即關閉
        setTimeout(() => document.addEventListener('pointerdown', close, true), 50);
    }

    /** 長按觸發：根據目前工具與狀態決定選單內容 */
    private handleLongPress(mx: number, my: number, clientX: number, clientY: number): void {
        if (this.tool === 'paintselect') {
            if (this.paintFragment && this.pointInFrag(mx, my)) {
                // 長按在 fragment 上 → 剪下 / 複製 / 等比例縮放 / 刪除
                this.showContextMenu(clientX, clientY, [
                    {
                        label: '✂ 剪下',
                        action: () => this.cutSelection(),
                    },
                    {
                        label: '⎘ 複製',
                        action: () => this.copySelection(),
                    },
                    {
                        label: this.proportionalScale ? '⤡ 等比例縮放 ✓' : '⤡ 等比例縮放',
                        action: () => { this.proportionalScale = !this.proportionalScale; },
                    },
                    {
                        label: '🗑 刪除',
                        action: () => {
                            this.pushHistory('刪除繪畫選取');
                            this.paintFragment = null;
                            this.paintFragDrag = null;
                            this.render();
                            this.refreshStatus();
                        },
                    },
                ]);
                return;
            }
        }

        if (this.tool === 'select') {
            // 長按在圖片圖層
            if (this.selectedIdx >= 0 && this.pointInLayer(mx, my, this.imageLayers[this.selectedIdx])) {
                this.showContextMenu(clientX, clientY, [
                    { label: '✂ 剪下',   action: () => this.cutSelection() },
                    { label: '⎘ 複製',   action: () => this.copySelection() },
                    {
                        label: this.proportionalScale ? '⤡ 等比例縮放 ✓' : '⤡ 等比例縮放',
                        action: () => { this.proportionalScale = !this.proportionalScale; },
                    },
                    {
                        label: '🗑 刪除',
                        action: () => {
                            this.pushHistory('刪除圖片圖層');
                            this.imageLayers.splice(this.selectedIdx, 1);
                            this.selectedIdx = -1;
                            this.render(); this.refreshStatus();
                        },
                    },
                ]);
                return;
            }
            // 長按在文字圖層
            if (this.selectedTextIdx >= 0 && this.pointInText(mx, my, this.textLayers[this.selectedTextIdx])) {
                this.showContextMenu(clientX, clientY, [
                    { label: '✂ 剪下',   action: () => this.cutSelection() },
                    { label: '⎘ 複製',   action: () => this.copySelection() },
                    {
                        label: this.proportionalScale ? '⤡ 等比例縮放 ✓' : '⤡ 等比例縮放',
                        action: () => { this.proportionalScale = !this.proportionalScale; },
                    },
                    {
                        label: '🗑 刪除',
                        action: () => {
                            this.pushHistory('刪除文字圖層');
                            this.textLayers.splice(this.selectedTextIdx, 1);
                            this.selectedTextIdx = -1;
                            this.render(); this.refreshStatus();
                        },
                    },
                ]);
                return;
            }
            // 長按在 Markdown 圖層
            if (this.selectedMdIdx >= 0 && this.pointInMd(mx, my, this.markdownLayers[this.selectedMdIdx])) {
                this.showContextMenu(clientX, clientY, [
                    { label: '✂ 剪下',   action: () => this.cutSelection() },
                    { label: '⎘ 複製',   action: () => this.copySelection() },
                    {
                        label: this.proportionalScale ? '⤡ 等比例縮放 ✓' : '⤡ 等比例縮放',
                        action: () => { this.proportionalScale = !this.proportionalScale; },
                    },
                    {
                        label: '🗑 刪除',
                        action: () => {
                            this.pushHistory('刪除 Markdown 圖層');
                            this.markdownLayers.splice(this.selectedMdIdx, 1);
                            this.selectedMdIdx = -1;
                            this.render(); this.refreshStatus();
                        },
                    },
                ]);
                return;
            }
        }

        // 空白處長按 → 貼上（若有剪貼簿）
        if (this.clipboard) {
            this.showContextMenu(clientX, clientY, [
                {
                    label: '⎗ 貼上',
                    action: () => this.pasteClipboard(),
                },
            ]);
        }
    }

    /** 等比例縮放對話框：輸入百分比後縮放 paintFragment */
    // ── 複製 / 剪下 / 貼上（內部剪貼簿）─────────────────────────────────────
    private copySelection(): void {
        if (this.tool === 'select') {
            if (this.selectedIdx >= 0 && this.selectedIdx < this.imageLayers.length) {
                const l = this.imageLayers[this.selectedIdx];
                this.clipboard = { type: 'image', img: l.img, w: l.w, h: l.h };
                new Notice('已複製圖片圖層');
            } else if (this.selectedMdIdx >= 0 && this.selectedMdIdx < this.markdownLayers.length) {
                const ml = this.markdownLayers[this.selectedMdIdx];
                this.clipboard = { type: 'markdown', layer: { ...ml, _cachedH: undefined } };
                new Notice('已複製 Markdown 圖層');
            } else if (this.selectedTextIdx >= 0 && this.selectedTextIdx < this.textLayers.length) {
                this.clipboard = { type: 'text', layer: { ...this.textLayers[this.selectedTextIdx] } };
                new Notice('已複製文字圖層');
            }
        } else if (this.tool === 'paintselect') {
            if (this.paintFragment) {
                // 複製浮動中的繪畫區塊
                const copy = document.createElement('canvas');
                copy.width  = this.paintFragment.offscreen.width;
                copy.height = this.paintFragment.offscreen.height;
                copy.getContext('2d')!.drawImage(this.paintFragment.offscreen, 0, 0);
                this.clipboard = { type: 'paint', offscreen: copy, w: this.paintFragment.w, h: this.paintFragment.h };
                new Notice('已複製繪畫選取');
            } else {
                const r = this.getSelRect();
                if (r) {
                    const copy = document.createElement('canvas');
                    copy.width  = r.w;
                    copy.height = r.h;
                    copy.getContext('2d')!.drawImage(this.paintCanvas, r.x * this.paintScale, r.y * this.paintScale, r.w * this.paintScale, r.h * this.paintScale, 0, 0, r.w, r.h);
                    this.clipboard = { type: 'paint', offscreen: copy, w: r.w, h: r.h };
                    new Notice('已複製繪畫選取');
                }
            }
        }
    }

    private cutSelection(): void {
        if (this.tool === 'select') {
            if (this.selectedIdx >= 0 && this.selectedIdx < this.imageLayers.length) {
                const l = this.imageLayers[this.selectedIdx];
                this.clipboard = { type: 'image', img: l.img, w: l.w, h: l.h };
                this.pushHistory('剪下圖片圖層');
                this.imageLayers.splice(this.selectedIdx, 1);
                this.selectedIdx = -1;
                this.render();
                this.refreshStatus();
                new Notice('已剪下圖片圖層');
            } else if (this.selectedMdIdx >= 0 && this.selectedMdIdx < this.markdownLayers.length) {
                const ml = this.markdownLayers[this.selectedMdIdx];
                this.clipboard = { type: 'markdown', layer: { ...ml, _cachedH: undefined } };
                this.pushHistory('剪下 Markdown 圖層');
                this.markdownLayers.splice(this.selectedMdIdx, 1);
                this.selectedMdIdx = -1;
                this.render();
                this.refreshStatus();
                new Notice('已剪下 Markdown 圖層');
            } else if (this.selectedTextIdx >= 0 && this.selectedTextIdx < this.textLayers.length) {
                this.clipboard = { type: 'text', layer: { ...this.textLayers[this.selectedTextIdx] } };
                this.pushHistory('剪下文字圖層');
                this.textLayers.splice(this.selectedTextIdx, 1);
                this.selectedTextIdx = -1;
                this.render();
                this.refreshStatus();
                new Notice('已剪下文字圖層');
            }
        } else if (this.tool === 'paintselect') {
            if (this.paintFragment) {
                // 浮動中的繪畫區塊已從畫布提取，直接存入剪貼簿
                const copy = document.createElement('canvas');
                copy.width  = this.paintFragment.offscreen.width;
                copy.height = this.paintFragment.offscreen.height;
                copy.getContext('2d')!.drawImage(this.paintFragment.offscreen, 0, 0);
                this.clipboard = { type: 'paint', offscreen: copy, w: this.paintFragment.w, h: this.paintFragment.h };
                // 捨棄浮動區塊（洞保留在畫布上）
                this.paintFragment = null;
                this.paintFragDrag = null;
                this.render();
                new Notice('已剪下繪畫選取');
            } else {
                const r = this.getSelRect();
                if (r) {
                    this.pushHistory('剪下繪畫選取');
                    const copy = document.createElement('canvas');
                    copy.width  = r.w;
                    copy.height = r.h;
                    copy.getContext('2d')!.drawImage(this.paintCanvas, r.x * this.paintScale, r.y * this.paintScale, r.w * this.paintScale, r.h * this.paintScale, 0, 0, r.w, r.h);
                    this.clipboard = { type: 'paint', offscreen: copy, w: r.w, h: r.h };
                    // 從畫布挖空選取區
                    this.paintCtx.save();
                    this.paintCtx.globalCompositeOperation = 'destination-out';
                    this.paintCtx.fillStyle = 'rgba(0,0,0,1)';
                    this.paintCtx.fillRect(r.x * this.paintScale, r.y * this.paintScale, r.w * this.paintScale, r.h * this.paintScale);
                    this.paintCtx.restore();
                    this.selStart   = null;
                    this.selCurrent = null;
                    this.render();
                    new Notice('已剪下繪畫選取');
                }
            }
        }
    }

    private pasteClipboard(): void {
        if (!this.clipboard) return;
        if (this.clipboard.type === 'paint') {
            // 先把現有浮動區塊合併入畫布（不另外佔一筆歷史）
            if (this.paintFragment) {
                const f  = this.paintFragment;
                const PS = this.paintScale;
                this.paintCtx.drawImage(f.offscreen, 0, 0, f.offscreen.width, f.offscreen.height, f.x * PS, f.y * PS, f.w * PS, f.h * PS);
                this.paintFragment = null;
                this.paintFragDrag = null;
            }
            this.pushHistory('貼上繪畫');
            const c = this.clipboard;
            const px = Math.max(0, Math.floor((this.canvas.width  - c.w) / 2));
            const py = Math.max(0, Math.floor((this.canvas.height - c.h) / 2));
            const newOffscreen = document.createElement('canvas');
            newOffscreen.width  = c.offscreen.width;
            newOffscreen.height = c.offscreen.height;
            newOffscreen.getContext('2d')!.drawImage(c.offscreen, 0, 0);
            this.paintFragment = { offscreen: newOffscreen, x: px, y: py, w: c.w, h: c.h };
            this.setTool('paintselect');
            this.render();
            this.refreshStatus();
            new Notice('已貼上繪畫');
            return;
        }
        this.pushHistory('貼上');
        const OFFSET = 20;
        if (this.clipboard.type === 'image') {
            const c = this.clipboard;
            const x = Math.min(OFFSET, this.canvas.width  - c.w);
            const y = Math.min(OFFSET, this.canvas.height - c.h);
            this.imageLayers.push({ img: c.img, x, y, w: c.w, h: c.h });
            this.selectedIdx     = this.imageLayers.length - 1;
            this.selectedTextIdx = -1;
            this.selectedMdIdx   = -1;
            this.setTool('select');
        } else if (this.clipboard.type === 'markdown') {
            const src = this.clipboard.layer;
            this.markdownLayers.push({ ...src, x: src.x + OFFSET, y: src.y + OFFSET, _cachedH: undefined });
            this.selectedMdIdx   = this.markdownLayers.length - 1;
            this.selectedIdx     = -1;
            this.selectedTextIdx = -1;
            this.setTool('select');
        } else {
            const src = this.clipboard.layer;
            this.textLayers.push({ ...src, x: src.x + OFFSET, y: src.y + OFFSET });
            this.selectedTextIdx = this.textLayers.length - 1;
            this.selectedIdx     = -1;
            this.selectedMdIdx   = -1;
            this.setTool('select');
        }
        this.render();
        this.refreshStatus();
    }

    // ── 自動儲存 ──────────────────────────────────────────────────────────────
    /** 每次 render() 後呼叫；debounce 3 秒後寫出暫存檔 */
    /** 啟動定時 auto-reload（setInterval，依設定週期載入畫布檔） */
    private startAutoSync(): void {
        this.stopAutoSync();
        const ms = Math.max(1000, this.settings.autoSyncPeriodMs ?? 5000);
        this._autoSyncTimer = setInterval(async () => {
            // 沒有檔名則跳過
            if (!this.lastProjectName) return;
            const driveFilename = `${this.lastProjectName}.enote`;
            const filepath = normalizePath(
                `${this.settings.saveFolder}/${driveFilename}`
            );
            // 若 Google Drive 已啟用，先從 Drive 下載並更新本地檔案
            if (this.settings.googleDriveEnabled && this.driveDownload) {
                try {
                    const content = await this.driveDownload(driveFilename);
                    if (content) {
                        const folder = normalizePath(this.settings.saveFolder);
                        if (!(await this.app.vault.adapter.exists(folder))) {
                            await this.app.vault.createFolder(folder);
                        }
                        if (await this.app.vault.adapter.exists(filepath)) {
                            const existing = this.app.vault.getAbstractFileByPath(filepath);
                            if (existing instanceof TFile) {
                                await this.app.vault.modifyBinary(existing, content.buffer as ArrayBuffer);
                            }
                        } else {
                            await this.app.vault.createBinary(filepath, content.buffer as ArrayBuffer);
                        }
                    }
                } catch (err) {
                    console.error('[EasyNote] Drive download error:', err);
                }
            }
            // 從本地 Vault 載入
            const file = this.app.vault.getAbstractFileByPath(filepath);
            if (file instanceof TFile) {
                this.loadProject(file);
            }
        }, ms);
    }

    /** 停止定時 auto-sync */
    private stopAutoSync(): void {
        if (this._autoSyncTimer !== null) {
            clearInterval(this._autoSyncTimer);
            this._autoSyncTimer = null;
        }
    }

    /** 啟動定時 auto-save（setInterval，依設定週期呼叫 autoSaveDirect） */
    private startPeriodicSave(): void {
        this.stopPeriodicSave();
        const ms = Math.max(1000, this.settings.autoPeriodicSavePeriodMs ?? 60000);
        this._autoPeriodicSaveTimer = setInterval(() => {
            this.autoSaveDirect();
        }, ms);
    }

    /** 停止定時 auto-save */
    private stopPeriodicSave(): void {
        if (this._autoPeriodicSaveTimer !== null) {
            clearInterval(this._autoPeriodicSaveTimer);
            this._autoPeriodicSaveTimer = null;
        }
    }

    private scheduleAutosave(): void {
        if (this.autoSaveTimer !== null) clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = setTimeout(() => {
            this.autoSaveTimer = null;
            this.autoSaveDirect();
        }, EasyNoteView.AUTOSAVE_DEBOUNCE_MS);
    }

    private async autoSaveDirect(): Promise<void> {
        try {
            const folder = normalizePath(this.settings.saveFolder);
            if (!(await this.app.vault.adapter.exists(folder))) {
                await this.app.vault.createFolder(folder);
            }
            // 若已有開啟/儲存過的畫布，直接回存同一個檔案；否則才用 autosave 暫存檔
            const filename = this.lastProjectName
                ? `${folder}/${this.lastProjectName}.enote`
                : `${folder}/${EasyNoteView.AUTOSAVE_FILENAME}`;
            const filepath = normalizePath(filename);

            const paintLayer  = this.paintCanvas.toDataURL('image/png');
            const imageLayers: ENoteImageLayer[] = this.imageLayers.map((lay) => {
                const tmp  = document.createElement('canvas');
                tmp.width  = lay.img.naturalWidth  || lay.w;
                tmp.height = lay.img.naturalHeight || lay.h;
                tmp.getContext('2d')!.drawImage(lay.img, 0, 0);
                return { src: tmp.toDataURL('image/png'), x: lay.x, y: lay.y, w: lay.w, h: lay.h, rotation: lay.rotation };
            });
            const project: ENote = {
                version:        1,
                canvasWidth:    this.canvas.width,
                canvasHeight:   this.canvas.height,
                paintLayer,
                imageLayers,
                markdownLayers: this.markdownLayers.map(ml => ({
                    text: ml.text, x: ml.x, y: ml.y, fontSize: ml.fontSize,
                    color: ml.color, width: ml.width, linkedNotePath: ml.linkedNotePath,
                })),
                textLayers: this.textLayers.map(tl => ({ ...tl })),
            };

            const bytes = new TextEncoder().encode(JSON.stringify(project));
            if (await this.app.vault.adapter.exists(filepath)) {
                const existing = this.app.vault.getAbstractFileByPath(filepath);
                if (existing instanceof TFile) {
                    await this.app.vault.modifyBinary(existing, bytes.buffer as ArrayBuffer);
                }
            } else {
                await this.app.vault.createBinary(filepath, bytes.buffer as ArrayBuffer);
            }
            // 上傳到 Google Drive（若已啟用）
            if (this.settings.googleDriveEnabled && this.driveUpload) {
                const driveFilename = this.lastProjectName
                    ? `${this.lastProjectName}.enote`
                    : EasyNoteView.AUTOSAVE_FILENAME;
                this.driveUpload(driveFilename, bytes).catch((err) => {
                    console.error('[EasyNote] Drive upload error:', err);
                    new Notice('Google Drive 上傳失敗', 2000);
                });
            }
            this.lastAutoSaveTime = new Date();
            this.refreshStatus();
            const displayName = this.lastProjectName ?? EasyNoteView.AUTOSAVE_FILENAME;
            new Notice(`暫存完成：${displayName}`, 2000);
        } catch (err) {
            console.error('[EasyNote] autosave error:', err);
        }
    }

    // ── 專案儲存 / 載入 (.enote) ──────────────────────────────────────────────
    async saveProject(baseName: string): Promise<void> {
        try {
            const folder = normalizePath(this.settings.saveFolder);
            if (!(await this.app.vault.adapter.exists(folder))) {
                await this.app.vault.createFolder(folder);
            }
            const filename = normalizePath(`${folder}/${baseName}.enote`);

            // 繪畫層 → base64 PNG
            const paintLayer = this.paintCanvas.toDataURL('image/png');

            // 圖片層 → 每張先畫到暫存 canvas 取得 data URL
            const imageLayers: ENoteImageLayer[] = this.imageLayers.map((lay) => {
                const tmp   = document.createElement('canvas');
                tmp.width   = lay.img.naturalWidth  || lay.w;
                tmp.height  = lay.img.naturalHeight || lay.h;
                tmp.getContext('2d')!.drawImage(lay.img, 0, 0);
                return { src: tmp.toDataURL('image/png'), x: lay.x, y: lay.y, w: lay.w, h: lay.h, rotation: lay.rotation };
            });

            const project: ENote = {
                version:        1,
                canvasWidth:    this.canvas.width,
                canvasHeight:   this.canvas.height,
                paintLayer,
                imageLayers,
                markdownLayers: this.markdownLayers.map(ml => ({
                    text: ml.text, x: ml.x, y: ml.y, fontSize: ml.fontSize,
                    color: ml.color, width: ml.width, linkedNotePath: ml.linkedNotePath,
                })),
                textLayers: this.textLayers.map(tl => ({ ...tl })),
            };

            const bytes = new TextEncoder().encode(JSON.stringify(project, null, 2));
            if (await this.app.vault.adapter.exists(filename)) {
                const existing = this.app.vault.getAbstractFileByPath(filename);
                if (existing instanceof TFile) {
                    await this.app.vault.modifyBinary(existing, bytes.buffer as ArrayBuffer);
                }
            } else {
                await this.app.vault.createBinary(filename, bytes.buffer as ArrayBuffer);
            }
            new Notice(`✓ 專案已儲存: ${filename}`);
            this.lastProjectName = baseName;
        } catch (err) {
            new Notice(`✗ 儲存專案失敗: ${err}`);
            console.error('[EasyNote] saveProject error:', err);
        }
    }

    async loadProject(file: TFile): Promise<void> {
        try {
            const raw     = await this.app.vault.readBinary(file);
            const json    = new TextDecoder().decode(raw);
            const project = JSON.parse(json) as ENote;

            // 重置狀態
            this.imageLayers     = [];
            this.markdownLayers  = [];
            this.textLayers      = [];
            this.selectedIdx     = -1;
            this.selectedMdIdx   = -1;
            this.selectedTextIdx = -1;
            this.mdDragState     = null;
            this.paintFragment   = null;

            // 設定畫布尺寸（直接寫，不復原舊內容）
            this.manualWidth  = project.canvasWidth;
            this.manualHeight = project.canvasHeight;
            this.canvas.width       = project.canvasWidth;
            this.canvas.height      = project.canvasHeight;
            this.paintCanvas.width  = Math.max(1, Math.round(project.canvasWidth  * this.paintScale));
            this.paintCanvas.height = Math.max(1, Math.round(project.canvasHeight * this.paintScale));

            // 載入繪畫層
            await new Promise<void>((resolve) => {
                const img = new Image();
                img.onload = () => {
                    // 將儲存圖片（全尺寸）縮放至 paintCanvas（PS 尺寸）
                    this.paintCtx.drawImage(img, 0, 0, this.paintCanvas.width, this.paintCanvas.height);
                    resolve();
                };
                img.onerror = () => resolve();
                img.src = project.paintLayer;
            });

            // 載入圖片層
            for (const lay of project.imageLayers) {
                await new Promise<void>((resolve) => {
                    const img = new Image();
                    img.onload = () => {
                        this.imageLayers.push({ img, x: lay.x, y: lay.y, w: lay.w, h: lay.h, rotation: lay.rotation || 0 });
                        resolve();
                    };
                    img.onerror = () => resolve();
                    img.src = lay.src;
                });
            }

            // 還原 Markdown 圖層
            this.markdownLayers = (project.markdownLayers ?? []).map(ml => ({ ...ml }));

            // 還原文字層
            this.textLayers = project.textLayers.map(tl => ({ ...tl }));

            // 重新從 Vault 讀取連結筆記的最新內容
            await this.resolveLinkedLayers();

            this.setTool('pan');
            this.applyZoom();
            this.render();
            this.historyIdx = -1;
            this.pushHistory('載入專案');
            this.lastProjectName = file.basename.replace(/\.enote$/i, '');
            new Notice('EasyNote：專案已載入');
            this.refreshUndoRedo();
        } catch (err) {
            new Notice(`✗ 載入專案失敗: ${err}`);
            console.error('[EasyNote] loadProject error:', err);
        }
    }

    // ── 筆記連結 ──────────────────────────────────────────────────────────────

    /** 讀取所有帶有 linkedNotePath 的文字圖層與 Markdown 圖層，從 Vault 更新內容 */
    private async resolveLinkedLayers(): Promise<void> {
        for (const tl of this.textLayers) {
            if (!tl.linkedNotePath) continue;
            const f = this.app.vault.getAbstractFileByPath(tl.linkedNotePath);
            if (f instanceof TFile) {
                tl.text = await this.app.vault.read(f);
            } else {
                tl.text = `[找不到筆記: ${tl.linkedNotePath}]`;
            }
        }
        for (const ml of this.markdownLayers) {
            if (!ml.linkedNotePath) continue;
            const f = this.app.vault.getAbstractFileByPath(ml.linkedNotePath);
            if (f instanceof TFile) {
                ml.text = await this.app.vault.read(f);
            } else {
                ml.text = `[找不到筆記: ${ml.linkedNotePath}]`;
            }
        }
    }

    /** 在畫布左上角插入一個連結到指定 .md 檔的 Markdown 圖層 */
    private async addLinkedMarkdownLayer(file: TFile): Promise<void> {
        this.pushHistory('插入連結筆記');
        const ml: MarkdownLayer = {
            text:           '',
            x:              20,
            y:              20,
            fontSize:       16,
            color:          '#000000',
            width:          Math.min(600, Math.max(200, this.canvas.width - 60)),
            linkedNotePath: file.path,
        };
        ml.text = await this.app.vault.read(file);
        this.markdownLayers.push(ml);
        this.selectedMdIdx   = this.markdownLayers.length - 1;
        this.selectedIdx     = -1;
        this.selectedTextIdx = -1;
        this.setTool('select');
        this.render();
        this.refreshStatus();
        new Notice(`已連結 Markdown 筆記「${file.basename}」`);
    }

    // ── Markdown 行內解析 ──────────────────────────────────────────────────────

    /** 將一段文字解析為行內格式片段（程式碼、粗體、斜體、連結…）*/
    private parseInline(text: string): InlineSeg[] {
        const result: InlineSeg[] = [];
        let i = 0;
        let buf = '';
        const flush = () => { if (buf) { result.push({ text: buf }); buf = ''; } };

        while (i < text.length) {
            // inline code: `code`
            if (text[i] === '`') {
                flush(); i++;
                let code = '';
                while (i < text.length && text[i] !== '`') code += text[i++];
                if (text[i] === '`') i++;
                if (code) result.push({ text: code, code: true });
                continue;
            }
            // wikilink: [[note]] or [[note|display]]
            if (text[i] === '[' && text[i + 1] === '[') {
                flush(); i += 2;
                let inner = '';
                while (i < text.length && !(text[i] === ']' && text[i + 1] === ']')) inner += text[i++];
                if (text[i] === ']') i += 2;
                const parts    = inner.split('|');
                const noteName = parts[0].trim();
                const display  = parts.length > 1 ? parts[1].trim() : noteName;
                if (display) result.push({ text: display, link: true, noteName });
                continue;
            }
            // markdown link: [text](url)
            if (text[i] === '[') {
                const ct = text.indexOf(']', i);
                if (ct !== -1 && text[ct + 1] === '(') {
                    const cu = text.indexOf(')', ct + 2);
                    if (cu !== -1) {
                        flush();
                        const urlStr = text.slice(ct + 2, cu);
                        result.push({ text: text.slice(i + 1, ct), link: true, url: urlStr });
                        i = cu + 1; continue;
                    }
                }
            }
            // bold+italic: ***text***
            if (text.startsWith('***', i)) {
                flush(); i += 3;
                let inner = '';
                while (i < text.length && !text.startsWith('***', i)) inner += text[i++];
                if (text.startsWith('***', i)) i += 3;
                if (inner) result.push({ text: inner, bold: true, italic: true });
                continue;
            }
            // bold: **text** or __text__
            if (text.startsWith('**', i) || text.startsWith('__', i)) {
                const marker = text.slice(i, i + 2);
                flush(); i += 2;
                let inner = '';
                while (i < text.length && !text.startsWith(marker, i)) inner += text[i++];
                if (text.startsWith(marker, i)) i += 2;
                if (inner) result.push({ text: inner, bold: true });
                continue;
            }
            // italic: *text* or _text_
            if (text[i] === '*' || text[i] === '_') {
                const marker = text[i];
                flush(); i++;
                let inner = '';
                while (i < text.length && text[i] !== marker && text[i] !== '\n') inner += text[i++];
                if (text[i] === marker) i++;
                if (inner) result.push({ text: inner, italic: true });
                continue;
            }
            // strikethrough: ~~text~~ (just render text)
            if (text.startsWith('~~', i)) {
                flush(); i += 2;
                let inner = '';
                while (i < text.length && !text.startsWith('~~', i)) inner += text[i++];
                if (text.startsWith('~~', i)) i += 2;
                if (inner) result.push({ text: inner });
                continue;
            }
            buf += text[i++];
        }
        flush();
        return result;
    }

    /**
     * 將行內片段渲染到 ctx，在 maxW 寬度內自動換行。
     * 回傳：下一行的起始 Y（即 y0 + 使用的行數 * LH）。
     */
    private drawInlineLine(
        ctx: CanvasRenderingContext2D,
        text: string,
        x0: number, y0: number,
        maxW: number,
        fontSize: number,
        color: string,
    ): number {
        const LH = fontSize * 1.4;
        const segs = this.parseInline(text);

        type Tok = { t: string; bold: boolean; italic: boolean; code: boolean; link: boolean; noteName?: string };
        const tokens: Tok[] = [];
        for (const seg of segs) {
            for (const p of seg.text.split(/(\s+)/)) {
                if (p.length > 0) tokens.push({
                    t: p, bold: !!seg.bold, italic: !!seg.italic,
                    code: !!seg.code, link: !!seg.link, noteName: seg.noteName,
                });
            }
        }

        let cx = x0, cy = y0, lineStart = true;
        for (const tok of tokens) {
            const isSpace = /^\s+$/.test(tok.t);
            if (lineStart && isSpace) continue;
            const font = tok.code
                ? `${fontSize * 0.85}px monospace`
                : `${tok.italic ? 'italic ' : ''}${tok.bold ? 'bold ' : ''}${fontSize}px sans-serif`;
            ctx.font = font;
            const tw = ctx.measureText(tok.t).width;

            if (!lineStart && cx + tw > x0 + maxW) {
                cy += LH; cx = x0; lineStart = true;
                if (isSpace) continue;
            }
            if (!isSpace) {
                ctx.save();
                ctx.textBaseline = 'top';
                if (tok.link) {
                    ctx.fillStyle = '#6c9ac0';
                    ctx.fillText(tok.t, cx, cy);
                    ctx.strokeStyle = '#6c9ac0';
                    ctx.lineWidth   = 1;
                    ctx.beginPath();
                    ctx.moveTo(cx,      cy + fontSize + 1);
                    ctx.lineTo(cx + tw, cy + fontSize + 1);
                    ctx.stroke();
                } else if (tok.code) {
                    ctx.fillStyle = 'rgba(120,120,120,0.18)';
                    ctx.fillRect(cx, cy, tw, fontSize * 1.1);
                    ctx.fillStyle = color;
                    ctx.fillText(tok.t, cx, cy);
                } else {
                    ctx.fillStyle = color;
                    ctx.fillText(tok.t, cx, cy);
                }
                ctx.restore();
            }
            cx += tw;
            lineStart = false;
        }
        return cy + LH;
    }

    /**
     * 渲染完整 Markdown 圖層到 ctx。
     * 回傳：渲染出的總高度（px）。同時會更新 ml._cachedH。
     */
    private drawMarkdownContent(ctx: CanvasRenderingContext2D, ml: MarkdownLayer): number {
        const base = ml.fontSize;
        const LH   = base * 1.4;
        const HSZ  = [base * 1.9, base * 1.5, base * 1.2];   // h1, h2, h3
        const x0   = ml.x;
        let y = ml.y;

        // 連結筆記：在頂部顯示檔案名稱標籤（與 Markdown 內容顏色不同）
        if (ml.linkedNotePath) {
            const basename = ml.linkedNotePath.split('/').pop()?.replace(/\.md$/i, '') ?? ml.linkedNotePath;
            ctx.save();
            ctx.font         = `italic ${base * 0.82}px sans-serif`;
            ctx.fillStyle    = '#22aa44';
            ctx.textBaseline = 'top';
            ctx.fillText(basename, x0, y);
            ctx.restore();
            y += base * 1.0;
            ctx.save();
            ctx.strokeStyle = 'rgba(34,170,68,0.45)';
            ctx.lineWidth   = 1;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(x0,            y);
            ctx.lineTo(x0 + ml.width, y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
            y += base * 0.45;
        }

        const lines     = ml.text.split('\n');
        let inFence     = false;
        const fenceLines: string[] = [];

        const flushFence = () => {
            if (fenceLines.length === 0) return;
            const blockH = fenceLines.length * LH * 0.85 + base * 0.4;
            ctx.save();
            ctx.fillStyle = 'rgba(100,100,100,0.1)';
            ctx.fillRect(x0, y, ml.width, blockH);
            ctx.font         = `${base * 0.85}px monospace`;
            ctx.fillStyle    = ml.color;
            ctx.textBaseline = 'top';
            for (const cl of fenceLines) {
                ctx.fillText(cl, x0 + 6, y + 2);
                y += LH * 0.85;
            }
            ctx.restore();
            y += base * 0.4;
            fenceLines.length = 0;
        };

        for (const rawLine of lines) {
            // code fence toggle
            if (rawLine.trimStart().startsWith('```')) {
                if (!inFence) { inFence = true; } else { inFence = false; flushFence(); }
                continue;
            }
            if (inFence) { fenceLines.push(rawLine); continue; }

            // blank line
            if (rawLine.trim() === '') { y += LH * 0.5; continue; }

            // HR: ---, ***, ___
            if (/^[-*_]{3,}\s*$/.test(rawLine.trim())) {
                ctx.save();
                ctx.strokeStyle = 'rgba(128,128,128,0.45)';
                ctx.lineWidth   = 1;
                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.moveTo(x0,              y + LH * 0.4);
                ctx.lineTo(x0 + ml.width,   y + LH * 0.4);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.restore();
                y += LH; continue;
            }

            // heading: #, ##, ###
            const hm = rawLine.match(/^(#{1,3})\s+(.*)/);
            if (hm) {
                const lvl = Math.min(3, hm[1].length) - 1;
                const hSz = HSZ[lvl];
                const hLH = hSz * 1.35;
                y += base * 0.2;
                ctx.save();
                ctx.font         = `bold ${hSz}px sans-serif`;
                ctx.fillStyle    = ml.color;
                ctx.textBaseline = 'top';
                let hx = x0, hy = y;
                const headWords = hm[2].split(' ');
                for (let wi = 0; wi < headWords.length; wi++) {
                    if (!headWords[wi]) continue;
                    const ws = wi < headWords.length - 1 ? headWords[wi] + ' ' : headWords[wi];
                    const ww = ctx.measureText(ws).width;
                    if (hx > x0 && hx + ww > x0 + ml.width) { hy += hLH; hx = x0; }
                    ctx.fillText(ws, hx, hy);
                    hx += ww;
                }
                ctx.restore();
                y = hy + hLH + base * 0.2; continue;
            }

            // blockquote: > text
            const qm = rawLine.match(/^>\s?(.*)/);
            if (qm) {
                ctx.save();
                ctx.fillStyle = 'rgba(80,160,80,0.75)';
                ctx.fillRect(x0, y, 3, LH);
                ctx.restore();
                y = this.drawInlineLine(ctx, qm[1], x0 + 10, y, ml.width - 10, base, ml.color);
                continue;
            }

            // bullet list: -, *, +
            const bm = rawLine.match(/^(\s*)[-*+]\s+(.*)/);
            if (bm) {
                const ind = Math.floor(bm[1].length / 2) * (base * 1.2);
                const ox  = x0 + ind + base * 1.2;
                ctx.save();
                ctx.font         = `${base}px sans-serif`;
                ctx.fillStyle    = ml.color;
                ctx.textBaseline = 'middle';
                ctx.fillText('•', x0 + ind + 2, y + LH * 0.5);
                ctx.restore();
                y = this.drawInlineLine(ctx, bm[2], ox, y, ml.width - (ox - x0), base, ml.color);
                continue;
            }

            // numbered list: 1. text
            const nm = rawLine.match(/^(\s*)(\d+)\.\s+(.*)/);
            if (nm) {
                const ind    = Math.floor(nm[1].length / 2) * (base * 1.2);
                const numStr = nm[2] + '.';
                const ox     = x0 + ind + base * 1.5;
                ctx.save();
                ctx.font         = `${base}px sans-serif`;
                ctx.fillStyle    = ml.color;
                ctx.textBaseline = 'top';
                ctx.fillText(numStr, x0 + ind, y);
                ctx.restore();
                y = this.drawInlineLine(ctx, nm[3], ox, y, ml.width - (ox - x0), base, ml.color);
                continue;
            }

            // normal paragraph
            y = this.drawInlineLine(ctx, rawLine, x0, y, ml.width, base, ml.color);
        }

        if (inFence) flushFence();
        const h = y - ml.y;
        ml._cachedH = h;
        return h;
    }

    // ── Markdown 圖層工具方法 ────────────────────────────────────────────────

    private mdBBox(ml: MarkdownLayer): { x: number; y: number; w: number; h: number } {
        const h = ml._cachedH
            ?? Math.max(ml.text.split('\n').length * ml.fontSize * 1.4 + ml.fontSize, ml.fontSize * 2);
        return { x: ml.x, y: ml.y, w: ml.width, h };
    }

    private pointInMd(mx: number, my: number, ml: MarkdownLayer): boolean {
        const b = this.mdBBox(ml);
        return this.pointInRotatedRect(mx, my, b.x, b.y, b.w, b.h, ml.rotation || 0);
    }

    private hitMdHandle(mx: number, my: number, ml: MarkdownLayer): HandleType | null {
        const b       = this.mdBBox(ml);
        const rot     = ml.rotation || 0;
        const corners = this.rotatedCorners(b.x, b.y, b.w, b.h, rot);
        const names: HandleType[] = ['nw', 'ne', 'sw', 'se'];
        const [rhx, rhy] = this.rotateHandleWorldPos(b.x, b.y, b.w, b.h, rot);
        if (Math.hypot(mx - rhx, my - rhy) <= HANDLE_SIZE * 2.4) return 'rotate';
        const hs = HANDLE_SIZE;
        for (let i = 0; i < 4; i++) {
            const [cx, cy] = corners[i];
            if (mx >= cx - hs && mx <= cx + hs && my >= cy - hs && my <= cy + hs) return names[i];
        }
        return null;
    }

    private drawMdSelectionBox(ml: MarkdownLayer): void {
        const b       = this.mdBBox(ml);
        const rot     = ml.rotation || 0;
        const linked  = !!ml.linkedNotePath;
        const color   = linked ? '#22aa44' : '#9966cc';
        const corners = this.rotatedCorners(b.x - 2, b.y - 2, b.w + 4, b.h + 4, rot);
        const [cnw, cne, csw, cse] = corners;
        this.ctx.save();
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth   = 1.5;
        this.ctx.setLineDash([5, 3]);
        this.ctx.beginPath();
        this.ctx.moveTo(cnw[0], cnw[1]);
        this.ctx.lineTo(cne[0], cne[1]);
        this.ctx.lineTo(cse[0], cse[1]);
        this.ctx.lineTo(csw[0], csw[1]);
        this.ctx.closePath();
        this.ctx.stroke();
        this.ctx.restore();
        const hs = HANDLE_SIZE / 2;
        for (const [cx, cy] of corners) {
            this.ctx.save();
            this.ctx.setLineDash([]);
            this.ctx.fillStyle   = '#ffffff';
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth   = 1.5;
            this.ctx.fillRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.strokeRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.restore();
        }
        const [rhx, rhy] = this.rotateHandleWorldPos(b.x - 2, b.y - 2, b.w + 4, b.h + 4, rot);
        const topCx = (cnw[0] + cne[0]) / 2, topCy = (cnw[1] + cne[1]) / 2;
        this.drawRotateHandle(topCx, topCy, rhx, rhy, color);
    }

    // ── 儲存至 Vault ──────────────────────────────────────────────────────────
    async saveDrawing(baseName: string, fmt: 'png' | 'jpeg' | 'webp'): Promise<void> {
        try {
            const folder = normalizePath(this.settings.saveFolder);
            if (!(await this.app.vault.adapter.exists(folder))) {
                await this.app.vault.createFolder(folder);
            }
            const ext      = fmt === 'jpeg' ? 'jpg' : fmt;
            const filename = normalizePath(`${folder}/${baseName}.${ext}`);

            // 合成到暫存 canvas（去掉選取框線）
            const tmp = document.createElement('canvas');
            tmp.width  = this.canvas.width;
            tmp.height = this.canvas.height;
            const tc   = tmp.getContext('2d')!;
            tc.fillStyle = '#ffffff';
            tc.fillRect(0, 0, tmp.width, tmp.height);
            // 圖片層（底部）
            for (const lay of this.imageLayers) {
                tc.drawImage(lay.img, lay.x, lay.y, lay.w, lay.h);
            }
            // 文字層（中間）
            for (const tl of this.textLayers) {
                tc.save();
                tc.font         = `${tl.fontSize}px sans-serif`;
                tc.textBaseline = 'top';
                const lines = tl.text.split('\n');
                const lineH = tl.fontSize * 1.3;
                for (let li = 0; li < lines.length; li++) {
                    let cx = tl.x;
                    const cy = tl.y + li * lineH;
                    for (const seg of parseWikilinks(lines[li])) {
                        const w = tc.measureText(seg.text).width;
                        if (seg.isLink) {
                            tc.fillStyle   = '#4a9eff';
                            tc.fillText(seg.text, cx, cy);
                            tc.strokeStyle = '#4a9eff';
                            tc.lineWidth   = Math.max(1, tl.fontSize * 0.06);
                            tc.beginPath();
                            tc.moveTo(cx,     cy + tl.fontSize + 1);
                            tc.lineTo(cx + w, cy + tl.fontSize + 1);
                            tc.stroke();
                        } else {
                            tc.fillStyle = tl.color;
                            tc.fillText(seg.text, cx, cy);
                        }
                        cx += w;
                    }
                }
                tc.restore();
            }
            // Markdown 層
            for (const ml of this.markdownLayers) {
                this.drawMarkdownContent(tc, ml);
            }
            // 繪畫層（上方）— paintCanvas 可能是 PS 縮放尺寸，拉伸回全畫布
            tc.drawImage(this.paintCanvas, 0, 0, this.canvas.width, this.canvas.height);
            // 若有浮動 fragment，也合入存圖
            if (this.paintFragment) {
                const f = this.paintFragment;
                tc.drawImage(f.offscreen, 0, 0, f.offscreen.width, f.offscreen.height, f.x, f.y, f.w, f.h);
            }

            const quality = fmt === 'png' ? undefined : 0.92;
            const dataUrl = tmp.toDataURL(`image/${fmt}`, quality);
            const base64  = dataUrl.split(',')[1];
            const binary  = atob(base64);
            const bytes   = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

            await this.app.vault.createBinary(filename, bytes.buffer);
            this.lastSaveName = baseName;
            new Notice(`✓ 已儲存: ${filename}`);
        } catch (err) {
            new Notice(`✗ 儲存失敗: ${err}`);
            console.error('[EasyNote] saveDrawing error:', err);
        }
    }
}

// ─── 儲存 Modal ──────────────────────────────────────────────────────────────
class SaveModal extends Modal {
    private defaultName: string;
    private onSave: (name: string, fmt: 'png' | 'jpeg' | 'webp') => void;

    constructor(app: App, defaultName: string, onSave: (name: string, fmt: 'png' | 'jpeg' | 'webp') => void) {
        super(app);
        this.defaultName = defaultName;
        this.onSave      = onSave;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: '儲存圖片' });

        // 檔案名稱
        new Setting(contentEl)
            .setName('檔案名稱')
            .setDesc('不需要加副檔名')
            .addText((t) => {
                t.setValue(this.defaultName);
                t.inputEl.style.width = '100%';
                t.onChange((v) => { this.defaultName = v.trim() || this.defaultName; });
                // 選取全部文字便於快速修改
                setTimeout(() => { t.inputEl.select(); t.inputEl.focus(); }, 30);
            });

        // 格式選擇
        let fmt: 'png' | 'jpeg' | 'webp' = 'png';
        new Setting(contentEl)
            .setName('檔案格式')
            .addDropdown((d) => {
                d.addOption('png',  'PNG（無損，支援透明）');
                d.addOption('jpeg', 'JPG（較小，不透明）');
                d.addOption('webp', 'WebP（高壓縮，支援透明）');
                d.setValue('png');
                d.onChange((v) => { fmt = v as 'png' | 'jpeg' | 'webp'; });
            });

        // 確認 / 取消
        const btnRow = contentEl.createEl('div', { cls: 'easynote-size-btnrow' });
        const saveBtn = btnRow.createEl('button', {
            cls:  'easynote-btn easynote-btn-save',
            text: '儲存',
        });
        saveBtn.addEventListener('click', () => {
            if (!this.defaultName) return;
            this.onSave(this.defaultName, fmt);
            this.close();
        });
        const cancelBtn = btnRow.createEl('button', { cls: 'easynote-btn', text: '取消' });
        cancelBtn.addEventListener('click', () => this.close());

        // Enter 確認
        contentEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { saveBtn.click(); e.preventDefault(); }
            if (e.key === 'Escape') { this.close(); e.preventDefault(); }
        });
    }

    onClose(): void { this.contentEl.empty(); }
}

// ─── 畫布大小設定 Modal ───────────────────────────────────────────────────────
class CanvasSizeModal extends Modal {
    private currentW: number;
    private currentH: number;
    private onApply: (w: number, h: number) => void;
    private hintEl!: HTMLElement;
    private wInput!: HTMLInputElement;
    private hInput!: HTMLInputElement;

    constructor(app: App, currentW: number, currentH: number, onApply: (w: number, h: number) => void) {
        super(app);
        this.currentW = currentW;
        this.currentH = currentH;
        this.onApply  = onApply;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: '設定畫布大小' });
        this.hintEl = contentEl.createEl('p', {
            cls:  'easynote-size-hint',
            text: `目前：${this.currentW} × ${this.currentH}　（現有內容會保留在左上角）`,
        });

        // 輸入列
        const inputRow = contentEl.createEl('div', { cls: 'easynote-size-row' });

        this.wInput = inputRow.createEl('input');
        this.wInput.type  = 'number';
        this.wInput.min   = '100';
        this.wInput.max   = '16000';
        this.wInput.value = String(this.currentW);
        this.wInput.className = 'easynote-size-input';

        inputRow.createEl('span', { text: ' × ', cls: 'easynote-size-x' });

        this.hInput = inputRow.createEl('input');
        this.hInput.type  = 'number';
        this.hInput.min   = '100';
        this.hInput.max   = '16000';
        this.hInput.value = String(this.currentH);
        this.hInput.className = 'easynote-size-input';

        // 快速預設按鈕
        const presetRow = contentEl.createEl('div', { cls: 'easynote-size-presets' });
        const presets: [string, () => void][] = [
            ['×2 寬',  () => { this.wInput.value = String((parseInt(this.wInput.value) || this.currentW) * 2); }],
            ['×2 高',  () => { this.hInput.value = String((parseInt(this.hInput.value) || this.currentH) * 2); }],
            ['×2 全',  () => { this.wInput.value = String((parseInt(this.wInput.value) || this.currentW) * 2); this.hInput.value = String((parseInt(this.hInput.value) || this.currentH) * 2); }],
            ['1920×1080', () => { this.wInput.value = '1920'; this.hInput.value = '1080'; }],
            ['3840×1080', () => { this.wInput.value = '3840'; this.hInput.value = '1080'; }],
            ['3840×2160', () => { this.wInput.value = '3840'; this.hInput.value = '2160'; }],
        ];
        for (const [label, fn] of presets) {
            const btn = presetRow.createEl('button', { cls: 'easynote-btn', text: label });
            btn.addEventListener('click', fn);
        }

        // 確認 / 關閉（套用後不關閉，可繼續調整）
        const btnRow = contentEl.createEl('div', { cls: 'easynote-size-btnrow' });
        const applyBtn = btnRow.createEl('button', {
            cls:  'easynote-btn easynote-btn-save',
            text: '套用',
        });
        applyBtn.addEventListener('click', () => {
            const w = Math.max(100, Math.min(16000, parseInt(this.wInput.value) || this.currentW));
            const h = Math.max(100, Math.min(16000, parseInt(this.hInput.value) || this.currentH));
            this.onApply(w, h);
            this.close();
        });
        const closeBtn = btnRow.createEl('button', { cls: 'easynote-btn', text: '關閉' });
        closeBtn.addEventListener('click', () => this.close());
    }

    onClose(): void { this.contentEl.empty(); }
}

// ─── 專案名稱 Modal ───────────────────────────────────────────────────────────
class ProjectNameModal extends Modal {
    private name: string;
    private onConfirm: (name: string) => void;

    constructor(app: App, defaultName: string, onConfirm: (name: string) => void) {
        super(app);
        this.name      = defaultName;
        this.onConfirm = onConfirm;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: '儲存專案' });

        new Setting(contentEl)
            .setName('專案名稱')
            .setDesc('儲存為 .enote 格式，可下次繼續編輯')
            .addText((t) => {
                t.setValue(this.name);
                t.inputEl.style.width = '100%';
                t.onChange((v) => { this.name = v.trim() || this.name; });
                setTimeout(() => { t.inputEl.select(); t.inputEl.focus(); }, 30);
            });

        const btnRow   = contentEl.createEl('div', { cls: 'easynote-size-btnrow' });
        const saveBtn  = btnRow.createEl('button', { cls: 'easynote-btn easynote-btn-save', text: '儲存' });
        saveBtn.addEventListener('click', () => { if (this.name) { this.onConfirm(this.name); this.close(); } });
        const cancelBtn = btnRow.createEl('button', { cls: 'easynote-btn', text: '取消' });
        cancelBtn.addEventListener('click', () => this.close());

        contentEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')  { saveBtn.click();  e.preventDefault(); }
            if (e.key === 'Escape') { this.close();     e.preventDefault(); }
        });
    }

    onClose(): void { this.contentEl.empty(); }
}

// ─── Vault 專案選擇 Modal (.enote) ────────────────────────────────────────────
class VaultProjectPickerModal extends Modal {
    private onChoose:     (file: TFile) => void;
    private searchInput!: HTMLInputElement;
    private listEl!:      HTMLElement;

    constructor(app: App, onChoose: (file: TFile) => void) {
        super(app);
        this.onChoose = onChoose;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.modalEl.addClass('easynote-project-picker-modal');
        contentEl.createEl('h3', { text: '載入 .enote 專案' });

        this.searchInput             = contentEl.createEl('input');
        this.searchInput.type        = 'text';
        this.searchInput.placeholder = '搜尋專案名稱…';
        this.searchInput.className   = 'easynote-picker-search';
        this.searchInput.addEventListener('input', () => this.renderList());

        this.listEl = contentEl.createEl('div', { cls: 'easynote-project-list' });
        this.renderList();
        setTimeout(() => this.searchInput.focus(), 50);
    }

    private getFiles(): TFile[] {
        const query = this.searchInput?.value.toLowerCase() ?? '';
        return this.app.vault.getFiles()
            .filter(f => f.extension.toLowerCase() === 'enote')
            .filter(f => !query || f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query))
            .sort((a, b) => b.stat.mtime - a.stat.mtime);  // 最近修改優先
    }

    private renderList(): void {
        this.listEl.empty();
        const files = this.getFiles();
        if (files.length === 0) {
            this.listEl.createEl('div', { cls: 'easynote-picker-empty', text: '找不到 .enote 檔案' });
            return;
        }
        for (const file of files) {
            const item = this.listEl.createEl('div', { cls: 'easynote-project-item' });
            item.createEl('span', { cls: 'easynote-project-name', text: file.basename });
            item.createEl('span', { cls: 'easynote-project-path', text: file.parent?.path ?? '/' });
            item.addEventListener('click', () => { this.onChoose(file); this.close(); });
        }
    }

    onClose(): void { this.contentEl.empty(); }
}

// ─── Vault 圖片選擇 Modal ──────────────────────────────────────────────────────
class VaultImagePickerModal extends Modal {
    private onChoose:       (file: TFile) => void;
    private searchInput!:   HTMLInputElement;
    private sidebarEl!:     HTMLElement;
    private gridEl!:        HTMLElement;
    private selectedFolder: string | null = null;   // null = 全部

    private static readonly IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

    constructor(app: App, onChoose: (file: TFile) => void) {
        super(app);
        this.onChoose = onChoose;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.modalEl.addClass('easynote-vault-picker-modal');
        contentEl.createEl('h3', { text: '選擇 Vault 圖片' });

        this.searchInput             = contentEl.createEl('input');
        this.searchInput.type        = 'text';
        this.searchInput.placeholder = '搜尋圖片檔名…';
        this.searchInput.className   = 'easynote-picker-search';
        this.searchInput.addEventListener('input', () => this.renderMain());

        // 主體：左側資料夾欄 + 右側縮圖區
        const wrap     = contentEl.createEl('div', { cls: 'easynote-picker-wrap' });
        this.sidebarEl = wrap.createEl('div', { cls: 'easynote-picker-sidebar' });
        this.gridEl    = wrap.createEl('div', { cls: 'easynote-picker-grid' });

        this.renderSidebar();
        this.renderMain();

        setTimeout(() => this.searchInput.focus(), 50);
    }

    private getAllImages(): TFile[] {
        return this.app.vault.getFiles().filter(f =>
            VaultImagePickerModal.IMAGE_EXTS.includes(f.extension.toLowerCase())
        );
    }

    private getFilteredFiles(): TFile[] {
        const query = this.searchInput.value.toLowerCase();
        return this.getAllImages().filter(f => {
            const matchQuery  = !query
                || f.name.toLowerCase().includes(query)
                || f.path.toLowerCase().includes(query);
            const matchFolder = this.selectedFolder === null
                || (f.parent?.path ?? '/') === this.selectedFolder;
            return matchQuery && matchFolder;
        });
    }

    private renderSidebar(): void {
        this.sidebarEl.empty();
        const allImages = this.getAllImages();

        // 計算各資料夾圖片數
        const folderCounts = new Map<string, number>();
        for (const f of allImages) {
            const folder = f.parent?.path ?? '/';
            folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
        }

        // 「全部」項目
        this.makeSidebarItem('🗂️', '全部', allImages.length, null);
        this.sidebarEl.createEl('div', { cls: 'easynote-picker-sidebar-sep' });

        // 各資料夾，根目錄優先
        const folders = [...folderCounts.keys()].sort((a, b) => {
            if (a === '/') return -1;
            if (b === '/') return  1;
            return a.localeCompare(b);
        });
        for (const folder of folders) {
            const label   = folder === '/' ? '根目錄' : (folder.split('/').pop() ?? folder);
            const tooltip = folder === '/' ? '根目錄' : folder;
            this.makeSidebarItem('📁', label, folderCounts.get(folder)!, folder, tooltip);
        }
    }

    private makeSidebarItem(
        icon: string, label: string, count: number,
        folder: string | null, tooltip?: string,
    ): void {
        const item = this.sidebarEl.createEl('div', { cls: 'easynote-picker-sidebar-item' });
        if (this.selectedFolder === folder) item.addClass('is-active');
        if (tooltip) item.title = tooltip;
        item.createEl('span', { cls: 'easynote-picker-sidebar-icon',  text: icon });
        item.createEl('span', { cls: 'easynote-picker-sidebar-label', text: label });
        item.createEl('span', { cls: 'easynote-picker-sidebar-count', text: `${count}` });
        item.addEventListener('click', () => {
            this.selectedFolder = folder;
            this.renderSidebar();
            this.renderMain();
        });
    }

    private renderMain(): void {
        this.gridEl.empty();
        const files = this.getFilteredFiles();

        if (files.length === 0) {
            this.gridEl.createEl('div', { cls: 'easynote-picker-empty', text: '找不到符合的圖片' });
            return;
        }

        for (const file of files) {
            const item  = this.gridEl.createEl('div', { cls: 'easynote-picker-item' });
            const thumb = item.createEl('img') as HTMLImageElement;
            thumb.className = 'easynote-picker-thumb';
            thumb.src       = this.app.vault.getResourcePath(file);
            thumb.alt       = file.name;
            item.createEl('span', { cls: 'easynote-picker-name', text: file.name });
            item.addEventListener('click', () => {
                this.onChoose(file);
                this.close();
            });
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

// ─── Vault 筆記選擇 Modal ─────────────────────────────────────────────────────
class VaultNotePickerModal extends Modal {
    private onChoose:     (file: TFile) => void;
    private searchInput!: HTMLInputElement;
    private listEl!:      HTMLElement;

    constructor(app: App, onChoose: (file: TFile) => void) {
        super(app);
        this.onChoose = onChoose;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.modalEl.addClass('easynote-project-picker-modal');
        contentEl.createEl('h3', { text: '連結 .md 筆記為文字圖層' });
        contentEl.createEl('p', {
            cls:  'easynote-picker-hint',
            text: '選擇筆記後，內容會以原始 Markdown 顯示。每次重新開啟 EasyNote 會自動重新讀取筆記最新內容。',
        });

        this.searchInput             = contentEl.createEl('input');
        this.searchInput.type        = 'text';
        this.searchInput.placeholder = '搜尋筆記名稱…';
        this.searchInput.className   = 'easynote-picker-search';
        this.searchInput.addEventListener('input', () => this.renderList());

        this.listEl = contentEl.createEl('div', { cls: 'easynote-project-list' });
        this.renderList();
        setTimeout(() => this.searchInput.focus(), 50);
    }

    private getFiles(): TFile[] {
        const query = this.searchInput?.value.toLowerCase() ?? '';
        return this.app.vault.getMarkdownFiles()
            .filter(f => !query || f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query))
            .sort((a, b) => b.stat.mtime - a.stat.mtime);
    }

    private renderList(): void {
        this.listEl.empty();
        const files = this.getFiles();
        if (files.length === 0) {
            this.listEl.createEl('div', { cls: 'easynote-picker-empty', text: '找不到 .md 筆記' });
            return;
        }
        for (const file of files) {
            const item = this.listEl.createEl('div', { cls: 'easynote-project-item' });
            item.createEl('span', { cls: 'easynote-project-name', text: file.basename });
            item.createEl('span', { cls: 'easynote-project-path', text: file.parent?.path ?? '/' });
            item.addEventListener('click', () => { this.onChoose(file); this.close(); });
        }
    }

    onClose(): void { this.contentEl.empty(); }
}

// ─── 主插件類別 ───────────────────────────────────────────────────────────────
export default class EasyNotePlugin extends Plugin {
    settings!: EasyNoteSettings;

    async onload(): Promise<void> {
        await this.loadSettings();

        // 註冊自訂 View
        this.registerView(VIEW_TYPE, (leaf) => new EasyNoteView(
            leaf,
            this.settings,
            () => this.saveSettings(),
            (filename, content) => this.uploadToGoogleDrive(filename, content),
            (filename) => this.downloadFromGoogleDrive(filename),
        ));

        // 左側 Ribbon 圖示
        this.addRibbonIcon('pencil', '開啟 EasyNote 手繪筆記', () => {
            this.activateView();
        });

        // Command Palette 指令
        this.addCommand({
            id:       'open-easynote',
            name:     '開啟 EasyNote 手繪筆記',
            callback: () => this.activateView(),
        });

        // 設定頁面
        this.addSettingTab(new EasyNoteSettingTab(this.app, this));
    }

    onunload(): void {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    }

    async activateView(): Promise<void> {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (!leaf) {
            leaf = workspace.getLeaf('tab');
            await leaf.setViewState({ type: VIEW_TYPE, active: true });
        }
        workspace.revealLeaf(leaf);
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    // ── Google Drive 整合 ──────────────────────────────────────────────────────

    /** 取得有效的 Access Token（必要時自動 refresh） */
    async getValidAccessToken(): Promise<string | null> {
        if (!this.settings.googleRefreshToken) {
            return null;
        }
        // 若目前 token 仍有效（預留 1 分鐘緩衝），直接回傳
        if (this.settings.googleAccessToken && Date.now() < this.settings.googleTokenExpiry - 60000) {
            return this.settings.googleAccessToken;
        }
        // 使用 refresh_token 換新 access token
        try {
            const resp = await requestUrl({
                url:    'https://oauth2.googleapis.com/token',
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id:     GOOGLE_CLIENT_ID,
                    client_secret: GOOGLE_CLIENT_SECRET,
                    refresh_token: this.settings.googleRefreshToken,
                    grant_type:    'refresh_token',
                }).toString(),
                throw: false,
            });
            if (resp.status !== 200) {
                console.error('[EasyNote] Token refresh failed:', resp.json);
                return null;
            }
            const data = resp.json;
            this.settings.googleAccessToken = data.access_token;
            this.settings.googleTokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
            await this.saveSettings();
            return this.settings.googleAccessToken;
        } catch (err) {
            console.error('[EasyNote] Token refresh error:', err);
            return null;
        }
    }

    /** 確保 Google Drive 上有 EasyNote-Sync 資料夾，回傳其 ID */
    async ensureGoogleDriveFolder(token: string): Promise<string> {
        if (this.settings.googleDriveFolderId) return this.settings.googleDriveFolderId;
        const FOLDER_NAME = 'EasyNote-Sync';
        const q = encodeURIComponent(
            `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
        );
        const searchResp = await requestUrl({
            url:    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
        });
        const files = searchResp.json.files ?? [];
        if (files.length > 0) {
            this.settings.googleDriveFolderId = files[0].id;
            await this.saveSettings();
            return files[0].id;
        }
        // 資料夾不存在，建立一個
        const createResp = await requestUrl({
            url:    'https://www.googleapis.com/drive/v3/files',
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body:   JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
        });
        this.settings.googleDriveFolderId = createResp.json.id;
        await this.saveSettings();
        return this.settings.googleDriveFolderId;
    }

    /** 上傳（或更新）檔案到 Google Drive */
    async uploadToGoogleDrive(filename: string, content: Uint8Array): Promise<void> {
        if (!this.settings.googleDriveEnabled) return;
        const token = await this.getValidAccessToken();
        if (!token) { console.warn('[EasyNote] Drive upload skipped: no token'); return; }
        const folderId = await this.ensureGoogleDriveFolder(token);

        // 確保 content 是獨立的 ArrayBuffer（避免 slice 問題）
        const contentBuf = content.buffer.slice(
            content.byteOffset, content.byteOffset + content.byteLength
        ) as ArrayBuffer;

        // 查詢是否已存在同名檔案
        const q = encodeURIComponent(`name='${filename}' and '${folderId}' in parents and trashed=false`);
        const searchResp = await requestUrl({
            url:    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
        });
        const existing = (searchResp.json.files ?? []) as { id: string }[];

        // 統一用 multipart upload（create 或 update 皆單次請求）
        const boundary  = `EasyNoteBoundary${Date.now()}`;
        const meta      = existing.length > 0
            ? JSON.stringify({ name: filename })                          // 更新不需 parents
            : JSON.stringify({ name: filename, parents: [folderId] });    // 建立需要 parents
        const headerStr = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
        const footerStr = `\r\n--${boundary}--`;
        const hBytes    = new TextEncoder().encode(headerStr);
        const fBytes    = new TextEncoder().encode(footerStr);
        const cBytes    = new Uint8Array(contentBuf);
        const body      = new Uint8Array(hBytes.length + cBytes.length + fBytes.length);
        body.set(hBytes, 0);
        body.set(cBytes, hBytes.length);
        body.set(fBytes, hBytes.length + cBytes.length);

        const method  = existing.length > 0 ? 'PATCH' : 'POST';
        const fileId  = existing.length > 0 ? `/${existing[0].id}` : '';
        const resp = await requestUrl({
            url:    `https://www.googleapis.com/upload/drive/v3/files${fileId}?uploadType=multipart`,
            method,
            headers: {
                Authorization:  `Bearer ${token}`,
                'Content-Type': `multipart/related; boundary=${boundary}`,
            },
            body:  body.buffer as ArrayBuffer,
            throw: false,
        });
        if (resp.status < 200 || resp.status >= 300) {
            console.error('[EasyNote] Drive upload error:', resp.status, resp.json);
            throw new Error(`Drive upload failed: HTTP ${resp.status}`);
        }
    }

    /** 從 Google Drive 下載檔案，回傳內容位元組（找不到時回傳 null） */
    async downloadFromGoogleDrive(filename: string): Promise<Uint8Array | null> {
        if (!this.settings.googleDriveEnabled) return null;
        const token = await this.getValidAccessToken();
        if (!token) { console.warn('[EasyNote] Drive download skipped: no token'); return null; }
        const folderId = await this.ensureGoogleDriveFolder(token);
        const q = encodeURIComponent(`name='${filename}' and '${folderId}' in parents and trashed=false`);
        const searchResp = await requestUrl({
            url:    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`,
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
        });
        const files = searchResp.json.files ?? [];
        if (files.length === 0) return null;
        const fileId = files[0].id;
        const resp = await requestUrl({
            url:    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
        });
        return new Uint8Array(resp.arrayBuffer);
    }

    /** 開啟瀏覽器引導使用者完成 Google OAuth2 授權，並儲存 Refresh Token */
    async startGoogleOAuthFlow(): Promise<void> {
        if (Platform.isDesktopApp) {
            await this._oauthDesktop();
        } else {
            await this._oauthMobile();
        }
    }

    /** 桌面版：啟動本機 HTTP server 自動接收授權碼 */
    private async _oauthDesktop(): Promise<void> {
        const port        = GOOGLE_OAUTH_PORT;
        const redirectUri = GOOGLE_REDIRECT_URI;
        const authUrl     = this._buildAuthUrl(redirectUri);

        const code = await new Promise<string | null>((resolve) => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const http = require('http') as typeof import('http');
            const server = http.createServer((req, res) => {
                const url  = new URL(req.url ?? '/', redirectUri);
                const code = url.searchParams.get('code');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<html><body style="font-family:sans-serif;padding:40px"><h2>✓ 授權成功！請回到 Obsidian。</h2><p>此視窗可以關閉。</p></body></html>');
                server.close();
                resolve(code);
            });
            server.listen(port, '127.0.0.1', () => {
                window.open(authUrl);
                new Notice('請在瀏覽器中完成 Google 登入授權…', 10000);
            });
            server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    new Notice(`埠號 ${port} 已被佔用，請關閉佔用該埠的程式後再試`, 5000);
                }
                resolve(null);
            });
            setTimeout(() => { try { server.close(); } catch { /* ignore */ } resolve(null); }, 120000);
        });

        if (!code) { new Notice('Google 授權失敗或超時，請重試'); return; }
        await this._exchangeCode(code, redirectUri);
    }

    /** 行動版（Android / iOS）：手動貼上跳轉網址取得授權碼 */
    private async _oauthMobile(): Promise<void> {
        // 行動版使用 http://localhost（無埠號），Desktop app 類型自動允許
        const redirectUri = 'http://localhost';
        const authUrl     = this._buildAuthUrl(redirectUri);

        const code = await new Promise<string | null>((resolve) => {
            new GoogleOAuthMobileModal(this.app, authUrl, resolve).open();
        });

        if (!code) { new Notice('Google 授權已取消'); return; }
        await this._exchangeCode(code, redirectUri);
    }

    private _buildAuthUrl(redirectUri: string): string {
        return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
            client_id:     GOOGLE_CLIENT_ID,
            redirect_uri:  redirectUri,
            response_type: 'code',
            scope:         'https://www.googleapis.com/auth/drive.file',
            access_type:   'offline',
            prompt:        'consent',
        }).toString();
    }

    private async _exchangeCode(code: string, redirectUri: string): Promise<void> {
        const resp = await requestUrl({
            url:    'https://oauth2.googleapis.com/token',
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id:     GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                code,
                redirect_uri:  redirectUri,
                grant_type:    'authorization_code',
            }).toString(),
            throw: false,
        });
        if (resp.status !== 200) {
            const detail = resp.json?.error_description ?? resp.json?.error ?? '';
            console.error('[EasyNote] OAuth token exchange failed:', resp.json);
            new Notice(`Google 授權失敗：${detail || 'Token 交換錯誤'}\n請確認 Google Cloud Console 的 Redirect URI 是否設為 ${redirectUri}`, 8000);
            return;
        }
        const data = resp.json;
        this.settings.googleRefreshToken  = data.refresh_token ?? '';
        this.settings.googleAccessToken   = data.access_token  ?? '';
        this.settings.googleTokenExpiry   = Date.now() + (data.expires_in ?? 3600) * 1000;
        this.settings.googleDriveFolderId = '';
        await this.saveSettings();
        new Notice('✓ Google Drive 授權成功！');
    }

    /** 中斷 Google Drive 連線，清除所有已儲存的憑證 */
    async revokeGoogleAuth(): Promise<void> {
        this.settings.googleRefreshToken  = '';
        this.settings.googleAccessToken   = '';
        this.settings.googleTokenExpiry   = 0;
        this.settings.googleDriveFolderId = '';
        await this.saveSettings();
        new Notice('已中斷 Google Drive 連線');
    }
}

// ─── Google OAuth 行動版 Modal ────────────────────────────────────────────────
/**
 * 行動版 OAuth 流程：
 * 1. 使用者點「開啟瀏覽器授權」→ 在瀏覽器登入 Google 並同意
 * 2. 瀏覽器跳轉到 http://localhost?code=XXX（會載入失敗，但網址列有 code）
 * 3. 使用者複製網址列完整網址，貼到下方欄位，按「確認」
 */
class GoogleOAuthMobileModal extends Modal {
    private authUrl:   string;
    private onResolve: (code: string | null) => void;
    private textarea!: HTMLTextAreaElement;

    constructor(app: App, authUrl: string, onResolve: (code: string | null) => void) {
        super(app);
        this.authUrl   = authUrl;
        this.onResolve = onResolve;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: 'Google Drive 授權（行動版）' });

        contentEl.createEl('p', {
            text: '步驟 1：點擊下方按鈕，在瀏覽器中登入 Google 並同意授權。',
        });

        const openBtn = contentEl.createEl('button', { text: '開啟瀏覽器授權', cls: 'mod-cta' });
        openBtn.style.marginBottom = '16px';
        openBtn.addEventListener('click', () => window.open(this.authUrl));

        contentEl.createEl('p', {
            text: '步驟 2：授權後瀏覽器會跳轉到一個無法載入的頁面（http://localhost?code=…），請複製網址列中的完整網址，貼到下方。',
        });

        this.textarea             = contentEl.createEl('textarea');
        this.textarea.placeholder = 'http://localhost?code=4/0AX…';
        this.textarea.style.cssText = 'width:100%;height:80px;margin-bottom:12px;font-size:12px;';

        const btnRow = contentEl.createEl('div', { cls: 'modal-button-container' });

        const cancelBtn = btnRow.createEl('button', { text: '取消' });
        cancelBtn.addEventListener('click', () => { this.onResolve(null); this.close(); });

        const confirmBtn = btnRow.createEl('button', { text: '確認', cls: 'mod-cta' });
        confirmBtn.addEventListener('click', () => {
            const raw  = this.textarea.value.trim();
            let code: string | null = null;
            try {
                // 嘗試把貼上內容當作完整網址解析
                const url = new URL(raw);
                code = url.searchParams.get('code');
            } catch {
                // 若貼的只是 code 字串本身，直接使用
                if (raw && !raw.includes(' ')) code = raw;
            }
            if (!code) {
                new Notice('無法從貼上的內容取得授權碼，請確認網址是否正確', 4000);
                return;
            }
            this.onResolve(code);
            this.close();
        });
    }

    onClose(): void { this.contentEl.empty(); }
}

// ─── 設定頁面 ─────────────────────────────────────────────────────────────────
class EasyNoteSettingTab extends PluginSettingTab {
    plugin: EasyNotePlugin;

    constructor(app: App, plugin: EasyNotePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'EasyNote 設定' });

        // 預設顏色
        new Setting(containerEl)
            .setName('預設顏色')
            .setDesc('開啟 EasyNote 時的預設畫筆顏色')
            .addDropdown((drop) => {
                COLOR_NAMES.forEach((name, i) => drop.addOption(String(i), name));
                drop.setValue(String(this.plugin.settings.defaultColorIdx));
                drop.onChange(async (value) => {
                    this.plugin.settings.defaultColorIdx = parseInt(value);
                    await this.plugin.saveSettings();
                });
            });

        // 筆刷模式
        new Setting(containerEl)
            .setName('筆刷模式')
            .setDesc('7 階模式：固定 7 個大小檔殔；連續模式：自由調整 1–60px')
            .addDropdown((drop) => {
                drop.addOption('steps', '7 階');
                drop.addOption('continuous', '連續');
                drop.setValue(this.plugin.settings.brushMode ?? 'steps');
                drop.onChange(async (value) => {
                    this.plugin.settings.brushMode = value as 'steps' | 'continuous';
                    await this.plugin.saveSettings();
                    this.display();
                });
            });

        // 預設筆刷大小
        if ((this.plugin.settings.brushMode ?? 'steps') === 'steps') {
            const curStep = brushSizeToStep(this.plugin.settings.defaultBrushSize);
            new Setting(containerEl)
                .setName('預設筆刷大小')
                .setDesc(`開啟 EasyNote 時的預設筆刷階數（7 階）`)
                .addSlider((slider) =>
                    slider
                        .setLimits(1, 7, 1)
                        .setValue(curStep)
                        .setDynamicTooltip()
                        .onChange(async (value) => {
                            this.plugin.settings.defaultBrushSize = BRUSH_STEPS[value - 1];
                            await this.plugin.saveSettings();
                        })
                );
            containerEl.createEl('p', {
                text: `7 階對應大小: ${BRUSH_STEPS.map((s, i) => `第${i+1}階=${s}px`).join(' / ')}`,
                cls: 'setting-item-description',
            });
        } else {
            new Setting(containerEl)
                .setName('預設筆刷大小')
                .setDesc(`開啟 EasyNote 時的預設筆刷大小（${MIN_BRUSH_SIZE}–${MAX_BRUSH_SIZE}px）`)
                .addSlider((slider) =>
                    slider
                        .setLimits(MIN_BRUSH_SIZE, MAX_BRUSH_SIZE, 1)
                        .setValue(this.plugin.settings.defaultBrushSize)
                        .setDynamicTooltip()
                        .onChange(async (value) => {
                            this.plugin.settings.defaultBrushSize = value;
                            await this.plugin.saveSettings();
                        })
                );
        }

        // 預設五色筆顏色
        containerEl.createEl('h3', { text: '預設五色筆顏色' });
        const colorLabels = ['顏色 1（黑）', '顏色 2（紅）', '顏色 3（藍）', '顏色 4（綠）', '顏色 5（橘）'];
        const defaults = this.plugin.settings.defaultColors ?? [...COLORS];
        for (let i = 0; i < 5; i++) {
            new Setting(containerEl)
                .setName(colorLabels[i])
                .addColorPicker((picker) => {
                    picker.setValue(defaults[i] ?? COLORS[i]);
                    picker.onChange(async (value) => {
                        if (!this.plugin.settings.defaultColors) {
                            this.plugin.settings.defaultColors = [...COLORS];
                        }
                        this.plugin.settings.defaultColors[i] = value;
                        await this.plugin.saveSettings();
                    });
                });
        }

        // 啟動畫布模式
        new Setting(containerEl)
            .setName('啟動畫布模式')
            .setDesc('開啟 EasyNote 時要呼叫前一次的畫布，還是呼叫對新畫布？選择「呼叫新畫布」時，關閉時會刪除自動暫存檔。')
            .addDropdown((drop) => {
                drop.addOption('new',      '呼叫新畫布（預設）');
                drop.addOption('previous', '打開前一次');
                drop.setValue(this.plugin.settings.startupMode ?? 'new');
                drop.onChange(async (value) => {
                    this.plugin.settings.startupMode = value as 'previous' | 'new';
                    await this.plugin.saveSettings();
                });
            });

        // 預設畫布大小
        new Setting(containerEl)
            .setName('預設畫布寬度（px）')
            .setDesc('新畫布的初始寬度（像素），預設 1920')
            .addText((text) =>
                text
                    .setPlaceholder('1920')
                    .setValue(String(this.plugin.settings.defaultCanvasWidth ?? 1920))
                    .onChange(async (value) => {
                        const v = parseInt(value);
                        if (v > 0) {
                            this.plugin.settings.defaultCanvasWidth = v;
                            await this.plugin.saveSettings();
                        }
                    })
            );
        new Setting(containerEl)
            .setName('預設畫布高度（px）')
            .setDesc('新畫布的初始高度（像素），預設 1080')
            .addText((text) =>
                text
                    .setPlaceholder('1080')
                    .setValue(String(this.plugin.settings.defaultCanvasHeight ?? 1080))
                    .onChange(async (value) => {
                        const v = parseInt(value);
                        if (v > 0) {
                            this.plugin.settings.defaultCanvasHeight = v;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        // 筆觸解析度
        new Setting(containerEl)
            .setName('筆觸解析度')
            .setDesc('降低可大幅提升大畫布（8K 等）效能，但筆觸邊緣在縮放後會略微模糊。更改後需重新開啟畫布才生效。')
            .addDropdown((drop) => {
                drop.addOption('1',    '1× 完整解析度（預設）');
                drop.addOption('0.75', '0.75× 較佳效能');
                drop.addOption('0.5',  '0.5× 高效能（推薦大畫布）');
                drop.addOption('0.25', '0.25× 最高效能');
                drop.setValue(String(this.plugin.settings.paintScale ?? 1));
                drop.onChange(async (value) => {
                    this.plugin.settings.paintScale = parseFloat(value);
                    await this.plugin.saveSettings();
                });
            });

        // 儲存資料夾
        new Setting(containerEl)
            .setName('時區')
            .setDesc('儲存檔名使用的時區（IANA 格式，例如 Asia/Taipei、America/New_York、Europe/London）')
            .addText((text) =>
                text
                    .setPlaceholder('Asia/Taipei')
                    .setValue(this.plugin.settings.timezone ?? 'Asia/Taipei')
                    .onChange(async (value) => {
                        const tz = value.trim();
                        // 簡單驗證：嘗試建立 Intl.DateTimeFormat，失敗則不儲存
                        try {
                            new Intl.DateTimeFormat('sv-SE', { timeZone: tz });
                            this.plugin.settings.timezone = tz;
                            await this.plugin.saveSettings();
                        } catch {
                            // 時區字串無效，不更新
                        }
                    })
            );

        // 定時 auto-sync
        new Setting(containerEl)
            .setName('定時自動重新載入')
            .setDesc('開啟後，畫布會依照設定的間隔定時自動重新載入目前畫布檔（工具列按鈕也可即時切換），沒有檔名時不作動')
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.autoSyncEnabled ?? false);
                toggle.onChange(async (value) => {
                    this.plugin.settings.autoSyncEnabled = value;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('自動重新載入間隔（秒）')
            .setDesc('定時自動重新載入的間隔秒數，最短 1 秒')
            .addText((text) =>
                text
                    .setPlaceholder('5')
                    .setValue(String((this.plugin.settings.autoSyncPeriodMs ?? 5000) / 1000))
                    .onChange(async (value) => {
                        const sec = parseFloat(value);
                        if (sec >= 1) {
                            this.plugin.settings.autoSyncPeriodMs = sec * 1000;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        // 定時 auto-save
        new Setting(containerEl)
            .setName('定時自動儲存')
            .setDesc('開啟後，畫布會依照設定的間隔定時自動儲存（工具列按鈕也可即時切換）')
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.autoPeriodicSaveEnabled ?? false);
                toggle.onChange(async (value) => {
                    this.plugin.settings.autoPeriodicSaveEnabled = value;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('自動儲存間隔（秒）')
            .setDesc('定時自動儲存的間隔秒數，最短 1 秒')
            .addText((text) =>
                text
                    .setPlaceholder('60')
                    .setValue(String((this.plugin.settings.autoPeriodicSavePeriodMs ?? 60000) / 1000))
                    .onChange(async (value) => {
                        const sec = parseFloat(value);
                        if (sec >= 1) {
                            this.plugin.settings.autoPeriodicSavePeriodMs = sec * 1000;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        new Setting(containerEl)
            .setName('儲存資料夾')
            .setDesc('點擊「儲存 PNG」後，手繪圖存入 Vault 的哪個資料夾')
            .addText((text) =>
                text
                    .setPlaceholder('EasyNote')
                    .setValue(this.plugin.settings.saveFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.saveFolder = value.trim() || 'EasyNote';
                        await this.plugin.saveSettings();
                    })
            );

        // ── Google Drive 同步 ────────────────────────────────────────────────
        containerEl.createEl('h3', { text: 'Google Drive 同步' });
        containerEl.createEl('p', {
            cls:  'setting-item-description',
            text: '自動儲存時同步上傳到 Google Drive，自動載入時從 Google Drive 下載（同步資料夾：EasyNote-Sync）。',
        });

        // 顯示需要登記的 Redirect URI
        const uriInfoEl = containerEl.createEl('p', { cls: 'setting-item-description' });
        uriInfoEl.innerHTML =
            `<b>桌面版</b>請在 Google Cloud Console → 憑證 → OAuth 2.0 用戶端 → 「已授權的重新導向 URI」新增：` +
            `<br><code style="user-select:all">http://localhost:42813</code>` +
            `<br><b>行動版（Android / iOS）</b>另需新增：` +
            `<br><code style="user-select:all">http://localhost</code>` +
            `<br>（若用戶端類型已選「桌面應用程式」則以上皆自動允許，無需手動新增）`;

        new Setting(containerEl)
            .setName('啟用 Google Drive 同步')
            .setDesc('開啟後，自動儲存時同步上傳到 Google Drive，自動載入時從 Google Drive 下載。')
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.googleDriveEnabled ?? false);
                toggle.onChange(async (value) => {
                    this.plugin.settings.googleDriveEnabled = value;
                    await this.plugin.saveSettings();
                });
            });

        const isConnected = !!this.plugin.settings.googleRefreshToken;
        new Setting(containerEl)
            .setName('Google Drive 連線狀態')
            .setDesc(isConnected
                ? '✓ 已連線 Google Drive（同步資料夾：EasyNote-Sync）'
                : '尚未連線，請點擊「連線 Google Drive」並在瀏覽器中登入 Google 帳戶。')
            .addButton((btn) => {
                btn.setButtonText(isConnected ? '重新授權' : '連線 Google Drive');
                btn.setCta();
                btn.onClick(async () => {
                    await this.plugin.startGoogleOAuthFlow();
                    this.display();
                });
            })
            .addButton((btn) => {
                btn.setButtonText('中斷連線');
                btn.setDisabled(!isConnected);
                btn.onClick(async () => {
                    await this.plugin.revokeGoogleAuth();
                    this.display();
                });
            });
    }
}
