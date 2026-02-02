import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
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

interface TabContextMenu {
  x: number;
  y: number;
  tab: Tab;
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
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenu | null>(null);
  const [appZoom, setAppZoom] = useState(1);
  const expandedSizeRef = useRef({ width: 700, height: 600 });
  const pinnedPathsRef = useRef<Record<string, string>>({});
  const cardsRef = useRef<HTMLDivElement>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const indexSearchRequestIdRef = useRef(0);

  // Load saved window size on mount
  useEffect(() => {
    const savedSize = localStorage.getItem('spyglass-window-size');
    if (savedSize) {
      try {
        const { width, height } = JSON.parse(savedSize);
        expandedSizeRef.current = { width, height };
        // Apply saved size to window
        const win = getCurrentWindow();
        win.setSize(new LogicalSize(width, height));
      } catch (e) {
        console.error('Failed to restore window size:', e);
      }
    }
  }, []);

  // Save window size when resized (not in pin mode)
  useEffect(() => {
    if (focusMode) return;

    let resizeTimeout: ReturnType<typeof setTimeout>;
    const handleResize = async () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(async () => {
        try {
          const win = getCurrentWindow();
          const size = await win.innerSize();
          expandedSizeRef.current = { width: size.width, height: size.height };
          localStorage.setItem('spyglass-window-size', JSON.stringify({ width: size.width, height: size.height }));
        } catch (e) {
          console.error('Failed to save window size:', e);
        }
      }, 500);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimeout);
    };
  }, [focusMode]);

  const activeTab = tabs.find(t => t.id === activeTabId);
  const currentPath = activeTab?.path || '';

  // Memoize Fuse instance
  const fuse = useMemo(() => {
    return new Fuse(entries, { keys: ['name'], threshold: 0.4 });
  }, [entries]);

  // Memoize filtered entries (skip local search when using the full index)
  const filteredEntries = useMemo(() => {
    if (!searchQuery || (useIndexSearch && searchQuery)) return entries;
    return fuse.search(searchQuery).map(r => r.item);
  }, [entries, fuse, searchQuery, useIndexSearch]);

  const indexedGroups = useMemo(() => {
    if (!useIndexSearch || !searchQuery) {
      return { folders: [] as IndexEntry[], files: [] as IndexEntry[], ordered: [] as IndexEntry[] };
    }
    const folders = indexedResults.filter(e => e.is_directory);
    const files = indexedResults.filter(e => !e.is_directory);
    return { folders, files, ordered: [...folders, ...files] };
  }, [indexedResults, searchQuery, useIndexSearch]);

  const visibleEntries = useMemo(() => {
    if (useIndexSearch && searchQuery) return indexedGroups.ordered;
    return filteredEntries;
  }, [filteredEntries, indexedGroups.ordered, searchQuery, useIndexSearch]);

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

  const collapseToCards = useCallback(async () => {
    const win = getCurrentWindow();
    const currentSize = await win.innerSize();

    // Wait for DOM to update, then measure and resize
    requestAnimationFrame(() => {
      requestAnimationFrame(async () => {
        if (cardsRef.current) {
          const cardsHeight = cardsRef.current.getBoundingClientRect().height;
          const newHeight = Math.max(80, Math.ceil(cardsHeight) + 28);
          await win.setSize(new LogicalSize(currentSize.width, newHeight));
        }
      });
    });
  }, []);

  const expandToFull = useCallback(async () => {
    const win = getCurrentWindow();
    await win.setSize(new LogicalSize(expandedSizeRef.current.width, expandedSizeRef.current.height));
  }, []);

  const toggleFocusMode = useCallback(async () => {
    const win = getCurrentWindow();

    if (focusMode) {
      // Exiting focus mode - restore expanded size
      setIsCollapsed(false);
      setFocusMode(false);
      pinnedPathsRef.current = {};
      await expandToFull();
    } else {
      // Entering focus mode - save current size first
      const currentSize = await win.innerSize();
      expandedSizeRef.current = { width: currentSize.width, height: currentSize.height };
      localStorage.setItem('spyglass-window-size', JSON.stringify({ width: currentSize.width, height: currentSize.height }));

      // Pin current paths
      const pinned: Record<string, string> = {};
      tabs.forEach(tab => {
        pinned[tab.id] = tab.path;
      });
      pinnedPathsRef.current = pinned;

      // Set state and collapse
      setFocusMode(true);
      setIsCollapsed(true);
      await collapseToCards();
    }
  }, [focusMode, tabs, collapseToCards, expandToFull]);

  // Open path in new window
  const openInNewWindow = useCallback(async (path: string) => {
    const windowId = `spyglass-${generateId()}`;
    const name = path.split('/').pop() || 'Spyglass';
    // Store path for new window to pick up
    localStorage.setItem(`spyglass-new-window-${windowId}`, path);
    try {
      const webview = new WebviewWindow(windowId, {
        url: `${window.location.origin}?windowId=${windowId}`,
        title: `Spyglass - ${name}`,
        width: 700,
        height: 600,
        center: true,
      });
      webview.once('tauri://error', (e: unknown) => {
        console.error('Failed to create window:', e);
      });
    } catch (e) {
      console.error('Failed to open new window:', e);
    }
  }, []);

  const scheduleCopyReset = useCallback((delayMs: number) => {
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = window.setTimeout(() => {
      setCopiedPath(null);
      copyTimeoutRef.current = null;
    }, delayMs);
  }, []);


  // Handle copy
  const handleCopy = useCallback(async (entry: FileEntry) => {
    try {
      await writeText(entry.path);
      setCopiedPath(entry.path);
      scheduleCopyReset(200);
    } catch (e) {
      console.error('Copy failed:', e);
    }
  }, [scheduleCopyReset]);

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
  const switchTab = useCallback(async (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (tab) {
      if (focusMode && isCollapsed) {
        setIsCollapsed(false);
        await expandToFull();
        // Load from pinned path in focus mode
        const pinnedPath = pinnedPathsRef.current[tabId] || tab.path;
        setActiveTabId(tabId);
        loadDirectory(pinnedPath);
      } else {
        setActiveTabId(tabId);
        loadDirectory(tab.path);
        saveState(tabs, tabId);
      }
    }
  }, [tabs, loadDirectory, saveState, focusMode, isCollapsed, expandToFull]);

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
    const requestId = ++indexSearchRequestIdRef.current;
    try {
      const results = await invoke<IndexEntry[]>('search_index', { query });
      if (requestId !== indexSearchRequestIdRef.current) return;
      setIndexedResults(results);
    } catch (e) {
      if (requestId !== indexSearchRequestIdRef.current) return;
      console.error('Search failed:', e);
    }
  }, []);

  // Debounced index search
  useEffect(() => {
    if (!useIndexSearch || !searchQuery) {
      indexSearchRequestIdRef.current += 1;
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

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setSelectedIndex((current) => {
      if (visibleEntries.length === 0) return 0;
      return Math.min(current, visibleEntries.length - 1);
    });
  }, [visibleEntries.length]);

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
        // Check for windowId in URL (for new windows)
        const urlParams = new URLSearchParams(window.location.search);
        const windowId = urlParams.get('windowId');

        if (windowId && mounted) {
          // New window - get path from localStorage
          const storedPath = localStorage.getItem(`spyglass-new-window-${windowId}`);
          localStorage.removeItem(`spyglass-new-window-${windowId}`); // Clean up

          if (storedPath) {
            const name = storedPath.split('/').pop() || '~';
            const initialTab: Tab = {
              id: generateId(),
              path: storedPath,
              name,
              color: TAB_COLORS[0],
            };
            setTabs([initialTab]);
            setActiveTabId(initialTab.id);
            await loadDirectory(storedPath);
            return;
          }
        }

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard handler
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (contextMenu) {
      if (e.key === 'Escape') setContextMenu(null);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, Math.max(visibleEntries.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      const selected = visibleEntries[selectedIndex];
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
    } else if ((e.key === '=' || e.key === '+') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setAppZoom(z => Math.min(1.5, z + 0.1));
    } else if (e.key === '-' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setAppZoom(z => Math.max(0.7, z - 0.1));
    } else if (e.key === '0' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setAppZoom(1);
    }
  }, [
    contextMenu,
    visibleEntries,
    selectedIndex,
    navigateTo,
    handleCopy,
    navigateBack,
    currentPath,
    openInNewTab,
    activeTabId,
    closeTab,
    toggleFocusMode,
  ]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Close context menus on click outside
  useEffect(() => {
    function onClick() {
      setContextMenu(null);
      setTabContextMenu(null);
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
    if (!focusMode) {
      setContextMenu({ x: e.clientX, y: e.clientY, entry });
    }
  }, [focusMode]);

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
    <div
      className={`app ${focusMode ? 'focus-mode' : ''} ${focusMode && isCollapsed ? 'collapsed' : ''}`}
      style={{ fontSize: `${appZoom * 13}px` }}
      onClick={() => { setContextMenu(null); setTabContextMenu(null); }}
      onMouseLeave={async () => {
        if (focusMode && !isCollapsed) {
          // Reset to pinned path before collapsing
          const pinnedPath = pinnedPathsRef.current[activeTabId];
          if (pinnedPath && pinnedPath !== currentPath) {
            const name = pinnedPath.split('/').pop() || '~';
            const newTabs = tabs.map(t =>
              t.id === activeTabId ? { ...t, path: pinnedPath, name } : t
            );
            setTabs(newTabs);
            loadDirectory(pinnedPath);
          }
          setIsCollapsed(true);
          await collapseToCards();
        }
      }}
    >
      {/* Pinned Cards */}
      <div
        className="pinned-cards"
        ref={cardsRef}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          e.preventDefault();
          const fromId = e.dataTransfer.getData('text/plain');
          if (fromId) {
            const draggedIdx = tabs.findIndex(t => t.id === fromId);
            if (draggedIdx !== -1 && draggedIdx !== tabs.length - 1) {
              const newTabs = [...tabs];
              const [moved] = newTabs.splice(draggedIdx, 1);
              newTabs.push(moved);
              setTabs(newTabs);
              saveState(newTabs, activeTabId);
            }
            setDraggedTabId(null);
          }
        }}
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`card ${tab.id === activeTabId ? 'active' : ''} ${draggedTabId === tab.id ? 'dragging' : ''} ${draggedTabId && draggedTabId !== tab.id ? 'drop-target' : ''}`}
            style={{ borderColor: tab.color }}
            title={tab.path}
            onClick={() => switchTab(tab.id)}
            draggable
            onDragStart={(e) => {
              setDraggedTabId(tab.id);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', tab.id);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDragEnd={() => setDraggedTabId(null)}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const fromId = e.dataTransfer.getData('text/plain');
              if (fromId && fromId !== tab.id) {
                reorderTabs(fromId, tab.id);
              }
              setDraggedTabId(null);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!focusMode) {
                setTabContextMenu({ x: e.clientX, y: e.clientY, tab });
              }
            }}
          >
            <svg className="card-icon" viewBox="0 0 24 24" fill={tab.color}>
              <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
            </svg>
            <span className="card-name">{tab.name}</span>
            {tabs.length > 1 && (
              <button
                className="card-close"
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button className="card-add" onClick={() => currentPath && openInNewTab(currentPath)} title="Pin current folder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button
          className={`focus-toggle ${focusMode ? 'active' : ''}`}
          onClick={toggleFocusMode}
          title={focusMode ? "Exit focus mode (⌘⇧F)" : "Focus mode (⌘⇧F)"}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {focusMode ? (
              <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
            ) : (
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
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
          placeholder={useIndexSearch ? `Search ${indexCount.toLocaleString()} files...` : "Search folder..."}
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
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
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

            const folders = indexedGroups.folders;
            const files = indexedGroups.files;
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
            <>
              <div
                className="context-menu-item"
                onClick={() => { openInNewTab(contextMenu.entry.path); setContextMenu(null); }}
              >
                Open in New Tab
              </div>
              <div
                className="context-menu-item"
                onClick={() => { openInNewWindow(contextMenu.entry.path); setContextMenu(null); }}
              >
                Open in New Window
              </div>
            </>
          )}
        </div>
      )}

      {/* Tab Context Menu */}
      {tabContextMenu && (
        <div
          className="context-menu tab-context-menu"
          style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="context-menu-item"
            onClick={async () => {
              await writeText(tabContextMenu.tab.path);
              setCopiedPath(tabContextMenu.tab.path);
              scheduleCopyReset(400);
              setTabContextMenu(null);
            }}
          >
            Copy Path
          </div>
          <div
            className="context-menu-item"
            onClick={() => { openInNewWindow(tabContextMenu.tab.path); setTabContextMenu(null); }}
          >
            Open in New Window
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-colors">
            {TAB_COLORS.map(color => (
              <div
                key={color}
                className={`color-swatch ${tabContextMenu.tab.color === color ? 'active' : ''}`}
                style={{ backgroundColor: color }}
                onClick={() => {
                  changeTabColor(tabContextMenu.tab.id, color);
                  setTabContextMenu(null);
                }}
              />
            ))}
          </div>
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
                <label className="settings-label">Display</label>
                <div className="settings-toggles">
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={showPaths}
                      onChange={() => togglePaths()}
                    />
                    <span>Show full file paths</span>
                  </label>
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={useIndexSearch}
                      onChange={() => setUseIndexSearch(!useIndexSearch)}
                    />
                    <span>Search all indexed files (not just current folder)</span>
                  </label>
                </div>
                <div className="settings-zoom">
                  <span className="settings-zoom-label">Zoom: {Math.round(appZoom * 100)}%</span>
                  <div className="settings-zoom-controls">
                    <button onClick={() => setAppZoom(z => Math.max(0.7, z - 0.1))}>−</button>
                    <button onClick={() => setAppZoom(1)}>Reset</button>
                    <button onClick={() => setAppZoom(z => Math.min(1.5, z + 0.1))}>+</button>
                  </div>
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
