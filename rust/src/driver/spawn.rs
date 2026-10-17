use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use std::collections::VecDeque;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, Notify};
use tokio::time::{sleep, timeout};

const MAX_STDOUT: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct CapturedRun {
    pub code: Option<i32>,
    pub stdout: String,
    pub timed_out: bool,
}

pub async fn run_captured(bin: &str, args: &[String], cwd: &str, timeout_ms: u64) -> Result<CapturedRun, String> {
    let (program, program_args) = resolve_command(bin, args)?;
    let mut child = command(&program, &program_args, cwd, Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start {bin}: {e}"))?;
    drain(child.stderr.take());

    let mut stdout_pipe = child.stdout.take().ok_or_else(|| "missing stdout".to_string())?;
    let read = async {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let n = tokio::io::AsyncReadExt::read(&mut stdout_pipe, &mut chunk)
                .await
                .map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            if buf.len() < MAX_STDOUT {
                let room = MAX_STDOUT - buf.len();
                buf.extend_from_slice(&chunk[..n.min(room)]);
            }
        }
        Ok::<_, String>(String::from_utf8_lossy(&buf).into_owned())
    };

    match timeout(Duration::from_millis(timeout_ms), async {
        let stdout = read.await?;
        let status = child.wait().await.map_err(|e| e.to_string())?;
        Ok::<_, String>(CapturedRun {
            code: status.code(),
            stdout,
            timed_out: false,
        })
    })
    .await
    {
        Ok(result) => result,
        Err(_) => {
            kill_tree(&mut child);
            let _ = child.wait().await;
            Ok(CapturedRun {
                code: None,
                stdout: String::new(),
                timed_out: true,
            })
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveLine {
    Text(String),
    Idle,
    Eof,
}

struct LiveInner {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    queue: Mutex<VecDeque<Option<String>>>,
    notify: Notify,
    timed_out: AtomicBool,
    exited: AtomicBool,
    exit_code: AtomicI32,
    start_error: Mutex<Option<String>>,
    kill_armed: AtomicBool,
    timeout_ms: u64,
    timeout_gen: std::sync::atomic::AtomicU64,
}

#[derive(Clone)]
pub struct LiveProcess {
    inner: Arc<LiveInner>,
}

impl LiveProcess {
    pub fn write(&self, line: &str) {
        let payload = if line.ends_with('\n') {
            line.to_string()
        } else {
            format!("{line}\n")
        };
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let mut guard = inner.stdin.lock().await;
            if let Some(stdin) = guard.as_mut() {
                let _ = stdin.write_all(payload.as_bytes()).await;
                let _ = stdin.flush().await;
            }
        });
    }

    pub fn end_input(&self) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let mut guard = inner.stdin.lock().await;
            if let Some(mut stdin) = guard.take() {
                let _ = stdin.shutdown().await;
            }
        });
    }

    pub fn kill(&self) {
        self.inner.kill_armed.store(false, Ordering::SeqCst);
        let inner = self.inner.clone();
        tokio::spawn(async move {
            if let Some(child) = inner.child.lock().await.as_mut() {
                kill_tree(child);
            }
        });
    }

    pub fn pause_timeout(&self) {
        self.inner.kill_armed.store(false, Ordering::SeqCst);
        self.inner.timeout_gen.fetch_add(1, Ordering::SeqCst);
    }

    pub fn arm_timeout(&self) {
        self.inner.kill_armed.store(true, Ordering::SeqCst);
        let gen = self.inner.timeout_gen.fetch_add(1, Ordering::SeqCst) + 1;
        let inner = self.inner.clone();
        let ms = inner.timeout_ms;
        tokio::spawn(async move {
            sleep(Duration::from_millis(ms)).await;
            if inner.timeout_gen.load(Ordering::SeqCst) != gen {
                return;
            }
            if !inner.kill_armed.load(Ordering::SeqCst) {
                return;
            }
            inner.timed_out.store(true, Ordering::SeqCst);
            if let Some(child) = inner.child.lock().await.as_mut() {
                kill_tree(child);
            }
        });
    }

    pub fn timed_out(&self) -> bool {
        self.inner.timed_out.load(Ordering::SeqCst)
    }

    pub fn exit_code(&self) -> Option<i32> {
        if self.inner.exited.load(Ordering::SeqCst) {
            let code = self.inner.exit_code.load(Ordering::SeqCst);
            if code == i32::MIN {
                None
            } else {
                Some(code)
            }
        } else {
            None
        }
    }

    pub async fn start_error(&self) -> Option<String> {
        self.inner.start_error.lock().await.clone()
    }

    pub async fn read_line(&self, idle_ms: Option<u64>) -> Result<LiveLine, String> {
        if let Some(err) = self.start_error().await {
            return Err(err);
        }
        let wait = async {
            loop {
                let notified = self.inner.notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if let Some(item) = self.inner.queue.lock().await.pop_front() {
                    return item;
                }
                notified.await;
            }
        };
        if let Some(ms) = idle_ms {
            match timeout(Duration::from_millis(ms), wait).await {
                Ok(Some(line)) => Ok(LiveLine::Text(line)),
                Ok(None) => Ok(LiveLine::Eof),
                Err(_) => Ok(LiveLine::Idle),
            }
        } else {
            match wait.await {
                Some(line) => Ok(LiveLine::Text(line)),
                None => Ok(LiveLine::Eof),
            }
        }
    }
}

