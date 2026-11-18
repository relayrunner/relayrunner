import AppKit
import RelayRunnerKit
import SwiftUI

/// The Jobs window: the jobs running or waiting on this Mac and every job it ran in the last week,
/// as the gateway has them, and for the one you pick its steps on a timeline and, when it failed,
/// why. It reads them through the bundled CLI (`relayrunner jobs --json`), which asks with this
/// Mac's own token. The list sits above the job, split by a line you can drag.
@MainActor
final class JobsWindow: NSObject, NSWindowDelegate {
  static let shared = JobsWindow()

  private var window: NSWindow?

  /// Opens the window, on job `id` when given (`url` is its GitHub link, for a job the gateway no
  /// longer has).
  func show(job id: Int? = nil, url: URL? = nil) {
    if let id { JobsStore.shared.select(id, url: url) }
    if let window {
      NSApp.activate(ignoringOtherApps: true)
      window.makeKeyAndOrderFront(nil)
      return
    }
    let store = JobsStore.shared
    let split = NSSplitViewController()
    split.splitView.isVertical = false
    split.splitView.dividerStyle = .thin
    let list = NSSplitViewItem(viewController: Self.hosting(JobsListView(store: store)))
    list.minimumThickness = 180
    let detail = NSSplitViewItem(viewController: Self.hosting(JobDetailPane(store: store)))
    detail.minimumThickness = 160
    // The job keeps its height as the window grows; the list takes the rest.
    detail.holdingPriority = NSLayoutConstraint.Priority(rawValue: 260)
    split.addSplitViewItem(list)
    split.addSplitViewItem(detail)

    let window = NSWindow(contentViewController: split)
    window.title = "Jobs"
    window.subtitle = Connection.shared.machineName ?? ""
    window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.contentMinSize = NSSize(width: 820, height: 480)
    window.setContentSize(NSSize(width: 980, height: 680))
    if !window.setFrameUsingName("Jobs") { window.center() }
    window.setFrameAutosaveName("Jobs")
    let placed = UserDefaults.standard.object(forKey: "NSSplitView Subview Frames JobsSplit") != nil
    split.splitView.autosaveName = "JobsSplit"
    self.window = window
    AppWindows.opened()
    window.makeKeyAndOrderFront(nil)
    if !placed {
      split.view.layoutSubtreeIfNeeded()
      split.splitView.setPosition(window.contentLayoutRect.height * 0.55, ofDividerAt: 0)
    }
  }

  /// Whether any of the window is on screen, so it doesn't refresh while hidden.
  var isVisible: Bool { window?.occlusionState.contains(.visible) ?? false }

  func windowWillClose(_ notification: Notification) {
    window = nil
    AppWindows.closed()
  }

  /// A pane that takes the size the split gives it rather than asking the window for its own.
  private static func hosting(_ view: some View) -> NSViewController {
    let controller = NSHostingController(rootView: view)
    controller.sizingOptions = []
    return controller
  }
}

/// What the Jobs window shows, kept while it's closed so it opens on the jobs it last had. The
/// unfiltered list is saved too, for the first open after the app starts, and refreshed as soon
/// as the window shows. Finished jobs' details are kept since they don't change.
@MainActor @Observable
final class JobsStore {
  static let shared = JobsStore()

  enum Load: Equatable {
    case idle
    case loading
    case loaded
    case failed(String)
  }

  var filter = JobsFilter() {
    didSet { if filter != oldValue { Task { await reload() } } }
  }
  var search = ""
  var sortOrder = [KeyPathComparator(\GatewayJob.finishedMs, order: .reverse)]
  var selection: GatewayJob.ID?
  private(set) var page: GatewayJobPage
  private(set) var load = Load.idle
  private(set) var loadingOlder = false
  /// Finished jobs' steps and failures, by id.
  private(set) var details: [Int: GatewayJobDetail] = [:]
  /// GitHub links for jobs opened from the menu, in case the gateway no longer has them.
  private(set) var links: [Int: URL] = [:]

  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var fetching: [Int: Task<Result<GatewayJobDetail, Problem>, Never>] = [:]

  private init() {
    page = Self.saved() ?? GatewayJobPage(jobs: [], next: nil)
  }

  /// Running and waiting jobs first, as the gateway put them, then the finished ones in the
  /// table's order. The search narrows both.
  var shown: [GatewayJob] {
    let active = (page.active ?? []).filter { $0.matches(search) }
    return active + page.jobs.filter { $0.matches(search) }.sorted(using: sortOrder)
  }

