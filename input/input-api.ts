/** 工具類型（功能層定義） */
export type Tool = 'draw' | 'select' | 'text' | 'paintselect' | 'pan';

/**
 * FeatureAPI — 裝置層（input handlers）呼叫功能層的抽象介面。
 *
 * 所有實作細節（狀態、UI 更新）都留在 EasyNoteView；
 * input handler 只透過此介面溝通，不需要 import EasyNoteView。
 */
export interface FeatureAPI {
    // ── Guard ────────────────────────────────────────────────────────────────
    /** 回傳此 view 是否為目前 workspace 的 active view */
    isActiveView(): boolean;

    // ── Tool ─────────────────────────────────────────────────────────────────
    getTool(): Tool;
    setTool(t: Tool): void;

    // ── State queries ────────────────────────────────────────────────────────
    /** 有內部剪貼簿（Ctrl+C 複製的圖層）*/
    hasInternalClipboard(): boolean;
    /** select 模式下是否有進行中的框選範圍（imgSelStart != null）*/
    hasImgSelBox(): boolean;
    /** select 模式下是否有已完成的多選群組（multiSel != null）*/
    hasMultiSel(): boolean;
    /** paintselect 模式下是否有進行中的選取框（selStart != null）*/
    hasPaintSelBox(): boolean;
    /** paintselect 模式下是否有已提取的繪畫片段（paintFragment != null）*/
    hasPaintFragment(): boolean;

    // ── History ──────────────────────────────────────────────────────────────
    undo(): void;
    redo(): void;

    // ── Selection actions ────────────────────────────────────────────────────
    copySelection(): void;
    cutSelection(): void;
    /** 貼上內部剪貼簿（與系統剪貼簿圖片貼上不同）*/
    pasteClipboard(): void;
    /** 刪除目前選取的圖層或繪畫片段（自動根據 tool 判斷） */
    deleteSelection(): void;
    clearImgSelBox(): void;
    clearMultiSel(): void;
    clearPaintSelBox(): void;

    // ── Canvas ───────────────────────────────────────────────────────────────
    clearCanvas(): void;
    toggleEraser(): void;
    setColor(idx: number): void;

    // ── Fragment (paintselect) ───────────────────────────────────────────────
    commitFragment(): void;
    cancelFragment(): void;

    // ── Brush ────────────────────────────────────────────────────────────────
    /** 增加一階或固定步距的筆刷大小（+ 鍵）*/
    incrementBrushSize(): void;
    /** 減少一階或固定步距的筆刷大小（- 鍵）*/
    decrementBrushSize(): void;

    // ── Zoom ─────────────────────────────────────────────────────────────────
    /** 以游標位置為錨點縮放（滾輪） */
    zoomAtCursor(clientX: number, clientY: number, deltaY: number): void;
    /** 重設縮放至 100%（0 鍵）*/
    resetZoom(): void;

    // ── Status ───────────────────────────────────────────────────────────────
    refreshStatus(): void;

    // ── Clipboard (system) ──────────────────────────────────────────────────
    /** 貼上來自系統剪貼簿的圖片檔案 */
    pasteImageFromFile(file: File): void;

    // ── Mode guards ──────────────────────────────────────────────────────────
    /** stroke-layer 模式下 paintselect 工具無意義，回傳 false 時應忽略對應快捷鍵 */
    isPaintSelectAvailable(): boolean;

    // ── Canvas pointer events (delegated from CanvasInputHandler) ────────────
    handlePointerDown(e: PointerEvent): void;
    handlePointerMove(e: PointerEvent): void;
    handlePointerUp(e: PointerEvent): void;
    /** pointercancel — 視同 pointerup，清理拖曳 / 繪圖狀態 */
    handlePointerCancel(e: PointerEvent): void;
    handlePointerLeave(e: PointerEvent): void;
    handleDblClick(e: MouseEvent): void;

    // ── Canvas drag-and-drop (delegated from CanvasInputHandler) ─────────────
    handleDragOver(e: DragEvent): void;
    handleDragLeave(e: DragEvent): void;
    handleDrop(e: DragEvent): void;

    // ── Mobile long-press (delegated from MobileLongPressHandler) ────────────
    /** 觸控長按觸發：座標為 clientX/Y，由 MobileLongPressHandler 偵測後呼叫 */
    triggerLongPress(clientX: number, clientY: number): void;
}