pub fn spawn_live(bin: &str, args: &[String], cwd: &str, timeout_ms: u64) -> LiveProcess {
    let inner = Arc::new(LiveInner {
        stdin: Mutex::new(None),
        child: Mutex::new(None),
        queue: Mutex::new(VecDeque::new()),
        notify: Notify::new(),
        timed_out: AtomicBool::new(false),
        exited: AtomicBool::new(false),
        exit_code: AtomicI32::new(i32::MIN),
        start_error: Mutex::new(None),
        kill_armed: AtomicBool::new(true),
        timeout_ms,
        timeout_gen: std::sync::atomic::AtomicU64::new(0),
    });
    let live = LiveProcess {
        inner: inner.clone(),
    };

    match resolve_command(bin, args) {
        Ok((program, program_args)) => match command(&program, &program_args, cwd, Stdio::piped()).spawn() {
            Ok(mut child) => {
                let stdin = child.stdin.take();
                let stdout = child.stdout.take();
                drain(child.stderr.take());
                {
                    let inner = inner.clone();
                    tokio::spawn(async move {
                        *inner.stdin.lock().await = stdin;
                        *inner.child.lock().await = Some(child);
                    });
                }
                if let Some(stdout) = stdout {
                    let inner = inner.clone();
                    tokio::spawn(async move {
                        let mut reader = BufReader::new(stdout);
                        let mut buf = String::new();
                        let mut size = 0usize;
                        loop {
                            buf.clear();
                            match reader.read_line(&mut buf).await {
                                Ok(0) => break,
                                Ok(n) => {
                                    size += n;
                                    if size > MAX_STDOUT {
                                        continue;
                                    }
                                    let line = buf.trim_end_matches(['\r', '\n']).to_string();
                                    inner.queue.lock().await.push_back(Some(line));
                                    inner.notify.notify_waiters();
                                }
                                Err(_) => break,
                            }
                        }
                        inner.queue.lock().await.push_back(None);
                        inner.notify.notify_waiters();
                    });
                } else {
                    let inner = inner.clone();
                    tokio::spawn(async move {
                        inner.queue.lock().await.push_back(None);
                        inner.notify.notify_waiters();
                    });
                }
                let waiter = inner.clone();
                tokio::spawn(async move {
                    loop {
                        let code = {
                            let mut guard = waiter.child.lock().await;
                            match guard.as_mut() {
                                Some(child) => match child.try_wait() {
                                    Ok(Some(status)) => Some(status.code()),
                                    Ok(None) => None,
                                    Err(_) => Some(None),
                                },
                                None => {
                                    drop(guard);
                                    sleep(Duration::from_millis(5)).await;
                                    continue;
                                }
                            }
                        };
                        if let Some(code) = code {
                            waiter.exited.store(true, Ordering::SeqCst);
                            waiter.exit_code.store(code.unwrap_or(i32::MIN), Ordering::SeqCst);
                            break;
                        }
                        sleep(Duration::from_millis(20)).await;
                    }
                });
                live.arm_timeout();
            }
            Err(err) => {
                let msg = format!("could not start {bin}: {err}");
                let inner = inner.clone();
                tokio::spawn(async move {
                    *inner.start_error.lock().await = Some(msg);
                    inner.queue.lock().await.push_back(None);
                    inner.notify.notify_waiters();
                });
            }
        },
        Err(err) => {
            let inner = inner.clone();
            tokio::spawn(async move {
                *inner.start_error.lock().await = Some(err);
                inner.queue.lock().await.push_back(None);
                inner.notify.notify_waiters();
            });
        }
    }

    live
}

fn command(program: &str, args: &[String], cwd: &str, stdin: Stdio) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}

fn drain<R: tokio::io::AsyncRead + Unpin + Send + 'static>(reader: Option<R>) {
    if let Some(mut reader) = reader {
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut reader, &mut tokio::io::sink()).await;
        });
    }
}

