import AppKit
import RelayRunnerKit
import SwiftUI

/// The Jobs window: every job this Mac ran in the last week, as the gateway has them, and for the
/// one you pick its steps on a timeline and, when it failed, why. It reads them through the bundled
/// CLI (`relayrunner jobs --json`), which asks with this Mac's own token.
@MainActor
final class JobsWindow: NSObject, NSWindowDelegate {
  static let shared = JobsWindow()

  private var window: NSWindow?

  func show() {
    if let window {
      NSApp.activate(ignoringOtherApps: true)
      window.makeKeyAndOrderFront(nil)
      return
    }
    let window = NSWindow(contentViewController: NSHostingController(rootView: JobsView()))
    window.title = "Jobs"
    window.subtitle = Connection.shared.machineName ?? ""
    window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.setContentSize(NSSize(width: 960, height: 640))
    if !window.setFrameUsingName("Jobs") { window.center() }
    window.setFrameAutosaveName("Jobs")
    self.window = window
    AppWindows.opened()
    window.makeKeyAndOrderFront(nil)
  }

  func windowWillClose(_ notification: Notification) {
    window = nil
    AppWindows.closed()
  }
}

private struct JobsView: View {
  private enum Load: Equatable {
    case loading
    case loaded
    case failed(String)
  }

  private enum Show: Hashable { case all, failed }

  @State private var page = GatewayJobPage(jobs: [], next: nil)
  @State private var load = Load.loading
  @State private var loadingOlder = false
  @State private var search = ""
  @State private var show = Show.all
  @State private var selection: GatewayJob.ID?
  @State private var sortOrder = [KeyPathComparator(\GatewayJob.finishedMs, order: .reverse)]

  var body: some View {
    VStack(spacing: 0) {
      bar
      Divider()
      content
    }
    .frame(minWidth: 720, minHeight: 480)
    .task { await reload() }
  }

