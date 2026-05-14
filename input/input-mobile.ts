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
 *
 * Android 注意事項：Android WebView 在長按時會先觸發 pointercancel（取消指標捕捉）
 * 再觸發 contextmenu。若只依賴計時器，pointercancel 會在計時器到期前清除它，
 * 導致長按選單無法出現。解法：
 *   1. 監聽 contextmenu 並呼叫 preventDefault()，阻止瀏覽器原生選單
 *   2. pointercancel 只清除計時器，保留 _touching 旗標
 *   3. contextmenu 到來時若 _touching 為 true，補發 triggerLongPress
 *
 * 不含任何功能邏輯，只負責計時器 / 旗標的生命週期管理。
 */
export class MobileLongPressHandler {
    private _timer:    ReturnType<typeof setTimeout> | null = null;
    private _startX  = 0;
    private _startY  = 0;
    /** 非滑鼠 pointerdown 後到 pointerup 之間為 true；pointercancel 不清除此旗標 */
    private _touching = false;

    private readonly _onDown:        (e: PointerEvent) => void;
    private readonly _onMove:        (e: PointerEvent) => void;
    private readonly _onUp:          (e: PointerEvent) => void;
    private readonly _onCancel:      (e: PointerEvent) => void;
    private readonly _onContextMenu: (e: MouseEvent)   => void;

    constructor(private readonly api: FeatureAPI) {
        this._onDown        = this._handleDown.bind(this);
        this._onMove        = this._handleMove.bind(this);
        this._onUp          = this._handleUp.bind(this);
        this._onCancel      = this._cancelTimer.bind(this);
        this._onContextMenu = this._handleContextMenu.bind(this);
    }

    /** 綁定畫布事件監聽（在 buildCanvas 結尾呼叫）*/
    bind(canvas: HTMLCanvasElement): void {
        canvas.addEventListener('pointerdown',   this._onDown);
        canvas.addEventListener('pointermove',   this._onMove);
        canvas.addEventListener('pointerup',     this._onUp);
        canvas.addEventListener('pointercancel', this._onCancel);
        canvas.addEventListener('contextmenu',   this._onContextMenu);
    }

    /** 移除畫布事件監聽（在 onClose 呼叫）*/
    unbind(canvas: HTMLCanvasElement): void {
        canvas.removeEventListener('pointerdown',   this._onDown);
        canvas.removeEventListener('pointermove',   this._onMove);
        canvas.removeEventListener('pointerup',     this._onUp);
        canvas.removeEventListener('pointercancel', this._onCancel);
        canvas.removeEventListener('contextmenu',   this._onContextMenu);
    }

    private _handleDown(e: PointerEvent): void {
        if (e.pointerType === 'mouse') return;
        this._abort();  // 清除上一次殘留狀態
        this._touching = true;
        this._startX   = e.clientX;
        this._startY   = e.clientY;
        this._timer    = setTimeout(() => {
            this._timer    = null;
            this._touching = false;  // 計時器正常完成，防止 contextmenu 重複觸發
            this.api.triggerLongPress(this._startX, this._startY);
        }, LONG_PRESS_MS);
    }

    private _handleMove(e: PointerEvent): void {
        if (!this._touching) return;
        const dx = e.clientX - this._startX;
        const dy = e.clientY - this._startY;
        if (Math.hypot(dx, dy) > LONG_PRESS_SLOP) this._abort();
    }

    private _handleUp(): void {
        this._abort();
    }

    /**
     * pointercancel：Android 長按時瀏覽器可能在計時器到期前取消指標。
     * 只清除計時器，保留 _touching=true，讓後續的 contextmenu 事件仍能補發長按。
     */
    private _cancelTimer(): void {
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    /**
     * contextmenu：
     *   - 永遠 preventDefault()，阻止瀏覽器原生長按選單（Android 和桌面右鍵皆適用）
     *   - 若 _touching 為 true（觸控長按），補發 triggerLongPress
     *     （處理 Android 先 pointercancel 再 contextmenu 的情境）
     */
    private _handleContextMenu(e: MouseEvent): void {
        e.preventDefault();
        if (!this._touching) return;
        this._abort();
        this.api.triggerLongPress(this._startX, this._startY);
    }

    /** 取消計時器並重置所有長按狀態 */
    private _abort(): void {
        this._touching = false;
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }
}
