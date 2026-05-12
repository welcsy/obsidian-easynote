import { type FeatureAPI } from './input-api';

/** 觸控長按偵測等待時間（ms）*/
export const LONG_PRESS_MS   = 500;
/** 允許手指移動的最大距離（px），超過此值即取消長按 */
export const LONG_PRESS_SLOP = 10;

/**
 * MobileLongPressHandler — 觸控 / 手寫筆長按偵測的「裝置層」。
 *
 * 在畫布上獨立監聽 pointerdown / pointermove / pointerup / pointercancel，
 * 偵測到長按後透過 FeatureAPI.triggerLongPress() 通知功能層。
 * 不含任何功能邏輯，只負責計時器的生命週期管理。
 */
export class MobileLongPressHandler {
    private _timer:  ReturnType<typeof setTimeout> | null = null;
    private _startX = 0;
    private _startY = 0;

    private readonly _onDown:   (e: PointerEvent) => void;
    private readonly _onMove:   (e: PointerEvent) => void;
    private readonly _onUp:     (e: PointerEvent) => void;
    private readonly _onCancel: (e: PointerEvent) => void;

    constructor(private readonly api: FeatureAPI) {
        this._onDown   = this._handleDown.bind(this);
        this._onMove   = this._handleMove.bind(this);
        this._onUp     = this._clearTimer.bind(this);
        this._onCancel = this._clearTimer.bind(this);
    }

    /** 綁定畫布事件監聽（在 buildCanvas 結尾呼叫）*/
    bind(canvas: HTMLCanvasElement): void {
        canvas.addEventListener('pointerdown',   this._onDown);
        canvas.addEventListener('pointermove',   this._onMove);
        canvas.addEventListener('pointerup',     this._onUp);
        canvas.addEventListener('pointercancel', this._onCancel);
    }

    /** 移除畫布事件監聽（在 onClose 呼叫）*/
    unbind(canvas: HTMLCanvasElement): void {
        canvas.removeEventListener('pointerdown',   this._onDown);
        canvas.removeEventListener('pointermove',   this._onMove);
        canvas.removeEventListener('pointerup',     this._onUp);
        canvas.removeEventListener('pointercancel', this._onCancel);
    }

    private _handleDown(e: PointerEvent): void {
        if (e.pointerType === 'mouse') return;
        this._clearTimer();
        this._startX = e.clientX;
        this._startY = e.clientY;
        this._timer  = setTimeout(() => {
            this._timer = null;
            this.api.triggerLongPress(this._startX, this._startY);
        }, LONG_PRESS_MS);
    }

    private _handleMove(e: PointerEvent): void {
        if (!this._timer) return;
        const dx = e.clientX - this._startX;
        const dy = e.clientY - this._startY;
        if (Math.hypot(dx, dy) > LONG_PRESS_SLOP) this._clearTimer();
    }

    private _clearTimer(): void {
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }
}
