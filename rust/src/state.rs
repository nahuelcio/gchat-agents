use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::google::GoogleConnection;
use crate::handler::HandlerDeps;
use crate::health::Health;
use crate::media::MediaStore;
use crate::schedules::{ScheduleStore, Scheduler};
use crate::settings::SettingsStore;
use crate::share::ShareToken;
use crate::transcripts::TranscriptStore;
use crate::workspace::Workspaces;

pub struct AppState {
    pub drive: Arc<crate::google_drive::Drive>,
    pub drive_mcp: Arc<crate::drive_mcp::DriveMcp>,
    pub activity: Arc<crate::activity::ActivityLog>,
    pub settings: Arc<SettingsStore>,
    pub health: Arc<Mutex<Health>>,
    pub schedules: Arc<ScheduleStore>,
    pub scheduler: Arc<Scheduler>,
    pub share: Arc<Mutex<ShareToken>>,
    pub transcripts: Arc<TranscriptStore>,
    pub workspaces: Arc<Workspaces>,
    pub handler: Arc<HandlerDeps>,
    pub google: Arc<GoogleConnection>,
    pub media: Arc<MediaStore>,
    pub web_dir: Option<PathBuf>,
    pub public_url: std::sync::Mutex<Option<String>>,
    pub data_dir: PathBuf,
}