  /// A job by id: from the list, or from its details when it's no longer in it.
  func job(_ id: Int) -> GatewayJob? {
    page.all.first { $0.id == id } ?? details[id]?.job
  }

  func link(_ id: Int) -> URL? { job(id)?.url ?? links[id] }

  func select(_ id: Int, url: URL?) {
    if let url { links[id] = url }
    selection = id
  }

  /// Asks for the list again. Calls that overlap keep only the newest answer.
  func reload() async {
    guard Connection.shared.isEnrolled else { return }
    generation += 1
    let asked = generation
    let filter = self.filter
    load = .loading
    let result = await Self.fetch(["jobs", "--json"] + filter.arguments(now: .now), GatewayJobPage.parse)
    guard asked == generation else { return }
    switch result {
    case .success(let fresh):
      page = fresh
      load = .loaded
      if filter.isEmpty { Self.save(fresh) }
      if selection == nil { selection = fresh.all.first?.id }
    case .failure(let problem):
      load = .failed(problem.message)
    }
  }

  func loadOlder() async {
    guard let next = page.next, !loadingOlder else { return }
    loadingOlder = true
    defer { loadingOlder = false }
    let asked = generation
    let arguments = ["jobs", "--json", "--before", String(Int(next))] + filter.arguments(now: .now)
    if case .success(let older) = await Self.fetch(arguments, GatewayJobPage.parse), asked == generation {
      page = page.adding(older)
    }
  }

  /// One job's details, kept once it has finished. Callers that ask together share one read.
  func detail(_ id: Int) async -> Result<GatewayJobDetail, Problem> {
    if let kept = details[id] { return .success(kept) }
    if let running = fetching[id] { return await running.value }
    let read = Task { await Self.fetch(["jobs", String(id), "--json"], GatewayJobDetail.parse) }
    fetching[id] = read
    let result = await read.value
    fetching[id] = nil
    if case .success(let detail) = result, !detail.job.isActive { details[id] = detail }
    return result
  }

  /// Reads the finished jobs either side of `id` ahead, together, so moving through the list is
  /// quick.
  func prefetch(around id: Int) async {
    let shown = self.shown
    guard let index = shown.firstIndex(where: { $0.id == id }) else { return }
    let ahead = [index + 1, index - 1].filter(shown.indices.contains).map { shown[$0] }
      .filter { !$0.isActive && details[$0.id] == nil }
    await withTaskGroup(of: Void.self) { group in
      for job in ahead { group.addTask { _ = await self.detail(job.id) } }
    }
  }

  private static func fetch<Value>(_ arguments: [String], _ parse: (Data) -> Value?) async -> Result<Value, Problem> {
    do {
      let output = try await CLI.run(arguments)
      if output.status == 0, let value = parse(output.stdout) {
        return .success(value)
      }
      return .failure(Problem(message: output.status == 0 ? "The CLI sent something this app can't read." : output.problem))
    } catch {
      return .failure(Problem(message: error.localizedDescription))
    }
  }

  // The last unfiltered list, with the machine it's from.
  private struct Saved: Codable {
    var machine: String?
    var page: GatewayJobPage
  }

  private static var file: URL? {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
      .appendingPathComponent(Bundle.main.bundleIdentifier ?? "RelayRunner")
      .appendingPathComponent("jobs.json")
  }

  private static func saved() -> GatewayJobPage? {
    guard let file, let data = try? Data(contentsOf: file),
      let saved = try? JSONDecoder().decode(Saved.self, from: data),
      saved.machine == Connection.shared.machineName
    else { return nil }
    return saved.page
  }

  private static func save(_ page: GatewayJobPage) {
    guard let file, let data = try? JSONEncoder().encode(Saved(machine: Connection.shared.machineName, page: page)) else {
      return
    }
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: file, options: .atomic)
  }
}

struct Problem: Error {
  let message: String
}

/// The window's top pane: filters, the list and a count.
private struct JobsListView: View {
  @Bindable var store: JobsStore
  @State private var opened = false
  private let connection = Connection.shared

  var body: some View {
    VStack(spacing: 0) {
      bar
      Divider()
      SlotsNote(connection: connection)
      content
    }
    // Refreshes when it opens, soon after a job starts or ends here (once the gateway has heard),
    // and every so often, more often while one runs.
    .task(id: connection.jobs) {
      if opened { try? await Task.sleep(for: .seconds(3)) }
      opened = true
      if !Task.isCancelled { await store.reload() }
    }
    .task(id: store.page.active?.isEmpty == false) {
      let every: Duration = store.page.active?.isEmpty == false ? .seconds(20) : .seconds(90)
      while !Task.isCancelled {
        try? await Task.sleep(for: every)
        if !Task.isCancelled, JobsWindow.shared.isVisible { await store.reload() }
      }
    }
  }

