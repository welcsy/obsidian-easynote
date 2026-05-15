# EasyNote — Obsidian Drawing Plugin

> **Platform compatibility:** Currently tested and supported on **Windows** and **Android** only.
> macOS, iOS, and Linux have not been verified and may have issues.

A full-featured drawing canvas in the Obsidian sidebar. Supports multi-color brushes, eraser, image layers (including multi-layer rubber-band selection), text layers, Markdown layers (with `[[wikilink]]` and `[text](url)` links), and named undo / redo history. Canvas state is saved in `.enote` format and can be resumed at any time.

---

## Features

### Drawing Tools
- **Multi-color brush**: Quick switch between 5 colors (keys `1`–`5`); long-press a color swatch to customize
- **Eraser** (key `E`):
  - **Pixel mode**: transparent `destination-out` erase — does not affect image layers
  - **Image mode**: tap to delete the corresponding stroke layer
- **Brush size**: 7-step mode or continuous 1–60 px mode (switchable in settings); slider shows value in real time
- **Opacity**: adjustable from 1% to 100%
- **Brush mode**:
  - **Pixel mode**: each stroke is drawn directly onto the paint layer (traditional pixel drawing)
  - **Image mode** (default): each stroke is automatically converted to a selectable / deletable image layer when lifted
- **Paint select** (key `M`, Pixel mode only): rubber-band select a region of the paint layer; move, resize, then merge back

### Image & Layer Tools
- **Select tool** (key `S`):
  - Single tap → move, corner-resize (`Shift` = proportional), `Del` to delete
  - **Rubber-band select**: drag on empty canvas to draw a selection box; all image / text / Markdown layers inside form a group (purple border) that can be moved, resized, or deleted together with `Del`
- **Load local image**: file picker, or drag-and-drop / `Ctrl+V` paste
- **Load Obsidian image**: browse and pick an image from the Vault

### Text Tools
- **Text layer** (key `T`): click canvas to add; double-click existing text to edit
- **Markdown layer**: load a Vault `.md` file via "Load Note" for live rendering; bidirectional sync; double-click to edit
  - Supports `[[wikilink]]` — click to open in Obsidian
  - Supports `[text](url)` — click to open in browser

### Undo / Redo
- **Ctrl+Z / Ctrl+Y**: undo / redo, up to 50 steps
- **History dropdown**: click the arrow next to ↩ / ↪ to expand the named history list and jump to any step directly

### Canvas Management
- **Save / Load Canvas**: save the full project as `.enote`; manage multiple canvases in the Vault
- **Export**: flatten all layers and export as PNG / JPEG / WebP to the Vault; the last saved or loaded project name is pre-filled automatically
- **Canvas size**: freely adjustable; default 1920 × 1080
- **Zoom & Pan**: scroll-wheel zoom (cursor-anchored), middle-button drag pan; `0` resets to 100%

### Touch Support
- **Two-finger pinch-to-zoom / pan**: standard gesture
- **Long press**: triggers the context menu
- **Stylus**: native Pointer Events support

---

## Layer Rendering Order (top to bottom)

| Layer | Description |
|---|---|
| Paint layer | Brush strokes (Pixel mode) or stroke image layers (Image mode) |
| Markdown layers | Vault note rendered output |
| Text layers | Movable text boxes |
| Image layers | Loaded images (bottom-most) |

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `1`–`5` | Switch brush color |
| `E` | Toggle eraser |
| `T` | Text tool |
| `S` | Select tool (with rubber-band multi-select) |
| `M` | Paint select tool (Pixel mode only) |
| `+` / `-` | Increase / decrease brush size |
| `0` | Reset zoom to 100% |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Ctrl+C` | Copy selected layer |
| `Ctrl+X` | Cut selected layer |
| `Ctrl+V` | Paste (internal clipboard or system image) |
| `Del` | Delete selected layer / group |
| `Esc` | Cancel selection box / deselect group |
| Scroll wheel | Zoom canvas |
| Middle-button drag | Pan canvas |

---

## Settings

| Setting | Description | Default |
|---|---|---|
| Language | Traditional Chinese / English | Traditional Chinese |
| Default color | Brush color on open | Black |
| Brush mode | Pixel mode (direct paint) or Image mode (each stroke becomes a layer) | Image mode |
| Brush size mode | 7-step fixed or continuous 1–60 px | 7-step |
| Default brush size | Brush size on open | Step 2 (6 px) |
| Default 5-color palette | Starting colors for the 5 color swatches | Black, Red, Blue, Green, Orange |
| Startup canvas mode | New canvas or resume previous | New canvas |
| Default canvas width / height | Initial size for new canvases | 1920 × 1080 |
| Paint resolution scale | 1.0 = full resolution; 0.5 = performance mode | 1.0 |
| Timezone | IANA timezone for export filename timestamps | Asia/Taipei |
| Auto sync | Periodically reload `.enote` from Vault | Off |
| Periodic auto-save | Periodically auto-save to `.enote` | Off |
| Save folder | Location for exported PNGs and `.enote` files | `EasyNote` |
| Google Drive sync | Connect Google Drive for backup / sync | Off |

---

## The .enote Format

`.enote` is EasyNote's project format. It stores the canvas dimensions, paint layer, image layers, text layers, and Markdown layers in their entirety.

### Showing .enote files in the Obsidian file explorer

Obsidian hides files with unknown extensions by default. To make `.enote` appear in the left-side file explorer, enable:

> **Settings → Files & Links → Detect all file extensions → On**

Once enabled, `.enote` files will appear normally in the file explorer and can be selected via the "Load Canvas" button.

---

## Installation

### Manual installation
1. Download the latest `main.js`, `manifest.json`, and `styles.css` from [Releases](../../releases)
2. Copy them to `.obsidian/plugins/easynote/` inside your Vault
3. Enable **Easy Note** in Obsidian Settings → Community Plugins

### Build from source
```bash
git clone <repo-url>
cd easynote
npm install
npm run build
```

---

## Requirements

- Obsidian `1.0.0` or higher
- Works on both desktop and mobile
