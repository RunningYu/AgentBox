use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg(target_os = "macos")]
use core_foundation::{
    base::TCFType, boolean::CFBoolean, dictionary::CFDictionary, string::CFString,
};
#[cfg(target_os = "macos")]
use core_graphics::event::{CGEvent, CGEventFlags, KeyCode};
#[cfg(target_os = "macos")]
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

#[cfg(target_os = "macos")]
use objc2::runtime::NSObjectProtocol;
#[cfg(target_os = "macos")]
use objc2::{define_class, ClassType, MainThreadMarker};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSApplicationActivationOptions, NSEvent, NSPanel, NSRunningApplication, NSScreen,
    NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask, NSWorkspace,
};
#[cfg(target_os = "macos")]
use objc2_foundation::NSPoint;

#[cfg(target_os = "macos")]
struct QuickPalettePanelIvars;

#[derive(Default)]
struct PluginDragState {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[cfg(target_os = "macos")]
define_class!(
    #[unsafe(super = NSPanel)]
    #[name = "AgentBoxQuickPalettePanel"]
    #[ivars = QuickPalettePanelIvars]
    struct RawQuickPalettePanel;

    unsafe impl NSObjectProtocol for RawQuickPalettePanel {}

    impl RawQuickPalettePanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool { true }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main_window(&self) -> bool { false }

        #[unsafe(method(isFloatingPanel))]
        fn is_floating_panel(&self) -> bool { true }

        #[unsafe(method(hidesOnDeactivate))]
        fn hides_on_deactivate(&self) -> bool { false }
    }
);

#[cfg(target_os = "macos")]
unsafe fn convert_to_quick_palette_panel(window: &tauri::WebviewWindow) -> bool {
    let Ok(pointer) = window.ns_window() else {
        return false;
    };
    unsafe extern "C" {
        fn object_getClass(obj: *mut objc2_foundation::NSObject)
            -> *const objc2::runtime::AnyClass;
        fn object_setClass(
            obj: *mut objc2_foundation::NSObject,
            cls: *const objc2::runtime::AnyClass,
        ) -> *const objc2::runtime::AnyClass;
    }
    let object = pointer as *mut objc2_foundation::NSObject;
    let current = object_getClass(object);
    if current == RawQuickPalettePanel::class() {
        return true;
    }
    object_setClass(object, RawQuickPalettePanel::class());
    true
}

mod session_store;

use session_store::WorkspaceArchive;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
    fn AXUIElementCreateApplication(pid: libc::pid_t) -> *const std::ffi::c_void;
    fn AXUIElementCopyAttributeValue(
        element: *const std::ffi::c_void,
        attribute: *const std::ffi::c_void,
        value: *mut *const std::ffi::c_void,
    ) -> i32;
    fn AXUIElementSetAttributeValue(
        element: *const std::ffi::c_void,
        attribute: *const std::ffi::c_void,
        value: *const std::ffi::c_void,
    ) -> i32;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRetain(value: *const std::ffi::c_void) -> *const std::ffi::c_void;
    fn CFRelease(value: *const std::ffi::c_void);
}

struct PtyRuntime {
    generation: String,
    master: Box<dyn MasterPty + Send>,
    input_tx: mpsc::Sender<Vec<u8>>,
    child: Box<dyn Child + Send + Sync>,
    output: PendingOutput,
    running: bool,
    error: Option<String>,
}

const MAX_PENDING_OUTPUT: usize = 262_144;

struct PendingOutput {
    bytes: VecDeque<u8>,
    limit: usize,
}

impl PendingOutput {
    fn new() -> Self {
        Self::with_limit(MAX_PENDING_OUTPUT)
    }

    fn with_limit(limit: usize) -> Self {
        Self {
            bytes: VecDeque::new(),
            limit,
        }
    }

    fn push(&mut self, data: &[u8]) {
        self.bytes.extend(data);
        while self.bytes.len() > self.limit {
            self.bytes.pop_front();
        }
    }

    fn drain(&mut self) -> String {
        let bytes: Vec<u8> = self.bytes.drain(..).collect();
        String::from_utf8_lossy(&bytes).to_string()
    }
}

#[derive(Default)]
struct PtyState {
    sessions: Mutex<HashMap<String, PtyRuntime>>,
}

#[cfg(target_os = "macos")]
struct SpeechRuntime {
    recording_id: String,
    child: std::process::Child,
    stdin: ChildStdin,
}

struct SpeechState {
    #[cfg(target_os = "macos")]
    recording: Arc<Mutex<Option<SpeechRuntime>>>,
    completed: Arc<Mutex<HashMap<String, SpeechEvent>>>,
}

impl Default for SpeechState {
    fn default() -> Self {
        Self {
            #[cfg(target_os = "macos")]
            recording: Arc::new(Mutex::new(None)),
            completed: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Clone, Serialize)]
struct SpeechEvent {
    kind: String,
    message: Option<String>,
    #[serde(rename = "recordingId")]
    recording_id: String,
    #[serde(rename = "isFinal")]
    is_final: Option<bool>,
    text: Option<String>,
}

fn is_expected_speech_stop_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::BrokenPipe
}

fn speech_helper_exit_message(saw_terminal_event: bool, stderr: &str) -> Option<String> {
    if saw_terminal_event {
        return None;
    }
    let detail = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(str::trim)
        .unwrap_or("");
    Some(if detail.is_empty() {
        "语音组件意外退出，未返回录音或转写结果".to_string()
    } else {
        format!("语音组件意外退出：{detail}")
    })
}

#[cfg(target_os = "macos")]
#[derive(Deserialize)]
struct SpeechHelperEvent {
    kind: String,
    message: Option<String>,
    #[serde(rename = "isFinal")]
    is_final: Option<bool>,
    text: Option<String>,
}

const DEFAULT_GLOBAL_SHORTCUT: &str = "Control+Option+Space";

#[derive(Default)]
struct MainWindowCloseRequestState(AtomicBool);

#[cfg(target_os = "macos")]
struct RetainedAxElement(NonNull<std::ffi::c_void>);

#[cfg(target_os = "macos")]
unsafe impl Send for RetainedAxElement {}
#[cfg(target_os = "macos")]
unsafe impl Sync for RetainedAxElement {}

#[cfg(target_os = "macos")]
impl RetainedAxElement {
    unsafe fn from_owned(value: *const std::ffi::c_void) -> Option<Self> {
        NonNull::new(value as *mut std::ffi::c_void).map(Self)
    }

    fn as_ptr(&self) -> *const std::ffi::c_void {
        self.0.as_ptr()
    }
}

#[cfg(target_os = "macos")]
impl Clone for RetainedAxElement {
    fn clone(&self) -> Self {
        unsafe { CFRetain(self.as_ptr()) };
        Self(self.0)
    }
}

#[cfg(target_os = "macos")]
impl Drop for RetainedAxElement {
    fn drop(&mut self) {
        unsafe { CFRelease(self.as_ptr()) };
    }
}

#[derive(Clone)]
struct PreviousApp {
    bundle_id: String,
    pid: libc::pid_t,
    #[cfg(target_os = "macos")]
    focused_element: Option<RetainedAxElement>,
    #[cfg(target_os = "macos")]
    focused_description: Option<String>,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
struct QuickPaletteInsertEvent {
    text: String,
    append_enter: bool,
}

#[derive(Default)]
struct PaletteState {
    previous_app: Mutex<Option<PreviousApp>>,
    shortcut: Mutex<String>,
}

#[derive(Clone, Default)]
struct StorageGate(Arc<Mutex<()>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyOutputEvent {
    session_id: String,
    generation: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitEvent {
    session_id: String,
    generation: String,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyStreamEvent {
    kind: String,
    session_id: String,
    generation: String,
    data: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyPollResult {
    data: String,
    running: bool,
    error: Option<String>,
}

#[derive(Debug, PartialEq)]
struct LaunchSpec {
    program: String,
    args: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CommandResult {
    status: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentNode {
    name: String,
    path: String,
    kind: String,
    extension: Option<String>,
    children: Option<Vec<DocumentNode>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentFileContent {
    path: String,
    name: String,
    extension: String,
    content: String,
    size: u64,
    binary: Option<Vec<u8>>,
    preview_kind: String,
    rendered_html: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentChangedFile {
    path: String,
    absolute_path: String,
    name: String,
    extension: String,
    created_ms: u64,
    modified_ms: u64,
    size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolboxImportFile {
    path: String,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentCenterImportFile {
    path: String,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitChangedFile {
    path: String,
    status: String,
    summary: String,
    modified_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitRootInfo {
    root: String,
    name: String,
    branch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusSummary {
    root: String,
    branch: String,
    files: Vec<GitChangedFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffResult {
    path: String,
    diff: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSkillItem {
    agent: String,
    name: String,
    command: String,
    source: String,
    description: String,
    path: String,
}

const DOCUMENT_MAX_DEPTH: usize = 48;
const DOCUMENT_MAX_FILES: usize = 50_000;
const DOCUMENT_MAX_FILE_SIZE: u64 = 20 * 1_048_576;
const CHANGE_TRACKER_MAX_FILES: usize = 30_000;
const CHANGE_TRACKER_MAX_DEPTH: usize = 32;
const TOOLBOX_IMPORT_MAX_FILE_SIZE: u64 = 1_048_576;
const AGENT_CENTER_IMPORT_MAX_FILE_SIZE: u64 = 1_048_576;
const SKILL_META_READ_LIMIT: usize = 16_384;

#[tauri::command]
fn read_promptpad_file(name: String) -> Result<String, String> {
    let path = agentbox_file(&name)?;
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(path).map_err(|err| err.to_string())
}

#[tauri::command]
fn write_promptpad_file(name: String, content: String) -> Result<(), String> {
    let path = agentbox_file(&name)?;
    let dir = path
        .parent()
        .ok_or_else(|| "无法解析 ~/.agentbox 目录".to_string())?;
    fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    atomic_write(path, content.as_bytes()).map_err(|err| err.to_string())
}

fn promptpad_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let current = home.join(storage_directory_name());
    let legacy = home.join(".promptpad");
    migrate_storage_directory(&legacy, &current)?;
    Ok(current)
}

fn storage_directory_name() -> &'static str {
    ".agentbox"
}

fn migrate_storage_directory(legacy: &Path, current: &Path) -> Result<(), String> {
    if !legacy.exists() {
        return Ok(());
    }
    fs::create_dir_all(current).map_err(|err| err.to_string())?;
    copy_storage_entries(legacy, current).map_err(|err| err.to_string())
}

fn copy_storage_entries(source: &Path, destination: &Path) -> io::Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            fs::create_dir_all(&destination_path)?;
            copy_storage_entries(&source_path, &destination_path)?;
        } else if file_type.is_file() && !destination_path.exists() {
            fs::copy(source_path, destination_path)?;
        }
    }
    Ok(())
}

fn saved_global_shortcut() -> Option<String> {
    let raw = read_promptpad_file("prefs.json".to_string()).ok()?;
    let shortcut = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()?
        .get("globalShortcut")?
        .as_str()?
        .trim()
        .to_string();
    (!shortcut.is_empty()).then_some(shortcut)
}

#[tauri::command]
async fn list_agent_skills(cwd: Option<String>) -> Result<Vec<AgentSkillItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = dirs::home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
        let mut roots: Vec<(String, String, PathBuf)> = Vec::new();
        add_skill_root(
            &mut roots,
            "codex",
            "Codex",
            home.join(".codex").join("skills"),
        );
        add_skill_root(
            &mut roots,
            "codex",
            "Codex 插件",
            home.join(".codex").join("plugins").join("cache"),
        );
        add_skill_root(
            &mut roots,
            "codex",
            "Codex Curated",
            home.join(".codex")
                .join("vendor_imports")
                .join("skills")
                .join("skills")
                .join(".curated"),
        );
        add_skill_root(
            &mut roots,
            "claude",
            "Claude",
            home.join(".claude").join("skills"),
        );
        add_skill_root(
            &mut roots,
            "claude",
            "Agents",
            home.join(".agents").join("skills"),
        );
        for plugin_root in installed_claude_plugin_roots(&home) {
            add_skill_root(&mut roots, "claude", "Claude 插件", plugin_root);
        }
        add_shared_skill_root(&mut roots, "本地", home.join(".cc-switch").join("skills"));
        add_shared_skill_root(&mut roots, "本地", home.join("AI").join("Skills"));
        if let Some(cwd) = cwd {
            let cwd = PathBuf::from(cwd);
            add_skill_root(
                &mut roots,
                "codex",
                "项目 Codex",
                cwd.join(".codex").join("skills"),
            );
            add_skill_root(
                &mut roots,
                "claude",
                "项目 Claude",
                cwd.join(".claude").join("skills"),
            );
            add_skill_root(
                &mut roots,
                "claude",
                "项目 Agents",
                cwd.join(".agents").join("skills"),
            );
        }

        let mut items = Vec::new();
        let mut visited_roots = HashSet::new();
        for (agent, source, root) in roots {
            if !visited_roots.insert(format!("{agent}:{}", root.to_string_lossy())) {
                continue;
            }
            collect_agent_skills(&agent, &source, &root, &mut items)?;
        }
        items.sort_by(|left, right| {
            left.agent
                .cmp(&right.agent)
                .then_with(|| left.path.cmp(&right.path))
                .then_with(|| left.source.cmp(&right.source))
                .then_with(|| left.command.cmp(&right.command))
        });
        items.dedup_by(|left, right| left.agent == right.agent && left.path == right.path);
        Ok(items)
    })
    .await
    .map_err(|err| format!("扫描 Skill 后台任务失败: {err}"))?
}

async fn run_session_store<T>(
    gate: Arc<Mutex<()>>,
    operation: impl FnOnce(&Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    let root = promptpad_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = gate
            .lock()
            .map_err(|_| "AI 会话存储进程内锁已损坏".to_string())?;
        session_store::with_storage_lock(&root, || operation(&root))
    })
    .await
    .map_err(|err| format!("AI 会话存储后台任务失败: {err}"))?
}

#[tauri::command]
async fn load_ai_workspace(gate: State<'_, StorageGate>) -> Result<WorkspaceArchive, String> {
    run_session_store(Arc::clone(&gate.0), |root| {
        session_store::load_or_migrate_workspace_unlocked(root)
    })
    .await
}

#[tauri::command]
async fn save_ai_workspace(
    gate: State<'_, StorageGate>,
    archive: WorkspaceArchive,
) -> Result<(), String> {
    run_session_store(Arc::clone(&gate.0), move |root| {
        session_store::save_workspace_unlocked(root, &archive)
    })
    .await
}

#[tauri::command]
async fn load_ai_session_history(
    gate: State<'_, StorageGate>,
    session_id: String,
) -> Result<String, String> {
    run_session_store(Arc::clone(&gate.0), move |root| {
        session_store::read_history_unlocked(root, &session_id)
    })
    .await
}

#[tauri::command]
async fn append_ai_session_history(
    gate: State<'_, StorageGate>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    run_session_store(Arc::clone(&gate.0), move |root| {
        session_store::append_history_with_limit_unlocked(
            root,
            &session_id,
            &data,
            session_store::HISTORY_LIMIT,
        )
    })
    .await
}

#[tauri::command]
async fn complete_gui_message(
    agent: String,
    model: String,
    cwd: String,
    prompt: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        complete_gui_message_blocking(&agent, &model, &cwd, &prompt)
    })
    .await
    .map_err(|err| format!("GUI 模型后台任务失败: {err}"))?
}

fn complete_gui_message_blocking(
    agent: &str,
    model: &str,
    cwd: &str,
    prompt: &str,
) -> Result<String, String> {
    let cwd = validate_working_directory(cwd)?;
    let output = match agent {
        "claude" => Command::new("claude")
            .arg("-p")
            .arg("--model")
            .arg(model)
            .arg("--output-format")
            .arg("text")
            .arg(prompt)
            .current_dir(&cwd)
            .output(),
        "codex" => Command::new(resolve_agent_program("codex"))
            .arg("exec")
            .arg("--cd")
            .arg(&cwd)
            .arg("--skip-git-repo-check")
            .arg("--sandbox")
            .arg("read-only")
            .arg("--model")
            .arg(model)
            .arg(prompt)
            .current_dir(&cwd)
            .output(),
        _ => return Err("GUI Agent 仅支持 claude 或 codex".to_string()),
    }
    .map_err(|err| format!("无法启动 GUI Agent {agent}: {err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("GUI Agent {agent} 模型 {model} 执行失败")
    } else {
        stderr
    })
}

#[tauri::command]
async fn delete_ai_session_histories(
    gate: State<'_, StorageGate>,
    session_ids: Vec<String>,
) -> Result<(), String> {
    run_session_store(Arc::clone(&gate.0), move |root| {
        session_store::delete_histories_unlocked(root, &session_ids)
    })
    .await
}

#[tauri::command]
async fn commit_ai_session_deletion(
    gate: State<'_, StorageGate>,
    archive: WorkspaceArchive,
    session_ids: Vec<String>,
) -> Result<(), String> {
    run_session_store(Arc::clone(&gate.0), move |root| {
        session_store::commit_session_deletion_unlocked(root, &archive, &session_ids)
    })
    .await
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    open::that(url).map_err(|err| err.to_string())
}

#[tauri::command]
fn open_plugin_window(
    app: tauri::AppHandle,
    plugin_id: String,
    title: String,
) -> Result<String, String> {
    let plugin_id = plugin_id.trim().to_string();
    if plugin_id.is_empty() {
        return Err("插件 ID 不能为空".to_string());
    }
    let label = format!(
        "plugin-{}",
        plugin_id.replace(
            |ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_',
            "-"
        )
    );
    if let Some(window) = app.get_webview_window(&label) {
        window
            .show()
            .and_then(|_| window.set_focus())
            .map_err(|err| format!("无法聚焦插件窗口：{err}"))?;
        return Ok(label);
    }

    let event_feature_id = plugin_id.clone();
    let main_window = app.get_webview_window("main");
    let window = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("index.html?plugin-window={plugin_id}").into()),
    )
    .title(if title.trim().is_empty() {
        "插件窗口"
    } else {
        title.trim()
    })
    .inner_size(820.0, 640.0)
    .min_inner_size(460.0, 360.0)
    .resizable(true)
    .build()
    .map_err(|err| format!("无法创建插件窗口：{err}"))?;

    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Some(main) = &main_window {
                let _ = main.emit("plugin-window-closed", &event_feature_id);
            }
        }
    });
    Ok(label)
}

