import { App, Modal, Setting, TFile } from 'obsidian';
import { t } from '../i18n';

// ─── 儲存 Modal ──────────────────────────────────────────────────────────────
export class SaveModal extends Modal {
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
        contentEl.createEl('h3', { text: t('modal.save.title') });

        // 檔案名稱
        new Setting(contentEl)
            .setName(t('modal.save.filename'))
            .setDesc(t('modal.save.filenameDesc'))
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
            .setName(t('modal.save.format'))
            .addDropdown((d) => {
                d.addOption('png',  t('modal.save.png'));
                d.addOption('jpeg', t('modal.save.jpg'));
                d.addOption('webp', t('modal.save.webp'));
                d.setValue('png');
                d.onChange((v) => { fmt = v as 'png' | 'jpeg' | 'webp'; });
            });

        // 確認 / 取消
        const btnRow = contentEl.createEl('div', { cls: 'easynote-size-btnrow' });
        const saveBtn = btnRow.createEl('button', {
            cls:  'easynote-btn easynote-btn-save',
            text: t('modal.save.save'),
        });
        saveBtn.addEventListener('click', () => {
            if (!this.defaultName) return;
            this.onSave(this.defaultName, fmt);
            this.close();
        });
        const cancelBtn = btnRow.createEl('button', { cls: 'easynote-btn', text: t('modal.save.cancel') });
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
export class CanvasSizeModal extends Modal {
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
        contentEl.createEl('h3', { text: t('modal.canvasSize.title') });
        this.hintEl = contentEl.createEl('p', {
            cls:  'easynote-size-hint',
            text: t('modal.canvasSize.hint', this.currentW, this.currentH),
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
            [t('modal.canvasSize.w2'),  () => { this.wInput.value = String((parseInt(this.wInput.value) || this.currentW) * 2); }],
            [t('modal.canvasSize.h2'),  () => { this.hInput.value = String((parseInt(this.hInput.value) || this.currentH) * 2); }],
            [t('modal.canvasSize.all2'),() => { this.wInput.value = String((parseInt(this.wInput.value) || this.currentW) * 2); this.hInput.value = String((parseInt(this.hInput.value) || this.currentH) * 2); }],
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
            text: t('modal.canvasSize.apply'),
        });
        applyBtn.addEventListener('click', () => {
            const w = Math.max(100, Math.min(16000, parseInt(this.wInput.value) || this.currentW));
            const h = Math.max(100, Math.min(16000, parseInt(this.hInput.value) || this.currentH));
            this.onApply(w, h);
            this.close();
        });
        const closeBtn = btnRow.createEl('button', { cls: 'easynote-btn', text: t('modal.canvasSize.close') });
        closeBtn.addEventListener('click', () => this.close());
    }

    onClose(): void { this.contentEl.empty(); }
}

// ─── 專案名稱 Modal ───────────────────────────────────────────────────────────
export class ProjectNameModal extends Modal {
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
        contentEl.createEl('h3', { text: t('modal.project.title') });

        new Setting(contentEl)
            .setName(t('modal.project.name'))
            .setDesc(t('modal.project.desc'))
            .addText((t) => {
                t.setValue(this.name);
                t.inputEl.style.width = '100%';
                t.onChange((v) => { this.name = v.trim() || this.name; });
                setTimeout(() => { t.inputEl.select(); t.inputEl.focus(); }, 30);
            });

        const btnRow   = contentEl.createEl('div', { cls: 'easynote-size-btnrow' });
        const saveBtn  = btnRow.createEl('button', { cls: 'easynote-btn easynote-btn-save', text: t('modal.project.save') });
        saveBtn.addEventListener('click', () => { if (this.name) { this.onConfirm(this.name); this.close(); } });
        const cancelBtn = btnRow.createEl('button', { cls: 'easynote-btn', text: t('modal.project.cancel') });
        cancelBtn.addEventListener('click', () => this.close());

        contentEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')  { saveBtn.click();  e.preventDefault(); }
            if (e.key === 'Escape') { this.close();     e.preventDefault(); }
        });
    }

    onClose(): void { this.contentEl.empty(); }
}

// ─── Vault 專案選擇 Modal (.enote) ────────────────────────────────────────────
export class VaultProjectPickerModal extends Modal {
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
        contentEl.createEl('h3', { text: t('modal.vaultProject.title') });

        this.searchInput             = contentEl.createEl('input');
        this.searchInput.type        = 'text';
        this.searchInput.placeholder = t('modal.vaultProject.search');
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
            this.listEl.createEl('div', { cls: 'easynote-picker-empty', text: t('modal.vaultProject.empty') });
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
export class VaultImagePickerModal extends Modal {
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
        contentEl.createEl('h3', { text: t('modal.vaultImage.title') });

        this.searchInput             = contentEl.createEl('input');
        this.searchInput.type        = 'text';
        this.searchInput.placeholder = t('modal.vaultImage.search');
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
        this.makeSidebarItem('🗂️', t('modal.vaultImage.allFolders'), allImages.length, null);
        this.sidebarEl.createEl('div', { cls: 'easynote-picker-sidebar-sep' });

        // 各資料夾，根目錄優先
        const folders = [...folderCounts.keys()].sort((a, b) => {
            if (a === '/') return -1;
            if (b === '/') return  1;
            return a.localeCompare(b);
        });
        for (const folder of folders) {
            const label   = folder === '/' ? t('modal.vaultImage.rootFolder') : (folder.split('/').pop() ?? folder);
            const tooltip = folder === '/' ? t('modal.vaultImage.rootFolder') : folder;
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
            this.gridEl.createEl('div', { cls: 'easynote-picker-empty', text: t('modal.vaultImage.empty') });
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
export class VaultNotePickerModal extends Modal {
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
        contentEl.createEl('h3', { text: t('modal.vaultNote.title') });
        contentEl.createEl('p', {
            cls:  'easynote-picker-hint',
            text: t('modal.vaultNote.hint'),
        });

        this.searchInput             = contentEl.createEl('input');
        this.searchInput.type        = 'text';
        this.searchInput.placeholder = t('modal.vaultNote.search');
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
            this.listEl.createEl('div', { cls: 'easynote-picker-empty', text: t('modal.vaultNote.empty') });
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

// ─── Google Drive 版本衝突確認 Modal ─────────────────────────────────────────
export class DriveConflictModal extends Modal {
    private driveTime: Date;
    private onResolve: (overwrite: boolean) => void;

    constructor(app: App, driveTime: Date, onResolve: (overwrite: boolean) => void) {
        super(app);
        this.driveTime = driveTime;
        this.onResolve = onResolve;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: 'Google Drive 版本衝突' });
        contentEl.createEl('p', {
            text: `Google Drive 上的檔案較新（最後修改：${this.driveTime.toLocaleString('zh-TW')}）。`,
        });
        contentEl.createEl('p', { text: '是否要以目前本機版本覆蓋 Google Drive 上的檔案？' });

        const btnRow = contentEl.createEl('div', { cls: 'easynote-size-btnrow' });

        const cancelBtn = btnRow.createEl('button', { cls: 'easynote-btn', text: '取消上傳（保留 Drive 版本）' });
        cancelBtn.addEventListener('click', () => { this.onResolve(false); this.close(); });

        const overwriteBtn = btnRow.createEl('button', { cls: 'easynote-btn mod-warning', text: '覆蓋 Drive 版本' });
        overwriteBtn.style.marginLeft = '8px';
        overwriteBtn.addEventListener('click', () => { this.onResolve(true); this.close(); });
    }

    onClose(): void { this.contentEl.empty(); }
}
