import {
    App,
    ItemView,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    WorkspaceLeaf,
    normalizePath,
    setIcon,
} from 'obsidian';

// ─── 常數（對應 EasyNote GDScript 的 COLORS / COLOR_NAMES）──────────────────
const VIEW_TYPE        = 'godot-easynote';
const TOOLBAR_HEIGHT   = 52;
const MIN_BRUSH_SIZE   = 1;
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
};

// ─── .enote 專案格式 ──────────────────────────────────────────────────────────
interface ENoteImageLayer    { src: string; x: number; y: number; w: number; h: number; }
interface ENoteTextLayer     { text: string; x: number; y: number; fontSize: number; color: string; linkedNotePath?: string; }
interface ENoteMarkdownLayer { text: string; x: number; y: number; fontSize: number; color: string; width: number; linkedNotePath?: string; }
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
}

type HandleType = 'move' | 'nw' | 'ne' | 'sw' | 'se';

interface DragState {
    handle:     HandleType;
    startMX:    number;
    startMY:    number;
    startX:     number;
    startY:     number;
    startW:     number;
    startH:     number;
}

interface TextLayer {
    text:           string;
    x:              number;
    y:              number;
    fontSize:       number;
    color:          string;
    linkedNotePath?: string;  // 連結到 Vault .md 筆記的路徑（開啟時自動更新內容）
}

interface TextDragState {
    handle:        HandleType;
    startMX:       number;
    startMY:       number;
    startX:        number;
    startY:        number;
    startFontSize: number;
    startW:        number;
    startH:        number;
}

/** 一小塊被「擷起」的繪畫內容，可經導動、縮放後再合并回繪畫層 */
interface PaintFragment {
    offscreen: HTMLCanvasElement;  // 提取的原始畫素
    x:  number;                    // 目前畫布上 X
    y:  number;
    w:  number;                    // 目前寬度（可被縮放）
    h:  number;
}

/** 行內 Markdown 片段（用於 MarkdownLayer 渲染） */
interface InlineSeg {
    text:     string;
    bold?:    boolean;
    italic?:  boolean;
    code?:    boolean;
    link?:    boolean;
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
    _cachedH?:       number;           // 執行期快取高度，不序列化
}

interface MdDragState {
    handle:        HandleType;
    startMX:       number;
    startMY:       number;
    startX:        number;
    startY:        number;
    startFontSize: number;
    startWidth:    number;
    startH:        number;
}

/** 畫布歷史快照（用於 Undo/Redo） */
interface HistoryEntry {
    label:          string;
    paintData:      ImageData;
    imageLayers:    { img: HTMLImageElement; x: number; y: number; w: number; h: number }[];
    markdownLayers: { text: string; x: number; y: number; fontSize: number; color: string; width: number; linkedNotePath?: string }[];
    textLayers:     { text: string; x: number; y: number; fontSize: number; color: string; linkedNotePath?: string }[];
    canvasW:        number;
    canvasH:        number;
}

// ─── 繪圖面板（ItemView）──────────────────────────────────────────────────────
class EasyNoteView extends ItemView {
    private settings: EasyNoteSettings;

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

    // 工具模式
    private tool:       'draw' | 'select' | 'text' | 'paintselect' = 'draw';
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

    // 縮放 & 平移（滾輪縮放，中鍵拖曳平移）
    private zoom          = 1.0;
    private isPanning     = false;
    private panStartX     = 0;
    private panStartY     = 0;
    private panScrollLeft = 0;
    private panScrollTop  = 0;

    // 自動儲存
    private autoSaveTimer:   ReturnType<typeof setTimeout> | null = null;
    private lastAutoSaveTime: Date | null = null;
    private static readonly AUTOSAVE_DEBOUNCE_MS = 3000;   // 最後一次變更後 3 秒觸發
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