#[tauri::command]
fn run_shell_command(command: String, cwd: Option<String>) -> Result<CommandResult, String> {
    let mut cmd = Command::new(default_shell());
    cmd.arg("-lc").arg(command);
    if let Some(dir) = cwd {
        if !dir.trim().is_empty() {
            cmd.current_dir(dir);
        }
    }
    let output = cmd
        .stdin(Stdio::null())
        .output()
        .map_err(|err| err.to_string())?;
    Ok(CommandResult {
        status: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

#[tauri::command]
async fn list_git_status(cwd: String) -> Result<GitStatusSummary, String> {
    tauri::async_runtime::spawn_blocking(move || list_git_status_sync(&cwd))
        .await
        .map_err(|err| format!("Git 状态后台任务失败: {err}"))?
}

#[tauri::command]
async fn list_git_roots(cwd: String) -> Result<Vec<GitRootInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || list_git_roots_sync(&cwd))
        .await
        .map_err(|err| format!("Git 仓库列表后台任务失败: {err}"))?
}

#[tauri::command]
async fn read_git_diff(cwd: String, path: String) -> Result<GitDiffResult, String> {
    tauri::async_runtime::spawn_blocking(move || read_git_diff_sync(&cwd, &path))
        .await
        .map_err(|err| format!("Git Diff 后台任务失败: {err}"))?
}

fn list_git_status_sync(cwd: &str) -> Result<GitStatusSummary, String> {
    let root = git_output(cwd, ["rev-parse", "--show-toplevel"])?;
    let branch = git_output(cwd, ["branch", "--show-current"])
        .or_else(|_| git_output(cwd, ["rev-parse", "--short", "HEAD"]))?;
    let porcelain = git_output(cwd, ["status", "--porcelain=v1"])?;
    let root_path = PathBuf::from(root.trim());
    let files = porcelain
        .lines()
        .filter_map(parse_git_status_line)
        .map(|mut file| {
            file.modified_ms = system_time_millis(
                fs::metadata(root_path.join(&file.path))
                    .and_then(|metadata| metadata.modified())
                    .ok(),
            );
            file
        })
        .collect::<Vec<_>>();
    Ok(GitStatusSummary {
        root: root.trim().to_string(),
        branch: branch.trim().to_string(),
        files,
    })
}

fn list_git_roots_sync(cwd: &str) -> Result<Vec<GitRootInfo>, String> {
    let current_root = git_output(cwd, ["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    let current_path = PathBuf::from(&current_root);
    let mut candidates = Vec::<PathBuf>::new();
    collect_git_root_candidate(&current_path, &mut candidates);
    collect_nested_git_root_candidates(&current_path, 0, 5, &mut candidates);

    for ancestor in current_path.ancestors().take(8) {
        collect_git_root_candidate(ancestor, &mut candidates);
        if let Ok(entries) = fs::read_dir(ancestor) {
            for entry in entries.flatten().take(240) {
                let path = entry.path();
                if path.is_dir() {
                    collect_git_root_candidate(&path, &mut candidates);
                    if path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| matches!(name, "requirements" | "worktrees"))
                    {
                        collect_nested_git_root_candidates(&path, 0, 6, &mut candidates);
                    }
                }
            }
        }
    }

    let mut seen = HashSet::<String>::new();
    let mut roots = candidates
        .into_iter()
        .filter_map(|path| {
            let root = path.to_string_lossy().to_string();
            if !seen.insert(root.clone()) {
                return None;
            }
            Some(GitRootInfo {
                branch: git_branch_for_root(&root),
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(&root)
                    .to_string(),
                root,
            })
        })
        .collect::<Vec<_>>();
    roots.sort_by(|left, right| {
        let left_current = left.root == current_root;
        let right_current = right.root == current_root;
        right_current
            .cmp(&left_current)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(roots)
}

fn collect_git_root_candidate(path: &Path, candidates: &mut Vec<PathBuf>) {
    if path.join(".git").exists() {
        candidates.push(path.to_path_buf());
    }
}

fn collect_nested_git_root_candidates(
    path: &Path,
    depth: usize,
    max_depth: usize,
    candidates: &mut Vec<PathBuf>,
) {
    if depth > max_depth || candidates.len() > 500 {
        return;
    }
    if path.join(".git").exists() {
        candidates.push(path.to_path_buf());
        return;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten().take(500) {
        let child = entry.path();
        if !child.is_dir() || should_skip_git_root_scan_dir(&child) {
            continue;
        }
        collect_nested_git_root_candidates(&child, depth + 1, max_depth, candidates);
    }
}

fn should_skip_git_root_scan_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            matches!(
                name,
                ".git" | "node_modules" | "target" | "dist" | "build" | ".idea" | ".gradle"
            )
        })
}

fn git_branch_for_root(root: &str) -> String {
    git_output(root, ["branch", "--show-current"])
        .or_else(|_| git_output(root, ["rev-parse", "--short", "HEAD"]))
        .map(|branch| branch.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string())
}

fn read_git_diff_sync(cwd: &str, path: &str) -> Result<GitDiffResult, String> {
    let status = git_output(cwd, ["status", "--porcelain=v1", "--", path])?;
    let file_status = status.lines().find_map(parse_git_status_line);
    let diff = if matches!(
        file_status.as_ref().map(|file| file.status.as_str()),
        Some("A" | "??")
    ) {
        git_output_allow_statuses(
            cwd,
            ["diff", "--no-index", "--", "/dev/null", path],
            &[0, 1],
        )?
    } else {
        let staged = git_output(cwd, ["diff", "--cached", "--", path])?;
        let unstaged = git_output(cwd, ["diff", "--", path])?;
        [staged.trim_end(), unstaged.trim_end()]
            .into_iter()
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok(GitDiffResult {
        path: path.to_string(),
        diff,
    })
}

fn git_output<const N: usize>(cwd: &str, args: [&str; N]) -> Result<String, String> {
    git_output_allow_statuses(cwd, args, &[0])
}

fn git_output_allow_statuses<const N: usize>(
    cwd: &str,
    args: [&str; N],
    allowed_statuses: &[i32],
) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|err| format!("执行 git 失败: {err}"))?;
    if output
        .status
        .code()
        .is_some_and(|code| allowed_statuses.contains(&code))
    {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git 命令失败，exit status: {}", output.status)
        } else {
            stderr
        })
    }
}

fn parse_git_status_line(line: &str) -> Option<GitChangedFile> {
    if line.len() < 3 {
        return None;
    }
    let code = &line[..2];
    let raw_path = line[3..].trim();
    if raw_path.is_empty() {
        return None;
    }
    let path = raw_path
        .rsplit_once(" -> ")
        .map(|(_, renamed)| renamed)
        .unwrap_or(raw_path)
        .trim_matches('"')
        .to_string();
    let status = if code == "??" {
        "??".to_string()
    } else if code.contains('D') {
        "D".to_string()
    } else if code.contains('A') {
        "A".to_string()
    } else if code.contains('R') {
        "R".to_string()
    } else {
        "M".to_string()
    };
    Some(GitChangedFile {
        path,
        status: status.clone(),
        summary: status,
        modified_ms: None,
    })
}

#[tauri::command]
fn open_system_terminal(command: String, input: Option<String>) -> Result<(), String> {
    let script = if let Some(text) = input.filter(|value| !value.trim().is_empty()) {
        format!(
            r#"tell application "Terminal"
  activate
  do script {}
  delay 1
  do script {} in selected tab of front window
end tell"#,
            applescript_string(&command),
            applescript_string(&text)
        )
    } else {
        format!(
            r#"tell application "Terminal"
  activate
  do script {}
end tell"#,
            applescript_string(&command)
        )
    };
    run_osascript(&script)
}

fn codex_resume_pids_from_process_list(output: &str, cli_session_id: &str) -> Vec<u32> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<u32>().ok()?;
            let command = fields.collect::<Vec<_>>();
            let is_codex = command.iter().any(|part| {
                Path::new(part).file_name().and_then(|name| name.to_str()) == Some("codex")
            });
            (is_codex && command.iter().any(|part| *part == cli_session_id)).then_some(pid)
        })
        .collect()
}

fn active_codex_resume_pids(cli_session_id: &str) -> Vec<u32> {
    let Ok(output) = Command::new("ps").args(["-axo", "pid=,command="]).output() else {
        return Vec::new();
    };
    codex_resume_pids_from_process_list(&String::from_utf8_lossy(&output.stdout), cli_session_id)
}

#[tauri::command]
fn start_pty(
    app: tauri::AppHandle,
    state: State<'_, PtyState>,
    session_id: String,
    generation: String,
    agent: String,
    model: Option<String>,
    agent_context: Option<String>,
    cli_session_id: Option<String>,
    resume: bool,
    fallback_resume: bool,
    cwd: String,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyStreamEvent>,
) -> Result<(), String> {
    let mut launch = agent_launch_spec(
        &agent,
        model.as_deref(),
        cli_session_id.as_deref(),
        resume,
        fallback_resume,
    )?;
    if launch.program == "codex" {
        launch.program = resolve_agent_program(&launch.program);
    }
    let working_directory = validate_working_directory(&cwd)?;
    if agent == "codex" && resume {
        if let Some(cli_session_id) = cli_session_id.as_deref() {
            let active_pids = active_codex_resume_pids(cli_session_id);
            if !active_pids.is_empty() {
                let pids = active_pids
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(format!(
                    "Codex 会话 {cli_session_id} 检测到仍在运行的 codex resume 进程（PID {pids}）。请关闭对应进程后重试，或点击“在此重启新会话”在当前列表项和目录启动新会话。"
                ));
            }
        }
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("无法创建终端: {err}"))?;

    let mut command = CommandBuilder::new(default_shell());
    command.arg("-lic");
    command.arg(terminal_launch_script());
    command.arg("AgentBox");
    command.arg(&launch.program);
    for arg in &launch.args {
        command.arg(arg);
    }
    if let Some(context) = agent_context.filter(|value| !value.trim().is_empty()) {
        match agent.as_str() {
            "claude" => {
                command.arg("--append-system-prompt");
                command.arg(context);
            }
            "codex" => {
                let encoded = serde_json::to_string(&context)
                    .map_err(|err| format!("无法编码 Agent 上下文: {err}"))?;
                command.arg("-c");
                command.arg(format!("developer_instructions={encoded}"));
            }
            _ => {}
        }
    }
    command.cwd(working_directory);
    for (name, value) in terminal_color_env() {
        command.env(name, value);
    }
    for name in terminal_color_env_removals() {
        command.env_remove(name);
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|err| format!("无法启动 {}: {err}", launch.program))?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("无法读取终端输出: {err}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("无法连接终端输入: {err}"))?;
    if generation.trim().is_empty() {
        return Err("终端 generation 不能为空".to_string());
    }

    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(bytes) = input_rx.recv() {
            if writer
                .write_all(&bytes)
                .and_then(|_| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });

    let replaced = state
        .sessions
        .lock()
        .map_err(|_| "终端会话状态已损坏".to_string())?
        .insert(
            session_id.clone(),
            PtyRuntime {
                generation: generation.clone(),
                master: pair.master,
                input_tx,
                child,
                output: PendingOutput::new(),
                running: true,
                error: None,
            },
        );
    if let Some(runtime) = replaced {
        shutdown_runtime_and_wait(runtime);
    }

    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut utf8_pending = Vec::new();
        let mut exit_error = None;
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    utf8_pending.extend_from_slice(&buffer[..count]);
                    let (data, consumed) = decode_complete_utf8_prefix(&utf8_pending);
                    if consumed > 0 {
                        utf8_pending.drain(..consumed);
                    }
                    if data.is_empty() {
                        continue;
                    }
                    let channel_delivered = on_event
                        .send(PtyStreamEvent {
                            kind: "output".to_string(),
                            session_id: session_id.clone(),
                            generation: generation.clone(),
                            data: Some(data.clone()),
                            error: None,
                        })
                        .is_ok();
                    if should_buffer_pty_output(channel_delivered) {
                        let state = app.state::<PtyState>();
                        if let Ok(mut sessions) = state.sessions.lock() {
                            if let Some(runtime) = sessions.get_mut(&session_id) {
                                if runtime.generation == generation {
                                    runtime.output.push(data.as_bytes());
                                }
                            }
                        }
                        emit_pty_output(&app, &session_id, &generation, data);
                    }
                }
                Err(err) => {
                    exit_error = Some(format!("终端输出读取失败: {err}"));
                    break;
                }
            }
        }

        if !utf8_pending.is_empty() {
            let data = String::from_utf8_lossy(&utf8_pending).into_owned();
            let channel_delivered = on_event
                .send(PtyStreamEvent {
                    kind: "output".to_string(),
                    session_id: session_id.clone(),
                    generation: generation.clone(),
                    data: Some(data.clone()),
                    error: None,
                })
                .is_ok();
            if should_buffer_pty_output(channel_delivered) {
                let state = app.state::<PtyState>();
                if let Ok(mut sessions) = state.sessions.lock() {
                    if let Some(runtime) = sessions.get_mut(&session_id) {
                        if runtime.generation == generation {
                            runtime.output.push(data.as_bytes());
                        }
                    }
                }
                emit_pty_output(&app, &session_id, &generation, data);
            }
        }

        let state = app.state::<PtyState>();
        if let Ok(mut sessions) = state.sessions.lock() {
            if let Some(runtime) = sessions.get_mut(&session_id) {
                if runtime.generation == generation {
                    runtime.running = false;
                    runtime.error = exit_error.clone();
                }
            }
        }
        if on_event
            .send(PtyStreamEvent {
                kind: "exit".to_string(),
                session_id: session_id.clone(),
                generation: generation.clone(),
                data: None,
                error: exit_error.clone(),
            })
            .is_err()
        {
            let _ = app.emit(
                "pty-exit",
                PtyExitEvent {
                    session_id,
                    generation,
                    error: exit_error,
                },
            );
        }
    });

    Ok(())
}

