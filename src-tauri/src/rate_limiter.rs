// Rate limiting for agent turns to prevent token exhaustion and abuse.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

const TURN_WINDOW_SECS: u64 = 60;
const MAX_TURNS_PER_WINDOW: u32 = 30;
#[allow(dead_code)]
const MAX_DAILY_TURNS: u32 = 500;

pub(crate) struct RateLimiter {
    window_turns: Mutex<HashMap<String, Vec<Instant>>>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self { window_turns: Mutex::new(HashMap::new()) }
    }
}

impl RateLimiter {
    pub fn check_turn(&self, window_id: &str) -> Result<(), String> {
        let mut turns = self.window_turns.lock().map_err(|e| format!("lock error: {e}"))?;
        let now = Instant::now();
        
        let window_turns = turns.entry(window_id.to_string()).or_insert_with(Vec::new);
        window_turns.retain(|t| t.elapsed().as_secs() < TURN_WINDOW_SECS);
        
        if window_turns.len() as u32 >= MAX_TURNS_PER_WINDOW {
            let oldest = window_turns.first().unwrap();
            let remaining = oldest.elapsed().as_secs();
            return Err(format!("rate limit exceeded: max {MAX_TURNS_PER_WINDOW} turns per {TURN_WINDOW_SECS}s, wait {remaining}s"));
        }

        window_turns.push(now);
        Ok(())
    }

    #[allow(dead_code)]
    pub fn daily_reset(&mut self) {
        self.window_turns.lock().map(|mut t| t.clear()).ok();
    }
}
