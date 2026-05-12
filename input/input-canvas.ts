import { type FeatureAPI } from './input-api';

/**
 * CanvasInputHandler — 畫布指標 / 雙擊事件的「裝置層」綁定。
 *
 * 只負責 addEventListener / removeEventListener，
 * 所有實際邏輯全部透過 FeatureAPI 委派給 EasyNoteView（功能層）。
 */
export class CanvasInputHandler {
    private readonly _onDown:      (e: PointerEvent) => void;
    private readonly _onMove:      (e: PointerEvent) => void;
    private readonly _onUp:        (e: PointerEvent) => void;
    private readonly _onCancel:    (e: PointerEvent) => void;
    private readonly _onLeave:     (e: PointerEvent) => void;
    private readonly _onDbl:       (e: MouseEvent)   => void;
    private readonly _onDragOver:  (e: DragEvent)    => void;
    private readonly _onDragLeave: (e: DragEvent)    => void;
    private readonly _onDrop:      (e: DragEvent)    => void;

    constructor(private readonly api: FeatureAPI) {
        this._onDown      = (e) => this.api.handlePointerDown(e);
        this._onMove      = (e) => this.api.handlePointerMove(e);
        this._onUp        = (e) => this.api.handlePointerUp(e);
        this._onCancel    = (e) => this.api.handlePointerCancel(e);
        this._onLeave     = (e) => this.api.handlePointerLeave(e);
        this._onDbl       = (e) => this.api.handleDblClick(e);
        this._onDragOver  = (e) => this.api.handleDragOver(e);
        this._onDragLeave = (e) => this.api.handleDragLeave(e);
        this._onDrop      = (e) => this.api.handleDrop(e);
    }

    /** 綁定畫布事件監聽（在 buildCanvas 結尾呼叫）*/
    bind(canvas: HTMLCanvasElement): void {
        canvas.addEventListener('pointerdown',   this._onDown);
        canvas.addEventListener('pointermove',   this._onMove);
        canvas.addEventListener('pointerup',     this._onUp);
        canvas.addEventListener('pointercancel', this._onCancel);
        canvas.addEventListener('pointerleave',  this._onLeave);
        canvas.addEventListener('dblclick',      this._onDbl);
        canvas.addEventListener('dragover',      this._onDragOver);
        canvas.addEventListener('dragleave',     this._onDragLeave);
        canvas.addEventListener('drop',          this._onDrop);
    }

    /** 移除畫布事件監聽（在 onClose 呼叫）*/
    unbind(canvas: HTMLCanvasElement): void {
        canvas.removeEventListener('pointerdown',   this._onDown);
        canvas.removeEventListener('pointermove',   this._onMove);
        canvas.removeEventListener('pointerup',     this._onUp);
        canvas.removeEventListener('pointercancel', this._onCancel);
        canvas.removeEventListener('pointerleave',  this._onLeave);
        canvas.removeEventListener('dblclick',      this._onDbl);
        canvas.removeEventListener('dragover',      this._onDragOver);
        canvas.removeEventListener('dragleave',     this._onDragLeave);
        canvas.removeEventListener('drop',          this._onDrop);
    }
}