  private var bar: some View {
    HStack(spacing: 8) {
      Picker("Result", selection: $store.filter.result) {
        Text("All Results").tag(JobsFilter.Result?.none)
        Divider()
        Text("Succeeded").tag(JobsFilter.Result?.some(.succeeded))
        Text("Failed").tag(JobsFilter.Result?.some(.failed))
        Text("Canceled").tag(JobsFilter.Result?.some(.canceled))
      }
      .fixedSize()
      Picker("Repo", selection: $store.filter.repo) {
        Text("All Repos").tag(String?.none)
        Divider()
        ForEach(choices(store.page.repos, { $0.repo }, chosen: store.filter.repo), id: \.self) { repo in
          Text(repo).tag(String?.some(repo))
        }
      }
      .frame(maxWidth: 200)
      Picker("Workflow", selection: $store.filter.workflow) {
        Text("All Workflows").tag(String?.none)
        Divider()
        ForEach(choices(store.page.workflows, { $0.workflow }, chosen: store.filter.workflow), id: \.self) { workflow in
          Text(workflow).tag(String?.some(workflow))
        }
      }
      .frame(maxWidth: 200)
      Picker("Time", selection: $store.filter.range) {
        ForEach(JobsFilter.Range.allCases, id: \.self) { range in
          Text(range.title).tag(range)
        }
      }
      .fixedSize()
      if !store.filter.isEmpty {
        Button("Clear") { store.filter = JobsFilter() }
          .buttonStyle(.link)
      }
      Spacer(minLength: 8)
      TextField("Search", text: $store.search)
        .textFieldStyle(.roundedBorder)
        .frame(minWidth: 120, maxWidth: 200)
      Button {
        Task { await store.reload() }
      } label: {
        if store.load == .loading {
          ProgressView().controlSize(.small).frame(width: 16, height: 16)
        } else {
          Image(systemName: "arrow.clockwise").frame(width: 16, height: 16)
        }
      }
      .help("Refresh")
      .disabled(store.load == .loading)
    }
    .labelsHidden()
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }

  /// A filter's choices: what the gateway offers or, from one that doesn't yet, what's in the list,
  /// and the chosen one even when it's in neither.
  private func choices(_ offered: [String]?, _ value: (GatewayJob) -> String?, chosen: String?) -> [String] {
    var seen = Set<String>()
    var names = offered ?? store.page.all.compactMap(value).filter { seen.insert($0).inserted }
    if let chosen, !names.contains(chosen) { names.insert(chosen, at: 0) }
    return names
  }

  @ViewBuilder private var content: some View {
    if !connection.isEnrolled {
      Message("Turn RelayRunner on once to sign this Mac in. Its jobs show here after that.")
    } else if store.page.all.isEmpty {
      switch store.load {
      case .idle, .loading:
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      case .failed(let reason):
        VStack(spacing: 10) {
          Message("Couldn't load this Mac's jobs. \(reason)")
          Button("Try Again") { Task { await store.reload() } }
        }
        .frame(maxHeight: .infinity)
      case .loaded:
        if store.filter.isEmpty {
          Message("No jobs from this Mac in the last week. Jobs show here once it has run one.")
        } else {
          VStack(spacing: 10) {
            Message("No jobs match these filters.")
            Button("Clear Filters") { store.filter = JobsFilter() }
          }
          .frame(maxHeight: .infinity)
        }
      }
    } else {
      table
      Divider()
      footer
    }
  }