  private var bar: some View {
    HStack(spacing: 10) {
      Picker("Show", selection: $show) {
        Text("All").tag(Show.all)
        Text("Failed").tag(Show.failed)
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .frame(width: 150)
      Spacer()
      TextField("Search jobs, workflows and repos", text: $search)
        .textFieldStyle(.roundedBorder)
        .frame(width: 240)
      Button {
        Task { await reload() }
      } label: {
        Image(systemName: "arrow.clockwise")
      }
      .help("Refresh")
      .disabled(load == .loading)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }

  @ViewBuilder private var content: some View {
    if !Connection.shared.isEnrolled {
      Message("Turn RelayRunner on once to sign this Mac in. Its jobs show here after that.")
    } else if page.jobs.isEmpty {
      switch load {
      case .loading:
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      case .failed(let reason):
        VStack(spacing: 10) {
          Message("Couldn't load this Mac's jobs. \(reason)")
          Button("Try Again") { Task { await reload() } }
        }
        .frame(maxHeight: .infinity)
      case .loaded:
        Message("No jobs from this Mac in the last week. Jobs show here once it has run one.")
      }
    } else {
      VSplitView {
        VStack(spacing: 0) {
          table
          Divider()
          footer
        }
        .frame(minHeight: 180)
        Group {
          if let job = page.jobs.first(where: { $0.id == selection }) {
            JobDetailView(job: job).id(job.id)
          } else {
            Message("Pick a job to see its steps and, when it failed, why.")
          }
        }
        .frame(minHeight: 220, maxHeight: .infinity)
      }
    }
  }

  private var shown: [GatewayJob] {
    page.jobs
      .filter { show == .all || $0.outcome == .failed }
      .filter { $0.matches(search) }
      .sorted(using: sortOrder)
  }

  private var table: some View {
    Table(shown, selection: $selection, sortOrder: $sortOrder) {
      TableColumn("") { job in OutcomeIcon(outcome: job.outcome) }
        .width(22)
      TableColumn("Job", value: \.name) { job in
        VStack(alignment: .leading, spacing: 1) {
          Text(job.name).lineLimit(1)
          if let workflow = job.workflow {
            Text(workflow).font(.caption).foregroundStyle(.secondary).lineLimit(1)
          }
        }
      }
      TableColumn("Repo", value: \.repo) { job in
        Text(job.shortRepo).lineLimit(1).help(job.repo)
      }
      .width(min: 80, ideal: 140)
      TableColumn("Waited", value: \.waitedMs) { job in
        Text(job.queuedAt == nil ? "–" : Durations.short(job.waitedMs)).monospacedDigit()
      }
      .width(70)
      TableColumn("Ran", value: \.ranMs) { job in
        Text(job.startedAt == nil ? "–" : Durations.short(job.ranMs)).monospacedDigit()
      }
      .width(70)
      TableColumn("Finished", value: \.finishedMs) { job in
        Text(job.finished?.formatted(date: .abbreviated, time: .shortened) ?? "–").monospacedDigit()
      }
      .width(min: 110, ideal: 140)
    }
    .contextMenu(forSelectionType: GatewayJob.ID.self) { ids in
      if let job = page.jobs.first(where: { ids.contains($0.id) }) {
        Button("Open on GitHub") { NSWorkspace.shared.open(job.url) }
      }
    } primaryAction: { ids in
      if let job = page.jobs.first(where: { ids.contains($0.id) }) { NSWorkspace.shared.open(job.url) }
    }
  }

  private var footer: some View {
    HStack {
      Text(count).font(.caption).foregroundStyle(.secondary)
      Spacer()
      if page.next != nil {
        Button(loadingOlder ? "Loading…" : "Load Older Jobs") { Task { await loadOlder() } }
          .controlSize(.small)
          .disabled(loadingOlder)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
  }

  private var count: String {
    let failed = page.jobs.filter { $0.outcome == .failed }.count
    var text = page.jobs.count == 1 ? "1 job" : "\(page.jobs.count) jobs"
    if failed > 0 { text += ", \(failed) failed" }
    return text + (page.next == nil ? " in the last week" : " so far")
  }

  private func reload() async {
    guard Connection.shared.isEnrolled else { return }
    load = .loading
    switch await Self.fetch(["jobs", "--json"]) {
    case .success(let fresh):
      page = fresh
      load = .loaded
      if selection == nil { selection = fresh.jobs.first?.id }
    case .failure(let reason):
      load = .failed(reason.message)
    }
  }

  private func loadOlder() async {
    guard let next = page.next else { return }
    loadingOlder = true
    defer { loadingOlder = false }
    if case .success(let older) = await Self.fetch(["jobs", "--json", "--before", String(Int(next))]) {
      page = page.adding(older)
    }
  }

  private static func fetch(_ arguments: [String]) async -> Result<GatewayJobPage, Problem> {
    do {
      let output = try await CLI.run(arguments)
      if output.status == 0, let page = GatewayJobPage.parse(output.stdout) { return .success(page) }
      return .failure(Problem(message: output.status == 0 ? "The CLI sent something this app can't read." : output.problem))
    } catch {
      return .failure(Problem(message: error.localizedDescription))
    }
  }
}

private struct Problem: Error {
  let message: String
}

/// One job: what it was, its steps on a timeline and, when it failed, why.
private struct JobDetailView: View {
  private enum Load {
    case loading
    case loaded(GatewayJobDetail)
    case failed(String)
  }

  let job: GatewayJob
  @State private var load = Load.loading

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        header
        switch load {
        case .loading:
          ProgressView().controlSize(.small)
        case .failed(let reason):
          Text("Couldn't load this job's steps. \(reason)").foregroundStyle(.secondary)
        case .loaded(let detail):
          if let failure = detail.failure { FailureView(failure: failure) }
          VStack(alignment: .leading, spacing: 8) {
            Text("Steps").font(.headline)
            if let steps = detail.steps, !steps.isEmpty {
              StepTimelineView(steps: steps)
            } else {
              Text("GitHub no longer has this job's steps.").foregroundStyle(.secondary)
            }
          }
        }
      }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .task { await fetch() }
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      OutcomeIcon(outcome: job.outcome)
      VStack(alignment: .leading, spacing: 2) {
        Text([job.workflow, job.name].compactMap { $0 }.joined(separator: " › ")).font(.title3.weight(.semibold))
        Text(facts).font(.callout).foregroundStyle(.secondary)
      }
      Spacer()
      Button("Open on GitHub") { NSWorkspace.shared.open(job.url) }
    }
  }

  private var facts: String {
    var parts = [job.repo]
    if job.runAttempt > 1 { parts.append("attempt \(job.runAttempt)") }
    if job.queuedAt != nil { parts.append("waited \(Durations.short(job.waitedMs))") }
    if job.startedAt != nil { parts.append("ran \(Durations.short(job.ranMs))") }
    if let finished = job.finished { parts.append("finished \(Durations.ago(finished))") }
    return parts.joined(separator: " · ")
  }

  private func fetch() async {
    do {
      let output = try await CLI.run(["jobs", String(job.id), "--json"])
      if output.status == 0, let detail = GatewayJobDetail.parse(output.stdout) {
        load = .loaded(detail)
      } else {
        load = .failed(output.status == 0 ? "The CLI sent something this app can't read." : output.problem)
      }
    } catch {
      load = .failed(error.localizedDescription)
    }
  }
}

/// Why a job failed: the AI's guess when there is one, the failed step, GitHub's annotations and
/// the end of the log.
private struct FailureView: View {
  let failure: JobFailure

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Why it failed").font(.headline)
      if let cause = failure.cause {
        Label(cause.summary, systemImage: "sparkles")
      }
      if failure.runnerFailed {
        Label("The runner failed before any step started.", systemImage: "exclamationmark.triangle")
      } else if let step = failure.failedStep {
        Label("Failed at \(step)", systemImage: "xmark.octagon").foregroundStyle(.red)
      }
      ForEach(Array(failure.annotations.enumerated()), id: \.offset) { _, note in
        Label(note, systemImage: "text.bubble").foregroundStyle(.secondary)
      }
      if let log = failure.log, !log.isEmpty {
        LogView(lines: log)
      } else if failure.log == nil {
        Text("GitHub no longer has this job's log.").foregroundStyle(.secondary)
      }
    }
    .textSelection(.enabled)
  }
}

