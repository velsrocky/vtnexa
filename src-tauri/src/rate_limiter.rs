// Rate limiting for agent turns to prevent token exhaustion and abuse.
// Per-minute AND daily caps, enforced on every expensive agent op
// (shell_run/bg, mcp_call_tool, gated browser ops) — not just shell_run.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

const TURN_WINDOW_SECS: u64 = 60;
const MAX_TURNS_PER_WINDOW: u32 = 30;
const DAY_SECS: u64 = 24 * 60 * 60;
const MAX_DAILY_TURNS: u32 = 500;

pub(crate) struct RateLimiter {
    window_turns: Mutex<HashMap<String, Vec<Instant>>>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self {
            window_turns: Mutex::new(HashMap::new()),
        }
    }
}

impl RateLimiter {
    pub fn check_turn(&self, window_id: &str) -> Result<(), String> {
        let mut turns = self
            .window_turns
            .lock()
            .map_err(|e| format!("lock error: {e}"))?;
        let now = Instant::now();

        let window_turns = turns.entry(window_id.to_string()).or_insert_with(Vec::new);
        // Bound memory: drop anything older than a day (daily cap horizon).
        window_turns.retain(|t| t.elapsed().as_secs() < DAY_SECS);

        if window_turns.len() as u32 >= MAX_DAILY_TURNS {
            return Err(format!(
                "rate limit exceeded: max {MAX_DAILY_TURNS} agent ops per day for this window"
            ));
        }

        let recent = window_turns
            .iter()
            .filter(|t| t.elapsed().as_secs() < TURN_WINDOW_SECS)
            .count() as u32;
        if recent >= MAX_TURNS_PER_WINDOW {
            let wait = window_turns
                .iter()
                .filter_map(|t| {
                    let e = t.elapsed().as_secs();
                    (e < TURN_WINDOW_SECS).then_some(TURN_WINDOW_SECS - e)
                })
                .max()
                .unwrap_or(1);
            return Err(format!(
                "rate limit exceeded: max {MAX_TURNS_PER_WINDOW} turns per {TURN_WINDOW_SECS}s, wait {wait}s"
            ));
        }

        window_turns.push(now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minute_cap_trips_at_thirty() {
        let r = RateLimiter::default();
        for _ in 0..30 {
            assert!(r.check_turn("w").is_ok());
        }
        let err = r.check_turn("w").unwrap_err();
        assert!(err.contains("30 turns per 60s"), "got: {}", err);
        // Other windows are unaffected.
        assert!(r.check_turn("other").is_ok());
    }

    #[test]
    fn daily_cap_trips_at_five_hundred() {
        let r = RateLimiter::default();
        // Seed 500 stale-but-within-day turns directly (no sleeping).
        {
            let mut m = r.window_turns.lock().unwrap();
            let base = Instant::now() - std::time::Duration::from_secs(120);
            m.insert("w".to_string(), vec![base; 500]);
        }
        let err = r.check_turn("w").unwrap_err();
        assert!(err.contains("500"), "got: {}", err);
    }
}