fn kill_tree(child: &mut Child) {
    if let Some(pid) = child.id() {
        #[cfg(unix)]
        let _ = std::process::Command::new("kill").args(["-KILL", &format!("-{pid}")]).status();
        #[cfg(windows)]
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.start_kill();
}

pub fn resolve_bin(bin: &str) -> String {
    if !cfg!(windows) || Path::new(bin).extension().is_some() || bin.contains(['/', '\\']) {
        return bin.to_string();
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    let dirs: Vec<_> = std::env::split_paths(&path).collect();
    [".exe", ".cmd"]
        .iter()
        .flat_map(|ext| dirs.iter().map(move |dir| dir.join(format!("{bin}{ext}"))))
        .find(|candidate| candidate.is_file())
        .map(|found| npm_shim_target(&found).unwrap_or(found).to_string_lossy().into_owned())
        .unwrap_or_else(|| bin.to_string())
}

fn npm_shim_target(shim: &Path) -> Option<std::path::PathBuf> {
    if !shim.extension()?.eq_ignore_ascii_case("cmd") {
        return None;
    }
    let text = std::fs::read_to_string(shim).ok()?;
    let rel = text.rsplit("\"%dp0%\\").next()?.split('"').next()?;
    let target = shim.parent()?.join(rel);
    target.is_file().then_some(target)
}

fn resolve_command(bin: &str, args: &[String]) -> Result<(String, Vec<String>), String> {
    let resolved = resolve_bin(bin);
    let bin = resolved.as_str();
    let path = Path::new(bin);
    if path.is_file() {
        if let Some(interp) = shebang_interpreter(path) {
            let mut out = vec![bin.to_string()];
            out.extend(args.iter().cloned());
            return Ok((interp, out));
        }
    }
    Ok((bin.to_string(), args.to_vec()))
}

fn shebang_interpreter(path: &Path) -> Option<String> {
    let mut bytes = [0u8; 256];
    let n = std::io::Read::read(&mut std::fs::File::open(path).ok()?, &mut bytes).ok()?;
    let bytes = &bytes[..n];
    if bytes.len() < 2 || bytes[0] != b'#' || bytes[1] != b'!' {
        return None;
    }
    let line = bytes
        .split(|&b| b == b'\n' || b == b'\r')
        .next()
        .and_then(|s| std::str::from_utf8(s).ok())?;
    let rest = line.trim_start_matches("#!").trim();
    if rest.contains("node") {
        return Some("node".into());
    }
    Some("sh".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_shim_points_to_real_binary() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("node_modules").join("tool.exe");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, "").unwrap();
        let shim = dir.path().join("tool.cmd");
        std::fs::write(&shim, "@ECHO off\r\n\"%dp0%\\node_modules\\tool.exe\"   %*\r\n").unwrap();
        assert_eq!(npm_shim_target(&shim), Some(exe));
    }

    #[tokio::test]
    async fn captures_fixture_echo() {
        #[cfg(windows)]
        let (bin, args) = ("cmd", vec!["/C".into(), "echo".into(), "hello-fixture".into()]);
        #[cfg(not(windows))]
        let (bin, args) = ("sh", vec!["-c".into(), "echo hello-fixture".into()]);
        let run = run_captured(bin, &args, ".", 5_000).await.unwrap();
        assert!(!run.timed_out);
        assert!(run.stdout.contains("hello-fixture"));
    }

    #[tokio::test]
    async fn times_out() {
        #[cfg(windows)]
        let (bin, args) = ("ping", vec!["-n".into(), "5".into(), "127.0.0.1".into()]);
        #[cfg(not(windows))]
        let (bin, args) = ("sleep", vec!["5".into()]);
        let run = run_captured(bin, &args, ".", 200).await.unwrap();
        assert!(run.timed_out);
    }

    #[tokio::test]
    async fn live_reads_lines_and_idle() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("live.mjs");
        std::fs::write(
            &script,
            r#"
import { setTimeout as sleep } from 'node:timers/promises';
console.log('one');
await sleep(400);
console.log('two');
"#,
        )
        .unwrap();
        let live = spawn_live(
            "node",
            &[script.to_string_lossy().into_owned()],
            dir.path().to_str().unwrap(),
            10_000,
        );
        assert_eq!(live.read_line(None).await.unwrap(), LiveLine::Text("one".into()));
        assert_eq!(live.read_line(Some(100)).await.unwrap(), LiveLine::Idle);
        assert_eq!(live.read_line(None).await.unwrap(), LiveLine::Text("two".into()));
        assert_eq!(live.read_line(None).await.unwrap(), LiveLine::Eof);
    }
}
