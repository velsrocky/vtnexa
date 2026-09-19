// Health checks and crash reporting stub.

use std::sync::Mutex;
use std::time::Instant;

#[allow(dead_code)]
const CRASH_REPORT_FILE: &str = "crash_report.json";

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[allow(dead_code)]
pub struct HealthStatus {
    pub frontend_connected: bool,
    pub last_heartbeat: u64,
    pub uptime_secs: u64,
    pub memory_usage_kb: u64,
    pub turn_count: u64,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[allow(dead_code)]
pub struct CrashReport {
    pub timestamp: u64,
    pub reason: String,
    pub stack: Option<String>,
}

#[allow(dead_code)]
pub struct HealthMonitor {
    pub start_time: Instant,
    pub heartbeat: Mutex<u64>,
    pub turn_count: Mutex<u64>,
}

impl Default for HealthMonitor {
    fn default() -> Self {
        Self {
            start_time: Instant::now(),
            heartbeat: Mutex::new(0),
            turn_count: Mutex::new(0),
        }
    }
}

impl HealthMonitor {
    #[allow(dead_code)]
    pub fn status(&self) -> HealthStatus {
        let uptime = self.start_time.elapsed().as_secs();
        let memory_kb = 0;

        HealthStatus {
            frontend_connected: *self.heartbeat.lock().unwrap() > 0,
            last_heartbeat: *self.heartbeat.lock().unwrap(),
            uptime_secs: uptime,
            memory_usage_kb: memory_kb,
            turn_count: *self.turn_count.lock().unwrap(),
        }
    }

    #[allow(dead_code)]
    pub fn heartbeat(&self) {
        *self.heartbeat.lock().unwrap() = Instant::now().elapsed().as_secs();
    }

    #[allow(dead_code)]
    pub fn increment_turns(&self) {
        *self.turn_count.lock().unwrap() += 1;
    }

    #[allow(dead_code)]
    pub fn report_crash(reason: &str) {
        let report = CrashReport {
            timestamp: Instant::now().elapsed().as_secs(),
            reason: reason.to_string(),
            stack: std::backtrace::Backtrace::capture().to_string().into(),
        };
        if let Ok(data) = serde_json::to_string(&report) {
            let _ = std::fs::write(CRASH_REPORT_FILE, data);
        }
    }
}
