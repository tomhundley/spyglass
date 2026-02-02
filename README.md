# Spyglass

A lightning-fast, minimal file explorer optimized for copying file and folder paths.

## Features

- **Single-click path copy** - Click any file/folder to copy its path to clipboard
- **Fast navigation** - Slide animations for smooth folder navigation
- **Fuzzy search** - Start typing anywhere to filter files
- **Global hotkey** - Toggle visibility from anywhere (configurable)
- **Keyboard-first** - Full keyboard navigation support
- **Dark theme** - Easy on the eyes

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `↑` / `↓` | Navigate list |
| `Enter` | Copy selected path |
| `→` | Enter folder |
| `←` | Go back |
| `Shift+Enter` | Copy absolute path |
| `Escape` | Clear search / Close settings |
| `Cmd+,` | Open settings |
| `Cmd+R` | Go to root |

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

## Tech Stack

- **Tauri** - Native app framework
- **React + TypeScript** - Frontend
- **Rust** - Backend filesystem operations
- **Framer Motion** - Animations
- **Fuse.js** - Fuzzy search

## Configuration

Settings are stored in `~/.config/spyglass/config.json`:

- **Projects Folder** - Default folder to open on launch
- **Global Hotkey** - Shortcut to toggle app visibility
- **Remember Location** - Whether to resume where you left off
