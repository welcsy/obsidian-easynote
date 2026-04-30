import {
    App,
    ItemView,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    WorkspaceLeaf,
    normalizePath,
} from 'obsidian';

// ─── 常數（對應 EasyNote GDScript 的 COLORS / COLOR_NAMES）──────────────────
const VIEW_TYPE        = 'godot-easynote';
const TOOLBAR_HEIGHT   = 52;          // px，與 GDScript TOOLBAR_HEIGHT 相同
const MIN_BRUSH_SIZE   = 1;
const MAX_BRUSH_SIZE   = 60;

const COLORS: string[] = [
    '#0d0d0d',  // 黑色
    '#e62626',  // 紅色
    '#1a66e5',  // 藍色
    '#1abf33',  // 綠色
    '#f29900',  // 橘色
];
const COLOR_NAMES: string[] = ['黑色', '紅色', '藍色', '綠色', '橘色'];

// ─── 設定介面 ─────────────────────────────────────────────────────────────────
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

// ─── 繪圖面板（ItemView）──────────────────────────────────────────────────────
class EasyNoteView extends ItemView {
    private settings: EasyNoteSettings;

    // canvas
    private canvas!:  HTMLCanvasElement;
    private ctx!:     CanvasRenderingContext2D;

    // 繪圖狀態（對應 GDScript 狀態變數）
    private drawing   = false;
    private prevX     = 0;
    private prevY     = 0;
    private brushSize = 6;
    private colorIdx  = 0;
    private eraser    = false;

    // 工具列 DOM 參考
    private statusLabel!: HTMLSpanElement;
    private eraserBtn!:   HTMLButtonElement;
    private sizeSlider!:  HTMLInputElement;
    private colorBtns:    HTMLElement[] = [];

    // 事件繫結（onClose 時解除）
    private _onKeyDown!: (e: KeyboardEvent) => void;
    private _onResize!:  ()               => void;

    constructor(leaf: WorkspaceLeaf, settings: EasyNoteSettings) {
        super(leaf);
        this.settings = settings;
    }

    getViewType():    string { return VIEW_TYPE;  }
    getDisplayText(): string { return 'EasyNote'; }
    getIcon():        string { return 'pencil';   }

    // ── 開啟 ─────────────────────────────────────────────────────────────────
    async onOpen(): Promise<void> {
        this.brushSize = this.settings.defaultBrushSize;
        this.colorIdx  = this.settings.defaultColorIdx;
        this.eraser    = false;

        const root = this.containerEl.children[1] as HTMLElement;
        root.empty();
        root.addClass('easynote-root');

        this.buildToolbar(root);
        this.buildCanvas(root);

        this._onKeyDown = this.handleKeyDown.bind(this);
        this._onResize  = this.resizeCanvas.bind(this);
        document.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('resize',   this._onResize);

        this.refreshColorBtns();
        this.refreshStatus();
    }

    async onClose(): Promise<void> {
        document.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('resize',   this._onResize);
    }

