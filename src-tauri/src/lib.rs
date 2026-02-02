use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{Manager, State};

// Index state
#[derive(Default)]
pub struct IndexState {
    pub entries: Mutex<Vec<IndexEntry>>,
    pub lower_names: Mutex<Vec<String>>,
    pub progress: Mutex<IndexProgress>,
    pub is_indexing: Mutex<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndexEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub parent_folder: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct IndexProgress {
    pub total_folders: usize,
    pub indexed_folders: usize,
    pub total_files: usize,
    pub current_folder: String,
    pub is_complete: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tab {
    pub id: String,
    pub path: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Config {
    pub root_folder: Option<String>,
    pub global_hotkey: Option<String>,
    pub remember_location: bool,
    pub last_location: Option<String>,
    #[serde(default)]
    pub tabs: Option<Vec<Tab>>,
    #[serde(default)]
    pub active_tab_id: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            root_folder: dirs::home_dir().map(|p| p.to_string_lossy().to_string()),
            global_hotkey: None,
            remember_location: true,
            last_location: None,
            tabs: None,
            active_tab_id: None,
        }
    }
}

fn get_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("spyglass")
}

fn get_config_path() -> PathBuf {
    get_config_dir().join("config.json")
}

#[tauri::command]
fn read_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let path = PathBuf::from(&path);

    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }

    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", path.display()));
    }

    let mut entries: Vec<FileEntry> = Vec::new();

    match fs::read_dir(&path) {
        Ok(read_dir) => {
            for entry in read_dir.flatten() {
                let file_name = entry.file_name().to_string_lossy().to_string();

                // Skip hidden files (starting with .)
                if file_name.starts_with('.') {
                    continue;
                }

                let file_path = entry.path();
                let is_dir = file_path.is_dir();

                entries.push(FileEntry {
                    name: file_name,
                    path: file_path.to_string_lossy().to_string(),
                    is_directory: is_dir,
                });
            }
        }
        Err(e) => return Err(format!("Failed to read directory: {}", e)),
    }

    // Sort: folders first, then files, both alphabetically
    entries.sort_by(|a, b| {
        match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

#[tauri::command]
fn get_parent_path(path: String) -> Option<String> {
    PathBuf::from(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn get_relative_path(full_path: String, base_path: String) -> String {
    let full = PathBuf::from(&full_path);
    let base = PathBuf::from(&base_path);

    full.strip_prefix(&base)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(full_path)
}

#[tauri::command]
fn load_config() -> Config {
    let config_path = get_config_path();

    if config_path.exists() {
        match fs::read_to_string(&config_path) {
            Ok(content) => {
                serde_json::from_str(&content).unwrap_or_default()
            }
            Err(_) => Config::default(),
        }
    } else {
        Config::default()
    }
}

#[tauri::command]
fn save_config(config: Config) -> Result<(), String> {
    let config_dir = get_config_dir();
    let config_path = get_config_path();

    // Create config directory if it doesn't exist
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(())
}

#[tauri::command]
fn get_home_dir() -> Option<String> {
    dirs::home_dir().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    PathBuf::from(&path).exists()
}

#[tauri::command]
async fn toggle_window_visibility(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn get_index_path() -> PathBuf {
    get_config_dir().join("index.json")
}

fn index_directory(
    path: &PathBuf,
    entries: &mut Vec<IndexEntry>,
    lower_names: &mut Vec<String>,
    progress: &Arc<Mutex<IndexProgress>>,
    skip_hidden: bool,
) {
    let dir_entries = match fs::read_dir(path) {
        Ok(e) => e,
        Err(_) => return,
    };

    let parent_folder = path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "~".to_string());

    // Update current folder in progress
    if let Ok(mut prog) = progress.lock() {
        prog.current_folder = path.to_string_lossy().to_string();
    }

    let mut subdirs = Vec::new();

    for entry in dir_entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/folders
        if skip_hidden && name.starts_with('.') {
            continue;
        }

        let file_path = entry.path();
        let is_dir = file_path.is_dir();
        let name_lower = name.to_lowercase();

        entries.push(IndexEntry {
            name: name.clone(),
            path: file_path.to_string_lossy().to_string(),
            is_directory: is_dir,
            parent_folder: parent_folder.clone(),
        });
        lower_names.push(name_lower);

        // Update total files count less frequently (every 100 files)
        if entries.len() % 100 == 0 {
            if let Ok(mut prog) = progress.lock() {
                prog.total_files = entries.len();
            }
        }

        if is_dir {
            // Skip common large/unneeded directories
            if !["node_modules", "target", ".git", "dist", "build", ".next", "vendor", "__pycache__", ".venv", "venv", ".cargo", "Library", ".Trash", "Applications"].contains(&name.as_str()) {
                if let Ok(mut prog) = progress.lock() {
                    prog.total_folders += 1;
                }
                subdirs.push(file_path);
            }
        }
    }

    // Update indexed folders count
    if let Ok(mut prog) = progress.lock() {
        prog.indexed_folders += 1;
        prog.total_files = entries.len();
    }

    // Recursively index subdirectories
    for subdir in subdirs {
        index_directory(&subdir, entries, lower_names, progress, skip_hidden);
    }
}

#[tauri::command]
fn start_indexing(app: tauri::AppHandle) -> Result<(), String> {
    let state: State<'_, IndexState> = app.state();

    // Check if already indexing
    {
        let is_indexing = state.is_indexing.lock().map_err(|e| e.to_string())?;
        if *is_indexing {
            return Ok(());
        }
    }

    // Set indexing flag
    {
        let mut is_indexing = state.is_indexing.lock().map_err(|e| e.to_string())?;
        *is_indexing = true;
    }

    // Get home directory
    let home_dir = dirs::home_dir().ok_or("Could not find home directory")?;

    // Initialize with the root folder, then increment as subfolders are discovered.
    let total_folders = 1usize;
    {
        let mut progress = state.progress.lock().map_err(|e| e.to_string())?;
        progress.total_folders = total_folders.max(1);
    }

    let app_handle = app.clone();

    thread::spawn(move || {
        let state: State<'_, IndexState> = app_handle.state();
        let mut new_entries = Vec::new();
        let mut new_lower_names = Vec::new();

        // Use the state's progress directly wrapped in Arc for the indexing function
        let progress_arc = Arc::new(Mutex::new(IndexProgress {
            total_folders,
            indexed_folders: 0,
            total_files: 0,
            current_folder: String::new(),
            is_complete: false,
        }));

        // Spawn a thread to sync progress to state
        let progress_for_sync = Arc::clone(&progress_arc);
        let app_for_sync = app_handle.clone();
        let sync_handle = thread::spawn(move || {
            loop {
                thread::sleep(std::time::Duration::from_millis(200));
                let sync_state: State<'_, IndexState> = app_for_sync.state();

                let is_done = {
                    if let Ok(prog) = progress_for_sync.lock() {
                        if let Ok(mut state_prog) = sync_state.progress.lock() {
                            *state_prog = prog.clone();
                        }
                        prog.is_complete
                    } else {
                        false
                    }
                };

                if is_done {
                    break;
                }
            }
        });

        index_directory(&home_dir, &mut new_entries, &mut new_lower_names, &progress_arc, true);

        let total_files = new_entries.len();

        // Mark complete
        if let Ok(mut prog) = progress_arc.lock() {
            prog.is_complete = true;
            prog.total_files = total_files;
        }

        // Wait for sync thread to finish
        let _ = sync_handle.join();

        // Update the state with results
        if let Ok(mut entries) = state.entries.lock() {
            *entries = new_entries;
        }

        if let Ok(mut lower_names) = state.lower_names.lock() {
            *lower_names = new_lower_names;
        }

        if let Ok(mut progress) = state.progress.lock() {
            progress.is_complete = true;
            progress.total_files = total_files;
        }

        if let Ok(mut is_indexing) = state.is_indexing.lock() {
            *is_indexing = false;
        }

        // Save index to disk
        let index_path = get_index_path();
        if let Ok(entries) = state.entries.lock() {
            if let Ok(content) = serde_json::to_string(&*entries) {
                let _ = fs::create_dir_all(get_config_dir());
                let _ = fs::write(index_path, content);
            }
        };
    });

    Ok(())
}

#[tauri::command]
fn get_index_progress(state: State<'_, IndexState>) -> IndexProgress {
    state.progress.lock()
        .map(|p| p.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn search_index(state: State<'_, IndexState>, query: String) -> Vec<IndexEntry> {
    let entries = match state.entries.lock() {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let lower_names = match state.lower_names.lock() {
        Ok(n) => n,
        Err(_) => return Vec::new(),
    };

    if query.is_empty() {
        return Vec::new();
    }

    let query_lower = query.to_lowercase();
    let query_dash = format!("-{}", query_lower);
    let query_underscore = format!("_{}", query_lower);
    let use_lower = lower_names.len() == entries.len();

    // Collect matching entries with a score
    let mut scored: Vec<(i32, &IndexEntry)> = Vec::new();
    if use_lower {
        for (idx, e) in entries.iter().enumerate() {
            let name_lower = &lower_names[idx];
            if !name_lower.contains(&query_lower) {
                continue;
            }
            let mut score = 0;

            // Exact match gets highest score
            if name_lower == &query_lower {
                score += 1000;
            }
            // Starts with query gets high score
            else if name_lower.starts_with(&query_lower) {
                score += 500;
            }
            // Query at word boundary (after - or _)
            else if name_lower.contains(&query_dash)
                 || name_lower.contains(&query_underscore) {
                score += 300;
            }

            // Directories get bonus
            if e.is_directory {
                score += 200;
            }

            // Shorter names rank higher (more relevant)
            score += 50 - (e.name.len() as i32).min(50);

            // Files in projects folder get bonus
            if e.path.contains("/projects/") {
                score += 100;
            }

            scored.push((score, e));
        }
    } else {
        for e in entries.iter() {
            let name_lower = e.name.to_lowercase();
            if !name_lower.contains(&query_lower) {
                continue;
            }
            let mut score = 0;

            if name_lower == query_lower {
                score += 1000;
            } else if name_lower.starts_with(&query_lower) {
                score += 500;
            } else if name_lower.contains(&query_dash)
                || name_lower.contains(&query_underscore)
            {
                score += 300;
            }

            if e.is_directory {
                score += 200;
            }

            score += 50 - (e.name.len() as i32).min(50);

            if e.path.contains("/projects/") {
                score += 100;
            }

            scored.push((score, e));
        }
    }

    // Sort by score descending
    scored.sort_by(|a, b| b.0.cmp(&a.0));

    // Return top 100
    scored.into_iter()
        .take(100)
        .map(|(_, e)| e.clone())
        .collect()
}

#[tauri::command]
fn load_saved_index(state: State<'_, IndexState>) -> bool {
    let index_path = get_index_path();

    if !index_path.exists() {
        return false;
    }

    match fs::read_to_string(&index_path) {
        Ok(content) => {
            match serde_json::from_str::<Vec<IndexEntry>>(&content) {
                Ok(entries) => {
                    let lower_names = entries.iter().map(|e| e.name.to_lowercase()).collect::<Vec<_>>();
                    if let Ok(mut state_entries) = state.entries.lock() {
                        let count = entries.len();
                        *state_entries = entries;
                        if let Ok(mut state_lower_names) = state.lower_names.lock() {
                            *state_lower_names = lower_names;
                        }

                        // Update progress to show loaded state
                        if let Ok(mut progress) = state.progress.lock() {
                            progress.total_files = count;
                            progress.is_complete = true;
                        }
                        return true;
                    }
                }
                Err(_) => {}
            }
        }
        Err(_) => {}
    }
    false
}

#[tauri::command]
fn get_index_count(state: State<'_, IndexState>) -> usize {
    state.entries.lock()
        .map(|e| e.len())
        .unwrap_or(0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(IndexState::default())
        .invoke_handler(tauri::generate_handler![
            read_directory,
            get_parent_path,
            get_relative_path,
            load_config,
            save_config,
            get_home_dir,
            path_exists,
            toggle_window_visibility,
            start_indexing,
            get_index_progress,
            search_index,
            load_saved_index,
            get_index_count,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