fn emit_pty_output(app: &tauri::AppHandle, session_id: &str, generation: &str, data: String) {
    let _ = app.emit(
        "pty-output",
        PtyOutputEvent {
            session_id: session_id.to_string(),
            generation: generation.to_string(),
            data,
        },
    );
}

fn should_buffer_pty_output(channel_delivered: bool) -> bool {
    !channel_delivered
}

fn decode_complete_utf8_prefix(bytes: &[u8]) -> (String, usize) {
    match std::str::from_utf8(bytes) {
        Ok(value) => (value.to_string(), bytes.len()),
        Err(error) if error.error_len().is_none() => {
            let valid_up_to = error.valid_up_to();
            (
                String::from_utf8_lossy(&bytes[..valid_up_to]).into_owned(),
                valid_up_to,
            )
        }
        Err(error) => {
            let consumed = error.valid_up_to() + error.error_len().unwrap_or(1);
            (
                String::from_utf8_lossy(&bytes[..consumed]).into_owned(),
                consumed,
            )
        }
    }
}

#[tauri::command]
fn poll_pty(
    state: State<'_, PtyState>,
    session_id: String,
    generation: String,
) -> Result<PtyPollResult, String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "终端会话状态已损坏".to_string())?;
    let runtime = matching_runtime_mut(&mut sessions, &session_id, &generation)?;
    Ok(PtyPollResult {
        data: runtime.output.drain(),
        running: runtime.running,
        error: runtime.error.clone(),
    })
}

#[tauri::command]
fn write_pty(
    state: State<'_, PtyState>,
    session_id: String,
    generation: String,
    data: String,
) -> Result<(), String> {
    let input_tx = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "终端会话状态已损坏".to_string())?;
        let runtime = match sessions.get(&session_id) {
            Some(runtime) if runtime.generation == generation => runtime,
            _ => return Err("终端会话已停止或已重新启动".to_string()),
        };
        runtime.input_tx.clone()
    };
    input_tx
        .send(data.into_bytes())
        .map_err(|_| "终端输入通道已关闭".to_string())
}

#[tauri::command]
fn resize_pty(
    state: State<'_, PtyState>,
    session_id: String,
    generation: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "终端会话状态已损坏".to_string())?;
    let runtime = matching_runtime_mut(&mut sessions, &session_id, &generation)?;
    runtime
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("终端尺寸调整失败: {err}"))
}

#[tauri::command]
fn stop_pty(
    state: State<'_, PtyState>,
    session_id: String,
    generation: String,
) -> Result<(), String> {
    let runtime = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "终端会话状态已损坏".to_string())?;
        match sessions.get(&session_id) {
            Some(runtime) if runtime.generation == generation => sessions.remove(&session_id),
            _ => return Err("终端会话已停止或已重新启动".to_string()),
        }
    };
    if let Some(runtime) = runtime {
        shutdown_runtime_and_wait(runtime);
    }
    Ok(())
}

#[tauri::command]
fn start_speech_recognition(
    app: tauri::AppHandle,
    state: State<'_, SpeechState>,
    locale: String,
) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, locale);
        return Err("语音输入第一版仅支持 macOS".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let helper = app
            .path()
            .resource_dir()
            .map_err(|error| format!("无法定位语音识别组件：{error}"))?
            .join("resources/AgentBoxSpeechHelper.app/Contents/MacOS/AgentBoxSpeechHelper");
        if !helper.is_file() {
            return Err("语音识别组件未打包，请重新安装最新版本 App".to_string());
        }

        let mut active = state
            .recording
            .lock()
            .map_err(|_| "语音输入状态已损坏".to_string())?;
        if let Some(mut previous) = active.take() {
            let _ = previous.child.kill();
        }

        let recording_id = format!(
            "speech-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "无法生成语音录音 ID".to_string())?
                .as_nanos()
        );
        let mut child = Command::new(helper)
            .arg(if locale.trim().is_empty() {
                "zh-CN"
            } else {
                locale.as_str()
            })
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("无法启动 macOS 语音识别：{error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "语音识别输入通道启动失败".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "语音识别输出通道启动失败".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "语音识别诊断通道启动失败".to_string())?;
        *active = Some(SpeechRuntime {
            recording_id: recording_id.clone(),
            child,
            stdin,
        });

        // Register the runtime before reading helper output. Permission errors can
        // arrive immediately after spawn; recording the state first prevents a
        // just-finished helper from being installed as an active recording.
        let event_app = app.clone();
        let event_state = Arc::clone(&state.recording);
        let completed = Arc::clone(&state.completed);
        let event_recording_id = recording_id.clone();
        let stderr_reader = std::thread::spawn(move || {
            let mut tail = VecDeque::with_capacity(32);
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if tail.len() == 32 {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
            tail.into_iter().collect::<Vec<_>>().join("\n")
        });
        std::thread::spawn(move || {
            let mut saw_terminal_event = false;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(message) = serde_json::from_str::<SpeechHelperEvent>(&line) else {
                    continue;
                };
                let terminal = message.kind == "error" || message.kind == "stopped";
                saw_terminal_event |= terminal;
                let event = SpeechEvent {
                    kind: message.kind,
                    message: message.message,
                    recording_id: event_recording_id.clone(),
                    is_final: message.is_final,
                    text: message.text,
                };
                if event.kind == "transcript" || event.kind == "error" {
                    if let Ok(mut results) = completed.lock() {
                        results.insert(event_recording_id.clone(), event.clone());
                        while results.len() > 16 {
                            if let Some(oldest) = results.keys().next().cloned() {
                                results.remove(&oldest);
                            }
                        }
                    }
                }
                let _ = event_app.emit("speech-event", event);
                if terminal {
                    if let Ok(mut current) = event_state.lock() {
                        if current
                            .as_ref()
                            .is_some_and(|runtime| runtime.recording_id == event_recording_id)
                        {
                            if let Some(mut runtime) = current.take() {
                                let _ = runtime.child.kill();
                            }
                        }
                    }
                    break;
                }
            }
            let stderr = stderr_reader.join().unwrap_or_default();
            if let Some(message) = speech_helper_exit_message(saw_terminal_event, &stderr) {
                let event = SpeechEvent {
                    kind: "error".to_string(),
                    message: Some(message),
                    recording_id: event_recording_id.clone(),
                    is_final: None,
                    text: None,
                };
                if let Ok(mut results) = completed.lock() {
                    results.insert(event_recording_id.clone(), event.clone());
                }
                let _ = event_app.emit("speech-event", event);
            }
            if let Ok(mut current) = event_state.lock() {
                if current
                    .as_ref()
                    .is_some_and(|runtime| runtime.recording_id == event_recording_id)
                {
                    if let Some(mut runtime) = current.take() {
                        let _ = runtime.child.kill();
                    }
                }
            }
        });
        Ok(recording_id)
    }
}

#[tauri::command]
async fn wait_speech_recognition_result(
    state: State<'_, SpeechState>,
    recording_id: String,
) -> Result<SpeechEvent, String> {
    let completed = Arc::clone(&state.completed);
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(125);
        loop {
            if let Ok(mut results) = completed.lock() {
                if let Some(result) = results.remove(&recording_id) {
                    return Ok(result);
                }
            }
            if std::time::Instant::now() >= deadline {
                return Err("语音转文字超时，录音组件未返回最终结果".to_string());
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    })
    .await
    .map_err(|error| format!("等待语音转写结果失败：{error}"))?
}

#[tauri::command]
fn stop_speech_recognition(
    app: tauri::AppHandle,
    state: State<'_, SpeechState>,
    recording_id: String,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, recording_id);
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let mut active = state
            .recording
            .lock()
            .map_err(|_| "语音输入状态已损坏".to_string())?;
        let Some(runtime) = active
            .as_mut()
            .filter(|runtime| runtime.recording_id == recording_id)
        else {
            if let Ok(mut results) = state.completed.lock() {
                results
                    .entry(recording_id.clone())
                    .or_insert_with(|| SpeechEvent {
                        kind: "error".to_string(),
                        message: Some("语音录音进程已提前结束，未取得转写结果".to_string()),
                        recording_id: recording_id.clone(),
                        is_final: None,
                        text: None,
                    });
            }
            let _ = app.emit(
                "speech-event",
                SpeechEvent {
                    kind: "stopped".to_string(),
                    message: None,
                    recording_id,
                    is_final: None,
                    text: None,
                },
            );
            return Ok(());
        };
        let result = runtime
            .stdin
            .write_all(b"stop\n")
            .and_then(|_| runtime.stdin.flush());
        if let Err(error) = result {
            if !is_expected_speech_stop_error(&error) {
                return Err(format!("无法停止语音录音：{error}"));
            }

            // The helper can finish first when the speech task reports an
            // error. Stopping an already-finished recording is idempotent.
            if let Some(mut finished) = active.take() {
                let _ = finished.child.kill();
            }
            let _ = app.emit(
                "speech-event",
                SpeechEvent {
                    kind: "stopped".to_string(),
                    message: None,
                    recording_id,
                    is_final: None,
                    text: None,
                },
            );
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn shutdown_speech(state: &SpeechState) {
    if let Ok(mut active) = state.recording.lock() {
        if let Some(mut runtime) = active.take() {
            let _ = runtime.child.kill();
        }
    }
}

#[tauri::command]
fn prepare_pty_restart(state: State<'_, PtyState>, session_id: String) -> Result<(), String> {
    let runtime = state
        .sessions
        .lock()
        .map_err(|_| "终端会话状态已损坏".to_string())?
        .remove(&session_id);
    if let Some(runtime) = runtime {
        shutdown_runtime_and_wait(runtime);
    }
    Ok(())
}

#[tauri::command]
fn choose_working_directory() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
fn validate_working_directory_path(cwd: String) -> Result<(), String> {
    validate_working_directory(&cwd).map(|_| ())
}

#[tauri::command]
fn open_working_directory(cwd: String) -> Result<(), String> {
    let path = validate_working_directory(&cwd)?;
    open::that(path).map_err(|err| format!("无法打开工作目录: {err}"))
}

#[tauri::command]
fn choose_document_directory() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
fn choose_document_file() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .pick_file()
        .map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
fn export_toolbox_config(default_name: String, content: String) -> Result<Option<String>, String> {
    let file_name = if default_name.trim().is_empty() {
        "AgentBox-tools.json".to_string()
    } else {
        default_name
    };
    let Some(path) = rfd::FileDialog::new()
        .add_filter("AgentBox 工具配置", &["json"])
        .set_file_name(&file_name)
        .save_file()
    else {
        return Ok(None);
    };
    fs::write(&path, content).map_err(|err| format!("导出工具配置失败: {err}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
fn export_agent_center_config(
    default_name: String,
    content: String,
) -> Result<Option<String>, String> {
    let file_name = if default_name.trim().is_empty() {
        "AgentBox-agents.json".to_string()
    } else {
        default_name
    };
    let Some(path) = rfd::FileDialog::new()
        .add_filter("AgentBox Agent 配置", &["json"])
        .set_file_name(&file_name)
        .save_file()
    else {
        return Ok(None);
    };
    fs::write(&path, content).map_err(|err| format!("导出 Agent 配置失败: {err}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
fn choose_toolbox_import_file() -> Result<Option<ToolboxImportFile>, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("AgentBox 工具配置", &["json"])
        .pick_file()
    else {
        return Ok(None);
    };
    let metadata = fs::metadata(&path).map_err(|err| format!("无法读取导入文件信息: {err}"))?;
    if metadata.len() > TOOLBOX_IMPORT_MAX_FILE_SIZE {
        return Err("导入文件超过 1MB，已拒绝读取".to_string());
    }
    let content =
        fs::read_to_string(&path).map_err(|err| format!("无法按文本读取导入文件: {err}"))?;
    Ok(Some(ToolboxImportFile {
        path: path.to_string_lossy().to_string(),
        content,
    }))
}

#[tauri::command]
fn choose_agent_center_import_file() -> Result<Option<AgentCenterImportFile>, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("AgentBox Agent 配置", &["json"])
        .pick_file()
    else {
        return Ok(None);
    };
    let metadata = fs::metadata(&path).map_err(|err| format!("无法读取导入文件信息: {err}"))?;
    if metadata.len() > AGENT_CENTER_IMPORT_MAX_FILE_SIZE {
        return Err("导入文件超过 1MB，已拒绝读取".to_string());
    }
    let content =
        fs::read_to_string(&path).map_err(|err| format!("无法按文本读取导入文件: {err}"))?;
    Ok(Some(AgentCenterImportFile {
        path: path.to_string_lossy().to_string(),
        content,
    }))
}

#[tauri::command]
fn list_document_tree(root_path: String) -> Result<Vec<DocumentNode>, String> {
    let root =
        fs::canonicalize(Path::new(&root_path)).map_err(|err| format!("无法读取目录: {err}"))?;
    if !root.is_dir() {
        return Err("请选择有效目录".to_string());
    }
    let mut count = 0;
    list_document_children(&root, &root, 0, &mut count)
}

#[tauri::command]
fn read_document_file(
    root_path: String,
    relative_path: String,
) -> Result<DocumentFileContent, String> {
    let root =
        fs::canonicalize(Path::new(&root_path)).map_err(|err| format!("无法读取目录: {err}"))?;
    if !root.is_dir() {
        return Err("请选择有效目录".to_string());
    }
    let path = resolve_document_path(&root, &relative_path)?;
    if !is_supported_document_file(&path) {
        return Err("暂不支持该文件类型".to_string());
    }
    read_document_content(&path, relative_path)
}

#[tauri::command]
fn read_context_file(path: String) -> Result<DocumentFileContent, String> {
    let path = fs::canonicalize(Path::new(&path)).map_err(|err| format!("无法读取文件: {err}"))?;
    if !path.is_file() {
        return Err("请选择有效文件".to_string());
    }
    if !is_supported_document_file(&path) {
        return Err("暂不支持该文件类型".to_string());
    }
    let display_path = path.to_string_lossy().to_string();
    read_document_content(&path, display_path)
}

fn read_document_content(path: &Path, display_path: String) -> Result<DocumentFileContent, String> {
    let metadata = fs::metadata(path).map_err(|err| format!("无法读取文件信息: {err}"))?;
    if metadata.len() > DOCUMENT_MAX_FILE_SIZE {
        return Err("文件超过 20MB，已拒绝读取".to_string());
    }
    let extension = document_extension(path).unwrap_or_default();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名")
        .to_string();

    match extension.as_str() {
        "doc" => {
            if let Ok(binary) = convert_legacy_word_to_docx(path) {
                return Ok(DocumentFileContent {
                    path: display_path,
                    name,
                    extension,
                    content: extract_text_with_textutil(path).unwrap_or_default(),
                    size: metadata.len(),
                    binary: Some(binary),
                    preview_kind: "docx".to_string(),
                    rendered_html: None,
                });
            }
            let rendered_html = convert_document_to_html(path)?;
            Ok(DocumentFileContent {
                path: display_path,
                name,
                extension,
                content: extract_text_with_textutil(path).unwrap_or_default(),
                size: metadata.len(),
                binary: None,
                preview_kind: "office-html".to_string(),
                rendered_html: Some(rendered_html),
            })
        }
        "docx" => Ok(DocumentFileContent {
            path: display_path,
            name,
            extension,
            content: extract_text_with_textutil(path).unwrap_or_default(),
            size: metadata.len(),
            binary: Some(fs::read(path).map_err(|err| format!("无法读取 Word 文档: {err}"))?),
            preview_kind: "docx".to_string(),
            rendered_html: None,
        }),
        "rtf" | "odt" | "ods" | "odp" => Ok(DocumentFileContent {
            path: display_path,
            name,
            extension,
            content: extract_text_with_textutil(path).unwrap_or_default(),
            size: metadata.len(),
            binary: None,
            preview_kind: "office-html".to_string(),
            rendered_html: Some(convert_document_to_html(path)?),
        }),
        "pdf" => Ok(DocumentFileContent {
            path: display_path,
            name,
            extension,
            content: String::new(),
            size: metadata.len(),
            binary: Some(fs::read(path).map_err(|err| format!("无法读取 PDF 文件: {err}"))?),
            preview_kind: "pdf".to_string(),
            rendered_html: None,
        }),
        "png" | "jpg" | "jpeg" | "gif" | "svg" => Ok(DocumentFileContent {
            path: display_path,
            name,
            extension,
            content: String::new(),
            size: metadata.len(),
            binary: Some(fs::read(path).map_err(|err| format!("无法读取图片文件: {err}"))?),
            preview_kind: "image".to_string(),
            rendered_html: None,
        }),
        _ => Ok(DocumentFileContent {
            path: display_path,
            name,
            extension,
            content: fs::read_to_string(path)
                .map_err(|err| format!("无法按文本读取文件: {err}"))?,
            size: metadata.len(),
            binary: None,
            preview_kind: "text".to_string(),
            rendered_html: None,
        }),
    }
}

fn textutil_output(format: &str, path: &Path) -> Result<Vec<u8>, String> {
    let output = Command::new("/usr/bin/textutil")
        .args(["-convert", format, "-stdout"])
        .arg(path)
        .output()
        .map_err(|err| format!("无法调用 macOS 文档转换器: {err}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "macOS 文档转换器不支持该文件".to_string()
        } else {
            format!("文档转换失败：{detail}")
        });
    }
    Ok(output.stdout)
}

fn extract_text_with_textutil(path: &Path) -> Result<String, String> {
    String::from_utf8(textutil_output("txt", path)?)
        .map_err(|err| format!("文档文本编码无效: {err}"))
}

fn convert_document_to_html(path: &Path) -> Result<String, String> {
    String::from_utf8(textutil_output("html", path)?)
        .map_err(|err| format!("文档 HTML 编码无效: {err}"))
}

fn convert_legacy_word_to_docx(path: &Path) -> Result<Vec<u8>, String> {
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("无法生成临时文件名: {err}"))?
        .as_nanos();
    let output_path = std::env::temp_dir().join(format!(
        "agentbox-document-{}-{id}.docx",
        std::process::id()
    ));
    let output = Command::new("/usr/bin/textutil")
        .args(["-convert", "docx", "-output"])
        .arg(&output_path)
        .arg(path)
        .output()
        .map_err(|err| format!("无法调用 macOS Word 转换器: {err}"))?;
    if !output.status.success() {
        let _ = fs::remove_file(&output_path);
        return Err("旧版 Word 文档无法转换".to_string());
    }
    let result = fs::read(&output_path).map_err(|err| format!("无法读取转换后的 Word 文档: {err}"));
    let _ = fs::remove_file(&output_path);
    result
}

#[tauri::command]
async fn scan_recent_changes(
    root_path: String,
    limit: usize,
) -> Result<Vec<RecentChangedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_recent_changes_sync(root_path, limit))
        .await
        .map_err(|err| format!("实时追踪扫描任务失败: {err}"))?
}

fn scan_recent_changes_sync(
    root_path: String,
    limit: usize,
) -> Result<Vec<RecentChangedFile>, String> {
    let root = fs::canonicalize(Path::new(&root_path))
        .map_err(|err| format!("无法读取追踪目录: {err}"))?;
    if !root.is_dir() {
        return Err("请选择有效追踪目录".to_string());
    }
    let limit = limit.clamp(1, 200);
    let mut count = 0;
    let mut files = Vec::new();
    collect_recent_changed_files(&root, &root, 0, limit, &mut count, &mut files)?;
    files.sort_by(|left, right| right.modified_ms.cmp(&left.modified_ms));
    Ok(files)
}

fn collect_recent_changed_files(
    root: &Path,
    dir: &Path,
    depth: usize,
    limit: usize,
    count: &mut usize,
    files: &mut Vec<RecentChangedFile>,
) -> Result<(), String> {
    if depth >= CHANGE_TRACKER_MAX_DEPTH || *count >= CHANGE_TRACKER_MAX_FILES {
        return Ok(());
    }
    let mut entries = fs::read_dir(dir)
        .map_err(|err| format!("无法读取目录 {}: {err}", dir.display()))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        change_tracker_entry_priority(left.path().as_path())
            .cmp(&change_tracker_entry_priority(right.path().as_path()))
            .then_with(|| left.file_name().cmp(&right.file_name()))
    });
    for entry in entries {
        if *count >= CHANGE_TRACKER_MAX_FILES {
            break;
        }
        let path = entry.path();
        let metadata = match entry.metadata() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if metadata.is_dir() {
            if should_skip_change_tracker_dir(&path) {
                continue;
            }
            collect_recent_changed_files(root, &path, depth + 1, limit, count, files)?;
            continue;
        }
        if !metadata.is_file()
            || !is_supported_document_file(&path)
            || metadata.len() > DOCUMENT_MAX_FILE_SIZE
        {
            continue;
        }
        *count += 1;
        let created_ms = system_time_millis(metadata.created().ok()).unwrap_or(0);
        let modified_ms = system_time_millis(metadata.modified().ok()).unwrap_or(0);
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        push_recent_changed_file(
            files,
            limit,
            RecentChangedFile {
                absolute_path: path.to_string_lossy().to_string(),
                created_ms,
                extension: document_extension(&path).unwrap_or_default(),
                modified_ms,
                name: path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("未命名")
                    .to_string(),
                path: relative,
                size: metadata.len(),
            },
        );
    }
    Ok(())
}

