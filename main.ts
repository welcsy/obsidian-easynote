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
}
const DEFAULT_SETTINGS: EasyNoteSettings = {
    defaultColorIdx:  0,
    defaultBrushSize: 6,
    saveFolder:       'EasyNote',
    defaultColors:    [...COLORS],
};

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
    text:     string;
    x:        number;
    y:        number;
    fontSize: number;
    color:    string;
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

    // 圖片圖層
    private imageLayers: ImageLayer[]  = [];
    private selectedIdx = -1;
    private dragState:   DragState | null = null;

    // 文字圖層
    private textLayers:      TextLayer[]        = [];
    private selectedTextIdx  = -1;
    private textDragState:   TextDragState | null = null;
    private textFontSize     = 24;
    private _textEditing: {
        el: HTMLTextAreaElement; layerIdx: number; x: number; y: number;
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
    private eraserBtn!:       HTMLButtonElement;
    private selectBtn!:       HTMLButtonElement;
    private textBtn!:         HTMLButtonElement;
    private fontSizeInput!:   HTMLInputElement;
    private sizeSlider!:    HTMLInputElement;
    private opacitySlider!: HTMLInputElement;
    private colorBtns:    HTMLElement[] = [];
    private fileInput!:   HTMLInputElement;

    // 縮放 & 平移（滾輪縮放，中鍵拖曳平移）
    private zoom          = 1.0;
    private isPanning     = false;
    private panStartX     = 0;
    private panStartY     = 0;
    private panScrollLeft = 0;
    private panScrollTop  = 0;

    // 事件繫結
    private _onKeyDown!: (e: KeyboardEvent)  => void;
    private _onPaste!:   (e: ClipboardEvent) => void;
    private _onResize!:  ()                  => void;

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

        const root = this.containerEl.children[1] as HTMLElement;
        root.empty();
        root.addClass('easynote-root');

        this.buildToolbar(root);
        this.buildCanvas(root);

        this._onKeyDown = this.handleKeyDown.bind(this);
        this._onPaste   = this.handlePaste.bind(this);
        this._onResize  = this.resizeCanvas.bind(this);
        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('paste',   this._onPaste);
        window.addEventListener('resize',    this._onResize);

        this.refreshColorBtns();
        this.refreshStatus();
    }

    async onClose(): Promise<void> {
        if (this._textEditing) { this._textEditing.el.remove(); this._textEditing = null; }
        if (this.paintFragment) this.commitFragment();
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

        // 橡皮擦（快捷 E）
        this.eraserBtn = row1.createEl('button', {
            cls:   'easynote-btn easynote-btn-icon',
            title: '橡皮擦（快捷：E）',
        });
        setIcon(this.eraserBtn, 'eraser');
        this.eraserBtn.addEventListener('click', () => this.toggleEraser());

        // 選取工具（快捷 S）
        this.selectBtn = row1.createEl('button', {
            cls:   'easynote-btn easynote-btn-icon',
            title: '選取並移動/縮放圖片（快捷：S）\nDel 刪除選取圖片',
        });
        setIcon(this.selectBtn, 'mouse-pointer-2');
        this.selectBtn.addEventListener('click', () => this.setTool('select'));

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

        // 繪畫選取工具（快捷 M）
        this.paintSelectBtn = row1.createEl('button', {
            cls:   'easynote-btn easynote-btn-icon',
            title: '框選繪畫層區塊，可移動/縮放後再合併（快捷：M）\nEnter 確認　Esc 取消　Del 刪除選取區塊',
        });
        setIcon(this.paintSelectBtn, 'lasso');
        this.paintSelectBtn.addEventListener('click', () => this.setTool('paintselect'));

        // 清除畫布（快捷 C）
        const clearBtn = row1.createEl('button', {
            cls:   'easynote-btn',
            text:  '清除 (C)',
            title: '清除整個畫布（快捷：C）',
        });
        clearBtn.addEventListener('click', () => this.clearCanvas());

        // ── 第二行 ──────────────────────────────────────────────────────────
        // 筆刷滑桿
        row2.createEl('span', { cls: 'easynote-label', text: '筆刷:' });
        this.sizeSlider           = row2.createEl('input');
        this.sizeSlider.type      = 'range';
        this.sizeSlider.min       = String(MIN_BRUSH_SIZE);
        this.sizeSlider.max       = String(MAX_BRUSH_SIZE);
        this.sizeSlider.value     = String(this.brushSize);
        this.sizeSlider.title     = '筆刷大小';
        this.sizeSlider.className = 'easynote-slider';
        this.sizeSlider.addEventListener('input', () => {
            this.brushSize = parseInt(this.sizeSlider.value);
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
        this.opacitySlider.addEventListener('input', () => {
            this.brushOpacity = parseInt(this.opacitySlider.value) / 100;
            this.refreshStatus();
        });
        row2.createEl('div', { cls: 'easynote-sep' });

        // 載入圖片 — 本機檔案
        const loadBtn = row2.createEl('button', {
            cls:   'easynote-btn',
            text:  '載入圖片',
            title: '從本機載入圖片（也可拖曳或 Ctrl+V）',
        });
        loadBtn.addEventListener('click', () => this.fileInput.click());

        this.fileInput        = row2.createEl('input');
        this.fileInput.type   = 'file';
        this.fileInput.accept = 'image/*';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', () => {
            const file = this.fileInput.files?.[0];
            if (file) this.loadImageFromBlob(file);
            this.fileInput.value = '';
        });

        // 從 Vault 選取圖片
        const vaultBtn = row2.createEl('button', {
            cls:   'easynote-btn',
            text:  'Vault 圖片',
            title: '從 Vault 中選取圖片',
        });
        vaultBtn.addEventListener('click', () => {
            new VaultImagePickerModal(this.app, (file) => this.loadImageFromVault(file)).open();
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

        // 儲存檔案
        const saveBtn = row2.createEl('button', {
            cls:   'easynote-btn easynote-btn-save',
            text:  '儲存檔案',
            title: '將手繪圖儲存到 Vault',
        });
        saveBtn.addEventListener('click', () => {
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            new SaveModal(this.app, `EasyNote-${ts}`, (name, fmt) => this.saveDrawing(name, fmt)).open();
        });

        row2.createEl('div', { cls: 'easynote-spacer' });
        this.statusLabel = row2.createEl('span', { cls: 'easynote-status' });
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
                    this.dragState       = null;
                    const tl = this.textLayers[hitText];
                    const b  = this.textBBox(tl);
                    this.textDragState = {
                        handle: 'move', startMX: mx, startMY: my,
                        startX: tl.x, startY: tl.y,
                        startFontSize: tl.fontSize, startW: b.w, startH: b.h,
                    };
                    this.render();
                    return;
                }
                // 先檢查是否點到控點
                if (this.selectedIdx >= 0) {
                    const h = this.hitHandle(mx, my, this.imageLayers[this.selectedIdx]);
                    if (h) {
                        const lay = this.imageLayers[this.selectedIdx];
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
                if (hit >= 0) {
                    const lay = this.imageLayers[hit];
                    this.dragState = { handle: 'move', startMX: mx, startMY: my,
                        startX: lay.x, startY: lay.y, startW: lay.w, startH: lay.h };
                }
                this.render();
            } else {
                // 畫筆 / 橡皮擦
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
        });
        this.canvas.addEventListener('mouseleave', () => {
            this.isPanning     = false;
            this.drawing       = false;
            this.dragState     = null;
            this.textDragState = null;
            this.paintFragDrag = null;
            if (this.selStart) { this.selStart = null; this.selCurrent = null; this.render(); }
        });

        // 雙擊選取模式下編輯文字
        this.canvas.addEventListener('dblclick', (e) => {
            if (this.tool !== 'select') return;
            const { x: mx, y: my } = this.toCanvasCoords(e);
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

    private resizeCanvas(): void {
        if (this.manualWidth > 0 && this.manualHeight > 0) return;
        const w = Math.max(1, this.canvasWrapper.clientWidth);
        const h = Math.max(1, this.canvasWrapper.clientHeight);
        this.applyCanvasSize(w, h);
    }

    setCanvasSize(w: number, h: number): void {
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
        // 3. 文字層（圖片上方，繪畫層下方）
        for (const tl of this.textLayers) {
            this.ctx.save();
            this.ctx.font         = `${tl.fontSize}px sans-serif`;
            this.ctx.fillStyle    = tl.color;
            this.ctx.textBaseline = 'top';
            const lines = tl.text.split('\n');
            const lineH = tl.fontSize * 1.3;
            for (let li = 0; li < lines.length; li++) {
                this.ctx.fillText(lines[li], tl.x, tl.y + li * lineH);
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
        this.ctx.save();
        this.ctx.strokeStyle = '#0066ff';
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
            this.ctx.strokeStyle = '#0066ff';
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
        if (this.dragState || this.textDragState) return;
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
        // 文字層
        for (let i = this.textLayers.length - 1; i >= 0; i--) {
            if (this.pointInText(mx, my, this.textLayers[i])) {
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

    // ── 繪圖核心 ──────────────────────────────────────────────────────────────

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
        this.paintCtx.clearRect(0, 0, this.paintCanvas.width, this.paintCanvas.height);
        this.imageLayers     = [];
        this.textLayers      = [];
        this.selectedIdx     = -1;
        this.selectedTextIdx = -1;
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
        const color    = layerIdx >= 0 ? this.textLayers[layerIdx].color    : this.colors[this.colorIdx];

        const ta             = document.createElement('textarea');
        ta.className         = 'easynote-text-editor';
        ta.style.left        = `${screenX}px`;
        ta.style.top         = `${screenY}px`;
        ta.style.fontSize    = `${fontSize * this.zoom}px`;
        ta.style.color       = color;
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

        if (text.trim()) {
            const fontSize = state.layerIdx >= 0 ? this.textLayers[state.layerIdx].fontSize : this.textFontSize;
            const color    = state.layerIdx >= 0 ? this.textLayers[state.layerIdx].color    : this.colors[this.colorIdx];
            if (state.layerIdx >= 0) {
                this.textLayers[state.layerIdx].text = text;
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
        const zoomStr = `縮放: ${Math.round(this.zoom * 100)}%`;
        if (this.tool === 'select') {
            const ni = this.imageLayers.length;
            const nt = this.textLayers.length;
            this.statusLabel.textContent = `選取模式 | 圖片: ${ni} 張 | 文字: ${nt} 個 | ${zoomStr}`;
        } else if (this.tool === 'text') {
            this.statusLabel.textContent = `工具: 文字 | 字體: ${this.textFontSize}px | ${zoomStr}`;
        } else if (this.tool === 'paintselect') {
            const fragStr = this.paintFragment ? ' | 已選取區塊' : '';
            this.statusLabel.textContent = `工具: 繪畫選取${fragStr} | Enter 確認　Esc 取消　Del 棄用 | ${zoomStr}`;
        } else {
            const toolName = this.eraser ? '橡皮擦' : `${this.colorNames[this.colorIdx]} 鉛筆`;
            const opPct    = Math.round(this.brushOpacity * 100);
            this.statusLabel.textContent = `工具: ${toolName} | 大小: ${this.brushSize} | 透明度: ${opPct}% | ${zoomStr}`;
        }
    }

    // ── 鍵盤快捷鍵 ───────────────────────────────────────────────────────────
    private handleKeyDown(e: KeyboardEvent): void {
        if (this.app.workspace.getActiveViewOfType(EasyNoteView) !== this) return;
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

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
                        this.imageLayers.splice(this.selectedIdx, 1);
                        this.selectedIdx = -1;
                        this.render();
                        this.refreshStatus();
                    } else if (this.selectedTextIdx >= 0) {
                        this.textLayers.splice(this.selectedTextIdx, 1);
                        this.selectedTextIdx = -1;
                        this.render();
                        this.refreshStatus();
                    }
                } else if (this.tool === 'paintselect' && this.paintFragment) {
                    // 棄用 fragment（不還原到畫布）
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
                this.brushSize        = Math.min(MAX_BRUSH_SIZE, this.brushSize + 2);
                this.sizeSlider.value = String(this.brushSize);
                this.refreshStatus();
                break;
            case '-':
                this.brushSize        = Math.max(MIN_BRUSH_SIZE, this.brushSize - 2);
                this.sizeSlider.value = String(this.brushSize);
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
                tc.fillStyle    = tl.color;
                tc.textBaseline = 'top';
                const lines = tl.text.split('\n');
                const lineH = tl.fontSize * 1.3;
                for (let li = 0; li < lines.length; li++) {
                    tc.fillText(lines[li], tl.x, tl.y + li * lineH);
                }
                tc.restore();
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

        // 預設筆刷大小
        new Setting(containerEl)
            .setName('預設筆刷大小')
            .setDesc(`開啟 EasyNote 時的預設筆刷大小（${MIN_BRUSH_SIZE}–${MAX_BRUSH_SIZE}）`)
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