    // ── 工具列建構 ────────────────────────────────────────────────────────────
    private buildToolbar(root: HTMLElement): void {
        const bar = root.createEl('div', { cls: 'easynote-toolbar' });

        bar.createEl('span', { cls: 'easynote-title', text: '✏ EasyNote' });
        bar.createEl('div',  { cls: 'easynote-sep'  });

        // 色彩按鈕（快捷 1~5）
        bar.createEl('span', { cls: 'easynote-label', text: '顏色:' });
        this.colorBtns = [];
        for (let i = 0; i < COLORS.length; i++) {
            const btn = bar.createEl('div', {
                cls:   'easynote-color-btn',
                title: `${COLOR_NAMES[i]}（快捷：${i + 1}）`,
            });
            (btn as HTMLElement).style.background = COLORS[i];
            btn.addEventListener('click', () => this.setColor(i));
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

        // 清除畫布（快捷 C）
        const clearBtn = bar.createEl('button', {
            cls:   'easynote-btn',
            text:  '清除 (C)',
            title: '清除整個畫布（快捷：C）',
        });
        clearBtn.addEventListener('click', () => this.clearCanvas());
        bar.createEl('div', { cls: 'easynote-sep' });

        // 筆刷滑桿（對應 GDScript HSlider，滾輪也可調整）
        bar.createEl('span', { cls: 'easynote-label', text: '筆刷:' });
        this.sizeSlider           = bar.createEl('input');
        this.sizeSlider.type      = 'range';
        this.sizeSlider.min       = String(MIN_BRUSH_SIZE);
        this.sizeSlider.max       = String(MAX_BRUSH_SIZE);
        this.sizeSlider.value     = String(this.brushSize);
        this.sizeSlider.title     = '筆刷大小（滾輪快速調整）';
        this.sizeSlider.className = 'easynote-slider';
        this.sizeSlider.addEventListener('input', () => {
            this.brushSize = parseInt(this.sizeSlider.value);
            this.refreshStatus();
        });
        bar.createEl('div', { cls: 'easynote-sep' });

        // 儲存 PNG 至 Vault
        const saveBtn = bar.createEl('button', {
            cls:   'easynote-btn easynote-btn-save',
            text:  '儲存 PNG',
            title: '將手繪圖儲存為 PNG 到 Vault',
        });
        saveBtn.addEventListener('click', () => this.saveDrawing());

        // 狀態文字（靠右）
        bar.createEl('div', { cls: 'easynote-spacer' });
        this.statusLabel = bar.createEl('span', { cls: 'easynote-status' });
    }

    // ── Canvas 建構 ───────────────────────────────────────────────────────────
    private buildCanvas(root: HTMLElement): void {
        this.canvas = root.createEl('canvas', { cls: 'easynote-canvas' });
        const ctx   = this.canvas.getContext('2d');
        if (!ctx) { new Notice('EasyNote：無法取得 Canvas 2D context'); return; }
        this.ctx = ctx;

        this.resizeCanvas();

        // 滑鼠按下 → 開始繪製（對應 GDScript MOUSE_BUTTON_LEFT pressed = true）
        this.canvas.addEventListener('mousedown', (e) => {
            this.drawing = true;
            this.prevX   = e.offsetX;
            this.prevY   = e.offsetY;
            this.paintDot(e.offsetX, e.offsetY);
        });

        // 滑鼠移動 → 插值筆觸（對應 GDScript InputEventMouseMotion）
        this.canvas.addEventListener('mousemove', (e) => {
            if (!this.drawing) return;
            this.paintStroke(this.prevX, this.prevY, e.offsetX, e.offsetY);
            this.prevX = e.offsetX;
            this.prevY = e.offsetY;
        });

        // 滑鼠放開 / 移出
        this.canvas.addEventListener('mouseup',    () => { this.drawing = false; });
        this.canvas.addEventListener('mouseleave', () => { this.drawing = false; });

        // 滾輪調整筆刷大小（對應 GDScript MOUSE_BUTTON_WHEEL_UP / DOWN）
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta    = e.deltaY < 0 ? 1 : -1;
            this.brushSize = Math.max(MIN_BRUSH_SIZE, Math.min(MAX_BRUSH_SIZE, this.brushSize + delta));
            this.sizeSlider.value = String(this.brushSize);
            this.refreshStatus();
        }, { passive: false });
    }

    // ── Canvas 大小調整（保留已繪內容）──────────────────────────────────────
    private resizeCanvas(): void {
        const container = this.canvas.parentElement;
        if (!container) return;
        const w = container.clientWidth;
        const h = Math.max(1, container.clientHeight - TOOLBAR_HEIGHT);

        // 把舊內容備份到暫時 canvas
        const tmp = document.createElement('canvas');
        tmp.width  = this.canvas.width  || w;
        tmp.height = this.canvas.height || h;
        tmp.getContext('2d')!.drawImage(this.canvas, 0, 0);

        this.canvas.width  = w;
        this.canvas.height = h;
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, w, h);
        this.ctx.drawImage(tmp, 0, 0);
    }

    // ── 繪圖核心（移植自 GDScript _paint_dot_raw / _paint_stroke）────────────

    /** 目前的繪圖顏色（擦子時為白色） */
    private activeColor(): string {
        return this.eraser ? '#ffffff' : COLORS[this.colorIdx];
    }

    /** 畫單點（對應 GDScript _paint_dot） */
    private paintDot(x: number, y: number): void {
        this.ctx.beginPath();
        this.ctx.arc(x, y, this.brushSize / 2, 0, Math.PI * 2);
        this.ctx.fillStyle = this.activeColor();
        this.ctx.fill();
    }

    /**
     * 在兩點間插值連續筆觸（對應 GDScript _paint_stroke）
     * 步長 = 筆刷半徑的 0.15 倍，確保筆觸連續
     */
    private paintStroke(x1: number, y1: number, x2: number, y2: number): void {
        const dist  = Math.hypot(x2 - x1, y2 - y1);
        const step  = Math.max(1, this.brushSize * 0.15);
        const steps = Math.floor(dist / step);
        for (let i = 0; i <= steps; i++) {
            const t = steps > 0 ? i / steps : 0;
            this.paintDot(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
        }
    }

    /** 清除畫布（對應 GDScript _clear_canvas） */
    private clearCanvas(): void {
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    // ── 工具切換（對應 GDScript _set_color / _on_eraser_toggled）────────────

    private setColor(idx: number): void {
        this.colorIdx = idx;
        this.eraser   = false;
        this.eraserBtn.removeClass('active');
        this.refreshColorBtns();
        this.refreshStatus();
    }

    private toggleEraser(): void {
        this.eraser = !this.eraser;
        this.eraserBtn.toggleClass('active', this.eraser);
        this.refreshColorBtns();
        this.refreshStatus();
    }

    // ── UI 刷新（對應 GDScript _refresh_status） ─────────────────────────────

    private refreshColorBtns(): void {
        this.colorBtns.forEach((btn, i) => {
            btn.toggleClass('active', i === this.colorIdx && !this.eraser);
        });
    }

    private refreshStatus(): void {
        const tool = this.eraser
            ? '橡皮擦'
            : `${COLOR_NAMES[this.colorIdx]} 鉛筆`;
        this.statusLabel.textContent = `工具: ${tool} | 大小: ${this.brushSize}`;
    }

    // ── 鍵盤快捷鍵（完整對應 GDScript match event.keycode）─────────────────
    private handleKeyDown(e: KeyboardEvent): void {
        // 只在此 View 為當前 active 時響應
        if (this.app.workspace.getActiveViewOfType(EasyNoteView) !== this) return;
        // 不攔截輸入框的按鍵
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        switch (e.key) {
            case 'c': case 'C':
                this.clearCanvas();
                break;
            case 'e': case 'E':
                this.toggleEraser();
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
        }
    }

    // ── 儲存至 Vault（Obsidian 特有功能）────────────────────────────────────
    async saveDrawing(): Promise<void> {
        try {
            const folder = normalizePath(this.settings.saveFolder);

            // 確保儲存資料夾存在
            if (!(await this.app.vault.adapter.exists(folder))) {
                await this.app.vault.createFolder(folder);
            }

            // 時間戳記檔名（避免覆蓋）
            const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const filename = normalizePath(`${folder}/EasyNote-${ts}.png`);

            // canvas → PNG → ArrayBuffer
            const dataUrl = this.canvas.toDataURL('image/png');
            const base64  = dataUrl.split(',')[1];
            const binary  = atob(base64);
            const bytes   = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }

            await this.app.vault.createBinary(filename, bytes.buffer);
            new Notice(`✓ 已儲存: ${filename}`);
        } catch (err) {
            new Notice(`✗ 儲存失敗: ${err}`);
            console.error('[EasyNote] saveDrawing error:', err);
        }
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
