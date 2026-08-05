//! Periodic memory telemetry for the debug log.
//!
//! Written after a multi-day session died silently at ~3.3 GB RSS with nothing
//! in the JS log, no kernel OOM and no coredump — the signature of WebKitGTK's
//! internal memory-pressure handler killing its web process. The JS side cannot
//! observe its own process tree, so the growth curve was invisible until the
//! machine's free-memory graph moved at the moment of death. This module logs
//! the resident set of the app process and every descendant (the WebKit web,
//! network and GPU processes) every SAMPLE_INTERVAL, so the next incident shows
//! a curve instead of a cliff.
//!
//! Linux-only: the process tree is read from /proc. On macOS/Windows the
//! sampler is a no-op — there is no /proc, and pulling in a sysinfo crate for
//! platforms where the crash has never been observed isn't worth the weight.
//! Lines go through logger::write_log, so they honor the same opt-in setting
//! and secret redaction as every other log line, and cost nothing when file
//! logging is off.

use std::time::Duration;

/// Five minutes: fine enough to see a leak's slope across hours, coarse enough
/// to add ~300 lines/day against the 5 MB log cap.
const SAMPLE_INTERVAL: Duration = Duration::from_secs(5 * 60);

pub fn spawn_sampler() {
    tauri::async_runtime::spawn(async {
        let mut tick = tokio::time::interval(SAMPLE_INTERVAL);
        loop {
            // First tick fires immediately — that startup sample is the
            // baseline every later reading is compared against.
            tick.tick().await;
            if let Some(line) = sample_line() {
                let _ = crate::logger::write_log(line);
            }
        }
    });
}

#[cfg(not(target_os = "linux"))]
fn sample_line() -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
fn sample_line() -> Option<String> {
    let procs = process_tree_rss();
    if procs.is_empty() {
        return None;
    }
    let total_kb: u64 = procs.iter().map(|p| p.rss_kb).sum();
    // Aggregate by process name: several WebKitWebProcess instances read better
    // as one "WebKitWebProcess=2900MB x3" than as three entries.
    let mut by_name: Vec<(String, u64, u32)> = Vec::new();
    for p in &procs {
        match by_name.iter_mut().find(|(name, _, _)| *name == p.name) {
            Some(entry) => {
                entry.1 += p.rss_kb;
                entry.2 += 1;
            }
            None => by_name.push((p.name.clone(), p.rss_kb, 1)),
        }
    }
    by_name.sort_by(|a, b| b.1.cmp(&a.1));
    let breakdown = by_name
        .iter()
        .map(|(name, kb, count)| {
            if *count > 1 {
                format!("{}={}MB x{}", name, kb / 1024, count)
            } else {
                format!("{}={}MB", name, kb / 1024)
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    Some(format!(
        "[LOG] {} [tauri] [memlog] rss total={}MB ({} processes): {}",
        iso8601_utc_now(),
        total_kb / 1024,
        procs.len(),
        breakdown,
    ))
}

#[cfg(target_os = "linux")]
struct ProcRss {
    name: String,
    rss_kb: u64,
}

/// RSS of this process and every descendant, from /proc/<pid>/status.
#[cfg(target_os = "linux")]
fn process_tree_rss() -> Vec<ProcRss> {
    let self_pid = std::process::id();

    // One pass over /proc collecting (pid, ppid, name, rss).
    struct Entry {
        pid: u32,
        ppid: u32,
        name: String,
        rss_kb: u64,
    }
    let mut entries: Vec<Entry> = Vec::new();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    for dent in dir.flatten() {
        let Some(pid) = dent.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let Ok(status) = std::fs::read_to_string(format!("/proc/{pid}/status")) else {
            continue; // raced with process exit — skip
        };
        let mut name = String::new();
        let mut ppid = 0u32;
        let mut rss_kb = 0u64;
        for line in status.lines() {
            if let Some(v) = line.strip_prefix("Name:") {
                name = v.trim().to_string();
            } else if let Some(v) = line.strip_prefix("PPid:") {
                ppid = v.trim().parse().unwrap_or(0);
            } else if let Some(v) = line.strip_prefix("VmRSS:") {
                rss_kb = v.trim().trim_end_matches("kB").trim().parse().unwrap_or(0);
            }
        }
        entries.push(Entry { pid, ppid, name, rss_kb });
    }

    // Walk down from our own pid. Repeated passes instead of a map: the tree
    // is tiny (app + a handful of WebKit helpers) and /proc order is arbitrary.
    let mut in_tree: Vec<u32> = vec![self_pid];
    loop {
        let before = in_tree.len();
        for e in &entries {
            if in_tree.contains(&e.ppid) && !in_tree.contains(&e.pid) {
                in_tree.push(e.pid);
            }
        }
        if in_tree.len() == before {
            break;
        }
    }

    entries
        .into_iter()
        .filter(|e| in_tree.contains(&e.pid) && e.rss_kb > 0)
        .map(|e| ProcRss { name: e.name, rss_kb: e.rss_kb })
        .collect()
}

/// UTC timestamp in the same `2026-08-05T04:11:57.000Z` shape the JS console
/// lines use, so one grep/sort covers both writers. No chrono dependency:
/// days-to-civil is Howard Hinnant's algorithm.
#[cfg(target_os = "linux")]
fn iso8601_utc_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    iso8601_utc(now.as_secs() as i64, now.subsec_millis())
}

#[cfg(any(target_os = "linux", test))]
fn iso8601_utc(secs: i64, millis: u32) -> String {
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (h, m, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    // civil_from_days (proleptic Gregorian), days since 1970-01-01.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::iso8601_utc;

    #[test]
    fn formats_known_timestamps() {
        assert_eq!(iso8601_utc(0, 0), "1970-01-01T00:00:00.000Z");
        // date -u -d @1785902832 → 2026-08-05T04:07:12Z (from the crash log)
        assert_eq!(iso8601_utc(1_785_902_832, 253), "2026-08-05T04:07:12.253Z");
        // Leap-year day: 2024-02-29T12:00:00Z
        assert_eq!(iso8601_utc(1_709_208_000, 0), "2024-02-29T12:00:00.000Z");
        // Year boundary: 2025-12-31T23:59:59Z
        assert_eq!(iso8601_utc(1_767_225_599, 999), "2025-12-31T23:59:59.999Z");
    }
}
