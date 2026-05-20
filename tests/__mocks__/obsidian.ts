/**
 * Obsidian API Mock
 * 測試環境中，obsidian 套件不可用（只在 Obsidian 桌面 app 內部存在），
 * 因此需要用 mock 替代所有從 'obsidian' import 的類別/函式。
 */
import { vi } from 'vitest';

// ─── 基礎類別 ──────────────────────────────────────────────────────────────
export class Plugin {
    app: App;
    manifest: unknown;
    constructor(app: App, manifest: unknown) { this.app = app; this.manifest = manifest; }
    loadData()                   { return Promise.resolve({}); }
    saveData(_data: unknown)     { return Promise.resolve(); }
    addCommand(_cmd: unknown)    {}
    addRibbonIcon(_icon: string, _title: string, _cb: () => void) { return document.createElement('div'); }
    addSettingTab(_tab: unknown) {}
    registerView(_type: string, _factory: unknown) {}
    registerExtensions(_exts: string[], _type: string) {}
    registerEvent(_ref: unknown) {}
    onload()    {}
    onunload()  {}
}

export class Modal {
    app: App;
    containerEl: HTMLElement;
    contentEl:   HTMLElement;
    constructor(app: App) {
        this.app = app;
        this.containerEl = document.createElement('div');
        this.contentEl   = document.createElement('div');
    }
    open()  {}
    close() {}
    onOpen()  {}
    onClose() {}
}

export class ItemView {
    app: App;
    leaf: WorkspaceLeaf;
    containerEl: HTMLElement;
    contentEl:   HTMLElement;
    constructor(leaf: WorkspaceLeaf) {
        this.leaf        = leaf;
        this.app         = leaf.view?.app ?? ({} as App);
        this.containerEl = document.createElement('div');
        this.contentEl   = document.createElement('div');
    }
    getViewType(): string { return ''; }
    getDisplayText(): string { return ''; }
    onload()   {}
    onunload() {}
}

export class PluginSettingTab {
    app: App;
    plugin: Plugin;
    containerEl: HTMLElement;
    constructor(app: App, plugin: Plugin) {
        this.app         = app;
        this.plugin      = plugin;
        this.containerEl = document.createElement('div');
    }
    display() {}
    hide()    {}
}

export class Setting {
    settingEl: HTMLElement;
    constructor(_containerEl: HTMLElement) {
        this.settingEl = document.createElement('div');
    }
    setName(_name: string)        { return this; }
    setDesc(_desc: string)        { return this; }
    addText(_cb: unknown)         { return this; }
    addToggle(_cb: unknown)       { return this; }
    addSlider(_cb: unknown)       { return this; }
    addDropdown(_cb: unknown)     { return this; }
    addButton(_cb: unknown)       { return this; }
    addTextArea(_cb: unknown)     { return this; }
    setClass(_cls: string)        { return this; }
    setHeading()                  { return this; }
}

export class Notice {
    constructor(_msg: string, _timeout?: number) {}
}

export class TFile {
    path: string;
    name: string;
    basename: string;
    extension: string;
    constructor(path: string) {
        this.path      = path;
        this.name      = path.split('/').pop() ?? path;
        const parts    = this.name.split('.');
        this.extension = parts.length > 1 ? parts.pop()! : '';
        this.basename  = parts.join('.');
    }
}

// ─── Workspace 相關 ────────────────────────────────────────────────────────
export class WorkspaceLeaf {
    view: { app: App } = { app: {} as App };
    openFile(_file: TFile)     { return Promise.resolve(); }
    setViewState(_state: unknown) { return Promise.resolve(); }
    getViewState() { return {}; }
}

// ─── App ──────────────────────────────────────────────────────────────────
export class App {
    vault    = new Vault();
    workspace = new Workspace();
    metadataCache = { getFirstLinkpathDest: vi.fn(() => null) };
}

export class Vault {
    adapter = { exists: vi.fn(() => Promise.resolve(false)), mkdir: vi.fn(() => Promise.resolve()) };
    read(_file: TFile)                    { return Promise.resolve(''); }
    write(_path: string, _data: string)   { return Promise.resolve(); }
    create(_path: string, _data: string)  { return Promise.resolve(new TFile(_path)); }
    modify(_file: TFile, _data: string)   { return Promise.resolve(); }
    delete(_file: TFile)                  { return Promise.resolve(); }
    getFiles(): TFile[]                   { return []; }
    getAbstractFileByPath(_path: string)  { return null; }
    on(_event: string, _cb: unknown)      { return { id: 'mock-ref' }; }
    off(_event: string, _cb: unknown)     {}
    offref(_ref: unknown)                 {}
}

export class Workspace {
    getActiveViewOfType<T>(_type: unknown): T | null { return null; }
    getLeaf(_newLeaf?: boolean): WorkspaceLeaf { return new WorkspaceLeaf(); }
    getLeavesOfType(_type: string): WorkspaceLeaf[] { return []; }
    getRightLeaf(_split: boolean): WorkspaceLeaf { return new WorkspaceLeaf(); }
    revealLeaf(_leaf: WorkspaceLeaf) {}
    on(_event: string, _cb: unknown) { return { id: 'mock-ref' }; }
    off(_event: string, _cb: unknown) {}
    offref(_ref: unknown) {}
}

// ─── 工具函式 ──────────────────────────────────────────────────────────────
export const Platform = {
    isDesktop: true,
    isMobile:  false,
    isAndroid: false,
    isIosApp:  false,
    isMacOS:   false,
};

export function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function setIcon(_el: HTMLElement, _icon: string): void {}

export const requestUrl = vi.fn(() =>
    Promise.resolve({ status: 200, json: {}, text: '', arrayBuffer: new ArrayBuffer(0) })
);
