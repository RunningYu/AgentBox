use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

// Reading view needs the complete retained conversation. Keep a generous
// bound for runaway PTY output while avoiding the old 200 KB truncation.
pub const HISTORY_LIMIT: usize = 10_000_000;

const TERMINAL_RESET: &[u8] = b"\x1bc\x1b[2J\x1b[H";
const TERMINAL_SYNC_START: &[u8] = b"\x1b[?2026h";

const WORKSPACE_FILE: &str = "ai_workspace.json";
const LEGACY_FILE: &str = "ai_sessions.json";
const HISTORY_DIR: &str = "ai_session_history";
const STORAGE_LOCK_FILE: &str = ".ai_workspace.lock";
const LOCK_RETRY_DELAY: Duration = Duration::from_millis(25);
const LOCK_RETRY_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceArchive {
    pub version: u8,
    pub groups: Vec<SessionGroup>,
    pub sessions: Vec<SessionMetadata>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub feature_window_states: Vec<FeatureWindowStepState>,
}

impl WorkspaceArchive {
    pub fn empty() -> Self {
        Self {
            version: 2,
            groups: Vec::new(),
            sessions: Vec::new(),
            feature_window_states: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeatureWindowStepState {
    pub feature_id: String,
    pub group_id: Option<String>,
    pub done: HashMap<String, bool>,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroup {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub collapsed: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub id: String,
    pub group_id: Option<String>,
    pub name: String,
    pub agent: Agent,
    pub cwd: String,
    pub status: SessionStatus,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gui_agent: Option<GuiAgent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gui_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_config: Option<AgentSessionConfig>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub agent_config_initialized: bool,
    pub pinned: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub knowledge_bases: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcps: Vec<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Claude,
    Codex,
    Terminal,
    Gui,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GuiAgent {
    Claude,
    Codex,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Starting,
    Running,
    Stopping,
    Stopped,
    Error,
}

pub fn load_or_migrate_workspace(root: &Path) -> Result<WorkspaceArchive, String> {
    with_storage_lock(root, || load_or_migrate_workspace_unlocked(root))
}

pub(crate) fn load_or_migrate_workspace_unlocked(root: &Path) -> Result<WorkspaceArchive, String> {
    load_or_migrate_workspace_unlocked_with_fault(root, false)
}

fn load_or_migrate_workspace_unlocked_with_fault(
    root: &Path,
    fail_after_history_publish: bool,
) -> Result<WorkspaceArchive, String> {
    let workspace_path = root.join(WORKSPACE_FILE);
    if workspace_path.exists() {
        let bytes = fs::read(&workspace_path).map_err(|err| err.to_string())?;
        let archive: WorkspaceArchive =
            serde_json::from_slice(&bytes).map_err(|err| err.to_string())?;
        if archive.version != 2 {
            return Err(format!("不支持的工作区版本: {}", archive.version));
        }
        return Ok(archive);
    }

    let legacy_path = root.join(LEGACY_FILE);
    if !legacy_path.exists() {
        return Ok(WorkspaceArchive::empty());
    }
    migrate_legacy(root, &legacy_path, fail_after_history_publish)
}

pub fn save_workspace(root: &Path, archive: &WorkspaceArchive) -> Result<(), String> {
    with_storage_lock(root, || save_workspace_unlocked(root, archive))
}

pub(crate) fn save_workspace_unlocked(
    root: &Path,
    archive: &WorkspaceArchive,
) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|err| err.to_string())?;
    let mut persisted = archive.clone();
    persisted.version = 2;
    let bytes = serde_json::to_vec_pretty(&persisted).map_err(|err| err.to_string())?;
    atomic_write(&root.join(WORKSPACE_FILE), &bytes)
}

pub fn read_history(root: &Path, session_id: &str) -> Result<String, String> {
    with_storage_lock(root, || read_history_unlocked(root, session_id))
}

pub(crate) fn read_history_unlocked(root: &Path, session_id: &str) -> Result<String, String> {
    let path = history_path(root, session_id)?;
    if !path.exists() {
        return Ok(String::new());
    }
    let bytes = fs::read(path).map_err(|err| err.to_string())?;
    Ok(String::from_utf8_lossy(&repair_terminal_history_start(&bytes)).into_owned())
}

pub fn append_history_with_limit(
    root: &Path,
    session_id: &str,
    data: &str,
    limit: usize,
) -> Result<(), String> {
    with_storage_lock(root, || {
        append_history_with_limit_unlocked(root, session_id, data, limit)
    })
}

pub(crate) fn append_history_with_limit_unlocked(
    root: &Path,
    session_id: &str,
    data: &str,
    limit: usize,
) -> Result<(), String> {
    let path = history_path(root, session_id)?;
    let mut existing = read_bounded_tail(&path, limit.saturating_add(3))?;
    let incoming = utf8_tail(data, limit);
    existing.extend_from_slice(incoming.as_bytes());
    let capped = cap_terminal_history(&existing, limit);
    let parent = path
        .parent()
        .ok_or_else(|| "无法解析历史目录".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    atomic_write(&path, &capped)
}

fn cap_terminal_history(bytes: &[u8], limit: usize) -> Vec<u8> {
    if bytes.len() <= limit {
        return bytes.to_vec();
    }
    let tail_start = bytes.len().saturating_sub(limit);
    let tail = &bytes[tail_start..];
    let Some(frame_offset) = find_subslice(tail, TERMINAL_SYNC_START) else {
        return String::from_utf8_lossy(tail).into_owned().into_bytes();
    };
    let mut repaired = Vec::with_capacity(TERMINAL_RESET.len() + tail.len() - frame_offset);
    repaired.extend_from_slice(TERMINAL_RESET);
    repaired.extend_from_slice(&tail[frame_offset..]);
    if repaired.len() <= limit {
        return repaired;
    }
    let valid = String::from_utf8_lossy(&repaired);
    utf8_tail(&valid, limit).as_bytes().to_vec()
}

fn repair_terminal_history_start(bytes: &[u8]) -> Vec<u8> {
    if bytes.is_empty() || starts_at_terminal_boundary(bytes) {
        return bytes.to_vec();
    }
    let Some(offset) = find_subslice(bytes, TERMINAL_SYNC_START) else {
        return bytes.to_vec();
    };
    let mut repaired = Vec::with_capacity(TERMINAL_RESET.len() + bytes.len() - offset);
    repaired.extend_from_slice(TERMINAL_RESET);
    repaired.extend_from_slice(&bytes[offset..]);
    repaired
}

fn starts_at_terminal_boundary(bytes: &[u8]) -> bool {
    bytes.starts_with(TERMINAL_RESET)
        || bytes.starts_with(TERMINAL_SYNC_START)
        || !bytes.iter().take(16).any(|byte| *byte == 0x1b)
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[allow(dead_code)]
pub fn delete_histories(root: &Path, session_ids: &[String]) -> Result<(), String> {
    with_storage_lock(root, || delete_histories_unlocked(root, session_ids))
}

pub(crate) fn delete_histories_unlocked(root: &Path, session_ids: &[String]) -> Result<(), String> {
    let mut changed = false;
    for session_id in session_ids {
        let path = history_path(root, session_id)?;
        match fs::remove_file(path) {
            Ok(()) => changed = true,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.to_string()),
        }
    }
    if changed {
        sync_dir_if_exists(&root.join(HISTORY_DIR))?;
    }
    Ok(())
}

pub fn commit_session_deletion(
    root: &Path,
    archive: &WorkspaceArchive,
    session_ids: &[String],
) -> Result<(), String> {
    with_storage_lock(root, || {
        commit_session_deletion_unlocked(root, archive, session_ids)
    })
}

pub(crate) fn commit_session_deletion_unlocked(
    root: &Path,
    archive: &WorkspaceArchive,
    session_ids: &[String],
) -> Result<(), String> {
    commit_session_deletion_unlocked_with_fault(root, archive, session_ids, false)
}

fn commit_session_deletion_unlocked_with_fault(
    root: &Path,
    archive: &WorkspaceArchive,
    session_ids: &[String],
    fail_before_archive_write: bool,
) -> Result<(), String> {
    let history_paths = session_ids
        .iter()
        .map(|id| history_path(root, id))
        .collect::<Result<Vec<_>, _>>()?;
    fs::create_dir_all(root).map_err(|err| err.to_string())?;
    let trash = root.join(unique_name(".ai_session_trash"));
    fs::create_dir(&trash).map_err(|err| err.to_string())?;
    let mut moved = Vec::new();

    for (session_id, source) in session_ids.iter().zip(history_paths.iter()) {
        if !source.exists()
            || moved
                .iter()
                .any(|(id, _, _): &(String, PathBuf, PathBuf)| id == session_id)
        {
            continue;
        }
        let destination = trash.join(format!("{session_id}.log"));
        if let Err(err) = fs::rename(source, &destination) {
            let rollback = restore_moved_histories(&moved);
            return Err(finish_failed_transaction(err.to_string(), rollback, &trash));
        }
        moved.push((session_id.clone(), source.clone(), destination));
    }
    if let Err(err) = sync_dir_if_exists(&root.join(HISTORY_DIR)).and_then(|_| sync_dir(&trash)) {
        let rollback = restore_moved_histories(&moved);
        return Err(finish_failed_transaction(err, rollback, &trash));
    }

    let archive_result = if fail_before_archive_write {
        Err("injected archive write failure".to_string())
    } else {
        save_workspace_unlocked(root, archive)
    };
    if let Err(err) = archive_result {
        let rollback = restore_moved_histories(&moved);
        return Err(finish_failed_transaction(err, rollback, &trash));
    }
    fs::remove_dir_all(&trash).map_err(|err| err.to_string())?;
    sync_dir(root)
}

fn migrate_legacy(
    root: &Path,
    legacy_path: &Path,
    fail_after_history_publish: bool,
) -> Result<WorkspaceArchive, String> {
    let legacy_bytes = fs::read(legacy_path).map_err(|err| err.to_string())?;
    let values: Vec<Value> =
        serde_json::from_slice(&legacy_bytes).map_err(|err| err.to_string())?;
    let mut archive = WorkspaceArchive::empty();
    let mut histories = Vec::new();
    let mut session_ids = HashSet::new();
    for value in values {
        if let Some((session, history)) = parse_legacy_session(&value) {
            if !session_ids.insert(session.id.clone()) {
                continue;
            }
            histories.push((session.id.clone(), history));
            archive.sessions.push(session);
        }
    }

    fs::create_dir_all(root).map_err(|err| err.to_string())?;
    let staging = root.join(unique_name(".ai_session_migration"));
    let staged_histories = staging.join(HISTORY_DIR);
    let staged_workspace = staging.join(WORKSPACE_FILE);
    let result = (|| -> Result<(), String> {
        recover_interrupted_histories(root)?;
        fs::create_dir_all(&staged_histories).map_err(|err| err.to_string())?;
        for (id, history) in &histories {
            write_synced(
                staged_histories.join(format!("{id}.log")),
                utf8_tail(history, HISTORY_LIMIT).as_bytes(),
            )?;
        }
        sync_dir(&staged_histories)?;
        let bytes = serde_json::to_vec_pretty(&archive).map_err(|err| err.to_string())?;
        write_synced(&staged_workspace, &bytes)?;
        sync_dir(&staging)?;

        let final_histories = root.join(HISTORY_DIR);
        let final_workspace = root.join(WORKSPACE_FILE);
        fs::rename(&staged_histories, &final_histories).map_err(|err| err.to_string())?;
        sync_dir(root)?;
        if fail_after_history_publish {
            return Err("injected failure after history publish".to_string());
        }
        if let Err(err) = fs::rename(&staged_workspace, &final_workspace) {
            let _ = fs::remove_dir_all(&final_histories);
            let _ = sync_dir(root);
            return Err(err.to_string());
        }
        if let Err(err) = sync_dir(root) {
            rollback_published_migration(root, &final_workspace, &final_histories, None);
            return Err(err);
        }

        let backup = unique_legacy_backup(root);
        if let Err(err) = fs::rename(legacy_path, &backup) {
            rollback_published_migration(root, &final_workspace, &final_histories, None);
            return Err(err.to_string());
        }
        if let Err(err) = sync_dir(root) {
            rollback_published_migration(
                root,
                &final_workspace,
                &final_histories,
                Some((&backup, legacy_path)),
            );
            return Err(err);
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&staging);
    result.map(|_| archive)
}

fn rollback_published_migration(
    root: &Path,
    workspace: &Path,
    histories: &Path,
    legacy_backup: Option<(&Path, &Path)>,
) {
    if let Some((backup, legacy)) = legacy_backup {
        let _ = fs::rename(backup, legacy);
    }
    let _ = fs::remove_file(workspace);
    let _ = fs::remove_dir_all(histories);
    let _ = sync_dir(root);
}

fn recover_interrupted_histories(root: &Path) -> Result<(), String> {
    let histories = root.join(HISTORY_DIR);
    if !histories.exists() {
        return Ok(());
    }
    let recovery = root.join(format!("{HISTORY_DIR}.recovery.{}", now_nanos()));
    fs::rename(histories, recovery).map_err(|err| err.to_string())?;
    sync_dir(root)
}

fn parse_legacy_session(value: &Value) -> Option<(SessionMetadata, String)> {
    let object = value.as_object()?;
    let id = object.get("id")?.as_str()?;
    if validate_session_id(id).is_err() {
        return None;
    }
    let name = object.get("name")?.as_str()?.to_string();
    let cwd = object.get("cwd")?.as_str()?.to_string();
    let history = object.get("history")?.as_str()?.to_string();
    let agent = match object.get("agent")?.as_str()? {
        "claude" => Agent::Claude,
        "codex" => Agent::Codex,
        "terminal" => Agent::Terminal,
        "gui" => Agent::Gui,
        _ => return None,
    };
    let gui_agent = match object
        .get("guiAgent")
        .or_else(|| object.get("guiModel"))
        .and_then(Value::as_str)
    {
        Some("claude") => Some(GuiAgent::Claude),
        Some("codex") => Some(GuiAgent::Codex),
        _ => None,
    };
    let gui_model = object
        .get("guiModel")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string());
    let cli_session_id = object
        .get("cliSessionId")
        .and_then(Value::as_str)
        .filter(|id| is_session_uuid(id))
        .map(|id| id.to_ascii_lowercase());
    Some((
        SessionMetadata {
            id: id.to_string(),
            group_id: None,
            name,
            agent,
            cwd,
            status: SessionStatus::Stopped,
            created_at: object.get("createdAt")?.as_u64()?,
            updated_at: object.get("updatedAt")?.as_u64()?,
            cli_session_id,
            gui_agent,
            gui_model,
            agent_config: None,
            agent_config_initialized: false,
            pinned: object
                .get("pinned")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        history,
    ))
}

fn history_path(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    Ok(root.join(HISTORY_DIR).join(format!("{session_id}.log")))
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty()
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("会话 ID 仅允许 ASCII 字母、数字、- 和 _".to_string());
    }
    Ok(())
}

fn is_session_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn utf8_tail(value: &str, limit: usize) -> &str {
    if value.len() <= limit {
        return value;
    }
    let mut start = value.len() - limit;
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

fn read_bounded_tail(path: &Path, max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.to_string()),
    };
    let len = file.metadata().map_err(|err| err.to_string())?.len();
    let count = len.min(max_bytes as u64);
    file.seek(SeekFrom::End(-(count as i64)))
        .map_err(|err| err.to_string())?;
    let mut bytes = Vec::with_capacity(count as usize);
    file.take(count)
        .read_to_end(&mut bytes)
        .map_err(|err| err.to_string())?;
    Ok(bytes)
}

pub(crate) fn with_storage_lock<T>(
    root: &Path,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _lock = StorageFileLock::acquire(root)?;
    operation()
}

struct StorageFileLock {
    file: File,
}

impl StorageFileLock {
    fn acquire(root: &Path) -> Result<Self, String> {
        let deadline = Instant::now() + LOCK_RETRY_TIMEOUT;
        loop {
            match Self::try_acquire(root) {
                Ok(lock) => return Ok(lock),
                Err(TryLockError::Busy) => {
                    let now = Instant::now();
                    if now >= deadline {
                        return Err("AI 会话存储正被另一进程使用，请稍后重试".to_string());
                    }
                    thread::sleep(LOCK_RETRY_DELAY.min(deadline - now));
                }
                Err(TryLockError::Other(error)) => return Err(error),
            }
        }
    }

    #[cfg(test)]
    fn try_acquire_once(root: &Path) -> Result<Self, String> {
        Self::try_acquire(root).map_err(|error| match error {
            TryLockError::Busy => "AI 会话存储正被另一进程使用，请稍后重试".to_string(),
            TryLockError::Other(error) => error,
        })
    }

    fn try_acquire(root: &Path) -> Result<Self, TryLockError> {
        fs::create_dir_all(root)
            .map_err(|err| TryLockError::Other(format!("无法创建 AI 会话存储目录: {err}")))?;
        let path = root.join(STORAGE_LOCK_FILE);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&path)
            .map_err(|err| {
                TryLockError::Other(format!("无法打开 AI 会话存储锁 {}: {err}", path.display()))
            })?;
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result == 0 {
            return Ok(Self { file });
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN => {
                Err(TryLockError::Busy)
            }
            _ => Err(TryLockError::Other(format!(
                "无法获取 AI 会话存储锁 {}: {error}",
                path.display()
            ))),
        }
    }
}

impl Drop for StorageFileLock {
    fn drop(&mut self) {
        let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
    }
}

enum TryLockError {
    Busy,
    Other(String),
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "无法解析存储目录".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let temp = parent.join(unique_name(".ai_store_tmp"));
    let result = (|| -> Result<(), String> {
        let mut file = File::create(&temp).map_err(|err| err.to_string())?;
        file.write_all(bytes).map_err(|err| err.to_string())?;
        file.sync_all().map_err(|err| err.to_string())?;
        fs::rename(&temp, path).map_err(|err| err.to_string())?;
        sync_dir(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn restore_moved_histories(moved: &[(String, PathBuf, PathBuf)]) -> Result<(), String> {
    for (session_id, original, trash_path) in moved.iter().rev() {
        if !trash_path.exists() {
            return Err(format!("找不到 {session_id} 的回滚文件"));
        }
        fs::rename(trash_path, original).map_err(|err| err.to_string())?;
    }
    if let Some((_, original, trash_path)) = moved.first() {
        if let Some(history_dir) = original.parent() {
            sync_dir(history_dir)?;
        }
        if let Some(trash_dir) = trash_path.parent() {
            sync_dir(trash_dir)?;
        }
    }
    Ok(())
}

fn finish_failed_transaction(error: String, rollback: Result<(), String>, trash: &Path) -> String {
    match rollback {
        Ok(()) => {
            let _ = fs::remove_dir_all(trash);
            if let Some(root) = trash.parent() {
                let _ = sync_dir(root);
            }
            error
        }
        Err(rollback_error) => format!(
            "{error}; 历史回滚失败: {rollback_error}; 恢复文件保留于 {}",
            trash.display()
        ),
    }
}

fn write_synced(path: impl AsRef<Path>, bytes: &[u8]) -> Result<(), String> {
    let mut file = File::create(path).map_err(|err| err.to_string())?;
    file.write_all(bytes).map_err(|err| err.to_string())?;
    file.sync_all().map_err(|err| err.to_string())
}

fn sync_dir(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|err| format!("无法同步目录 {}: {err}", path.display()))
}

fn sync_dir_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        sync_dir(path)
    } else {
        Ok(())
    }
}

fn unique_name(prefix: &str) -> String {
    format!("{prefix}.{}.{}", std::process::id(), now_nanos())
}

fn unique_legacy_backup(root: &Path) -> PathBuf {
    root.join(format!("ai_sessions.v1.{}.bak", now_nanos()))
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[cfg(test)]
enum MigrationFault {
    AfterHistoryPublish,
}

#[cfg(test)]
fn load_or_migrate_workspace_with_fault(
    root: &Path,
    fault: MigrationFault,
) -> Result<WorkspaceArchive, String> {
    with_storage_lock(root, || match fault {
        MigrationFault::AfterHistoryPublish => {
            load_or_migrate_workspace_unlocked_with_fault(root, true)
        }
    })
}

#[cfg(test)]
enum DeletionFault {
    BeforeArchiveWrite,
}

#[cfg(test)]
fn commit_session_deletion_with_fault(
    root: &Path,
    archive: &WorkspaceArchive,
    session_ids: &[String],
    fault: DeletionFault,
) -> Result<(), String> {
    with_storage_lock(root, || match fault {
        DeletionFault::BeforeArchiveWrite => {
            commit_session_deletion_unlocked_with_fault(root, archive, session_ids, true)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "agentbox-session-store-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn archive_with_session(id: &str) -> WorkspaceArchive {
        WorkspaceArchive {
            version: 2,
            groups: vec![],
            sessions: vec![SessionMetadata {
                id: id.to_string(),
                group_id: None,
                name: "Session".to_string(),
                agent: Agent::Codex,
                cwd: "/tmp/project".to_string(),
                status: SessionStatus::Stopped,
                created_at: 10,
                updated_at: 20,
                cli_session_id: None,
                gui_agent: None,
                gui_model: None,
                agent_config: None,
                agent_config_initialized: false,
                pinned: false,
            }],
            feature_window_states: vec![],
        }
    }

    #[test]
    fn persists_group_pin_and_defaults_old_archives_to_unpinned() {
        let root = temp_root("group-pin");
        let archive = WorkspaceArchive {
            version: 2,
            groups: vec![SessionGroup {
                id: "group-1".to_string(),
                name: "服务瘦身".to_string(),
                created_at: 10,
                collapsed: false,
                pinned: true,
                deleted_at: None,
            }],
            sessions: vec![],
            feature_window_states: vec![],
        };

        save_workspace(&root, &archive).unwrap();
        assert!(load_or_migrate_workspace(&root).unwrap().groups[0].pinned);

        let old_archive = serde_json::json!({
            "version": 2,
            "groups": [{
                "id": "group-1",
                "name": "服务瘦身",
                "createdAt": 10,
                "collapsed": false
            }],
            "sessions": []
        });
        fs::write(
            root.join(WORKSPACE_FILE),
            serde_json::to_vec(&old_archive).unwrap(),
        )
        .unwrap();
        assert!(!load_or_migrate_workspace(&root).unwrap().groups[0].pinned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migrates_v1_metadata_and_extracts_capped_history() {
        let root = temp_root("migration");
        let long_history = format!("{}{}", "x".repeat(HISTORY_LIMIT - 1), "中文");
        let legacy = serde_json::json!([
            {
                "id": "valid-session",
                "name": "Legacy",
                "agent": "codex",
                "cwd": "/tmp/project",
                "status": "running",
                "groupId": "old-group",
                "history": long_history,
                "generation": "runtime-only",
                "error": "runtime-only",
                "createdAt": 10,
                "updatedAt": 20,
                "cliSessionId": "019f8565-e310-7f73-b003-8d5bf94a7982",
                "pinned": true
            },
            { "id": "broken", "history": "ignored" }
        ]);
        fs::write(
            root.join("ai_sessions.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();

        let archive = load_or_migrate_workspace(&root).unwrap();

        assert_eq!(archive.version, 2);
        assert_eq!(archive.groups, vec![]);
        assert_eq!(archive.sessions.len(), 1);
        let session = &archive.sessions[0];
        assert_eq!(session.id, "valid-session");
        assert_eq!(session.group_id, None);
        assert_eq!(session.status, SessionStatus::Stopped);
        assert!(session.pinned);
        assert_eq!(
            session.cli_session_id.as_deref(),
            Some("019f8565-e310-7f73-b003-8d5bf94a7982")
        );
        let history = read_history(&root, "valid-session").unwrap();
        assert!(history.len() <= HISTORY_LIMIT);
        assert!(history.ends_with("中文"));
        assert!(!root.join("ai_sessions.json").exists());
        assert!(fs::read_dir(&root).unwrap().flatten().any(|entry| entry
            .file_name()
            .to_string_lossy()
            .starts_with("ai_sessions.v1.")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_keeps_first_valid_duplicate_id() {
        let root = temp_root("migration-duplicate");
        let legacy = serde_json::json!([
            {
                "id": "duplicate", "name": "First", "agent": "codex",
                "cwd": "/tmp/first", "history": "first-history", "createdAt": 1, "updatedAt": 2
            },
            {
                "id": "duplicate", "name": "Second", "agent": "claude",
                "cwd": "/tmp/second", "history": "second-history", "createdAt": 3, "updatedAt": 4
            }
        ]);
        fs::write(
            root.join("ai_sessions.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();

        let archive = load_or_migrate_workspace(&root).unwrap();

        assert_eq!(archive.sessions.len(), 1);
        assert_eq!(archive.sessions[0].name, "First");
        assert_eq!(read_history(&root, "duplicate").unwrap(), "first-history");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn append_caps_bytes_at_utf8_boundary() {
        let root = temp_root("utf8-cap");
        append_history_with_limit(&root, "session_1", "ab中文cd", 7).unwrap();
        assert_eq!(read_history(&root, "session_1").unwrap(), "文cd");
        append_history_with_limit(&root, "session_1", "🙂🙂", 5).unwrap();
        let history = read_history(&root, "session_1").unwrap();
        assert_eq!(history, "d🙂");
        assert!(history.len() <= 5);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn append_caps_terminal_history_at_complete_sync_frame() {
        let root = temp_root("terminal-history-frame");
        let frame = "\x1b[?2026hnew frame\x1b[?2026l";

        append_history_with_limit(&root, "session-1", &"x".repeat(40), 32).unwrap();
        append_history_with_limit(&root, "session-1", frame, 32).unwrap();

        assert_eq!(
            read_history(&root, "session-1").unwrap(),
            format!("\x1bc\x1b[2J\x1b[H{frame}")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn loading_repairs_history_that_starts_inside_an_ansi_sequence() {
        let root = temp_root("repair-terminal-history");
        let path = history_path(&root, "session-1").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"026lgarbage\x1b[?2026hvalid frame\x1b[?2026l").unwrap();

        assert_eq!(
            read_history(&root, "session-1").unwrap(),
            "\x1bc\x1b[2J\x1b[H\x1b[?2026hvalid frame\x1b[?2026l"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_invalid_session_ids() {
        let root = temp_root("invalid-id");
        for id in ["../escape", "nested/path", "", "会话", "dot.name"] {
            assert!(read_history(&root, id).is_err(), "accepted {id:?}");
            assert!(append_history_with_limit(&root, id, "data", 20).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_migration_preserves_legacy_and_recovers_on_next_load() {
        let root = temp_root("migration-recovery");
        let legacy_path = root.join("ai_sessions.json");
        let legacy = serde_json::json!([{
            "id": "session-1", "name": "Legacy", "agent": "claude",
            "cwd": "/tmp/project", "history": "history", "createdAt": 1, "updatedAt": 2
        }]);
        let original = serde_json::to_vec(&legacy).unwrap();
        fs::write(&legacy_path, &original).unwrap();

        assert!(
            load_or_migrate_workspace_with_fault(&root, MigrationFault::AfterHistoryPublish)
                .is_err()
        );
        assert_eq!(fs::read(&legacy_path).unwrap(), original);
        assert!(!root.join("ai_workspace.json").exists());
        assert!(root.join("ai_session_history").exists());
        assert!(!fs::read_dir(&root).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".ai_session_migration")
        }));

        let archive = load_or_migrate_workspace(&root).unwrap();
        assert_eq!(archive.sessions.len(), 1);
        assert_eq!(read_history(&root, "session-1").unwrap(), "history");
        assert!(fs::read_dir(&root).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("ai_session_history.recovery.")
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn independent_file_handles_cannot_hold_lock_simultaneously() {
        let root = temp_root("flock-exclusive");
        let first = StorageFileLock::acquire(&root).unwrap();
        let competing_root = root.clone();

        let blocked = thread::spawn(move || StorageFileLock::try_acquire_once(&competing_root))
            .join()
            .unwrap();
        let blocked_error = match blocked {
            Err(error) => error,
            Ok(_) => panic!("second handle unexpectedly acquired the lock"),
        };
        assert!(
            blocked_error.contains("另一进程"),
            "unexpected error: {blocked_error}"
        );

        drop(first);
        let released_root = root.clone();
        let acquired_after_release =
            thread::spawn(move || StorageFileLock::acquire(&released_root))
                .join()
                .unwrap();
        assert!(acquired_after_release.is_ok());
        drop(acquired_after_release);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn dropping_guard_releases_lock_without_deleting_lock_file() {
        let root = temp_root("flock-drop");
        let lock_path = root.join(STORAGE_LOCK_FILE);
        let first = StorageFileLock::acquire(&root).unwrap();
        assert!(lock_path.exists());

        drop(first);

        assert!(lock_path.exists());
        let second = StorageFileLock::acquire(&root).unwrap();
        drop(second);
        assert!(lock_path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_appends_are_serialized_without_lost_updates() {
        let root = Arc::new(temp_root("concurrent-append"));
        let barrier = Arc::new(Barrier::new(6));
        let threads = (0..6)
            .map(|index| {
                let root = Arc::clone(&root);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    append_history_with_limit(&root, "shared", &index.to_string(), HISTORY_LIMIT)
                })
            })
            .collect::<Vec<_>>();

        for handle in threads {
            handle.join().unwrap().unwrap();
        }
        let mut chars = read_history(&root, "shared")
            .unwrap()
            .chars()
            .collect::<Vec<_>>();
        chars.sort_unstable();
        assert_eq!(chars, vec!['0', '1', '2', '3', '4', '5']);
        fs::remove_dir_all(root.as_ref()).unwrap();
    }

    #[test]
    fn existing_v2_is_loaded_without_repeating_migration() {
        let root = temp_root("idempotent");
        let archive = archive_with_session("v2-session");
        save_workspace(&root, &archive).unwrap();
        fs::write(root.join("ai_sessions.json"), b"not valid json").unwrap();

        let loaded = load_or_migrate_workspace(&root).unwrap();

        assert_eq!(loaded, archive);
        assert_eq!(
            fs::read(root.join("ai_sessions.json")).unwrap(),
            b"not valid json"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deletion_commits_archive_and_removes_history() {
        let root = temp_root("delete-success");
        append_history_with_limit(&root, "remove-me", "history", HISTORY_LIMIT).unwrap();
        let archive = WorkspaceArchive::empty();

        commit_session_deletion(&root, &archive, &["remove-me".to_string()]).unwrap();

        assert_eq!(load_or_migrate_workspace(&root).unwrap(), archive);
        assert_eq!(read_history(&root, "remove-me").unwrap(), "");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archive_write_failure_preserves_existing_archive_and_rolls_back_histories() {
        let root = temp_root("delete-rollback");
        let baseline = archive_with_session("baseline");
        save_workspace(&root, &baseline).unwrap();
        let original_archive = fs::read(root.join("ai_workspace.json")).unwrap();
        append_history_with_limit(&root, "keep-one", "first", HISTORY_LIMIT).unwrap();
        append_history_with_limit(&root, "keep-two", "second", HISTORY_LIMIT).unwrap();

        assert!(commit_session_deletion_with_fault(
            &root,
            &WorkspaceArchive::empty(),
            &[
                "keep-one".to_string(),
                "keep-two".to_string(),
                "keep-one".to_string(),
            ],
            DeletionFault::BeforeArchiveWrite,
        )
        .is_err());

        assert_eq!(
            fs::read(root.join("ai_workspace.json")).unwrap(),
            original_archive
        );
        assert_eq!(read_history(&root, "keep-one").unwrap(), "first");
        assert_eq!(read_history(&root, "keep-two").unwrap(), "second");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deleting_missing_history_still_commits_archive() {
        let root = temp_root("delete-missing");
        let archive = archive_with_session("remaining");

        commit_session_deletion(&root, &archive, &["missing".to_string()]).unwrap();

        assert_eq!(load_or_migrate_workspace(&root).unwrap(), archive);
        fs::remove_dir_all(root).unwrap();
    }
}