fn push_recent_changed_file(
    files: &mut Vec<RecentChangedFile>,
    limit: usize,
    file: RecentChangedFile,
) {
    if files.len() < limit {
        files.push(file);
        return;
    }
    if let Some((oldest_index, oldest)) = files
        .iter()
        .enumerate()
        .min_by_key(|(_, item)| item.modified_ms)
    {
        if file.modified_ms > oldest.modified_ms {
            files[oldest_index] = file;
        }
    }
}

fn change_tracker_entry_priority(path: &Path) -> usize {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    match name {
        "worktrees" => 0,
        "src" => 1,
        "service" | "contract" => 2,
        "requirements" => 3,
        "archived" | "node_modules" | "target" | "dist" | "build" => 90,
        _ => 20,
    }
}

fn should_skip_change_tracker_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            matches!(
                name,
                ".git"
                    | "node_modules"
                    | "target"
                    | "dist"
                    | "build"
                    | ".idea"
                    | ".gradle"
                    | ".next"
                    | ".turbo"
                    | "coverage"
            )
        })
}

fn list_document_children(
    root: &Path,
    dir: &Path,
    depth: usize,
    count: &mut usize,
) -> Result<Vec<DocumentNode>, String> {
    if depth >= DOCUMENT_MAX_DEPTH || *count >= DOCUMENT_MAX_FILES {
        return Ok(Vec::new());
    }
    let mut entries = fs::read_dir(dir)
        .map_err(|err| format!("无法读取目录内容: {err}"))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());

    let mut nodes = Vec::new();
    for entry in entries {
        if *count >= DOCUMENT_MAX_FILES {
            break;
        }
        let path = entry.path();
        let name = match path.file_name().and_then(|value| value.to_str()) {
            Some(value) => value.to_string(),
            _ => continue,
        };
        if path.is_dir() {
            if should_skip_document_dir(&name) {
                continue;
            }
            let children = list_document_children(root, &path, depth + 1, count)?;
            nodes.push(DocumentNode {
                name,
                path: relative_document_path(root, &path)?,
                kind: "directory".to_string(),
                extension: None,
                children: Some(children),
            });
        } else if path.is_file() {
            *count += 1;
            nodes.push(DocumentNode {
                name,
                path: relative_document_path(root, &path)?,
                kind: "file".to_string(),
                extension: document_extension(&path),
                children: None,
            });
        }
    }
    Ok(nodes)
}

fn resolve_document_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("文件路径必须位于所选目录内".to_string());
    }
    let path = root.join(relative);
    let canonical = fs::canonicalize(&path).map_err(|err| format!("无法读取文件: {err}"))?;
    if !canonical.starts_with(root) {
        return Err("文件路径必须位于所选目录内".to_string());
    }
    Ok(canonical)
}

fn relative_document_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|_| "文件路径必须位于所选目录内".to_string())
        .map(|value| value.to_string_lossy().replace('\\', "/"))
}

fn is_supported_document_file(path: &Path) -> bool {
    document_extension(path)
        .as_deref()
        .is_some_and(|extension| {
            matches!(
                extension,
                "md" | "markdown"
                    | "java"
                    | "json"
                    | "txt"
                    | "ts"
                    | "tsx"
                    | "js"
                    | "jsx"
                    | "css"
                    | "html"
                    | "xml"
                    | "yaml"
                    | "yml"
                    | "properties"
                    | "sql"
                    | "kt"
                    | "rs"
                    | "toml"
                    | "log"
                    | "docx"
                    | "doc"
                    | "pdf"
                    | "rtf"
                    | "odt"
                    | "ods"
                    | "odp"
                    | "png"
                    | "jpg"
                    | "jpeg"
                    | "gif"
                    | "svg"
                    | "sh"
                    | "bash"
                    | "py"
                    | "go"
                    | "c"
                    | "cpp"
                    | "h"
                    | "vue"
                    | "ini"
                    | "conf"
                    | "env"
            )
        })
}

fn document_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .or_else(|| {
            path.file_name()
                .and_then(|value| value.to_str())
                .filter(|value| value.starts_with('.') && value.len() > 1)
                .map(|value| value[1..].to_ascii_lowercase())
        })
}

fn should_skip_document_dir(name: &str) -> bool {
    matches!(name, ".git")
}

#[tauri::command]
fn find_agent_session_id(
    agent: String,
    cwd: String,
    started_at_ms: u64,
) -> Result<Option<String>, String> {
    match agent.as_str() {
        "claude" => find_claude_session_id(&cwd, started_at_ms),
        "codex" => find_codex_session_id(&cwd, started_at_ms),
        _ => Err(format!("不支持的 Agent 类型: {agent}")),
    }
}

#[tauri::command]
fn find_pty_session_id(
    state: State<'_, PtyState>,
    session_id: String,
    generation: String,
    agent: String,
    cwd: String,
) -> Result<Option<String>, String> {
    if agent != "codex" {
        return Ok(None);
    }
    let process_group = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "终端会话状态已损坏".to_string())?;
        let runtime = match sessions.get(&session_id) {
            Some(runtime) if runtime.generation == generation => runtime,
            _ => return Ok(None),
        };
        runtime.master.process_group_leader()
    };
    let Some(process_group) = process_group else {
        return Ok(None);
    };
    find_codex_session_id_for_process_group(process_group, &cwd)
}

fn find_codex_session_id(cwd: &str, started_at_ms: u64) -> Result<Option<String>, String> {
    let root = dirs::home_dir()
        .ok_or_else(|| "无法定位用户主目录".to_string())?
        .join(".codex")
        .join("sessions");
    if !root.exists() {
        return Ok(None);
    }

    let mut files = Vec::new();
    collect_jsonl_files(&root, &mut files).map_err(|err| err.to_string())?;
    let mut nearest: Option<(u64, String)> = None;
    for path in files {
        let file = match fs::File::open(&path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let mut first_line = String::new();
        if BufReader::new(file).read_line(&mut first_line).is_err() {
            continue;
        }
        if let Some(session_id) = parse_codex_session_meta(&first_line, cwd) {
            if !codex_session_started_near(&session_id, started_at_ms) {
                continue;
            }
            let distance = codex_session_timestamp_ms(&session_id)
                .map(|timestamp| timestamp.abs_diff(started_at_ms))
                .unwrap_or(u64::MAX);
            if nearest.as_ref().is_none_or(|(best, _)| distance < *best) {
                nearest = Some((distance, session_id));
            }
        }
    }
    Ok(nearest.map(|(_, session_id)| session_id))
}

fn find_codex_session_id_for_process_group(
    process_group: i32,
    cwd: &str,
) -> Result<Option<String>, String> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-Fn", "-g", &process_group.to_string()])
        .output()
        .map_err(|err| format!("无法检查 Codex 会话文件: {err}"))?;
    for path in lsof_session_paths(&String::from_utf8_lossy(&output.stdout)) {
        let Ok(file) = fs::File::open(path) else {
            continue;
        };
        let mut first_line = String::new();
        if BufReader::new(file).read_line(&mut first_line).is_ok() {
            if let Some(session_id) = parse_codex_session_meta(&first_line, cwd) {
                return Ok(Some(session_id));
            }
        }
    }
    Ok(None)
}

fn find_claude_session_id(cwd: &str, started_at_ms: u64) -> Result<Option<String>, String> {
    let root = dirs::home_dir()
        .ok_or_else(|| "无法定位用户主目录".to_string())?
        .join(".claude")
        .join("projects")
        .join(claude_project_key(cwd));
    if !root.exists() {
        return Ok(None);
    }

    let mut files = Vec::new();
    collect_jsonl_files(&root, &mut files).map_err(|err| err.to_string())?;
    let mut newest: Option<(u64, String)> = None;
    for path in files {
        let metadata = match fs::metadata(&path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let modified_ms = match system_time_millis(metadata.modified().ok()) {
            Some(value) if codex_candidate_is_recent(value, started_at_ms) => value,
            _ => continue,
        };
        let first_line_id = fs::File::open(&path).ok().and_then(|file| {
            let mut line = String::new();
            BufReader::new(file)
                .read_line(&mut line)
                .ok()
                .and_then(|_| parse_claude_session_id(&line))
        });
        let filename_id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| is_session_uuid(value))
            .map(str::to_lowercase);
        if let Some(session_id) = first_line_id.or(filename_id) {
            if newest.as_ref().is_none_or(|(time, _)| modified_ms > *time) {
                newest = Some((modified_ms, session_id));
            }
        }
    }
    Ok(newest.map(|(_, session_id)| session_id))
}

#[tauri::command]
fn agent_session_exists(
    agent: String,
    cwd: String,
    cli_session_id: String,
) -> Result<bool, String> {
    let session_id = cli_session_id.trim().to_lowercase();
    if !is_session_uuid(&session_id) {
        return Ok(false);
    }
    match agent.as_str() {
        "claude" => {
            let root = dirs::home_dir()
                .ok_or_else(|| "无法定位用户主目录".to_string())?
                .join(".claude")
                .join("projects")
                .join(claude_project_key(&cwd));
            if !root.exists() {
                return Ok(false);
            }
            let mut files = Vec::new();
            collect_jsonl_files(&root, &mut files).map_err(|err| err.to_string())?;
            Ok(files.into_iter().any(|path| {
                path.file_stem()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case(&session_id))
                    || fs::File::open(path).ok().is_some_and(|file| {
                        let mut line = String::new();
                        BufReader::new(file).read_line(&mut line).is_ok()
                            && parse_claude_session_id(&line)
                                .is_some_and(|value| value == session_id)
                    })
            }))
        }
        "codex" => {
            let Some(root) = dirs::home_dir().map(|home| home.join(".codex").join("sessions"))
            else {
                return Ok(false);
            };
            if !root.exists() {
                return Ok(false);
            }
            let mut files = Vec::new();
            collect_jsonl_files(&root, &mut files).map_err(|err| err.to_string())?;
            Ok(files.into_iter().any(|path| {
                fs::File::open(path).ok().is_some_and(|file| {
                    let mut line = String::new();
                    BufReader::new(file).read_line(&mut line).is_ok()
                        && parse_codex_session_meta(&line, &cwd)
                            .is_some_and(|value| value == session_id)
                })
            }))
        }
        _ => Ok(false),
    }
}