  private var table: some View {
    Table(store.shown, selection: $store.selection, sortOrder: $store.sortOrder) {
      TableColumn("") { job in JobIcon(job: job) }
        .width(22)
      TableColumn("Job", value: \.name) { job in
        VStack(alignment: .leading, spacing: 1) {
          Text(job.name).lineLimit(1)
          if let workflow = job.workflow {
            Text(workflow).font(.caption).foregroundStyle(.secondary).lineLimit(1)
          }
        }
      }
      .width(min: 120, ideal: 240)
      TableColumn("Repo", value: \.repo) { job in
        Text(job.shortRepo).lineLimit(1).help(job.repo)
      }
      .width(min: 80, ideal: 160)
      TableColumn("Waited", value: \.waitedMs) { job in
        if job.isWaiting {
          Elapsed(job: job)
        } else {
          Text(job.queuedAt == nil ? "–" : Durations.short(job.waitedMs)).monospacedDigit()
        }
      }
      .width(min: 56, ideal: 72)
      TableColumn("Ran", value: \.ranMs) { job in
        if job.isActive, !job.isWaiting {
          Elapsed(job: job)
        } else {
          Text(job.startedAt == nil ? "–" : Durations.short(job.ranMs)).monospacedDigit()
        }
      }
      .width(min: 56, ideal: 72)
      TableColumn("Finished", value: \.finishedMs) { job in
        if job.isActive {
          Text(job.isWaiting ? "Waiting to start" : "Running").foregroundStyle(.secondary)
        } else {
          Text(job.finished?.formatted(date: .abbreviated, time: .shortened) ?? "–").monospacedDigit()
        }
      }
      .width(min: 110, ideal: 150)
    }
    .contextMenu(forSelectionType: GatewayJob.ID.self) { ids in
      if let id = ids.first, let url = store.link(id) {
        Button("Open on GitHub") { NSWorkspace.shared.open(url) }
      }
    } primaryAction: { ids in
      if let id = ids.first, let url = store.link(id) { NSWorkspace.shared.open(url) }
    }
  }

  private var footer: some View {
    HStack {
      Text(count).font(.caption).foregroundStyle(.secondary)
      if case .failed(let reason) = store.load {
        Label("Couldn't refresh. \(reason)", systemImage: "exclamationmark.triangle")
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .help(reason)
      }
      Spacer()
      if store.page.next != nil {
        Button(store.loadingOlder ? "Loading…" : "Load Older Jobs") { Task { await store.loadOlder() } }
          .controlSize(.small)
          .disabled(store.loadingOlder)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
  }

  private var count: String {
    let page = store.page
    var parts: [String] = []
    let running = page.active?.filter { !$0.isWaiting }.count ?? 0
    let waiting = (page.active?.count ?? 0) - running
    if running > 0 { parts.append("\(running) running") }
    if waiting > 0 { parts.append("\(waiting) waiting") }
    var finished = page.jobs.count == 1 ? "1 job" : "\(page.jobs.count) jobs"
    finished += page.next == nil ? " in the \(store.filter.range.title.lowercased())" : " so far"
    parts.append(finished)
    let failed = page.jobs.filter { $0.outcome == .failed }.count
    if store.filter.result == nil, failed > 0 { parts.append("\(failed) failed") }
    return parts.joined(separator: " · ")
  }
}

/// Above the list when jobs went to hosted runners because every slot here was busy: the offer to
/// take one more at once, and how that's going once taken.
private struct SlotsNote: View {
  let connection: Connection

  var body: some View {
    Group {
      if let count = connection.allowingSlots {
        Note(text: "Taking \(count) jobs at once as soon as the running jobs finish. New jobs go elsewhere until then.")
      } else {
        TimelineView(.periodic(from: .now, by: 30)) { context in
          let spilled = Spillover.lastHour(connection.spilled, now: context.date)
          if spilled > 0 {
            Note(
              text:
                "In the last hour, \(spilled == 1 ? "1 job" : "\(spilled) jobs") went to hosted runners because every slot here was busy."
            ) {
              if let more = Spillover.moreSlots(than: connection.slots, memory: HostMemory.shareInUse()) {
                Button("Allow \(more) Jobs at Once") { connection.allowJobs(more) }
                  .help("Pauses new jobs until the running ones finish, then takes up to \(more) at once")
              } else {
                Button("Open Settings…") { MenuBar.openSettings() }
              }
            }
          }
        }
      }
    }
    .controlSize(.small)
  }
}

/// An amber note, with an action beside it when there is one.
private struct Note<Action: View>: View {
  let text: String
  @ViewBuilder var action: () -> Action

  var body: some View {
    HStack(spacing: 12) {
      Text(text)
        .font(.subheadline)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      action()
    }
    .padding(8)
    .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
    .overlay(alignment: .leading) {
      UnevenRoundedRectangle(topLeadingRadius: 6, bottomLeadingRadius: 6)
        .fill(.orange)
        .frame(width: 3)
    }
    .padding(.horizontal, 12)
    .padding(.top, 8)
  }
}

extension Note where Action == EmptyView {
  init(text: String) { self.init(text: text) { EmptyView() } }
}

/// A job's result as a coloured symbol.
private struct OutcomeIcon: View {
  let outcome: JobOutcome

  var body: some View {
    let (symbol, color, label): (String, Color, String) =
      switch outcome {
      case .succeeded: ("checkmark.circle.fill", .green, "Succeeded")
      case .failed: ("xmark.circle.fill", .red, "Failed")
      case .canceled: ("minus.circle.fill", .gray, "Canceled")
      case .other: ("circle.fill", .gray, "Done")
      }
    Image(systemName: symbol)
      .foregroundStyle(color)
      .frame(width: 18)
      .accessibilityLabel(label)
  }
}

/// A job's result, or that it's running or waiting.
private struct JobIcon: View {
  let job: GatewayJob

  var body: some View {
    if job.isWaiting {
      Image(systemName: "clock").foregroundStyle(.secondary).help("Waiting to start")
    } else if job.isActive {
      Image(systemName: "play.circle.fill").foregroundStyle(.blue).help("Running")
    } else {
      OutcomeIcon(outcome: job.outcome)
    }
  }
}

/// How long a running job has run, or a waiting one waited, ticking.
private struct Elapsed: View {
  let job: GatewayJob

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      Text(Durations.short(job.elapsedMs(now: context.date))).monospacedDigit()
    }
  }
}

