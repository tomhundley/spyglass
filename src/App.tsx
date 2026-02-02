import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import Fuse from 'fuse.js';
import './App.css';

interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
}

interface Tab {
  id: string;
  path: string;
  name: string;
  color: string;
}

interface ContextMenu {
  x: number;
  y: number;
  entry: FileEntry;
}

interface IndexEntry {
  name: string;
  path: string;
  is_directory: boolean;
  parent_folder: string;
}

interface IndexProgress {
  total_folders: number;
  indexed_folders: number;
  total_files: number;
  current_folder: string;
  is_complete: boolean;
}

const TAB_COLORS = ['#4ade80', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#f87171', '#2dd4bf', '#fb923c', '#a3e635', '#22d3ee'];

const PROJECTS_ROOT = '/Users/tomhundley/projects';

function generateId() {
  return Math.random().toString(36).substring(2, 9);
}

function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null);
  const [indexCount, setIndexCount] = useState(0);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexedResults, setIndexedResults] = useState<IndexEntry[]>([]);
  const [useIndexSearch, setUseIndexSearch] = useState(true);
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [showPaths, setShowPaths] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const expandedSizeRef = useRef({ width: 700, height: 600 });
  const collapsedHeightRef = useRef(100);

  const activeTab = tabs.find(t => t.id === activeTabId);
  const currentPath = activeTab?.path || '';

  // Memoize Fuse instance
  const fuse = useMemo(() => {
    return new Fuse(entries, { keys: ['name'], threshold: 0.4 });
  }, [entries]);

  // Memoize filtered entries
  const filteredEntries = useMemo(() => {
    if (!searchQuery) return entries;
    return fuse.search(searchQuery).map(r => r.item);
  }, [entries, fuse, searchQuery]);

  // Save state to config
  const saveState = useCallback(async (newTabs: Tab[], newActiveId: string) => {
    try {
      await invoke('save_config', {
        config: {
          root_folder: null,
          global_hotkey: null,
          remember_location: true,
          last_location: null,
          tabs: newTabs,
          active_tab_id: newActiveId,
        }
      });
    } catch (e) {
      console.error('Failed to save state:', e);
    }
  }, []);

  // Load directory
  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    setSearchQuery('');
    setSelectedIndex(0);
    try {
      const result = await invoke<FileEntry[]>('read_directory', { path });
      setEntries(result);
    } catch (e) {
      setError(String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Navigate to path in current tab
  const navigateTo = useCallback(async (path: string) => {
    if (!activeTabId) return;
    const name = path.split('/').pop() || '~';
    const newTabs = tabs.map(t =>
      t.id === activeTabId ? { ...t, path, name } : t
    );
    setTabs(newTabs);
    saveState(newTabs, activeTabId);
    await loadDirectory(path);
  }, [activeTabId, tabs, loadDirectory, saveState]);

  // Navigate back
  const navigateBack = useCallback(async () => {
    if (!currentPath) return;
    try {
      const parent = await invoke<string | null>('get_parent_path', { path: currentPath });
      if (parent) {
        await navigateTo(parent);
      }
    } catch (e) {
      console.error('Navigate back failed:', e);
    }
  }, [currentPath, navigateTo]);

  // Focus mode window operations
  const collapseWindow = useCallback(async () => {
    const win = getCurrentWindow();
    try {
      const size = await win.innerSize();
      expandedSizeRef.current = { width: size.width, height: size.height };
      await win.setSize(new LogicalSize(size.width, collapsedHeightRef.current));
      setIsCollapsed(true);
    } catch (e) {
      console.error('Failed to collapse window:', e);
    }
  }, []);

  const expandWindow = useCallback(async () => {
    const win = getCurrentWindow();
    try {
      await win.setSize(new LogicalSize(expandedSizeRef.current.width, expandedSizeRef.current.height));
      setIsCollapsed(false);
    } catch (e) {
      console.error('Failed to expand window:', e);
    }
  }, []);

  const toggleFocusMode = useCallback(async () => {
    if (focusMode) {
      // Exiting focus mode - expand and disable
      await expandWindow();
      setFocusMode(false);
    } else {
      // Entering focus mode - collapse and enable
      setFocusMode(true);
      await collapseWindow();
    }
  }, [focusMode, collapseWindow, expandWindow]);

  // Save collapsed height when user resizes in focus mode
  useEffect(() => {
    if (!focusMode || !isCollapsed) return;

    let resizeTimeout: ReturnType<typeof setTimeout>;
    const handleResize = async () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(async () => {
        try {
          const win = getCurrentWindow();
          const size = await win.innerSize();
          collapsedHeightRef.current = size.height;
        } catch (e) {
          console.error('Failed to save collapsed height:', e);
        }
      }, 200);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimeout);
    };
  }, [focusMode, isCollapsed]);

  // Handle copy
  const handleCopy = useCallback(async (entry: FileEntry) => {
    try {
      await writeText(entry.path);
      setCopiedPath(entry.path);
      if (focusMode && !isCollapsed) {
        setTimeout(() => collapseWindow(), 200);
      }
      setTimeout(() => setCopiedPath(null), 200);
    } catch (e) {
      console.error('Copy failed:', e);
    }
  }, [focusMode, isCollapsed, collapseWindow]);

  // Open in new tab
  const openInNewTab = useCallback((path: string, color?: string) => {
    const name = path.split('/').pop() || '~';
    const newTab: Tab = {
      id: generateId(),
      path,
      name,
      color: color || TAB_COLORS[tabs.length % TAB_COLORS.length],
    };
    const newTabs = [...tabs, newTab];
    setTabs(newTabs);
    setActiveTabId(newTab.id);
    saveState(newTabs, newTab.id);
    loadDirectory(path);
  }, [tabs, loadDirectory, saveState]);

  // Close tab
  const closeTab = useCallback((tabId: string) => {
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex(t => t.id === tabId);
    const newTabs = tabs.filter(t => t.id !== tabId);
    setTabs(newTabs);

    if (activeTabId === tabId) {
      const newActive = newTabs[Math.min(idx, newTabs.length - 1)];
      setActiveTabId(newActive.id);
      loadDirectory(newActive.path);
      saveState(newTabs, newActive.id);
    } else {
      saveState(newTabs, activeTabId);
    }
  }, [tabs, activeTabId, loadDirectory, saveState]);

  // Switch tab
  const switchTab = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (tab) {
      if (focusMode && isCollapsed) {
        expandWindow();
      }
      setActiveTabId(tabId);
      loadDirectory(tab.path);
      saveState(tabs, tabId);
    }
  }, [tabs, loadDirectory, saveState, focusMode, isCollapsed, expandWindow]);

  // Change tab color
  const changeTabColor = useCallback((tabId: string, color: string) => {
    const newTabs = tabs.map(t =>
      t.id === tabId ? { ...t, color } : t
    );
    setTabs(newTabs);
    saveState(newTabs, activeTabId);
  }, [tabs, activeTabId, saveState]);

  // Reorder tabs
  const reorderTabs = useCallback((fromId: string, toId: string) => {
    const fromIdx = tabs.findIndex(t => t.id === fromId);
    const toIdx = tabs.findIndex(t => t.id === toId);
    if (fromIdx === -1 || toIdx === -1) return;

    const newTabs = [...tabs];
    const [moved] = newTabs.splice(fromIdx, 1);
    newTabs.splice(toIdx, 0, moved);
    setTabs(newTabs);
    saveState(newTabs, activeTabId);
  }, [tabs, activeTabId, saveState]);

  // Start indexing
  const startIndexing = useCallback(async () => {
    try {
      setIsIndexing(true);
      await invoke('start_indexing');
    } catch (e) {
      console.error('Failed to start indexing:', e);
      setIsIndexing(false);
    }
  }, []);

  // Poll index progress
  useEffect(() => {
    if (!isIndexing) return;

    const interval = setInterval(async () => {
      try {
        const progress = await invoke<IndexProgress>('get_index_progress');
        setIndexProgress(progress);

        if (progress.is_complete) {
          setIsIndexing(false);
          const count = await invoke<number>('get_index_count');
          setIndexCount(count);
        }
      } catch (e) {
        console.error('Failed to get progress:', e);
      }
    }, 500);

    return () => clearInterval(interval);
  }, [isIndexing]);

  // Search indexed files
  const searchIndexed = useCallback(async (query: string) => {
    if (!query || query.length < 2) {
      setIndexedResults([]);
      return;
    }
    try {
      const results = await invoke<IndexEntry[]>('search_index', { query });
      setIndexedResults(results);
    } catch (e) {
      console.error('Search failed:', e);
    }
  }, []);

  // Debounced index search
  useEffect(() => {
    if (!useIndexSearch || !searchQuery) {
      setIndexedResults([]);
      return;
    }

    const timeout = setTimeout(() => {
      searchIndexed(searchQuery);
    }, 100);

    return () => clearTimeout(timeout);
  }, [searchQuery, useIndexSearch, searchIndexed]);

  // Load saved index on startup
  useEffect(() => {
    async function loadIndex() {
      try {
        const loaded = await invoke<boolean>('load_saved_index');
        if (loaded) {
          const count = await invoke<number>('get_index_count');
          setIndexCount(count);
          setIndexProgress({ total_folders: 0, indexed_folders: 0, total_files: count, current_folder: '', is_complete: true });
        } else {
          // No saved index, start indexing automatically
          startIndexing();
        }
      } catch (e) {
        console.error('Failed to load index:', e);
      }
    }
    loadIndex();
  }, [startIndexing]);

  // Theme handling
  useEffect(() => {
    const root = document.documentElement;

    const applyTheme = (isDark: boolean) => {
      root.setAttribute('data-theme', isDark ? 'dark' : 'light');
    };

    const syncWindowTheme = async () => {
      const appWindow = getCurrentWindow();
      try {
        if (theme === 'system') {
          // null = follow system theme
          await appWindow.setTheme(null);
        } else {
          await appWindow.setTheme(theme);
        }
      } catch (e) {
        console.error('Failed to set window theme:', e);
      }
    };

    syncWindowTheme();

    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      applyTheme(mediaQuery.matches);

      const handler = (e: MediaQueryListEvent) => applyTheme(e.matches);
      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    } else {
      applyTheme(theme === 'dark');
    }
  }, [theme]);

  // Load saved preferences
  useEffect(() => {
    const savedTheme = localStorage.getItem('spyglass-theme') as 'light' | 'dark' | 'system' | null;
    if (savedTheme) setTheme(savedTheme);
    const savedShowPaths = localStorage.getItem('spyglass-show-paths');
    if (savedShowPaths) setShowPaths(savedShowPaths === 'true');
  }, []);

  // Save theme
  const changeTheme = useCallback((newTheme: 'light' | 'dark' | 'system') => {
    setTheme(newTheme);
    localStorage.setItem('spyglass-theme', newTheme);
  }, []);

  // Toggle paths
  const togglePaths = useCallback(() => {
    setShowPaths(prev => {
      localStorage.setItem('spyglass-show-paths', (!prev).toString());
      return !prev;
    });
  }, []);

  // Initialize
  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        const cfg = await invoke<any>('load_config');

        if (mounted) {
          if (cfg.tabs && cfg.tabs.length > 0) {
            setTabs(cfg.tabs);
            const activeId = cfg.active_tab_id || cfg.tabs[0].id;
            setActiveTabId(activeId);
            const activeTab = cfg.tabs.find((t: Tab) => t.id === activeId) || cfg.tabs[0];
            await loadDirectory(activeTab.path);
          } else {
            // Create tabs for each folder in projects directory
            try {
              const projectFolders = await invoke<FileEntry[]>('read_directory', { path: PROJECTS_ROOT });
              const folders = projectFolders.filter(e => e.is_directory);

              if (folders.length > 0) {
                const initialTabs: Tab[] = folders.map((folder, index) => ({
                  id: generateId(),
                  path: folder.path,
                  name: folder.name,
                  color: TAB_COLORS[index % TAB_COLORS.length],
                }));
                setTabs(initialTabs);
                setActiveTabId(initialTabs[0].id);
                await loadDirectory(initialTabs[0].path);
                // Save these tabs
                saveState(initialTabs, initialTabs[0].id);
              } else {
                // Fallback to home dir if no project folders
                const path = await invoke<string>('get_home_dir');
                const initialTab: Tab = {
                  id: generateId(),
                  path: path!,
                  name: path!.split('/').pop() || '~',
                  color: TAB_COLORS[0],
                };
                setTabs([initialTab]);
                setActiveTabId(initialTab.id);
                await loadDirectory(path!);
              }
            } catch {
              // Fallback if projects folder doesn't exist
              const path = await invoke<string>('get_home_dir');
              const initialTab: Tab = {
                id: generateId(),
                path: path!,
                name: path!.split('/').pop() || '~',
                color: TAB_COLORS[0],
              };
              setTabs([initialTab]);
              setActiveTabId(initialTab.id);
              await loadDirectory(path!);
            }
          }
        }
      } catch (e) {
        if (mounted) {
          setError(String(e));
          setLoading(false);
        }
      }
    }

    init();
    return () => { mounted = false; };
  }, [loadDirectory, saveState]);

  // Keyboard handler
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (contextMenu) {
        if (e.key === 'Escape') setContextMenu(null);
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, filteredEntries.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        const selected = filteredEntries[selectedIndex];
        if (selected) {
          if (selected.is_directory) {
            navigateTo(selected.path);
          } else {
            handleCopy(selected);
          }
        }
      } else if (e.key === 'ArrowLeft') {
        navigateBack();
      } else if (e.key === 'Escape') {
        setSearchQuery('');
        setSelectedIndex(0);
      } else if (e.key === 't' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (currentPath) openInNewTab(currentPath);
      } else if (e.key === 'w' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (activeTabId) closeTab(activeTabId);
      } else if (e.key === 'f' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault();
        toggleFocusMode();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filteredEntries, selectedIndex, handleCopy, navigateTo, navigateBack, contextMenu, currentPath, openInNewTab, closeTab, activeTabId, toggleFocusMode]);

  // Close context menu on click outside
  useEffect(() => {
    function onClick() {
      setContextMenu(null);
    }
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, []);

  // Handle item click - copy path
  const handleItemClick = useCallback((entry: FileEntry) => {
    handleCopy(entry);
  }, [handleCopy]);

  // Handle double click - drill down into folder
  const handleDoubleClick = useCallback((entry: FileEntry) => {
    if (entry.is_directory) {
      navigateTo(entry.path);
    }
  }, [navigateTo]);

  // Handle context menu
  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  // Build breadcrumb segments
  const breadcrumbSegments = useMemo(() => {
    if (!currentPath) return [];
    const parts = currentPath.split('/').filter(Boolean);
    const segments: { name: string; path: string }[] = [];
    let path = '';
    for (const part of parts) {
      path += '/' + part;
      segments.push({ name: part, path });
    }
    return segments.slice(-4); // Show last 4 segments
  }, [currentPath]);

  return (
    <div className={`app ${focusMode && isCollapsed ? 'focus-mode' : ''}`} onClick={() => setContextMenu(null)}>
      {/* Tab Bar */}
      <div className="tab-bar">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? 'active' : ''} ${draggedTabId === tab.id ? 'dragging' : ''} ${draggedTabId && draggedTabId !== tab.id ? 'drop-target' : ''}`}
            style={{ borderTopColor: tab.color }}
            onClick={() => switchTab(tab.id)}
            draggable
            onDragStart={(e) => {
              setDraggedTabId(tab.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDragEnd={() => setDraggedTabId(null)}
            onDrop={() => {
              if (draggedTabId && draggedTabId !== tab.id) {
                reorderTabs(draggedTabId, tab.id);
              }
              setDraggedTabId(null);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // Show color picker
              const rect = (e.target as HTMLElement).getBoundingClientRect();
              const colorPicker = document.createElement('div');
              colorPicker.className = 'color-picker';
              colorPicker.style.left = rect.left + 'px';
              colorPicker.style.top = rect.bottom + 'px';
              TAB_COLORS.forEach(color => {
                const swatch = document.createElement('div');
                swatch.className = 'color-swatch';
                swatch.style.backgroundColor = color;
                swatch.onclick = () => {
                  changeTabColor(tab.id, color);
                  colorPicker.remove();
                };
                colorPicker.appendChild(swatch);
              });
              document.body.appendChild(colorPicker);
              setTimeout(() => {
                const remove = () => { colorPicker.remove(); document.removeEventListener('click', remove); };
                document.addEventListener('click', remove);
              }, 10);
            }}
          >
            <span className="tab-name">{tab.name}</span>
            {tabs.length > 1 && (
              <button
                className="tab-close"
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button className="tab-add" onClick={() => currentPath && openInNewTab(currentPath)}>
          +
        </button>
        <button
          className={`focus-mode-btn ${focusMode ? 'active' : ''}`}
          onClick={toggleFocusMode}
          title={focusMode ? "Exit focus mode (⌘⇧F)" : "Enter focus mode (⌘⇧F)"}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {focusMode ? (
              <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
            ) : (
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            )}
          </svg>
        </button>
      </div>

      {/* Breadcrumb */}
      <div className="breadcrumb">
        <button
          className={`breadcrumb-back ${!currentPath ? 'disabled' : ''}`}
          onClick={navigateBack}
          disabled={!currentPath}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          <span className="breadcrumb-back-text">Back</span>
        </button>
        <div className="breadcrumb-path">
          {breadcrumbSegments.map((seg, i) => (
            <span key={seg.path}>
              {i > 0 && <span className="breadcrumb-separator"> / </span>}
              <span
                className={`breadcrumb-segment ${seg.path === currentPath ? 'current' : ''}`}
                onClick={() => seg.path !== currentPath && navigateTo(seg.path)}
              >
                {seg.name}
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="search-bar">
        <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          type="text"
          className="search-input"
          placeholder={useIndexSearch ? `Search ${indexCount.toLocaleString()} indexed files and folders...` : "Search current folder..."}
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); setSelectedIndex(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setSearchQuery('');
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {searchQuery && (
          <button className="search-clear" onClick={() => setSearchQuery('')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
        <button
          className={`toolbar-btn ${showPaths ? 'active' : ''}`}
          onClick={togglePaths}
          title={showPaths ? "Hide full paths" : "Show full paths"}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <button
          className={`toolbar-btn ${useIndexSearch ? 'active' : ''}`}
          onClick={() => setUseIndexSearch(!useIndexSearch)}
          title={useIndexSearch ? "Search all indexed files" : "Search current folder only"}
        >
          {useIndexSearch ? '~' : './'}
        </button>
        <button
          className="theme-toggle"
          onClick={() => changeTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}
          title={`Theme: ${theme}`}
        >
          {theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          ) : theme === 'light' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="5" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          )}
        </button>
        <button className="settings-button" onClick={() => setShowSettings(true)} title="Settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>

      {/* File List */}
      <div className="file-list">
        {loading && !useIndexSearch ? (
          <div className="file-list-loading">
            <div className="loading-spinner" />
          </div>
        ) : error && !useIndexSearch ? (
          <div className="file-list-error">
            <span className="error-icon">!</span>
            <span className="error-message">{error}</span>
          </div>
        ) : useIndexSearch && searchQuery ? (
          // Indexed search results
          (() => {
            if (indexedResults.length === 0) {
              return (
                <div className="file-list-empty">
                  {searchQuery.length < 2 ? 'Type at least 2 characters...' : 'No matches'}
                </div>
              );
            }

            const folders = indexedResults.filter(e => e.is_directory);
            const files = indexedResults.filter(e => !e.is_directory);
            let globalIndex = 0;

            return (
              <>
                {folders.length > 0 && (
                  <>
                    <div className="file-group-header">Folders ({folders.length})</div>
                    {folders.map((entry) => {
                      const idx = globalIndex++;
                      return (
                        <div
                          key={entry.path}
                          className={`file-item ${idx === selectedIndex ? 'selected' : ''} ${copiedPath === entry.path ? 'copied' : ''}`}
                          onClick={() => handleItemClick(entry)}
                          onDoubleClick={() => handleDoubleClick(entry)}
                          onContextMenu={(e) => handleContextMenu(e, entry)}
                        >
                          <div className="file-item-content">
                            <span className="file-icon">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="#fbbf24">
                                <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                              </svg>
                            </span>
                            <div className="file-info">
                              <span className="file-name">{entry.name}</span>
                              {showPaths && <span className="file-path">{entry.path.replace(/^\/Users\/[^/]+/, '~')}</span>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
                {files.length > 0 && (
                  <>
                    <div className="file-group-header">Files ({files.length})</div>
                    {files.map((entry) => {
                      const idx = globalIndex++;
                      return (
                        <div
                          key={entry.path}
                          className={`file-item ${idx === selectedIndex ? 'selected' : ''} ${copiedPath === entry.path ? 'copied' : ''}`}
                          onClick={() => handleItemClick(entry)}
                          onDoubleClick={() => handleDoubleClick(entry)}
                          onContextMenu={(e) => handleContextMenu(e, entry)}
                        >
                          <div className="file-item-content">
                            <span className="file-icon">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="#60a5fa">
                                <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z" />
                              </svg>
                            </span>
                            <div className="file-info">
                              <span className="file-name">{entry.name}</span>
                              {showPaths && <span className="file-path">{entry.path.replace(/^\/Users\/[^/]+/, '~')}</span>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </>
            );
          })()
        ) : filteredEntries.length === 0 ? (
          <div className="file-list-empty">
            {searchQuery ? 'No matches' : 'Empty folder'}
          </div>
        ) : (
          filteredEntries.map((entry, index) => (
            <div
              key={entry.path}
              className={`file-item ${index === selectedIndex ? 'selected' : ''} ${copiedPath === entry.path ? 'copied' : ''}`}
              onClick={() => handleItemClick(entry)}
              onDoubleClick={() => handleDoubleClick(entry)}
              onContextMenu={(e) => handleContextMenu(e, entry)}
            >
              <div className="file-item-content">
                <span className="file-icon">
                  {entry.is_directory ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="#fbbf24">
                      <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="#60a5fa">
                      <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z" />
                    </svg>
                  )}
                </span>
                <div className="file-info">
                  <span className="file-name">{entry.name}</span>
                  {showPaths && <span className="file-path">{entry.path.replace(/^\/Users\/[^/]+/, '~')}</span>}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            onClick={() => { handleCopy(contextMenu.entry); setContextMenu(null); }}
          >
            Copy Path
          </div>
          {contextMenu.entry.is_directory && (
            <div
              className="context-menu-item"
              onClick={() => { openInNewTab(contextMenu.entry.path); setContextMenu(null); }}
            >
              Open in New Tab
            </div>
          )}
        </div>
      )}

      {/* Settings Panel */}
      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <h2>Settings</h2>
              <button className="settings-close" onClick={() => setShowSettings(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="settings-content">
              <div className="settings-section">
                <label className="settings-label">Theme</label>
                <div className="theme-selector">
                  <button
                    className={`theme-option ${theme === 'light' ? 'active' : ''}`}
                    onClick={() => changeTheme('light')}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="5" />
                      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                    </svg>
                    Light
                  </button>
                  <button
                    className={`theme-option ${theme === 'dark' ? 'active' : ''}`}
                    onClick={() => changeTheme('dark')}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                    </svg>
                    Dark
                  </button>
                  <button
                    className={`theme-option ${theme === 'system' ? 'active' : ''}`}
                    onClick={() => changeTheme('system')}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <path d="M8 21h8M12 17v4" />
                    </svg>
                    System
                  </button>
                </div>
              </div>

              <div className="settings-section">
                <label className="settings-label">File Index</label>
                <div className="index-status">
                  {isIndexing ? (
                    <>
                      <div className="index-progress">
                        <div className="index-progress-bar">
                          <div
                            className="index-progress-fill"
                            style={{
                              width: `${indexProgress ? Math.round((indexProgress.indexed_folders / Math.max(indexProgress.total_folders, 1)) * 100) : 0}%`
                            }}
                          />
                        </div>
                        <span className="index-progress-text">
                          {indexProgress ? `${Math.round((indexProgress.indexed_folders / Math.max(indexProgress.total_folders, 1)) * 100)}%` : '0%'}
                        </span>
                      </div>
                      <div className="index-stats">
                        <span>{indexProgress?.total_files.toLocaleString() || 0} files indexed</span>
                      </div>
                      <div className="index-current">
                        Scanning: {indexProgress?.current_folder.split('/').slice(-2).join('/') || '...'}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="index-complete">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2">
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                        <span>{indexCount.toLocaleString()} files indexed</span>
                      </div>
                      <button className="settings-button" onClick={startIndexing}>
                        Re-index Home Folder
                      </button>
                    </>
                  )}
                </div>
                <span className="settings-hint">
                  Indexes all files in ~ (excluding node_modules, .git, etc.) for instant search.
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