#[tauri::command]
fn load_claude_transcript(
    cwd: String,
    cli_session_id: String,
) -> Result<Vec<ClaudeTranscriptMessage>, String> {
    let session_id = cli_session_id.trim().to_lowercase();
    if !is_session_uuid(&session_id) {
        return Ok(Vec::new());
    }
    let root = dirs::home_dir()
        .ok_or_else(|| "无法定位用户主目录".to_string())?
        .join(".claude")
        .join("projects")
        .join(claude_project_key(&cwd));
    let path = root.join(format!("{session_id}.jsonl"));
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let content =
        fs::read_to_string(path).map_err(|err| format!("无法读取 Claude 会话记录: {err}"))?;
    Ok(parse_claude_transcript(&content))
}

#[tauri::command]
fn load_codex_transcript(
    cwd: String,
    cli_session_id: String,
) -> Result<Vec<ClaudeTranscriptMessage>, String> {
    let session_id = cli_session_id.trim().to_lowercase();
    if !is_session_uuid(&session_id) {
        return Ok(Vec::new());
    }
    let root = dirs::home_dir()
        .ok_or_else(|| "无法定位用户主目录".to_string())?
        .join(".codex")
        .join("sessions");
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    collect_jsonl_files(&root, &mut files).map_err(|err| err.to_string())?;
    let Some(path) = files.into_iter().find(|path| {
        let Ok(file) = fs::File::open(path) else {
            return false;
        };
        let mut reader = BufReader::new(file);
        let mut first_line = String::new();
        reader.read_line(&mut first_line).is_ok()
            && parse_codex_session_meta(&first_line, &cwd).is_some_and(|value| value == session_id)
    }) else {
        return Ok(Vec::new());
    };

    let file = fs::File::open(path).map_err(|err| format!("无法读取 Codex 会话记录: {err}"))?;
    let reader = BufReader::new(file);
    Ok(parse_codex_transcript_lines(reader.lines()))
}

fn parse_claude_transcript(content: &str) -> Vec<ClaudeTranscriptMessage> {
    let mut messages = Vec::new();
    for line in content.lines() {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(kind) = event.get("type").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if kind != "user" && kind != "assistant"
            || event.get("isMeta").and_then(serde_json::Value::as_bool) == Some(true)
        {
            continue;
        }
        let Some(message) = event.get("message") else {
            continue;
        };
        if message.get("role").and_then(serde_json::Value::as_str) != Some(kind) {
            continue;
        }
        let text = claude_transcript_text(message.get("content"));
        if text.is_empty() || is_internal_claude_message(&text) {
            continue;
        }
        let timestamp = event
            .get("timestamp")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        if kind == "assistant"
            && messages
                .last()
                .is_some_and(|item: &ClaudeTranscriptMessage| item.kind == "assistant")
        {
            if let Some(previous) = messages.last_mut() {
                previous.text.push_str("\n\n");
                previous.text.push_str(&text);
            }
        } else {
            messages.push(ClaudeTranscriptMessage {
                kind: kind.to_string(),
                text,
                timestamp,
            });
        }
    }
    messages
}

#[cfg(test)]
fn parse_codex_transcript(content: &str) -> Vec<ClaudeTranscriptMessage> {
    parse_codex_transcript_lines(content.lines().map(|line| Ok(line.to_string())))
}

fn parse_codex_transcript_lines<I>(lines: I) -> Vec<ClaudeTranscriptMessage>
where
    I: Iterator<Item = io::Result<String>>,
{
    let mut messages = Vec::new();
    for line in lines {
        let Ok(line) = line else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(payload) = event.get("payload") else {
            continue;
        };
        if event.get("type").and_then(serde_json::Value::as_str) != Some("response_item")
            || payload.get("type").and_then(serde_json::Value::as_str) != Some("message")
        {
            continue;
        }
        let Some(kind) = payload.get("role").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if kind != "user" && kind != "assistant" {
            continue;
        }
        let text = codex_transcript_text(payload.get("content"), kind);
        if text.is_empty() || (kind == "user" && is_codex_startup_context(&text)) {
            continue;
        }
        let timestamp = event
            .get("timestamp")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        if kind == "assistant"
            && messages
                .last()
                .is_some_and(|item: &ClaudeTranscriptMessage| item.kind == "assistant")
        {
            if let Some(previous) = messages.last_mut() {
                previous.text.push_str("\n\n");
                previous.text.push_str(&text);
            }
        } else {
            messages.push(ClaudeTranscriptMessage {
                kind: kind.to_string(),
                text,
                timestamp,
            });
        }
    }
    messages
}

fn is_codex_startup_context(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with("# AGENTS.md instructions for ")
        && trimmed.contains("<INSTRUCTIONS>")
        && (trimmed.contains("@CLAUDE.md")
            || trimmed.contains("<!-- OPENWIKI:START -->")
            || trimmed.contains("<!-- OPENWIKI:END -->"))
}