    constructor(leaf: WorkspaceLeaf, settings: EasyNoteSettings) {
        super(leaf);
        this.settings = settings;
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
        this.tool               = 'draw';
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
        // 取消 debounce
        if (this.autoSaveTimer !== null) {
            clearTimeout(this.autoSaveTimer);
            this.autoSaveTimer = null;
        }
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

        row1.createEl('span', { cls: 'easynote-title', text: '✏ EasyNote' });
        row1.createEl('div',  { cls: 'easynote-sep'  });

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
        setIcon(this.paintSelectBtn, 'lasso');
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
            btn.addEventListener('click', () => this.setColor(i));

            // 雙擊 → 在按鈕正下方顯示顏色選擇面板
            btn.addEventListener('dblclick', (e) => {
                e.stopPropagation();
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
            });

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
        row1.createEl('span', { cls: 'easynote-group-label', text: '圖片' });

        // 選取工具（快捷 S）
        this.selectBtn = row1.createEl('button', {
            cls:   'easynote-btn easynote-btn-icon',
            title: '選取並移動/縮放圖片（快捷：S）\nDel 刪除選取圖片',
        });
        setIcon(this.selectBtn, 'mouse-pointer-2');
        this.selectBtn.addEventListener('click', () => this.setTool('select'));

        // 載入本機圖片
        const loadBtn = row1.createEl('button', {
            cls:   'easynote-btn',
            text:  '載入本機圖片',
            title: '從本機載入圖片（也可拖曳或 Ctrl+V）',
        });
        loadBtn.addEventListener('click', () => this.fileInput.click());

        this.fileInput        = row1.createEl('input');
        this.fileInput.type   = 'file';
        this.fileInput.accept = 'image/*';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', () => {
            const file = this.fileInput.files?.[0];
            if (file) this.loadImageFromBlob(file);
            this.fileInput.value = '';
        });

        // 載入Obsidian圖片
        const vaultBtn = row1.createEl('button', {
            cls:   'easynote-btn',
            text:  '載入Obsidian圖片',
            title: '從 Vault 中選取圖片',
        });
        vaultBtn.addEventListener('click', () => {
            new VaultImagePickerModal(this.app, (file) => this.loadImageFromVault(file)).open();
        });

        // 載入筆記
        const loadNoteBtn = row1.createEl('button', {
            cls:   'easynote-btn',
            text:  '載入筆記',
            title: '將 Vault .md 筆記以 Markdown 圖層載入（每次開啟自動更新）',
        });
        loadNoteBtn.addEventListener('click', () => {
            new VaultNotePickerModal(this.app, (file) => this.addLinkedMarkdownLayer(file)).open();
        });

        // 目前圕層類型標示（右側）
        row1.createEl('div', { cls: 'easynote-spacer' });
        this.activeLayerLabel = row1.createEl('span', { cls: 'easynote-active-layer' });

        // ── 第二行 ──────────────────────────────────────────────────────────
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

        // 畫布大小
        const canvasSizeBtn = row2.createEl('button', {
            cls:   'easynote-btn',
            text:  '畫布大小',
            title: '調整畫布尺寸（現有內容保留）',
        });
        canvasSizeBtn.addEventListener('click', () => {
            new CanvasSizeModal(this.app, this.canvas.width, this.canvas.height,
                (w, h) => this.setCanvasSize(w, h)).open();
        });
        row2.createEl('div', { cls: 'easynote-sep' });

        // 儲存專案 (.enote)
        const saveProjectBtn = row2.createEl('button', {
            cls:   'easynote-btn',
            text:  '儲存畫布',
            title: '儲存可繼續編輯的 .enote 專案檔',
        });
        saveProjectBtn.addEventListener('click', () => {
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const defaultName = this.lastProjectName || `EasyNote-${ts}`;
            new ProjectNameModal(this.app, defaultName, (name) => this.saveProject(name)).open();
        });

        // 載入專案 (.enote)
        const loadProjectBtn = row2.createEl('button', {
            cls:   'easynote-btn',
            text:  '載入畫布',
            title: '從 Vault 載入 .enote 專案檔',
        });
        loadProjectBtn.addEventListener('click', () => {
            new VaultProjectPickerModal(this.app, (file) => this.loadProject(file)).open();
        });

        // 儲存檔案
        const saveBtn = row2.createEl('button', {
            cls:   'easynote-btn easynote-btn-save',
            text:  '匯出',
            title: '將手繪圖儲存到 Vault',
        });
        saveBtn.addEventListener('click', () => {
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const defaultName = this.lastSaveName || `EasyNote-${ts}`;
            new SaveModal(this.app, defaultName, (name, fmt) => this.saveDrawing(name, fmt)).open();
        });

        row2.createEl('div', { cls: 'easynote-spacer' });
        this.statusLabel = row2.createEl('span', { cls: 'easynote-status' });

        // ── 歸御小組 (row2 右側) ────────────────────────
        row2.createEl('div', { cls: 'easynote-sep' });

        // Undo 組合按鈕
        const undoGroup       = row2.createEl('div', { cls: 'easynote-history-group' });
        this.undoBtn          = undoGroup.createEl('button', {
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

        // Redo 組合按鈕
        const redoGroup       = row2.createEl('div', { cls: 'easynote-history-group' });
        this.redoBtn          = redoGroup.createEl('button', {
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
        this.canvas.addEventListener('mousedown', (e) => {
            // 中鍵按下 → 開始平移
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
            const { x: mx, y: my } = this.toCanvasCoords(e);

            if (this.tool === 'text') {
                // 文字工具：搜尋是否點到已有文字圖層
                let hitTextIdx = -1;
                for (let i = this.textLayers.length - 1; i >= 0; i--) {
                    if (this.pointInText(mx, my, this.textLayers[i])) { hitTextIdx = i; break; }
                }
                this.openTextEditor(mx, my, hitTextIdx);
            } else if (this.tool === 'paintselect') {
                if (this.paintFragment) {
                    // 有 fragment：檢查控點 / 內部變鑑 / 外部 confirm
                    const h = this.hitFragHandle(mx, my);
                    if (h) {
                        this.paintFragDrag = {
                            handle: h, startMX: mx, startMY: my,
                            startX: this.paintFragment.x, startY: this.paintFragment.y,
                            startW: this.paintFragment.w, startH: this.paintFragment.h,
                        };
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
                        const ml = this.markdownLayers[this.selectedMdIdx];
                        const b  = this.mdBBox(ml);
                        this.pushHistory('縮放 Markdown 圖層');
                        this.mdDragState = {
                            handle: h, startMX: mx, startMY: my,
                            startX: ml.x, startY: ml.y,
                            startFontSize: ml.fontSize, startWidth: ml.width, startH: b.h,
                        };
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
                        this.pushHistory('縮放圖片圖層');  // 縮放圖片層前先存快照
                        this.dragState = { handle: h, startMX: mx, startMY: my,
                            startX: lay.x, startY: lay.y, startW: lay.w, startH: lay.h };
                        return;
                    }
                }
                // 點到哪個圖片圖層？（由上到下）
                let hit = -1;
                for (let i = this.imageLayers.length - 1; i >= 0; i--) {
                    if (this.pointInLayer(mx, my, this.imageLayers[i])) { hit = i; break; }
                }
                this.selectedIdx     = hit;
                this.selectedTextIdx = -1;
                this.selectedMdIdx   = -1;
                if (hit >= 0) {
                    const lay = this.imageLayers[hit];
                    this.pushHistory('移動圖片圖層');  // 移動圖片層前先存快照
                    this.dragState = { handle: 'move', startMX: mx, startMY: my,
                        startX: lay.x, startY: lay.y, startW: lay.w, startH: lay.h };
                }
                this.render();
            } else {
                // 畫筆 / 橡皮擦
                this.pushHistory(this.eraser ? '橡皮擦' : '筆觸');  // 每次筆觸開始前保存快照
                this.drawing = true;
                this.prevX = mx; this.prevY = my;
                this.paintDot(mx, my);
            }
        });

        this.canvas.addEventListener('mousemove', (e) => {
            // 中鍵平移
            if (this.isPanning) {
                this.canvasWrapper.scrollLeft = this.panScrollLeft - (e.clientX - this.panStartX);
                this.canvasWrapper.scrollTop  = this.panScrollTop  - (e.clientY - this.panStartY);
                return;
            }
            const { x: mx, y: my } = this.toCanvasCoords(e);

            if (this.tool === 'select') {
                // 更新游標
                this.updateCursor(mx, my);

                // Markdown 拖曳 / 縮放
                if (this.mdDragState && this.selectedMdIdx >= 0) {
                    const md  = this.mdDragState;
                    const ml  = this.markdownLayers[this.selectedMdIdx];
                    const dx  = mx - md.startMX;
                    const MIN_FONT  = 8;
                    const MIN_WIDTH = 40;
                    if (md.handle === 'move') {
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

                    if (td.handle === 'move') {
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

                    if (ds.handle === 'move') {
                        lay.x = ds.startX + dx;
                        lay.y = ds.startY + dy;
                    } else {
                        // 縮放：各角拖曳改變 x/y/w/h
                        const MIN = 20;
                        if (ds.handle === 'nw') {
                            let nw = Math.max(MIN, ds.startW - dx);
                            let nh = Math.max(MIN, ds.startH - dy);
                            if (e.shiftKey) {
                                // 以較大變化量為主，保持比例
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
                            if (e.shiftKey) {
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
                            if (e.shiftKey) {
                                const scale = Math.max((ds.startW - dx) / ds.startW, (ds.startH + dy) / ds.startH);
                                nw = Math.max(MIN, ds.startW * scale);
                                nh = Math.max(MIN, nw / ratio);
                            }
                            lay.x = ds.startX + (ds.startW - nw);
                            lay.w = nw; lay.h = nh;
                        } else { // se
                            let nw = Math.max(MIN, ds.startW + dx);
                            let nh = Math.max(MIN, ds.startH + dy);
                            if (e.shiftKey) {
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
                this.paintStroke(this.prevX, this.prevY, mx, my);
                this.prevX = mx; this.prevY = my;
            } else if (this.tool === 'paintselect') {
                if (this.paintFragDrag && this.paintFragment) {
                    const ds    = this.paintFragDrag;
                    const dx    = mx - ds.startMX;
                    const dy    = my - ds.startMY;
                    const frag  = this.paintFragment;
                    const ratio = ds.startW / ds.startH;
                    const MIN   = 10;
                    if (ds.handle === 'move') {
                        frag.x = ds.startX + dx;
                        frag.y = ds.startY + dy;
                    } else if (ds.handle === 'nw') {
                        let nw = Math.max(MIN, ds.startW - dx);
                        let nh = Math.max(MIN, ds.startH - dy);
                        if (e.shiftKey) { const sc = Math.max((ds.startW-dx)/ds.startW,(ds.startH-dy)/ds.startH); nw=Math.max(MIN,ds.startW*sc); nh=nw/ratio; }
                        frag.x = ds.startX + (ds.startW - nw); frag.y = ds.startY + (ds.startH - nh); frag.w = nw; frag.h = nh;
                    } else if (ds.handle === 'ne') {
                        let nw = Math.max(MIN, ds.startW + dx);
                        let nh = Math.max(MIN, ds.startH - dy);
                        if (e.shiftKey) { const sc = Math.max((ds.startW+dx)/ds.startW,(ds.startH-dy)/ds.startH); nw=Math.max(MIN,ds.startW*sc); nh=nw/ratio; }
                        frag.w = nw; frag.y = ds.startY + (ds.startH - nh); frag.h = nh;
                    } else if (ds.handle === 'sw') {
                        let nw = Math.max(MIN, ds.startW - dx);
                        let nh = Math.max(MIN, ds.startH + dy);
                        if (e.shiftKey) { const sc = Math.max((ds.startW-dx)/ds.startW,(ds.startH+dy)/ds.startH); nw=Math.max(MIN,ds.startW*sc); nh=nw/ratio; }
                        frag.x = ds.startX + (ds.startW - nw); frag.w = nw; frag.h = nh;
                    } else { // se
                        let nw = Math.max(MIN, ds.startW + dx);
                        let nh = Math.max(MIN, ds.startH + dy);
                        if (e.shiftKey) { const sc = Math.max((ds.startW+dx)/ds.startW,(ds.startH+dy)/ds.startH); nw=Math.max(MIN,ds.startW*sc); nh=nw/ratio; }
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

        this.canvas.addEventListener('mouseup', (e) => {
            if (e.button === 1) {
                this.isPanning = false;
                this.canvas.style.cursor = this.tool === 'draw' ? 'crosshair' : (this.tool === 'text' ? 'text' : (this.tool === 'paintselect' ? 'crosshair' : 'default'));
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
            this.drawing       = false;
            this.dragState     = null;
            this.textDragState = null;
            this.mdDragState   = null;
        });
        this.canvas.addEventListener('mouseleave', () => {
            this.isPanning     = false;
            this.drawing       = false;
            this.dragState     = null;
            this.textDragState = null;
            this.mdDragState   = null;
            this.paintFragDrag = null;
            if (this.selStart) { this.selStart = null; this.selCurrent = null; this.render(); }
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
            const wRect = this.canvasWrapper.getBoundingClientRect();
            const cx    = e.clientX - wRect.left;
            const cy    = e.clientY - wRect.top;
            const ratio = this.zoom / oldZoom;
            this.applyZoom();
            this.canvasWrapper.scrollLeft = (this.canvasWrapper.scrollLeft + cx) * ratio - cx;
            this.canvasWrapper.scrollTop  = (this.canvasWrapper.scrollTop  + cy) * ratio - cy;
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
        // 備份 paintCanvas
        const tmp = document.createElement('canvas');
        tmp.width  = this.paintCanvas.width  || w;
        tmp.height = this.paintCanvas.height || h;
        tmp.getContext('2d')!.drawImage(this.paintCanvas, 0, 0);

        this.paintCanvas.width  = w;
        this.paintCanvas.height = h;
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
    private toCanvasCoords(e: MouseEvent): { x: number; y: number } {
        return { x: e.offsetX / this.zoom, y: e.offsetY / this.zoom };
    }

    // ── 合成渲染 ──────────────────────────────────────────────────────────────

    private render(): void {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        // 1. 白底
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        // 2. 圖片層（底部）
        for (const lay of this.imageLayers) {
            this.ctx.drawImage(lay.img, lay.x, lay.y, lay.w, lay.h);
        }
        // 2b. Markdown 圖層（圖片層上方）
        for (const ml of this.markdownLayers) {
            ml._cachedH = this.drawMarkdownContent(this.ctx, ml);
        }
        // 3. 文字層（圖片上方，繪畫層下方）
        for (const tl of this.textLayers) {
            this.ctx.save();
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
        this.ctx.drawImage(this.paintCanvas, 0, 0);
        // 4a. 繪畫選取 fragment（繪畫層上方）
        if (this.paintFragment) {
            const f = this.paintFragment;
            this.ctx.drawImage(f.offscreen, 0, 0, f.offscreen.width, f.offscreen.height, f.x, f.y, f.w, f.h);
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
        this.scheduleAutosave();
    }

    private drawSelectionHandles(lay: ImageLayer): void {
        const { x, y, w, h } = lay;
        // 虛線框
        this.ctx.save();
        this.ctx.strokeStyle = '#0066ff';
        this.ctx.lineWidth   = 1.5;
        this.ctx.setLineDash([5, 3]);
        this.ctx.strokeRect(x, y, w, h);
        this.ctx.restore();
        // 四個角控點
        for (const [cx, cy] of this.cornerPositions(lay)) {
            this.ctx.fillStyle   = '#ffffff';
            this.ctx.strokeStyle = '#0066ff';
            this.ctx.lineWidth   = 1.5;
            this.ctx.fillRect(cx - HANDLE_SIZE / 2, cy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.strokeRect(cx - HANDLE_SIZE / 2, cy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        }
    }

    private cornerPositions(lay: ImageLayer): [number, number][] {
        return [
            [lay.x,         lay.y        ],
            [lay.x + lay.w, lay.y        ],
            [lay.x,         lay.y + lay.h],
            [lay.x + lay.w, lay.y + lay.h],
        ];
    }

    private hitHandle(mx: number, my: number, lay: ImageLayer): HandleType | null {
        const corners: [HandleType, number, number][] = [
            ['nw', lay.x,         lay.y        ],
            ['ne', lay.x + lay.w, lay.y        ],
            ['sw', lay.x,         lay.y + lay.h],
            ['se', lay.x + lay.w, lay.y + lay.h],
        ];
        const hs = HANDLE_SIZE;
        for (const [type, cx, cy] of corners) {
            if (mx >= cx - hs && mx <= cx + hs && my >= cy - hs && my <= cy + hs) return type;
        }
        return null;
    }

    private pointInLayer(mx: number, my: number, lay: ImageLayer): boolean {
        return mx >= lay.x && mx <= lay.x + lay.w && my >= lay.y && my <= lay.y + lay.h;
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
        return mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h;
    }

    private drawTextSelectionBox(tl: TextLayer): void {
        const b = this.textBBox(tl);
        const linked = !!tl.linkedNotePath;
        this.ctx.save();
        this.ctx.strokeStyle = linked ? '#22aa44' : '#0066ff';
        this.ctx.lineWidth   = 1.5;
        this.ctx.setLineDash([5, 3]);
        this.ctx.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
        this.ctx.restore();
        // 四個角控點
        const hs = HANDLE_SIZE / 2;
        for (const [cx, cy] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]] as [number, number][]) {
            this.ctx.save();
            this.ctx.setLineDash([]);
            this.ctx.fillStyle   = '#ffffff';
            this.ctx.strokeStyle = linked ? '#22aa44' : '#0066ff';
            this.ctx.lineWidth   = 1.5;
            this.ctx.fillRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.strokeRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.restore();
        }
    }

    private hitTextHandle(mx: number, my: number, tl: TextLayer): HandleType | null {
        const b  = this.textBBox(tl);
        const hs = HANDLE_SIZE;
        const corners: [HandleType, number, number][] = [
            ['nw', b.x,       b.y      ],
            ['ne', b.x + b.w, b.y      ],
            ['sw', b.x,       b.y + b.h],
            ['se', b.x + b.w, b.y + b.h],
        ];
        for (const [type, cx, cy] of corners) {
            if (mx >= cx - hs && mx <= cx + hs && my >= cy - hs && my <= cy + hs) return type;
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
        const offscreen      = document.createElement('canvas');
        offscreen.width      = r.w;
        offscreen.height     = r.h;
        offscreen.getContext('2d')!.drawImage(this.paintCanvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
        // 從 paintCanvas 挖除選取區
        this.paintCtx.save();
        this.paintCtx.globalCompositeOperation = 'destination-out';
        this.paintCtx.fillStyle = 'rgba(0,0,0,1)';
        this.paintCtx.fillRect(r.x, r.y, r.w, r.h);
        this.paintCtx.restore();
        this.paintFragment = { offscreen, x: r.x, y: r.y, w: r.w, h: r.h };
        this.render();
    }

    private commitFragment(): void {
        if (!this.paintFragment) return;
        this.pushHistory('合併繪畫區塊');                 // 合併繪畫區塊前先存快照
        const f = this.paintFragment;
        this.paintCtx.drawImage(f.offscreen, 0, 0, f.offscreen.width, f.offscreen.height, f.x, f.y, f.w, f.h);
        this.paintFragment = null;
        this.paintFragDrag = null;
        this.render();
    }

    private cancelFragment(): void {
        // 將 fragment 放回目前位置（不保留浮動狀態）
        this.commitFragment();
    }

    private hitFragHandle(mx: number, my: number): HandleType | null {
        if (!this.paintFragment) return null;
        const { x, y, w, h } = this.paintFragment;
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

    private pointInFrag(mx: number, my: number): boolean {
        if (!this.paintFragment) return false;
        const { x, y, w, h } = this.paintFragment;
        return mx >= x && mx <= x + w && my >= y && my <= y + h;
    }

    private drawFragmentHandles(frag: PaintFragment): void {
        const { x, y, w, h } = frag;
        this.ctx.save();
        this.ctx.strokeStyle = '#ff6600';
        this.ctx.lineWidth   = 1.5;
        this.ctx.setLineDash([5, 3]);
        this.ctx.strokeRect(x, y, w, h);
        this.ctx.restore();
        const hs = HANDLE_SIZE / 2;
        for (const [cx, cy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]] as [number, number][]) {
            this.ctx.save();
            this.ctx.setLineDash([]);
            this.ctx.fillStyle   = '#ffffff';
            this.ctx.strokeStyle = '#ff6600';
            this.ctx.lineWidth   = 1.5;
            this.ctx.fillRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.strokeRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.restore();
        }
    }

    private updateCursor(mx: number, my: number): void {
        if (this.dragState || this.textDragState || this.mdDragState) return;
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

    private activeColor(): string {
        return this.eraser ? '#000000' : this.colors[this.colorIdx];
    }

    private paintDot(x: number, y: number): void {
        this.paintCtx.save();
        if (this.eraser) {
            this.paintCtx.globalCompositeOperation = 'destination-out';
            this.paintCtx.fillStyle = 'rgba(0,0,0,1)';
        } else {
            this.paintCtx.globalCompositeOperation = 'source-over';
            this.paintCtx.globalAlpha = this.brushOpacity;
            this.paintCtx.fillStyle = this.colors[this.colorIdx];
        }
        this.paintCtx.beginPath();
        this.paintCtx.arc(x, y, this.brushSize / 2, 0, Math.PI * 2);
        this.paintCtx.fill();
        this.paintCtx.restore();
        this.render();
    }

    private paintStroke(x1: number, y1: number, x2: number, y2: number): void {
        const dist  = Math.hypot(x2 - x1, y2 - y1);
        const step  = Math.max(1, this.brushSize * 0.15);
        const steps = Math.floor(dist / step);
        this.paintCtx.save();
        if (this.eraser) {
            this.paintCtx.globalCompositeOperation = 'destination-out';
            this.paintCtx.fillStyle = 'rgba(0,0,0,1)';
        } else {
            this.paintCtx.globalCompositeOperation = 'source-over';
            this.paintCtx.globalAlpha = this.brushOpacity;
            this.paintCtx.fillStyle = this.colors[this.colorIdx];
        }
        for (let i = 0; i <= steps; i++) {
            const t = steps > 0 ? i / steps : 0;
            const x = x1 + (x2 - x1) * t;
            const y = y1 + (y2 - y1) * t;
            this.paintCtx.beginPath();
            this.paintCtx.arc(x, y, this.brushSize / 2, 0, Math.PI * 2);
            this.paintCtx.fill();
        }
        this.paintCtx.restore();
        this.render();
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

        ta.addEventListener('blur', () => {
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

    private setTool(t: 'draw' | 'select' | 'text' | 'paintselect'): void {
        // 離開 paintselect 時先 commit fragment
        if (this.tool === 'paintselect' && t !== 'paintselect') {
            this.commitFragment();
        }
        this.tool = t;
        this.paintSelectBtn.toggleClass('active', t === 'paintselect');
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
                if (this.tool === 'paintselect') {
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
                    if (this.selectedIdx >= 0) {
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
            imageLayers:    this.imageLayers.map(l => ({ img: l.img, x: l.x, y: l.y, w: l.w, h: l.h })),
            markdownLayers: this.markdownLayers.map(ml => ({
                text: ml.text, x: ml.x, y: ml.y, fontSize: ml.fontSize,
                color: ml.color, width: ml.width, linkedNotePath: ml.linkedNotePath,
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
        // 若畫布尺寸不同需先調整
        if (this.canvas.width !== entry.canvasW || this.canvas.height !== entry.canvasH) {
            this.canvas.width       = entry.canvasW;
            this.canvas.height      = entry.canvasH;
            this.paintCanvas.width  = entry.canvasW;
            this.paintCanvas.height = entry.canvasH;
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
                    copy.getContext('2d')!.drawImage(this.paintCanvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
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
                    copy.getContext('2d')!.drawImage(this.paintCanvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
                    this.clipboard = { type: 'paint', offscreen: copy, w: r.w, h: r.h };
                    // 從畫布挖空選取區
                    this.paintCtx.save();
                    this.paintCtx.globalCompositeOperation = 'destination-out';
                    this.paintCtx.fillStyle = 'rgba(0,0,0,1)';
                    this.paintCtx.fillRect(r.x, r.y, r.w, r.h);
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
                const f = this.paintFragment;
                this.paintCtx.drawImage(f.offscreen, 0, 0, f.offscreen.width, f.offscreen.height, f.x, f.y, f.w, f.h);
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
            const filepath = normalizePath(`${folder}/${EasyNoteView.AUTOSAVE_FILENAME}`);

            const paintLayer  = this.paintCanvas.toDataURL('image/png');
            const imageLayers: ENoteImageLayer[] = this.imageLayers.map((lay) => {
                const tmp  = document.createElement('canvas');
                tmp.width  = lay.img.naturalWidth  || lay.w;
                tmp.height = lay.img.naturalHeight || lay.h;
                tmp.getContext('2d')!.drawImage(lay.img, 0, 0);
                return { src: tmp.toDataURL('image/png'), x: lay.x, y: lay.y, w: lay.w, h: lay.h };
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
            this.lastAutoSaveTime = new Date();
            this.refreshStatus();
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
                return { src: tmp.toDataURL('image/png'), x: lay.x, y: lay.y, w: lay.w, h: lay.h };
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
            this.canvas.width      = project.canvasWidth;
            this.canvas.height     = project.canvasHeight;
            this.paintCanvas.width  = project.canvasWidth;
            this.paintCanvas.height = project.canvasHeight;

            // 載入繪畫層
            await new Promise<void>((resolve) => {
                const img = new Image();
                img.onload = () => { this.paintCtx.drawImage(img, 0, 0); resolve(); };
                img.onerror = () => resolve();
                img.src = project.paintLayer;
            });

            // 載入圖片層
            for (const lay of project.imageLayers) {
                await new Promise<void>((resolve) => {
                    const img = new Image();
                    img.onload = () => {
                        this.imageLayers.push({ img, x: lay.x, y: lay.y, w: lay.w, h: lay.h });
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

            this.setTool('draw');
            this.applyZoom();
            this.render();
            // 重置歷史記錄，載入狀態作為起點
            this.history    = [];
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
                        result.push({ text: text.slice(i + 1, ct), link: true });
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
        return mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h;
    }

    private hitMdHandle(mx: number, my: number, ml: MarkdownLayer): HandleType | null {
        const b  = this.mdBBox(ml);
        const hs = HANDLE_SIZE;
        const corners: [HandleType, number, number][] = [
            ['nw', b.x,       b.y      ],
            ['ne', b.x + b.w, b.y      ],
            ['sw', b.x,       b.y + b.h],
            ['se', b.x + b.w, b.y + b.h],
        ];
        for (const [type, cx, cy] of corners) {
            if (mx >= cx - hs && mx <= cx + hs && my >= cy - hs && my <= cy + hs) return type;
        }
        return null;
    }

    private drawMdSelectionBox(ml: MarkdownLayer): void {
        const b      = this.mdBBox(ml);
        const linked = !!ml.linkedNotePath;
        this.ctx.save();
        this.ctx.strokeStyle = linked ? '#22aa44' : '#9966cc';
        this.ctx.lineWidth   = 1.5;
        this.ctx.setLineDash([5, 3]);
        this.ctx.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
        this.ctx.restore();
        const hs = HANDLE_SIZE / 2;
        for (const [cx, cy] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]] as [number, number][]) {
            this.ctx.save();
            this.ctx.setLineDash([]);
            this.ctx.fillStyle   = '#ffffff';
            this.ctx.strokeStyle = linked ? '#22aa44' : '#9966cc';
            this.ctx.lineWidth   = 1.5;
            this.ctx.fillRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.strokeRect(cx - hs, cy - hs, HANDLE_SIZE, HANDLE_SIZE);
            this.ctx.restore();
        }
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
            // 繪畫層（上方）
            tc.drawImage(this.paintCanvas, 0, 0);
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
        contentEl.createEl('p', {
            cls:  'easynote-size-hint',
            text: `目前：${this.currentW} × ${this.currentH}　（現有內容會保留在左上角）`,
        });

        // 輸入列
        const inputRow = contentEl.createEl('div', { cls: 'easynote-size-row' });

        const wInput = inputRow.createEl('input');
        wInput.type  = 'number';
        wInput.min   = '100';
        wInput.max   = '16000';
        wInput.value = String(this.currentW);
        wInput.className = 'easynote-size-input';

        inputRow.createEl('span', { text: ' × ', cls: 'easynote-size-x' });

        const hInput = inputRow.createEl('input');
        hInput.type  = 'number';
        hInput.min   = '100';
        hInput.max   = '16000';
        hInput.value = String(this.currentH);
        hInput.className = 'easynote-size-input';

        // 快速預設按鈕
        const presetRow = contentEl.createEl('div', { cls: 'easynote-size-presets' });
        const presets: [string, () => void][] = [
            ['×2 寬',  () => { wInput.value = String(this.currentW * 2); }],
            ['×2 高',  () => { hInput.value = String(this.currentH * 2); }],
            ['×2 全',  () => { wInput.value = String(this.currentW * 2); hInput.value = String(this.currentH * 2); }],
            ['1920×1080', () => { wInput.value = '1920'; hInput.value = '1080'; }],
            ['3840×1080', () => { wInput.value = '3840'; hInput.value = '1080'; }],
            ['3840×2160', () => { wInput.value = '3840'; hInput.value = '2160'; }],
        ];
        for (const [label, fn] of presets) {
            const btn = presetRow.createEl('button', { cls: 'easynote-btn', text: label });
            btn.addEventListener('click', fn);
        }

        // 確認 / 取消
        const btnRow = contentEl.createEl('div', { cls: 'easynote-size-btnrow' });
        const applyBtn = btnRow.createEl('button', {
            cls:  'easynote-btn easynote-btn-save',
            text: '套用',
        });
        applyBtn.addEventListener('click', () => {
            const w = Math.max(100, Math.min(16000, parseInt(wInput.value) || this.currentW));
            const h = Math.max(100, Math.min(16000, parseInt(hInput.value) || this.currentH));
            this.onApply(w, h);
            this.close();
        });
        const cancelBtn = btnRow.createEl('button', { cls: 'easynote-btn', text: '取消' });
        cancelBtn.addEventListener('click', () => this.close());
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
        this.registerView(VIEW_TYPE, (leaf) => new EasyNoteView(leaf, this.settings));

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

        // 儲存資料夾
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
    }
}
