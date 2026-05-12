import { type FeatureAPI } from './input-api';

/**
 * DesktopInputHandler — 桌面裝置的鍵盤 / 滾輪 / 貼上事件處理。
 *
 * 只處理「觸發方式」（keyboard, wheel, paste），
 * 實際功能邏輯全部透過 FeatureAPI 委派給 EasyNoteView。
 */
export class DesktopInputHandler {
    private readonly _onKey:   (e: KeyboardEvent)  => void;
    private readonly _onWheel: (e: WheelEvent)     => void;
    private readonly _onPaste: (e: ClipboardEvent) => void;

    constructor(private readonly api: FeatureAPI) {
        this._onKey   = this.handleKeyDown.bind(this);
        this._onWheel = this.handleWheel.bind(this);
        this._onPaste = this.handlePaste.bind(this);
    }

    /** 綁定事件監聽（在 onOpen 呼叫）*/
    bind(doc: Document, canvas: HTMLCanvasElement): void {
        doc.addEventListener('keydown', this._onKey);
        doc.addEventListener('paste',   this._onPaste);
        canvas.addEventListener('wheel', this._onWheel, { passive: false });
    }

    /** 移除事件監聽（在 onClose 呼叫）*/
    unbind(doc: Document, canvas: HTMLCanvasElement): void {
        doc.removeEventListener('keydown', this._onKey);
        doc.removeEventListener('paste',   this._onPaste);
        canvas.removeEventListener('wheel', this._onWheel);
    }

    // ── 鍵盤 ──────────────────────────────────────────────────────────────────
    private handleKeyDown(e: KeyboardEvent): void {
        if (!this.api.isActiveView()) return;
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        // ── Ctrl / Meta 組合鍵 ────────────────────────────────────────────────
        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'z':
                    e.preventDefault();
                    this.api.undo();
                    return;
                case 'y':
                    e.preventDefault();
                    this.api.redo();
                    return;
                case 'c':
                    e.preventDefault();
                    this.api.copySelection();
                    return;
                case 'x':
                    e.preventDefault();
                    this.api.cutSelection();
                    return;
                case 'v':
                    // 內部剪貼簿貼上（系統剪貼簿圖片由 handlePaste 處理）
                    if (this.api.hasInternalClipboard()) {
                        e.preventDefault();
                        this.api.pasteClipboard();
                    }
                    return;
            }
        }

        switch (e.key) {
            case 's': case 'S':
                this.api.setTool(this.api.getTool() === 'select' ? 'draw' : 'select');
                break;
            case 't': case 'T':
                this.api.setTool(this.api.getTool() === 'text' ? 'draw' : 'text');
                break;
            case 'm': case 'M':
                if (this.api.isPaintSelectAvailable()) {
                    this.api.setTool(this.api.getTool() === 'paintselect' ? 'draw' : 'paintselect');
                }
                break;
            case 'Enter':
                if (this.api.getTool() === 'paintselect') {
                    this.api.commitFragment();
                    this.api.refreshStatus();
                }
                break;
            case 'Escape':
                if (this.api.getTool() === 'select') {
                    if (this.api.hasImgSelBox())   this.api.clearImgSelBox();
                    else if (this.api.hasMultiSel()) this.api.clearMultiSel();
                } else if (this.api.getTool() === 'paintselect') {
                    if (this.api.hasPaintSelBox()) this.api.clearPaintSelBox();
                    else { this.api.cancelFragment(); this.api.refreshStatus(); }
                }
                break;
            case 'c': case 'C':
                if (this.api.getTool() !== 'select') this.api.clearCanvas();
                break;
            case 'e': case 'E':
                this.api.toggleEraser();
                break;
            case 'Delete': case 'Backspace':
                this.api.deleteSelection();
                break;
            case '1': this.api.setColor(0); break;
            case '2': this.api.setColor(1); break;
            case '3': this.api.setColor(2); break;
            case '4': this.api.setColor(3); break;
            case '5': this.api.setColor(4); break;
            case '+': case '=':
                this.api.incrementBrushSize();
                this.api.refreshStatus();
                break;
            case '-':
                this.api.decrementBrushSize();
                this.api.refreshStatus();
                break;
            case '0':   // 重設縮放至 100%
                this.api.resetZoom();
                this.api.refreshStatus();
                break;
        }
    }

    // ── 滾輪縮放 ──────────────────────────────────────────────────────────────
    private handleWheel(e: WheelEvent): void {
        e.preventDefault();
        this.api.zoomAtCursor(e.clientX, e.clientY, e.deltaY);
    }

    // ── 系統剪貼簿貼上圖片 ────────────────────────────────────────────────────
    private handlePaste(e: ClipboardEvent): void {
        if (!this.api.isActiveView()) return;
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        const items = e.clipboardData?.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
                const blob = items[i].getAsFile();
                if (blob) { e.preventDefault(); this.api.pasteImageFromFile(blob); }
                return;
            }
        }
    }
}