fn codex_transcript_text(content: Option<&serde_json::Value>, kind: &str) -> String {
    let expected_type = if kind == "user" {
        "input_text"
    } else {
        "output_text"
    };
    match content {
        Some(serde_json::Value::String(value)) => value.trim().to_string(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter(|item| {
                item.get("type")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|item_type| item_type == expected_type || item_type == "text")
            })
            .filter_map(|item| item.get("text").and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct ClaudeTranscriptMessage {
    kind: String,
    text: String,
    timestamp: Option<String>,
}

fn claude_transcript_text(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(value)) => value.trim().to_string(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter(|item| item.get("type").and_then(serde_json::Value::as_str) == Some("text"))
            .filter_map(|item| item.get("text").and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

fn is_internal_claude_message(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed == "No response requested."
        || (trimmed.starts_with("<local-command-caveat>")
            && trimmed.ends_with("</local-command-caveat>"))
        || [
            "command-name",
            "command-message",
            "command-args",
            "local-command-stdout",
            "local-command-stderr",
        ]
        .iter()
        .any(|tag| {
            trimmed.starts_with(&format!("<{tag}>")) && trimmed.ends_with(&format!("</{tag}>"))
        })
}

#[tauri::command]
fn set_clipboard_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn get_clipboard_text(app: tauri::AppHandle) -> Result<String, String> {
    app.clipboard().read_text().map_err(|err| err.to_string())
}

#[tauri::command]
fn paste_clipboard(append_enter: bool) -> Result<(), String> {
    let script = if append_enter {
        r#"tell application "System Events" to keystroke "v" using command down
tell application "System Events" to key code 36"#
    } else {
        r#"tell application "System Events" to keystroke "v" using command down"#
    };
    run_osascript(script)
}

fn valid_bundle_id(bundle_id: &str) -> bool {
    !bundle_id.is_empty()
        && bundle_id.len() <= 255
        && bundle_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-')
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PasteDeliveryPath {
    InternalEvent,
    DirectAccessibility,
    FocusedKeyboard,
}

#[cfg(target_os = "macos")]
fn paste_delivery_path(bundle_id: &str, focused_description: Option<&str>) -> PasteDeliveryPath {
    if bundle_id == "com.zz.toolbox" {
        PasteDeliveryPath::InternalEvent
    } else if matches!(bundle_id, "com.openai.codex" | "com.openai.chatgpt")
        || matches!(bundle_id, "com.apple.Terminal" | "com.googlecode.iterm2")
        || focused_description.is_some_and(|value| {
            let value = value.to_ascii_lowercase();
            value.contains("terminal") || value.contains("shell")
        })
    {
        // Terminal panes, TUI CLIs, and Electron text areas need a real paste
        // key sequence delivered to the target process.
        PasteDeliveryPath::FocusedKeyboard
    } else {
        PasteDeliveryPath::DirectAccessibility
    }
}

#[cfg(target_os = "macos")]
fn paste_delivery_requires_frontmost(delivery_path: PasteDeliveryPath) -> bool {
    delivery_path == PasteDeliveryPath::FocusedKeyboard
}

#[cfg(target_os = "macos")]
fn paste_delivery_allows_missing_focused_element(delivery_path: PasteDeliveryPath) -> bool {
    delivery_path == PasteDeliveryPath::FocusedKeyboard
}

#[cfg(target_os = "macos")]
fn copy_ax_string(element: *const std::ffi::c_void, attribute: &str) -> Option<String> {
    let attribute = CFString::new(attribute);
    let mut value: *const std::ffi::c_void = std::ptr::null();
    let status = unsafe {
        AXUIElementCopyAttributeValue(
            element,
            attribute.as_concrete_TypeRef() as *const std::ffi::c_void,
            &mut value,
        )
    };
    if status != 0 || value.is_null() {
        return None;
    }
    Some(unsafe { CFString::wrap_under_create_rule(value as *const _) }.to_string())
}

#[cfg(target_os = "macos")]
fn copy_ax_element_attribute(
    element: *const std::ffi::c_void,
    attribute: &str,
) -> Option<RetainedAxElement> {
    let attribute = CFString::new(attribute);
    let mut value: *const std::ffi::c_void = std::ptr::null();
    let status = unsafe {
        AXUIElementCopyAttributeValue(
            element,
            attribute.as_concrete_TypeRef() as *const std::ffi::c_void,
            &mut value,
        )
    };
    if status != 0 || value.is_null() {
        return None;
    }
    unsafe { RetainedAxElement::from_owned(value) }
}

#[cfg(target_os = "macos")]
fn capture_focused_element(pid: libc::pid_t) -> (Option<RetainedAxElement>, Option<String>) {
    let application = unsafe { AXUIElementCreateApplication(pid) };
    if application.is_null() {
        return (None, None);
    }
    let focused_element = copy_ax_element_attribute(application, "AXFocusedUIElement");
    unsafe { CFRelease(application) };
    let description = focused_element.as_ref().and_then(|element| {
        copy_ax_string(element.as_ptr(), "AXDescription")
            .or_else(|| copy_ax_string(element.as_ptr(), "AXRoleDescription"))
    });
    (focused_element, description)
}

#[cfg(target_os = "macos")]
fn capture_frontmost_app() -> Option<PreviousApp> {
    let application = NSWorkspace::sharedWorkspace().frontmostApplication()?;
    let bundle_id = application.bundleIdentifier()?.to_string();
    let pid = application.processIdentifier();
    if pid <= 0 || !valid_bundle_id(&bundle_id) {
        return None;
    }
    let (focused_element, focused_description) = capture_focused_element(pid);
    Some(PreviousApp {
        bundle_id,
        pid,
        focused_element,
        focused_description,
    })
}

#[cfg(not(target_os = "macos"))]
fn capture_frontmost_app() -> Option<PreviousApp> {
    None
}

#[cfg(target_os = "macos")]
fn position_quick_palette(window: &tauri::WebviewWindow) -> bool {
    let Some(marker) = MainThreadMarker::new() else {
        return false;
    };
    let mouse = NSEvent::mouseLocation();
    let screens = NSScreen::screens(marker);
    let target = screens
        .iter()
        .find(|screen| {
            let frame = screen.frame();
            mouse.x >= frame.origin.x
                && mouse.x <= frame.origin.x + frame.size.width
                && mouse.y >= frame.origin.y
                && mouse.y <= frame.origin.y + frame.size.height
        })
        .or_else(|| {
            screens.iter().min_by(|left, right| {
                point_distance_to_screen(mouse.x, mouse.y, left.frame())
                    .total_cmp(&point_distance_to_screen(mouse.x, mouse.y, right.frame()))
            })
        });
    let Some(target) = target else {
        return false;
    };
    let visible = target.visibleFrame();
    let Ok(pointer) = window.ns_window() else {
        return false;
    };
    let native_window = unsafe { (pointer as *mut NSWindow).as_ref() };
    let Some(native_window) = native_window else {
        return false;
    };
    let window_size = native_window.frame().size;
    let x = visible.origin.x + ((visible.size.width - window_size.width).max(0.0) / 2.0);
    let top_y = visible.origin.y + visible.size.height
        - ((visible.size.height - window_size.height).max(0.0) / 2.0);
    native_window.setFrameTopLeftPoint(NSPoint::new(x, top_y));
    true
}

#[cfg(target_os = "macos")]
fn quick_palette_window_level() -> objc2_app_kit::NSWindowLevel {
    NSScreenSaverWindowLevel
}

#[cfg(target_os = "macos")]
fn configure_quick_palette_window(window: &tauri::WebviewWindow) -> bool {
    if !unsafe { convert_to_quick_palette_panel(window) } {
        return false;
    }
    let Ok(pointer) = window.ns_window() else {
        return false;
    };
    let native_window = unsafe { (pointer as *mut NSWindow).as_ref() };
    let Some(native_window) = native_window else {
        return false;
    };
    native_window.setLevel(quick_palette_window_level());
    native_window.setStyleMask(native_window.styleMask() | NSWindowStyleMask::NonactivatingPanel);
    if let Some(panel) = unsafe { (pointer as *mut NSPanel).as_ref() } {
        panel.setBecomesKeyOnlyIfNeeded(true);
    }
    native_window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Transient,
    );
    true
}

#[cfg(not(target_os = "macos"))]
fn configure_quick_palette_window(window: &tauri::WebviewWindow) -> bool {
    window.set_always_on_top(true).is_ok()
}

#[cfg(target_os = "macos")]
fn bring_quick_palette_to_front(window: &tauri::WebviewWindow) {
    if let Ok(pointer) = window.ns_window() {
        if let Some(native_window) = unsafe { (pointer as *mut NSWindow).as_ref() } {
            native_window.orderFrontRegardless();
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn bring_quick_palette_to_front(_window: &tauri::WebviewWindow) {}

#[cfg(not(target_os = "macos"))]
fn position_quick_palette(window: &tauri::WebviewWindow) -> bool {
    window.center().is_ok()
}

#[cfg(target_os = "macos")]
fn point_distance_to_screen(x: f64, y: f64, frame: objc2_foundation::NSRect) -> f64 {
    let dx = if x < frame.origin.x {
        frame.origin.x - x
    } else if x > frame.origin.x + frame.size.width {
        x - (frame.origin.x + frame.size.width)
    } else {
        0.0
    };
    let dy = if y < frame.origin.y {
        frame.origin.y - y
    } else if y > frame.origin.y + frame.size.height {
        y - (frame.origin.y + frame.size.height)
    } else {
        0.0
    };
    dx * dx + dy * dy
}

fn toggle_quick_palette(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("quick-palette") else {
        return;
    };
    let _ = configure_quick_palette_window(&window);
    if !position_quick_palette(&window) {
        let _ = window.center();
    }
    let _ = window.show();
    bring_quick_palette_to_front(&window);
    let _ = window.emit("quick-palette-open", ());
}

fn remember_frontmost_app(app: &tauri::AppHandle) {
    if let Some(previous_app) = capture_frontmost_app() {
        if let Ok(mut previous) = app.state::<PaletteState>().previous_app.lock() {
            *previous = Some(previous_app);
        }
    }
}

#[tauri::command]
fn hide_quick_palette(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("quick-palette")
        .ok_or_else(|| "快捷工具窗口不存在".to_string())?;
    window.hide().map_err(|err| err.to_string())
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?
        .hide()
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn take_main_window_close_request(state: State<MainWindowCloseRequestState>) -> bool {
    state.0.swap(false, Ordering::SeqCst)
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn start_quick_palette_drag(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("quick-palette")
        .ok_or_else(|| "快捷工具窗口不存在".to_string())?
        .start_dragging()
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn start_plugin_window_drag(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(label.trim())
        .ok_or_else(|| "插件窗口不存在".to_string())?;
    window
        .show()
        .and_then(|_| window.set_focus())
        .and_then(|_| window.start_dragging())
        .map_err(|err| format!("无法开始拖动插件窗口：{err}"))
}

fn plugin_window_label(plugin_id: &str) -> String {
    format!(
        "plugin-{}",
        plugin_id.replace(
            |ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_',
            "-",
        )
    )
}

#[tauri::command]
fn start_plugin_window_follow(
    app: tauri::AppHandle,
    state: State<'_, PluginDragState>,
    plugin_id: String,
) -> Result<(), String> {
    let label = plugin_window_label(plugin_id.trim());
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "插件窗口不存在".to_string())?;
    window
        .show()
        .and_then(|_| window.set_focus())
        .map_err(|err| format!("无法显示插件窗口：{err}"))?;

    let running = Arc::new(AtomicBool::new(true));
    if let Ok(mut active) = state.active.lock() {
        if let Some(previous) = active.insert(label.clone(), Arc::clone(&running)) {
            previous.store(false, Ordering::Release);
        }
    }
    let app_handle = app.clone();
    std::thread::spawn(move || {
        while running.load(Ordering::Acquire) {
            #[cfg(target_os = "macos")]
            if NSEvent::pressedMouseButtons() & 1 == 0 {
                running.store(false, Ordering::Release);
                break;
            }
            let tick_running = Arc::clone(&running);
            let tick_label = label.clone();
            let tick_app = app_handle.clone();
            let _ = app_handle.run_on_main_thread(move || {
                if !tick_running.load(Ordering::Acquire) {
                    return;
                }
                #[cfg(target_os = "macos")]
                {
                    let Some(_marker) = MainThreadMarker::new() else {
                        return;
                    };
                    let mouse = NSEvent::mouseLocation();
                    let Some(window) = tick_app.get_webview_window(&tick_label) else {
                        return;
                    };
                    let Ok(pointer) = window.ns_window() else {
                        return;
                    };
                    let Some(native_window) = (unsafe { (pointer as *mut NSWindow).as_ref() })
                    else {
                        return;
                    };
                    let frame = native_window.frame();
                    native_window.setFrameOrigin(NSPoint::new(
                        mouse.x - frame.size.width / 2.0,
                        mouse.y - frame.size.height / 2.0,
                    ));
                }
            });
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
    });
    Ok(())
}

#[tauri::command]
fn stop_plugin_window_follow(
    state: State<'_, PluginDragState>,
    plugin_id: String,
) -> Result<(), String> {
    let label = plugin_window_label(plugin_id.trim());
    if let Ok(mut active) = state.active.lock() {
        if let Some(running) = active.remove(&label) {
            running.store(false, Ordering::Release);
        }
    }
    Ok(())
}

#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    open::that("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn request_accessibility_permission() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let prompt_key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
        let options: CFDictionary<CFString, CFBoolean> =
            CFDictionary::from_CFType_pairs(&[(prompt_key, CFBoolean::true_value())]);
        return Ok(unsafe {
            AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef() as *const std::ffi::c_void)
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
fn prompt_for_accessibility_permission() -> bool {
    let prompt_key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
    let options: CFDictionary<CFString, CFBoolean> =
        CFDictionary::from_CFType_pairs(&[(prompt_key, CFBoolean::true_value())]);
    unsafe {
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef() as *const std::ffi::c_void)
    }
}

#[tauri::command]
fn paste_to_previous_app(
    app: tauri::AppHandle,
    state: State<'_, PaletteState>,
    text: String,
    append_enter: bool,
) -> Result<(), String> {
    app.clipboard()
        .write_text(&text)
        .map_err(|err| err.to_string())?;
    let previous_app = state
        .previous_app
        .lock()
        .map_err(|_| "无法读取原应用信息".to_string())?
        .clone()
        .filter(|value| valid_bundle_id(&value.bundle_id) && value.pid > 0)
        .ok_or_else(|| "未记录到可恢复的原应用，内容已复制到剪贴板".to_string())?;
    #[cfg(target_os = "macos")]
    {
        let mut delivery_path = paste_delivery_path(
            &previous_app.bundle_id,
            previous_app.focused_description.as_deref(),
        );
        if delivery_path == PasteDeliveryPath::InternalEvent {
            app.emit(
                "quick-palette-insert-main",
                QuickPaletteInsertEvent { text, append_enter },
            )
            .map_err(|error| format!("无法将内容发送到 AgentBox 输入框: {error}"))?;
            return Ok(());
        }
        if !accessibility_is_trusted() {
            let _ = prompt_for_accessibility_permission();
            return Err("当前运行的 AgentBox 尚未通过 macOS 辅助功能校验，已发起系统授权请求，内容同时保留在剪贴板".to_string());
        }
        if NSRunningApplication::runningApplicationWithProcessIdentifier(previous_app.pid).is_none()
        {
            return Err("原应用已经退出，内容已复制到剪贴板".to_string());
        }
        let focused_element = previous_app.focused_element.as_ref();
        if delivery_path == PasteDeliveryPath::DirectAccessibility {
            restore_target_application_window(previous_app.pid).map_err(|error| {
                format!("无法把目标应用恢复到前台：{error}；内容已保留在剪贴板")
            })?;
            std::thread::sleep(std::time::Duration::from_millis(80));
            if let Some(focused_element) = refreshed_focused_element(&previous_app) {
                if set_ax_selected_text(&focused_element, &text).is_ok() {
                    if append_enter {
                        post_return_key_to_pid(previous_app.pid)
                            .map_err(|error| format!("文本已插入，但发送回车失败：{error}"))?;
                    }
                    return Ok(());
                }
            }
            delivery_path = PasteDeliveryPath::FocusedKeyboard;
        }

        if paste_delivery_requires_frontmost(delivery_path) {
            restore_target_application_window(previous_app.pid).map_err(|error| {
                format!("无法把目标应用恢复到前台：{error}；内容已保留在剪贴板")
            })?;
        }
        if focused_element.is_none()
            && !paste_delivery_allows_missing_focused_element(delivery_path)
        {
            return Err("快捷键唤起时没有捕获到原输入框，内容已保留在剪贴板".to_string());
        }
        paste_key_sequence_to_pid(previous_app.pid, append_enter).map_err(|error| {
            format!(
                "无法向目标应用 {} 粘贴：{error}；内容已保留在剪贴板",
                previous_app.bundle_id
            )
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (previous_app, append_enter);
        Err("当前系统不支持全局粘贴，内容已复制到剪贴板".to_string())
    }
}

#[cfg(target_os = "macos")]
fn accessibility_is_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

#[cfg(target_os = "macos")]
fn restore_target_window_script(pid: libc::pid_t) -> String {
    format!(
        r#"tell application "System Events"
set targetProcess to first application process whose unix id is {pid}
set frontmost of targetProcess to true
if (count of windows of targetProcess) > 0 then
    perform action "AXRaise" of window 1 of targetProcess
end if
end tell"#
    )
}

#[cfg(target_os = "macos")]
fn restore_target_application_window(pid: libc::pid_t) -> Result<(), String> {
    let application = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .ok_or_else(|| "目标应用进程不存在".to_string())?;
    let options = NSApplicationActivationOptions::ActivateAllWindows;
    let _ = application.activateWithOptions(options);
    if wait_for_frontmost_application(pid, 800) {
        return Ok(());
    }
    Err("目标应用未能切换到前台，请先退出当前全屏窗口或手动激活目标应用".to_string())
}

#[cfg(target_os = "macos")]
fn wait_for_frontmost_application(pid: libc::pid_t, timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        if NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .is_some_and(|application| application.processIdentifier() == pid)
        {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(16));
    }
}

#[cfg(target_os = "macos")]
fn refreshed_focused_element(previous_app: &PreviousApp) -> Option<RetainedAxElement> {
    let refreshed = capture_focused_element(previous_app.pid).0;
    refreshed.or_else(|| previous_app.focused_element.clone())
}

#[cfg(target_os = "macos")]
fn set_ax_focused(element: &RetainedAxElement) -> Result<(), String> {
    let attribute = CFString::from_static_string("AXFocused");
    let status = unsafe {
        AXUIElementSetAttributeValue(
            element.as_ptr(),
            attribute.as_concrete_TypeRef() as *const std::ffi::c_void,
            CFBoolean::true_value().as_concrete_TypeRef() as *const std::ffi::c_void,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("AX 错误 {status}"))
    }
}

#[cfg(target_os = "macos")]
fn set_ax_selected_text(element: &RetainedAxElement, text: &str) -> Result<(), String> {
    set_ax_focused(element)?;
    let attribute = CFString::from_static_string("AXSelectedText");
    let value = CFString::new(text);
    let status = unsafe {
        AXUIElementSetAttributeValue(
            element.as_ptr(),
            attribute.as_concrete_TypeRef() as *const std::ffi::c_void,
            value.as_concrete_TypeRef() as *const std::ffi::c_void,
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(format!("AX 错误 {status}"))
    }
}

#[cfg(target_os = "macos")]
fn paste_key_sequence_to_pid(pid: libc::pid_t, append_enter: bool) -> Result<(), String> {
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "无法创建 macOS 键盘事件".to_string())?;
    // Give NSPasteboard consumers time to observe the new clipboard item.
    std::thread::sleep(std::time::Duration::from_millis(80));
    let command_down = CGEvent::new_keyboard_event(source.clone(), KeyCode::COMMAND, true)
        .map_err(|_| "无法发送 Command 键".to_string())?;
    command_down.set_flags(CGEventFlags::CGEventFlagCommand);
    command_down.post_to_pid(pid);
    let paste_down = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_V, true)
        .map_err(|_| "无法发送粘贴按键".to_string())?;
    paste_down.set_flags(CGEventFlags::CGEventFlagCommand);
    paste_down.post_to_pid(pid);
    let paste_up = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_V, false)
        .map_err(|_| "无法发送粘贴按键".to_string())?;
    paste_up.set_flags(CGEventFlags::CGEventFlagCommand);
    paste_up.post_to_pid(pid);
    let command_up = CGEvent::new_keyboard_event(source.clone(), KeyCode::COMMAND, false)
        .map_err(|_| "无法发送 Command 键".to_string())?;
    command_up.set_flags(CGEventFlags::CGEventFlagNull);
    command_up.post_to_pid(pid);
    if append_enter {
        std::thread::sleep(std::time::Duration::from_millis(140));
        post_return_key_to_pid_with_source(pid, source)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn post_return_key_to_pid(pid: libc::pid_t) -> Result<(), String> {
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "无法创建回车按键事件".to_string())?;
    post_return_key_to_pid_with_source(pid, source)
}

#[cfg(target_os = "macos")]
fn post_return_key_to_pid_with_source(
    pid: libc::pid_t,
    source: CGEventSource,
) -> Result<(), String> {
    let enter_down = CGEvent::new_keyboard_event(source.clone(), KeyCode::RETURN, true)
        .map_err(|_| "无法发送回车按键".to_string())?;
    enter_down.post_to_pid(pid);
    let enter_up = CGEvent::new_keyboard_event(source, KeyCode::RETURN, false)
        .map_err(|_| "无法发送回车按键".to_string())?;
    enter_up.post_to_pid(pid);
    Ok(())
}

#[tauri::command]
fn set_global_shortcut(
    app: tauri::AppHandle,
    state: State<'_, PaletteState>,
    shortcut: String,
) -> Result<(), String> {
    let shortcut = shortcut.trim().to_string();
    let old = state
        .shortcut
        .lock()
        .map_err(|_| "无法读取快捷键配置".to_string())?
        .clone();
    if shortcut == old {
        return Ok(());
    }
    app.global_shortcut()
        .unregister(old.as_str())
        .map_err(|err| err.to_string())?;
    if let Err(error) = app.global_shortcut().register(shortcut.as_str()) {
        let _ = app.global_shortcut().register(old.as_str());
        return Err(format!("快捷键已被占用或格式无效：{error}"));
    }
    *state
        .shortcut
        .lock()
        .map_err(|_| "无法保存快捷键配置".to_string())? = shortcut;
    Ok(())
}

fn run_osascript(script: &str) -> Result<(), String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

fn collect_agent_skills(
    agent: &str,
    source: &str,
    root: &Path,
    items: &mut Vec<AgentSkillItem>,
) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    collect_agent_skills_inner(agent, source, root, 0, items)
}

fn add_skill_root(
    roots: &mut Vec<(String, String, PathBuf)>,
    agent: &str,
    source: &str,
    root: PathBuf,
) {
    roots.push((agent.to_string(), source.to_string(), root));
}

fn add_shared_skill_root(roots: &mut Vec<(String, String, PathBuf)>, source: &str, root: PathBuf) {
    add_skill_root(roots, "codex", source, root.clone());
    add_skill_root(roots, "claude", source, root);
}

fn installed_claude_plugin_roots(home: &Path) -> Vec<PathBuf> {
    let path = home
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Vec::new();
    };
    let Some(plugins) = value.get("plugins").and_then(|item| item.as_object()) else {
        return Vec::new();
    };
    let mut roots = Vec::new();
    for installs in plugins.values() {
        let Some(installs) = installs.as_array() else {
            continue;
        };
        for install in installs {
            if let Some(path) = install.get("installPath").and_then(|item| item.as_str()) {
                roots.push(PathBuf::from(path));
            }
        }
    }
    roots
}

fn collect_agent_skills_inner(
    agent: &str,
    source: &str,
    dir: &Path,
    depth: usize,
    items: &mut Vec<AgentSkillItem>,
) -> Result<(), String> {
    if depth > 12 {
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            collect_agent_skills_inner(agent, source, &path, depth + 1, items)?;
            continue;
        }
        if path.file_name().and_then(|value| value.to_str()) != Some("SKILL.md") {
            continue;
        }
        if let Some(item) = parse_skill_file(agent, source, &path) {
            items.push(item);
        }
    }
    Ok(())
}

fn parse_skill_file(agent: &str, source: &str, path: &Path) -> Option<AgentSkillItem> {
    let mut file = fs::File::open(path).ok()?;
    let mut buffer = vec![0_u8; SKILL_META_READ_LIMIT];
    let read = file.read(&mut buffer).ok()?;
    buffer.truncate(read);
    let content = String::from_utf8_lossy(&buffer);
    let metadata = parse_skill_frontmatter(&content)?;
    let fallback_name = path.parent()?.file_name()?.to_str()?.to_string();
    let name = metadata
        .get("name")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or(fallback_name);
    let description = metadata.get("description").cloned().unwrap_or_default();
    Some(AgentSkillItem {
        agent: agent.to_string(),
        command: format!("/{}", slugify_skill_name(&name)),
        description,
        name,
        path: path.to_string_lossy().to_string(),
        source: source.to_string(),
    })
}

fn parse_skill_frontmatter(content: &str) -> Option<HashMap<String, String>> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut result = HashMap::new();
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        if key.trim() == "name" || key.trim() == "description" {
            result.insert(key.trim().to_string(), unquote_yaml_scalar(value.trim()));
        }
    }
    Some(result)
}

fn unquote_yaml_scalar(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

fn slugify_skill_name(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "skill".to_string()
    } else {
        slug
    }
}

fn applescript_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "")
        .replace('\n', "\\n");
    format!("\"{escaped}\"")
}

fn agentbox_file(name: &str) -> Result<PathBuf, String> {
    let allowed = [
        "features.json",
        "prefs.json",
        "workflow_projects.json",
        "sessions.json",
        "ai_sessions.json",
        "ai_workspace.json",
    ];
    if !allowed.contains(&name) {
        return Err(format!("不允许访问文件: {name}"));
    }
    Ok(promptpad_root()?.join(name))
}

fn atomic_write(path: PathBuf, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

fn resolve_program_from_candidates(
    program: &str,
    path_dirs: &[PathBuf],
    fallback_candidates: &[PathBuf],
) -> String {
    let program_path = Path::new(program);
    if program_path.is_absolute() {
        return program.to_string();
    }

    for directory in path_dirs {
        let candidate = directory.join(program);
        if is_executable_file(&candidate) {
            return candidate.to_string_lossy().to_string();
        }
    }
    for candidate in fallback_candidates {
        if is_executable_file(candidate) {
            return candidate.to_string_lossy().to_string();
        }
    }
    program.to_string()
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn codex_fallback_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ];
    let Some(home) = dirs::home_dir() else {
        return candidates;
    };

    candidates.extend([
        home.join(".volta").join("bin").join("codex"),
        home.join(".asdf").join("shims").join("codex"),
        home.join(".local").join("bin").join("codex"),
        home.join(".npm-global").join("bin").join("codex"),
        home.join(".pnpm-global").join("bin").join("codex"),
    ]);

    let node_versions = home.join(".nvm").join("versions").join("node");
    if let Ok(entries) = fs::read_dir(node_versions) {
        let mut versions = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect::<Vec<_>>();
        versions.sort_by(|left, right| right.cmp(left));
        for version in versions {
            candidates.push(version.join("bin").join("codex"));
            candidates.push(
                version
                    .join("lib")
                    .join("node_modules")
                    .join("@openai")
                    .join("codex")
                    .join("bin")
                    .join("codex.js"),
            );
        }
    }
    candidates
}

fn resolve_agent_program(program: &str) -> String {
    let path_dirs = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    let fallback_candidates = if program == "codex" {
        codex_fallback_candidates()
    } else {
        Vec::new()
    };
    resolve_program_from_candidates(program, &path_dirs, &fallback_candidates)
}

fn terminal_color_env() -> Vec<(String, String)> {
    vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        ("CLICOLOR_FORCE".to_string(), "1".to_string()),
        ("FORCE_COLOR".to_string(), "1".to_string()),
    ]
}

fn terminal_color_env_removals() -> Vec<&'static str> {
    vec!["NO_COLOR"]
}

fn terminal_launch_script() -> &'static str {
    "unset NO_COLOR; export TERM=xterm-256color COLORTERM=truecolor CLICOLOR_FORCE=1 FORCE_COLOR=1; exec \"$@\""
}

fn agent_launch_spec(
    agent: &str,
    model: Option<&str>,
    cli_session_id: Option<&str>,
    resume: bool,
    fallback_resume: bool,
) -> Result<LaunchSpec, String> {
    let session_id = match cli_session_id {
        Some(value) if is_session_uuid(value) => Some(value.to_lowercase()),
        Some(_) => return Err("CLI 会话 ID 不是有效 UUID".to_string()),
        None => None,
    };
    let mut launch = match (agent, resume, session_id, fallback_resume) {
        ("terminal", false, None, _) => Ok(LaunchSpec {
            program: default_shell(),
            args: vec!["-l".to_string()],
        }),
        ("terminal", true, _, _) => Err("普通终端不支持恢复，请重新启动终端".to_string()),
        ("claude", false, Some(id), _) => Ok(LaunchSpec {
            program: "claude".to_string(),
            args: vec!["--session-id".to_string(), id],
        }),
        ("claude", false, None, _) => Err("Claude 新会话缺少会话 ID".to_string()),
        ("claude", true, Some(id), _) => Ok(LaunchSpec {
            program: "claude".to_string(),
            args: vec!["--resume".to_string(), id],
        }),
        ("claude", true, None, true) => Ok(LaunchSpec {
            program: "claude".to_string(),
            args: vec!["--continue".to_string()],
        }),
        ("codex", false, _, _) => Ok(LaunchSpec {
            program: "codex".to_string(),
            args: Vec::new(),
        }),
        ("codex", true, Some(id), _) => Ok(LaunchSpec {
            program: "codex".to_string(),
            args: vec!["resume".to_string(), id],
        }),
        ("codex", true, None, _) => {
            Err("Codex 恢复会话缺少 CLI 会话 ID，已拒绝使用最近会话兜底".to_string())
        }
        ("claude", true, None, false) => Err("恢复会话缺少 CLI 会话 ID".to_string()),
        _ => Err(format!("不支持的 Agent 类型: {agent}")),
    }?;
    if !resume && matches!(agent, "claude" | "codex") {
        if let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) {
            let mut args = vec!["--model".to_string(), model.to_string()];
            args.extend(launch.args);
            launch.args = args;
        }
    }
    Ok(launch)
}