/// The window's bottom pane: the picked job.
private struct JobDetailPane: View {
  let store: JobsStore

  var body: some View {
    if let id = store.selection {
      JobDetailView(store: store, id: id).id(id)
    } else {
      Message("Pick a job to see its steps and, when it failed, why.")
    }
  }
}

/// One job: what it was, its steps on a timeline and, when it failed, why. Read again when a
/// running job finishes.
private struct JobDetailView: View {
  private enum Load {
    case loading
    case loaded(GatewayJobDetail)
    case failed(String)
  }

  let store: JobsStore
  let id: Int
  @State private var load: Load

  init(store: JobsStore, id: Int) {
    self.store = store
    self.id = id
    _load = State(initialValue: store.details[id].map(Load.loaded) ?? .loading)
  }

  /// The list's copy, which is newer while the job runs, else the one its details came with.
  private var job: GatewayJob? {
    if let listed = store.job(id) { return listed }
    if case .loaded(let detail) = load { return detail.job }
    return nil
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        header
        switch load {
        case .loading:
          ProgressView().controlSize(.small)
        case .failed(let reason):
          Text("Couldn't load this job. \(reason)").foregroundStyle(.secondary)
        case .loaded(let detail):
          if let failure = detail.failure { FailureView(failure: failure) }
          VStack(alignment: .leading, spacing: 8) {
            Text("Steps").font(.headline)
            if let steps = detail.steps, !steps.isEmpty {
              StepTimelineView(steps: steps)
            } else if detail.job.isActive {
              Text("No steps yet.").foregroundStyle(.secondary)
            } else {
              Text("GitHub no longer has this job's steps.").foregroundStyle(.secondary)
            }
          }
        }
      }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .task(id: job?.completedAt) {
      if case .loaded(let detail) = load, !detail.job.isActive { return }
      switch await store.detail(id) {
      case .success(let detail): load = .loaded(detail)
      case .failure(let problem): load = .failed(problem.message)
      }
      // Only once the pick settles, so arrowing through the list doesn't read every job.
      try? await Task.sleep(for: .milliseconds(400))
      if !Task.isCancelled { await store.prefetch(around: id) }
    }
  }

  @ViewBuilder private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      if let job {
        JobIcon(job: job)
        VStack(alignment: .leading, spacing: 2) {
          Text([job.workflow, job.name].compactMap { $0 }.joined(separator: " › ")).font(.title3.weight(.semibold))
          Text(facts(job)).font(.callout).foregroundStyle(.secondary)
        }
      }
      Spacer()
      if let url = store.link(id) {
        Button("Open on GitHub") { NSWorkspace.shared.open(url) }
      }
    }
  }

  private func facts(_ job: GatewayJob) -> String {
    var parts = [job.repo]
    if job.runAttempt > 1 { parts.append("attempt \(job.runAttempt)") }
    if job.isWaiting {
      parts.append("waiting to start")
    } else if job.isActive {
      parts.append("running")
    } else {
      if job.queuedAt != nil { parts.append("waited \(Durations.short(job.waitedMs))") }
      if job.startedAt != nil { parts.append("ran \(Durations.short(job.ranMs))") }
      if let finished = job.finished { parts.append("finished \(Durations.ago(finished))") }
    }
    return parts.joined(separator: " · ")
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