/// The end of a job's log, with GitHub's error lines in red.
private struct LogView: View {
  let lines: [String]

  var body: some View {
    let parsed = lines.map(LogLine.init)
    ScrollView(.horizontal) {
      VStack(alignment: .leading, spacing: 1) {
        ForEach(Array(parsed.enumerated()), id: \.offset) { _, line in
          Text(line.text.isEmpty ? " " : line.text)
            .foregroundStyle(line.isError ? Color(red: 1, green: 0.54, blue: 0.52) : Color(white: 0.82))
        }
      }
      .font(.system(size: 11.5, design: .monospaced))
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(Color(red: 0.05, green: 0.07, blue: 0.06), in: RoundedRectangle(cornerRadius: 8))
  }
}

/// A job's steps, each a bar placed where it ran in the job.
private struct StepTimelineView: View {
  let steps: [JobStep]

  var body: some View {
    let bars = StepTimeline.bars(steps)
    Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 6) {
      ForEach(Array(zip(steps, bars)), id: \.0.id) { step, bar in
        GridRow {
          Text(step.name)
            .lineLimit(1)
            .truncationMode(.middle)
            .foregroundStyle(bar == nil ? .secondary : .primary)
            .frame(width: 220, alignment: .leading)
          Track(bar: bar, failed: step.outcome == .failed)
          Text(step.durationMs.map(Durations.short) ?? (step.conclusion ?? ""))
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .frame(width: 64, alignment: .trailing)
        }
      }
    }
  }

  private struct Track: View {
    let bar: StepTimeline.Bar?
    let failed: Bool

    var body: some View {
      GeometryReader { geometry in
        if let bar {
          RoundedRectangle(cornerRadius: 3)
            .fill(failed ? Color.red : Color.green)
            .frame(width: max(2, geometry.size.width * bar.width), height: 8)
            .offset(x: min(geometry.size.width * bar.start, geometry.size.width - 2))
        }
      }
      .frame(height: 8)
    }
  }
}

private struct Message: View {
  let text: String
  init(_ text: String) { self.text = text }

  var body: some View {
    Text(text)
      .foregroundStyle(.secondary)
      .multilineTextAlignment(.center)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .padding(24)
  }
}