fn is_session_uuid(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    let lengths = [8, 4, 4, 4, 12];
    parts.len() == lengths.len()
        && parts.iter().zip(lengths).all(|(part, length)| {
            part.len() == length && part.chars().all(|ch| ch.is_ascii_hexdigit())
        })
}

fn parse_codex_session_meta(line: &str, expected_cwd: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    let payload = value.get("payload")?;
    if Path::new(payload.get("cwd")?.as_str()?) != Path::new(expected_cwd) {
        return None;
    }
    let session_id = payload
        .get("id")
        .or_else(|| payload.get("session_id"))?
        .as_str()?;
    is_session_uuid(session_id).then(|| session_id.to_lowercase())
}

fn claude_project_key(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

fn parse_claude_session_id(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let session_id = value
        .get("sessionId")
        .or_else(|| value.get("session_id"))?
        .as_str()?;
    is_session_uuid(session_id).then(|| session_id.to_lowercase())
}

fn codex_candidate_is_recent(modified_ms: u64, started_at_ms: u64) -> bool {
    modified_ms.saturating_add(5_000) >= started_at_ms
}

const CODEX_SESSION_START_TOLERANCE_MS: u64 = 30_000;

fn codex_session_timestamp_ms(session_id: &str) -> Option<u64> {
    if !is_session_uuid(session_id) {
        return None;
    }
    let mut parts = session_id.split('-');
    let timestamp_hex = format!("{}{}", parts.next()?, parts.next()?);
    u64::from_str_radix(&timestamp_hex, 16).ok()
}

fn codex_session_started_near(session_id: &str, started_at_ms: u64) -> bool {
    codex_session_timestamp_ms(session_id).is_some_and(|timestamp| {
        timestamp.abs_diff(started_at_ms) <= CODEX_SESSION_START_TOLERANCE_MS
    })
}

fn lsof_session_paths(output: &str) -> Vec<&str> {
    output
        .lines()
        .filter_map(|line| line.strip_prefix('n'))
        .filter(|path| path.contains("/.codex/sessions/") && path.ends_with(".jsonl"))
        .collect()
}

fn collect_jsonl_files(dir: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_jsonl_files(&path, files)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            files.push(path);
        }
    }
    Ok(())
}

fn system_time_millis(value: Option<SystemTime>) -> Option<u64> {
    value?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn validate_working_directory(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if !path.is_dir() {
        return Err(format!("工作目录不存在: {value}"));
    }
    Ok(path.to_path_buf())
}

fn matching_runtime_mut<'a>(
    sessions: &'a mut HashMap<String, PtyRuntime>,
    session_id: &str,
    generation: &str,
) -> Result<&'a mut PtyRuntime, String> {
    match sessions.get_mut(session_id) {
        Some(runtime) if runtime.generation == generation => Ok(runtime),
        _ => Err("终端会话已停止或已重新启动".to_string()),
    }
}

fn signal_runtime_process_group(runtime: &PtyRuntime) {
    #[cfg(unix)]
    if let Some(process_group) = runtime.master.process_group_leader() {
        unsafe {
            libc::kill(-process_group, libc::SIGHUP);
        }
    }
}

fn shutdown_runtime_and_wait(mut runtime: PtyRuntime) {
    signal_runtime_process_group(&runtime);
    let _ = runtime.child.kill();
    let _ = runtime.child.wait();
}

fn shutdown_runtime(mut runtime: PtyRuntime) {
    signal_runtime_process_group(&runtime);
    std::thread::spawn(move || {
        let _ = runtime.child.kill();
        let _ = runtime.child.wait();
    });
}

