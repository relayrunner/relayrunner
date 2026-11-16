//! How much CPU and memory a job uses, sampled while its runner runs. A port of apps/cli/usage.ts.

use crate::protocol::JobUsage;
use crate::sys;
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::oneshot;

const SAMPLE: Duration = Duration::from_secs(5);
const MB: f64 = 1024.0 * 1024.0;

/// One reading: CPU as a share (0 to 1) of what the job may use, and memory in bytes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Reading {
    pub cpu: f64,
    pub memory_bytes: u64,
}

/// Where to read a job's usage, and what it may use.
#[derive(Clone, Debug)]
pub enum Source {
    /// The runner process and everything under it, on this machine.
    Tree { pid: u32, cpus: u32, memory_mb: u64 },
    /// A VM, read with `container stats`.
    Vm {
        name: String,
        cpus: u32,
        memory_mb: u64,
    },
}

impl Source {
    fn capacity(&self) -> (u32, u64) {
        match self {
            Source::Tree {
                cpus, memory_mb, ..
            }
            | Source::Vm {
                cpus, memory_mb, ..
            } => (*cpus, *memory_mb),
        }
    }

    async fn read(&self) -> Option<Reading> {
        match self {
            Source::Tree { pid, cpus, .. } => {
                let output = sys::run("ps", &["-A", "-o", "pid=,ppid=,%cpu=,rss="]).await?;
                tree_reading(&output, *pid, *cpus)
            }
            Source::Vm { name, cpus, .. } => {
                let output = sys::run(
                    "container",
                    &["stats", "--format", "json", "--no-stream", name],
                )
                .await?;
                let stats: serde_json::Value = serde_json::from_str(&output).ok()?;
                let cpu = stats[0]["cpuUtilization"].as_f64()?;
                let memory = stats[0]["memoryUsageBytes"].as_f64()?;
                Some(Reading {
                    cpu: cpu / f64::from(*cpus),
                    memory_bytes: memory as u64,
                })
            }
        }
    }
}

/// Samples until the returned sender fires, then answers with the usage, or None when nothing was
/// read.
pub fn sample(
    source: Source,
) -> (
    oneshot::Sender<()>,
    tokio::task::JoinHandle<Option<JobUsage>>,
) {
    let (stop, mut stopped) = oneshot::channel();
    let task = tokio::spawn(async move {
        let mut readings = Vec::new();
        let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + SAMPLE, SAMPLE);
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                _ = tick.tick() => if let Some(r) = source.read().await { readings.push(r) },
            }
        }
        summarize(&readings, source.capacity())
    });
    (stop, task)
}

pub fn summarize(readings: &[Reading], (cpus, memory_mb): (u32, u64)) -> Option<JobUsage> {
    if readings.is_empty() {
        return None;
    }
    let cpu: Vec<f64> = readings.iter().map(|r| r.cpu.clamp(0.0, 1.0)).collect();
    let memory: Vec<u64> = readings
        .iter()
        .map(|r| (r.memory_bytes as f64 / MB).round() as u64)
        .collect();
    let round = |share: f64| (share * 1000.0).round() / 1000.0;
    Some(JobUsage {
        cpu_p95: round(p95(&cpu)),
        cpu_peak: round(cpu.iter().copied().fold(0.0, f64::max)),
        memory_p95_mb: p95(&memory),
        memory_peak_mb: *memory.iter().max().unwrap(),
        cpus,
        memory_mb,
        samples: readings.len() as u32,
    })
}

// The nearest-rank 95th percentile.
fn p95<T: Copy + PartialOrd>(values: &[T]) -> T {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    sorted[(sorted.len() as f64 * 0.95).ceil() as usize - 1]
}

/// Sums `ps -o pid=,ppid=,%cpu=,rss=` output over `root` and its descendants.
pub fn tree_reading(output: &str, root: u32, cores: u32) -> Option<Reading> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut usage: HashMap<u32, (f64, u64)> = HashMap::new();
    for line in output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let [pid, ppid, cpu, rss] = fields[..] else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) else {
            continue;
        };
        usage.insert(pid, (cpu.parse().unwrap_or(0.0), rss.parse().unwrap_or(0)));
        children.entry(ppid).or_default().push(pid);
    }
    usage.get(&root)?;
    let (mut percent, mut rss_kb) = (0.0, 0);
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        let (cpu, rss) = usage[&pid];
        percent += cpu;
        rss_kb += rss;
        stack.extend(children.get(&pid).into_iter().flatten());
    }
    Some(Reading {
        cpu: percent / 100.0 / f64::from(cores),
        memory_bytes: rss_kb * 1024,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_a_process_tree() {
        let ps = "  1   0  5.0  1000\n 10   1 50.0  2048\n 11  10 30.0  1024\n 12   1 99.0  9999\n";
        let reading = tree_reading(ps, 10, 4).unwrap();
        assert!((reading.cpu - 0.2).abs() < 1e-9);
        assert_eq!(reading.memory_bytes, 3072 * 1024);
        assert_eq!(tree_reading(ps, 99, 4), None);
    }

    #[test]
    fn summarizes_readings() {
        let readings: Vec<Reading> = (1..=20u32)
            .map(|i| Reading {
                cpu: f64::from(i) / 20.0,
                memory_bytes: u64::from(i) * 1024 * 1024,
            })
            .collect();
        let usage = summarize(&readings, (4, 8192)).unwrap();
        assert_eq!(usage.cpu_p95, 0.95);
        assert_eq!(usage.cpu_peak, 1.0);
        assert_eq!(usage.memory_p95_mb, 19);
        assert_eq!(usage.samples, 20);
        assert_eq!(summarize(&[], (1, 1)), None);
    }
}
