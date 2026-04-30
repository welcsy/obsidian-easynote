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
}
const DEFAULT_SETTINGS: EasyNoteSettings = {
    defaultColorIdx:  0,
    defaultBrushSize: 6,
    saveFolder:       'EasyNote',
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

    // 工具模式
    private tool:       'draw' | 'select' = 'draw';
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
    private statusLabel!: HTMLSpanElement;
    private eraserBtn!:   HTMLButtonElement;
    private selectBtn!:   HTMLButtonElement;
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
        this.brushSize   = this.settings.defaultBrushSize;
        this.colorIdx    = this.settings.defaultColorIdx;
        this.eraser      = false;
        this.tool        = 'draw';
        this.imageLayers = [];
        this.selectedIdx = -1;
        this.dragState   = null;

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
        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener('paste',   this._onPaste);
        window.removeEventListener('resize',    this._onResize);
    }

    // ── 工具列建構 ────────────────────────────────────────────────────────────
    private buildToolbar(root: HTMLElement): void {
        const bar = root.createEl('div', { cls: 'easynote-toolbar' });

        bar.createEl('span', { cls: 'easynote-title', text: '✏ EasyNote' });
        bar.createEl('div',  { cls: 'easynote-sep'  });

        // 色彩按鈕（單擊選色 / 雙擊開啟顏色選擇器 快捷 1~5）
        bar.createEl('span', { cls: 'easynote-label', text: '顏色:' });
        this.colorBtns = [];
        for (let i = 0; i < this.colors.length; i++) {
            const wrapper = bar.createEl('div', { cls: 'easynote-color-wrapper' });

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
        bar.createEl('div', { cls: 'easynote-sep' });

        // 橡皮擦（快捷 E）
        this.eraserBtn = bar.createEl('button', {
            cls:   'easynote-btn',
            text:  '橡皮擦 (E)',
            title: '切換橡皮擦（快捷：E）',
        });
        this.eraserBtn.addEventListener('click', () => this.toggleEraser());

        // 選取工具（快捷 S）
        this.selectBtn = bar.createEl('button', {
            cls:   'easynote-btn',
            text:  '選取 (S)',
            title: '選取並移動/縮放圖片（快捷：S）\nDel 刪除選取圖片',
        });
        this.selectBtn.addEventListener('click', () => this.setTool('select'));

        // 清除畫布（快捷 C）
        const clearBtn = bar.createEl('button', {
            cls:   'easynote-btn',
            text:  '清除 (C)',
            title: '清除整個畫布（快捷：C）',
        });
        clearBtn.addEventListener('click', () => this.clearCanvas());
        bar.createEl('div', { cls: 'easynote-sep' });

        // 筆刷滑桿
        bar.createEl('span', { cls: 'easynote-label', text: '筆刷:' });
        this.sizeSlider           = bar.createEl('input');
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
        bar.createEl('span', { cls: 'easynote-label', text: '透明度:' });
        this.opacitySlider           = bar.createEl('input');
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
        bar.createEl('div', { cls: 'easynote-sep' });

        // 載入圖片 — 本機檔案
        const loadBtn = bar.createEl('button', {
            cls:   'easynote-btn',
            text:  '載入圖片',
            title: '從本機載入圖片（也可拖曳或 Ctrl+V）',
        });
        loadBtn.addEventListener('click', () => this.fileInput.click());

        this.fileInput        = bar.createEl('input');
        this.fileInput.type   = 'file';
        this.fileInput.accept = 'image/*';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', () => {
            const file = this.fileInput.files?.[0];
            if (file) this.loadImageFromBlob(file);
            this.fileInput.value = '';
        });

        // 從 Vault 選取圖片
        const vaultBtn = bar.createEl('button', {
            cls:   'easynote-btn',
            text:  'Vault 圖片',
            title: '從 Vault 中選取圖片',
        });
        vaultBtn.addEventListener('click', () => {
            new VaultImagePickerModal(this.app, (file) => this.loadImageFromVault(file)).open();
        });
        bar.createEl('div', { cls: 'easynote-sep' });

        // 畫布大小
        const canvasSizeBtn = bar.createEl('button', {
            cls:   'easynote-btn',
            text:  '畫布大小',
            title: '調整畫布尺寸（現有內容保留）',
        });
        canvasSizeBtn.addEventListener('click', () => {
            new CanvasSizeModal(this.app, this.canvas.width, this.canvas.height,
                (w, h) => this.setCanvasSize(w, h)).open();
        });
        bar.createEl('div', { cls: 'easynote-sep' });

        // 儲存 PNG
        const saveBtn = bar.createEl('button', {
            cls:   'easynote-btn easynote-btn-save',
            text:  '儲存 PNG',
            title: '將手繪圖儲存為 PNG 到 Vault',
        });
        saveBtn.addEventListener('click', () => this.saveDrawing());

        bar.createEl('div', { cls: 'easynote-spacer' });
        this.statusLabel = bar.createEl('span', { cls: 'easynote-status' });
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

            if (this.tool === 'select') {
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
                // 點到哪個圖層？（由上到下）
                let hit = -1;
                for (let i = this.imageLayers.length - 1; i >= 0; i--) {
                    if (this.pointInLayer(mx, my, this.imageLayers[i])) { hit = i; break; }
                }
                this.selectedIdx = hit;
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
            }
        });

        this.canvas.addEventListener('mouseup', (e) => {
            if (e.button === 1) {
                this.isPanning = false;
                this.canvas.style.cursor = this.tool === 'draw' ? 'crosshair' : 'default';
                return;
            }
            this.drawing   = false;
            this.dragState = null;
        });
        this.canvas.addEventListener('mouseleave', () => {
            this.isPanning = false;
            this.drawing   = false;
            this.dragState = null;
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
        // 3. 繪畫層（在圖片上方，可畫到圖片上）
        this.ctx.drawImage(this.paintCanvas, 0, 0);
        // 4. 選取框 & 控點
        if (this.tool === 'select' && this.selectedIdx >= 0) {
            this.drawSelectionHandles(this.imageLayers[this.selectedIdx]);
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

    private updateCursor(mx: number, my: number): void {
        if (this.dragState) return;
        if (this.selectedIdx >= 0) {
            const h = this.hitHandle(mx, my, this.imageLayers[this.selectedIdx]);
            if (h === 'nw' || h === 'se') { this.canvas.style.cursor = 'nwse-resize'; return; }
            if (h === 'ne' || h === 'sw') { this.canvas.style.cursor = 'nesw-resize'; return; }
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
        this.imageLayers = [];
        this.selectedIdx = -1;
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

    private setTool(t: 'draw' | 'select'): void {
        this.tool = t;
        if (t === 'draw') {
            this.canvas.style.cursor = 'crosshair';
            this.selectBtn.removeClass('active');
            this.eraserBtn.toggleClass('active', this.eraser);
        } else {
            this.canvas.style.cursor = 'default';
            this.selectBtn.addClass('active');
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
            const n = this.imageLayers.length;
            this.statusLabel.textContent = `選取模式 | 圖片: ${n} 張 | ${zoomStr}`;
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
            case 'c': case 'C':
                if (this.tool !== 'select') this.clearCanvas();
                break;
            case 'e': case 'E':
                this.toggleEraser();
                break;
            case 'Delete': case 'Backspace':
                if (this.tool === 'select' && this.selectedIdx >= 0) {
                    this.imageLayers.splice(this.selectedIdx, 1);
                    this.selectedIdx = -1;
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
    async saveDrawing(): Promise<void> {
        try {
            const folder = normalizePath(this.settings.saveFolder);
            if (!(await this.app.vault.adapter.exists(folder))) {
                await this.app.vault.createFolder(folder);
            }
            const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const filename = normalizePath(`${folder}/EasyNote-${ts}.png`);

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
            // 繪畫層（上方）
            tc.drawImage(this.paintCanvas, 0, 0);

            const dataUrl = tmp.toDataURL('image/png');
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