fn shutdown_all_ptys(state: &PtyState) {
    if let Ok(mut sessions) = state.sessions.lock() {
        for (_, runtime) in sessions.drain() {
            shutdown_runtime(runtime);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let app = app.clone();
                // Capture the target before dispatching to the main thread. By
                // then the quick palette may already be considered frontmost.
                remember_frontmost_app(&app);
                let callback_app = app.clone();
                let _ = app.run_on_main_thread(move || toggle_quick_palette(&callback_app));
            }
        })
        .build();
    let app = tauri::Builder::default()
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    window
                        .state::<MainWindowCloseRequestState>()
                        .0
                        .store(true, Ordering::SeqCst);
                    let close_window = window.clone();
                    if let Err(error) = window.run_on_main_thread(move || {
                        if let Err(error) =
                            close_window.emit_to("main", "main-window-close-requested", ())
                        {
                            eprintln!("发送主窗口关闭确认事件失败：{error}");
                        }
                    }) {
                        eprintln!("调度主窗口关闭确认事件失败：{error}");
                    }
                }
            }
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(shortcut_plugin)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(PtyState::default())
        .manage(MainWindowCloseRequestState::default())
        .manage(PluginDragState::default())
        .manage(SpeechState::default())
        .manage(PaletteState {
            previous_app: Mutex::new(None),
            shortcut: Mutex::new(DEFAULT_GLOBAL_SHORTCUT.to_string()),
        })
        .manage(StorageGate::default())
        .setup(|app| {
            let preferred =
                saved_global_shortcut().unwrap_or_else(|| DEFAULT_GLOBAL_SHORTCUT.to_string());
            let mut candidates = vec![
                preferred,
                DEFAULT_GLOBAL_SHORTCUT.to_string(),
                "Control+Shift+Space".to_string(),
            ];
            candidates.dedup();
            for shortcut in candidates {
                if app.global_shortcut().register(shortcut.as_str()).is_ok() {
                    if let Ok(mut current) = app.state::<PaletteState>().shortcut.lock() {
                        *current = shortcut;
                    }
                    break;
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            if let Some(window) = app.get_webview_window("quick-palette") {
                let _ = configure_quick_palette_window(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_promptpad_file,
            write_promptpad_file,
            load_ai_workspace,
            save_ai_workspace,
            load_ai_session_history,
            load_claude_transcript,
            load_codex_transcript,
            append_ai_session_history,
            complete_gui_message,
            delete_ai_session_histories,
            commit_ai_session_deletion,
            open_external_url,
            open_plugin_window,
            run_shell_command,
            list_git_roots,
            list_git_status,
            read_git_diff,
            open_system_terminal,
            start_pty,
            poll_pty,
            write_pty,
            resize_pty,
            stop_pty,
            start_speech_recognition,
            stop_speech_recognition,
            wait_speech_recognition_result,
            prepare_pty_restart,
            choose_working_directory,
            validate_working_directory_path,
            open_working_directory,
            choose_document_directory,
            choose_document_file,
            export_toolbox_config,
            export_agent_center_config,
            choose_toolbox_import_file,
            choose_agent_center_import_file,
            list_document_tree,
            read_document_file,
            read_context_file,
            scan_recent_changes,
            find_agent_session_id,
            agent_session_exists,
            find_pty_session_id,
            list_agent_skills,
            set_clipboard_text,
            get_clipboard_text,
            paste_clipboard,
            hide_quick_palette,
            hide_main_window,
            take_main_window_close_request,
            exit_app,
            request_accessibility_permission,
            start_quick_palette_drag,
            start_plugin_window_drag,
            start_plugin_window_follow,
            stop_plugin_window_follow,
            open_accessibility_settings,
            paste_to_previous_app,
            set_global_shortcut
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = &event {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        if matches!(
            &event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            shutdown_all_ptys(&app_handle.state::<PtyState>());
            #[cfg(target_os = "macos")]
            shutdown_speech(&app_handle.state::<SpeechState>());
        }
    });
}

fn main() {
    run();
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::quick_palette_window_level;
    use super::{
        agent_launch_spec, claude_project_key, codex_resume_pids_from_process_list,
        codex_session_started_near, codex_session_timestamp_ms, is_expected_speech_stop_error,
        is_supported_document_file, list_document_children, lsof_session_paths,
        migrate_storage_directory, parse_claude_session_id, parse_claude_transcript,
        parse_codex_session_meta, parse_codex_transcript,
        paste_delivery_allows_missing_focused_element, paste_delivery_path,
        paste_delivery_requires_frontmost, resolve_document_path, resolve_program_from_candidates,
        restore_target_window_script, scan_recent_changes_sync, speech_helper_exit_message,
        storage_directory_name, terminal_color_env, terminal_color_env_removals,
        terminal_launch_script, valid_bundle_id, validate_working_directory, PasteDeliveryPath,
        PendingOutput, SpeechEvent,
    };
    #[cfg(target_os = "macos")]
    use objc2_app_kit::NSScreenSaverWindowLevel;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::{
        fs, io,
        path::Path,
        time::{SystemTime, UNIX_EPOCH},
    };

    const SESSION_ID: &str = "019f8565-e310-7f73-b003-8d5bf94a7982";

    #[test]
    fn resolves_codex_from_fallback_candidates_when_path_is_missing() {
        let root = std::env::temp_dir().join(format!(
            "agentbox-codex-resolution-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let fallback = root.join("codex");
        fs::write(&fallback, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        fs::set_permissions(&fallback, fs::Permissions::from_mode(0o755)).unwrap();

        let resolved = resolve_program_from_candidates("codex", &[], &[fallback.clone()]);

        assert_eq!(resolved, fallback.to_string_lossy());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn skips_non_executable_path_candidates_before_resolving_program() {
        let root = std::env::temp_dir().join(format!(
            "agentbox-executable-resolution-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let bad_bin = root.join("bad-bin");
        let good_bin = root.join("good-bin");
        fs::create_dir_all(&bad_bin).unwrap();
        fs::create_dir_all(&good_bin).unwrap();
        let bad_claude = bad_bin.join("claude");
        let good_claude = good_bin.join("claude");
        fs::write(&bad_claude, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&bad_claude, fs::Permissions::from_mode(0o644)).unwrap();
        fs::write(&good_claude, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&good_claude, fs::Permissions::from_mode(0o755)).unwrap();

        let resolved = resolve_program_from_candidates("claude", &[bad_bin, good_bin], &[]);

        assert_eq!(resolved, good_claude.to_string_lossy());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_only_real_claude_conversation_messages() {
        let transcript = [
            r#"{"type":"attachment","content":"startup"}"#,
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"internal"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"你好"},"timestamp":"2026-09-01T10:00:00Z"}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read"}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"第一段"}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"第二段"}]}}"#,
        ].join("\n");

        let messages = parse_claude_transcript(&transcript);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].kind, "user");
        assert_eq!(messages[0].text, "你好");
        assert_eq!(messages[1].kind, "assistant");
        assert_eq!(messages[1].text, "第一段\n\n第二段");
    }

    #[test]
    fn parses_only_real_codex_conversation_messages() {
        let transcript = [
            r#"{"type":"session_meta","payload":{"id":"019f8565-e310-7f73-b003-8d5bf94a7982","cwd":"/tmp/project"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"internal instructions"}]}}"#,
            r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\n@CLAUDE.md\n\n<!-- OPENWIKI:START -->\n\n## OpenWiki\n\nThis repository has generated context.\n\n<!-- OPENWIKI:END -->"}]}}"##,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"请检查这个问题"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"第一段回答"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}"}}"#,
            r#"{"type":"event_msg","payload":{"type":"exec_command_begin","command":"pwd"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"第二段回答"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"tool","content":[{"type":"output_text","text":"工具输出不应显示"}]}}"#,
        ]
        .join("\n");

        let messages = parse_codex_transcript(&transcript);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].kind, "user");
        assert_eq!(messages[0].text, "请检查这个问题");
        assert_eq!(messages[1].kind, "assistant");
        assert_eq!(messages[1].text, "第一段回答\n\n第二段回答");
    }

    #[test]
    fn serializes_speech_recording_id_for_frontend() {
        let event = serde_json::to_value(SpeechEvent {
            kind: "ready".to_string(),
            message: None,
            recording_id: "speech-test".to_string(),
            is_final: None,
            text: None,
        })
        .unwrap();
        assert_eq!(event["recordingId"], "speech-test");
        assert!(event.get("recording_id").is_none());
    }

    #[test]
    fn treats_a_closed_speech_helper_as_a_completed_stop() {
        assert!(is_expected_speech_stop_error(&io::Error::from(
            io::ErrorKind::BrokenPipe
        )));
        assert!(!is_expected_speech_stop_error(&io::Error::from(
            io::ErrorKind::PermissionDenied
        )));
    }

    #[test]
    fn reports_a_speech_helper_that_exits_without_a_terminal_event() {
        assert_eq!(
            speech_helper_exit_message(false, "fatal: microphone capture aborted"),
            Some("语音组件意外退出：fatal: microphone capture aborted".to_string())
        );
        assert_eq!(speech_helper_exit_message(true, "ignored"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn quick_palette_uses_a_level_above_fullscreen_apps() {
        assert_eq!(quick_palette_window_level(), NSScreenSaverWindowLevel);
    }

    #[test]
    fn finds_only_codex_processes_holding_the_requested_resume_id() {
        let output = r#"
35468 node /opt/bin/codex resume 019f7b31-5706-7c31-9818-8f27a1bf03d8
35469 /opt/vendor/codex resume 019f7b31-5706-7c31-9818-8f27a1bf03d8
40000 /opt/vendor/codex resume 019aaaaaaaaaaaaaaaaaaaaaaaaaaaaa
50000 bash -lc echo 019f7b31-5706-7c31-9818-8f27a1bf03d8
"#;
        assert_eq!(
            codex_resume_pids_from_process_list(output, "019f7b31-5706-7c31-9818-8f27a1bf03d8"),
            vec![35468, 35469]
        );
    }

    #[test]
    fn validates_frontmost_application_bundle_ids() {
        assert!(valid_bundle_id("com.larksuite.feishu"));
        assert!(valid_bundle_id("com.jetbrains.intellij.ce"));
        assert!(!valid_bundle_id("com.example\"\nkey code 36"));
        assert!(!valid_bundle_id(""));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn routes_palette_inserts_by_captured_control_kind() {
        assert_eq!(
            paste_delivery_path("com.zz.toolbox", None),
            PasteDeliveryPath::InternalEvent
        );
        assert_eq!(
            paste_delivery_path("com.apple.Terminal", Some("Shell")),
            PasteDeliveryPath::FocusedKeyboard
        );
        assert_eq!(
            paste_delivery_path("com.jetbrains.intellij", Some("Terminal")),
            PasteDeliveryPath::FocusedKeyboard
        );
        assert_eq!(
            paste_delivery_path("com.jetbrains.intellij", Some("Editor")),
            PasteDeliveryPath::DirectAccessibility
        );
        assert_eq!(
            paste_delivery_path("com.google.Chrome", Some("text field")),
            PasteDeliveryPath::DirectAccessibility
        );
        assert_eq!(
            paste_delivery_path("com.openai.codex", Some("Web area")),
            PasteDeliveryPath::FocusedKeyboard
        );
        assert_eq!(
            paste_delivery_path("com.openai.chatgpt", Some("Web area")),
            PasteDeliveryPath::FocusedKeyboard
        );
        assert!(paste_delivery_requires_frontmost(
            PasteDeliveryPath::FocusedKeyboard
        ));
        assert!(paste_delivery_allows_missing_focused_element(
            PasteDeliveryPath::FocusedKeyboard
        ));
        assert!(!paste_delivery_allows_missing_focused_element(
            PasteDeliveryPath::DirectAccessibility
        ));
        assert!(!paste_delivery_requires_frontmost(
            PasteDeliveryPath::DirectAccessibility
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn restores_the_target_process_and_raises_its_window_before_keyboard_delivery() {
        let script = restore_target_window_script(21_322);
        assert!(script.contains("unix id is 21322"));
        assert!(script.contains("set frontmost of targetProcess to true"));
        assert!(script.contains("perform action \"AXRaise\" of window 1"));
    }

    #[test]
    fn builds_claude_launch_modes() {
        let new = agent_launch_spec(
            "claude",
            Some("Claude Sonnet 4.6"),
            Some(SESSION_ID),
            false,
            false,
        )
        .unwrap();
        let resume = agent_launch_spec("claude", None, Some(SESSION_ID), true, false).unwrap();
        let fallback = agent_launch_spec("claude", None, None, true, true).unwrap();

        assert_eq!(
            new.args,
            vec![
                "--model".to_string(),
                "Claude Sonnet 4.6".to_string(),
                "--session-id".to_string(),
                SESSION_ID.to_string()
            ]
        );
        assert_eq!(
            resume.args,
            vec!["--resume".to_string(), SESSION_ID.to_string()]
        );
        assert_eq!(fallback.args, vec!["--continue".to_string()]);
        assert_eq!(
            (new.program, resume.program, fallback.program),
            (
                "claude".to_string(),
                "claude".to_string(),
                "claude".to_string()
            )
        );
    }

    #[test]
    fn builds_codex_launch_modes() {
        let new = agent_launch_spec("codex", Some("gpt-5.5"), None, false, false).unwrap();
        let resume = agent_launch_spec("codex", None, Some(SESSION_ID), true, false).unwrap();
        let fallback = agent_launch_spec("codex", None, None, true, true);

        assert_eq!(new.args, vec!["--model".to_string(), "gpt-5.5".to_string()]);
        assert_eq!(
            resume.args,
            vec!["resume".to_string(), SESSION_ID.to_string()]
        );
        assert!(fallback.is_err());
        assert_eq!(
            (new.program, resume.program),
            ("codex".to_string(), "codex".to_string())
        );
    }

    #[test]
    fn builds_plain_terminal_launch_mode() {
        let terminal = agent_launch_spec("terminal", None, None, false, false).unwrap();
        let resume = agent_launch_spec("terminal", None, None, true, false);

        assert_eq!(terminal.program, super::default_shell());
        assert_eq!(terminal.args, vec!["-l".to_string()]);
        assert!(resume.is_err());
    }

    #[test]
    fn terminal_color_environment_forces_cli_color_output() {
        let env = terminal_color_env();
        assert!(env.contains(&("TERM".to_string(), "xterm-256color".to_string())));
        assert!(env.contains(&("COLORTERM".to_string(), "truecolor".to_string())));
        assert!(env.contains(&("CLICOLOR_FORCE".to_string(), "1".to_string())));
        assert!(env.contains(&("FORCE_COLOR".to_string(), "1".to_string())));
        assert!(terminal_color_env_removals().contains(&"NO_COLOR"));
        assert!(terminal_launch_script().contains("unset NO_COLOR"));
        assert!(terminal_launch_script().contains("FORCE_COLOR=1"));
    }

    #[test]
    fn channel_output_is_not_added_to_poll_fallback_buffer() {
        assert!(!super::should_buffer_pty_output(true));
        assert!(super::should_buffer_pty_output(false));
    }

    #[test]
    fn utf8_decoder_waits_for_a_complete_multibyte_character() {
        let bytes = "中文".as_bytes();
        let (first, consumed) = super::decode_complete_utf8_prefix(&bytes[..4]);
        assert_eq!(first, "中");
        assert_eq!(consumed, 3);

        let mut remaining = bytes[consumed..4].to_vec();
        remaining.extend_from_slice(&bytes[4..]);
        let (second, consumed) = super::decode_complete_utf8_prefix(&remaining);
        assert_eq!(second, "文");
        assert_eq!(consumed, remaining.len());
    }

    #[test]
    fn rejects_unknown_agents_and_invalid_session_ids() {
        assert!(agent_launch_spec("other", None, None, false, false).is_err());
        assert!(agent_launch_spec("claude", None, Some("bad"), false, false).is_err());
    }

    #[test]
    fn rejects_missing_working_directory() {
        let result = validate_working_directory("/definitely/missing/agentbox-directory");
        assert!(result.is_err());
    }

    #[test]
    fn accepts_existing_working_directory() {
        let root = std::env::temp_dir().join(format!(
            "agentbox-working-directory-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();

        let result = validate_working_directory(root.to_str().unwrap());

        assert!(result.is_ok());
        let _ = fs::remove_dir(&root);
    }

    #[test]
    fn buffers_and_drains_pty_output() {
        let mut output = PendingOutput::with_limit(6);
        output.push(b"1234");
        output.push(b"5678");

        assert_eq!(output.drain(), "345678");
        assert_eq!(output.drain(), "");
    }

    #[test]
    fn parses_matching_codex_session_metadata() {
        let line = format!(
            r#"{{"type":"session_meta","payload":{{"id":"{SESSION_ID}","cwd":"/tmp/project"}}}}"#
        );

        assert_eq!(
            parse_codex_session_meta(&line, "/tmp/project"),
            Some(SESSION_ID.to_string())
        );
        assert_eq!(parse_codex_session_meta(&line, "/tmp/other"), None);
    }

    #[test]
    fn matches_codex_candidates_by_uuid_creation_time_instead_of_file_modification_time() {
        let own_session = "01a02256-ef08-7db2-9d03-62d77304c323";
        let unrelated_session = "01a0223d-9f12-7640-96dd-c5699dde4605";
        let launch_time = 1_787_282_517_354;

        assert_eq!(
            codex_session_timestamp_ms(own_session),
            Some(1_787_282_517_768)
        );
        assert!(codex_session_started_near(own_session, launch_time));
        assert!(!codex_session_started_near(unrelated_session, launch_time));
    }

    #[test]
    fn extracts_only_codex_rollout_paths_from_lsof_field_output() {
        let output = r#"p13838
n/Users/example/.codex/sessions/2026/08/21/rollout-own.jsonl
n/dev/ttys002
p57210
n/Users/example/.codex/history.jsonl
"#;

        assert_eq!(
            lsof_session_paths(output),
            vec!["/Users/example/.codex/sessions/2026/08/21/rollout-own.jsonl"]
        );
    }

    #[test]
    fn maps_claude_project_directory_and_parses_session_id() {
        let line = format!(r#"{{"type":"last-prompt","sessionId":"{SESSION_ID}"}}"#);

        assert_eq!(
            claude_project_key("/tmp/agentbox-project"),
            "-tmp-agentbox-project"
        );
        assert_eq!(parse_claude_session_id(&line), Some(SESSION_ID.to_string()));
    }
    #[test]
    fn recognizes_supported_document_files() {
        assert!(is_supported_document_file(Path::new("README.md")));
        assert!(is_supported_document_file(Path::new("ProductFacade.java")));
        assert!(is_supported_document_file(Path::new("config.json")));
        assert!(is_supported_document_file(Path::new("app.log")));
        for path in [
            "方案.docx",
            "旧版.doc",
            "说明.pdf",
            "富文本.rtf",
            "文档.odt",
            "表格.ods",
            "演示.odp",
            "截图.png",
            "截图.jpg",
            "截图.jpeg",
            "动画.gif",
            "图标.svg",
            "script.sh",
            "script.bash",
            "tool.py",
            "service.go",
            "main.c",
            "main.cpp",
            "header.h",
            "component.vue",
            "settings.ini",
            "server.conf",
            ".env",
        ] {
            assert!(is_supported_document_file(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn document_tree_includes_every_regular_file() {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agentbox-doc-tree-{id}"));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src").join("BrandSourceEnum.java"),
            "enum BrandSourceEnum {}",
        )
        .unwrap();
        fs::write(root.join("image.png"), [0_u8, 1, 2, 3]).unwrap();

        let mut count = 0;
        let tree = list_document_children(&root, &root, 0, &mut count).unwrap();

        assert!(tree
            .iter()
            .any(|node| node.name == "image.png" && node.kind == "file"));
        let src = tree.iter().find(|node| node.name == "src").unwrap();
        assert!(src
            .children
            .as_ref()
            .unwrap()
            .iter()
            .any(|node| node.name == "BrandSourceEnum.java"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn change_tracker_keeps_recent_deep_worktree_file_when_many_old_files_exist() {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agentbox-change-tracker-{id}"));
        let archived = root.join("archived/old");
        fs::create_dir_all(&archived).unwrap();
        for index in 0..120 {
            fs::write(archived.join(format!("old-{index}.md")), "old").unwrap();
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        let deep_dir = root.join("requirements/sample/worktrees/sample-service/service/src/main/java/com/example/sample_service/pricing");
        fs::create_dir_all(&deep_dir).unwrap();
        let target = deep_dir.join("LeaseSystemPricingServiceImpl.java");
        fs::write(&target, "class LeaseSystemPricingServiceImpl {}").unwrap();

        let files = scan_recent_changes_sync(root.to_string_lossy().to_string(), 1).unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "LeaseSystemPricingServiceImpl.java");
        assert!(files[0]
            .path
            .contains("requirements/sample/worktrees/sample-service"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn document_tree_keeps_deep_java_paths_and_empty_directories() {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agentbox-doc-deep-{id}"));
        let deep_dir = root.join("requirements/sample/worktrees/sample-service/service/src/main/java/com/example/sample_service/enums");
        fs::create_dir_all(&deep_dir).unwrap();
        fs::create_dir_all(root.join("empty-dir")).unwrap();
        fs::write(
            deep_dir.join("BrandSourceEnum.java"),
            "enum BrandSourceEnum {}",
        )
        .unwrap();

        let mut count = 0;
        let tree = list_document_children(&root, &root, 0, &mut count).unwrap();

        assert!(tree_contains_path(&tree, "requirements/sample/worktrees/sample-service/service/src/main/java/com/example/sample_service/enums/BrandSourceEnum.java"));
        assert!(tree_contains_path(&tree, "empty-dir"));

        fs::remove_dir_all(root).unwrap();
    }

    fn tree_contains_path(nodes: &[super::DocumentNode], path: &str) -> bool {
        nodes.iter().any(|node| {
            node.path == path
                || node
                    .children
                    .as_ref()
                    .is_some_and(|children| tree_contains_path(children, path))
        })
    }

    #[test]
    fn rejects_document_paths_outside_root() {
        let root = Path::new("/tmp/project");
        let result = resolve_document_path(root, "../secret.md");

        assert!(result.is_err());
    }

    #[test]
    fn uses_agentbox_storage_directory_and_migrates_legacy_files_without_overwriting_new_data() {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agentbox-storage-migration-{id}"));
        let legacy = root.join(".promptpad");
        let current = root.join(".agentbox");
        fs::create_dir_all(legacy.join("ai_session_history")).unwrap();
        fs::write(legacy.join("features.json"), "legacy features").unwrap();
        fs::write(
            legacy.join("ai_session_history").join("session-1.log"),
            "legacy history",
        )
        .unwrap();
        fs::create_dir_all(&current).unwrap();
        fs::write(current.join("features.json"), "new features").unwrap();

        migrate_storage_directory(&legacy, &current).unwrap();

        assert_eq!(
            fs::read_to_string(current.join("features.json")).unwrap(),
            "new features"
        );
        assert_eq!(
            fs::read_to_string(current.join("ai_session_history").join("session-1.log")).unwrap(),
            "legacy history"
        );
        assert_eq!(storage_directory_name(), ".agentbox");

        fs::remove_dir_all(root).unwrap();
    }
}
