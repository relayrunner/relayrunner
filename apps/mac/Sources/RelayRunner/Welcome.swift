import AppKit
import RelayRunnerKit
import SwiftUI

/// The window a first launch opens. A menu bar app has no window of its own, so without it a new
/// download looks like it did nothing. It moves the app to Applications, signs this Mac in and turns
/// on opening at login.
@MainActor
final class Welcome: NSObject, NSWindowDelegate {
  static let shared = Welcome()

  private var window: NSWindow?

  /// On a first launch only. A Mac that's signed in already (someone updating from an older version)
  /// skips it.
  func showIfNew() {
    // For development: RELAYRUNNER_WELCOME=hello, signIn or done opens it at that step regardless.
    if let name = ProcessInfo.processInfo.environment["RELAYRUNNER_WELCOME"] {
      return show(step: name == "done" ? .done : name == "signIn" ? .signIn : .hello)
    }
    let moved = AppSettings.welcomeMoved
    AppSettings.welcomeMoved = false
    if (AppSettings.welcomed && !moved) || Connection.shared.isEnrolled {
      AppSettings.welcomed = true
      return
    }
    show(step: moved ? .signIn : .hello)
  }

  private func show(step: WelcomeView.Step) {
    let view = WelcomeView(connection: .shared, step: step) { [weak self] in self?.window?.close() }
    let window = NSWindow(contentViewController: NSHostingController(rootView: view))
    window.title = "Welcome to RelayRunner"
    window.styleMask = [.titled, .closable, .fullSizeContentView]
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.isMovableByWindowBackground = true
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.center()
    self.window = window
    AppWindows.opened()
    window.makeKeyAndOrderFront(nil)
  }

  func windowWillClose(_ notification: Notification) {
    AppSettings.welcomed = true
    window = nil
    AppWindows.closed()
  }

  // MARK: Moving to Applications

  /// In /Applications or ~/Applications. A build run from Xcode or `swift run` isn't an app bundle, so
  /// it counts as moved. Moving relaunches the app, so this can't change while it runs.
  static let inApplications: Bool = {
    let url = Bundle.main.bundleURL
    guard url.pathExtension == "app" else { return true }
    let folders = [URL(fileURLWithPath: "/Applications"), FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")]
    return folders.contains { url.deletingLastPathComponent().standardizedFileURL.path == $0.standardizedFileURL.path }
  }()

  /// Copies the app to /Applications, replacing an older copy, and opens it from there. Returns what
  /// went wrong, or nil once the new copy is opening.
  func moveToApplications() -> String? {
    let source = Bundle.main.bundleURL
    let target = URL(fileURLWithPath: "/Applications").appendingPathComponent(source.lastPathComponent)
    let files = FileManager.default
    do {
      if files.fileExists(atPath: target.path) { try files.trashItem(at: target, resultingItemURL: nil) }
      try files.copyItem(at: source, to: target)
    } catch {
      return "Couldn't move it (\(error.localizedDescription)). Drag RelayRunner into Applications yourself, then open it from there."
    }
    // From Downloads this tidies up. From the disk image it fails, which is fine.
    try? files.trashItem(at: source, resultingItemURL: nil)
    AppSettings.welcomeMoved = true
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.createsNewApplicationInstance = true
    NSWorkspace.shared.openApplication(at: target, configuration: configuration) { _, error in
      DispatchQueue.main.async {
        if error == nil { NSApp.terminate(nil) }
      }
    }
    return nil
  }
}

struct WelcomeView: View {
  enum Step { case hello, signIn, done }

  let connection: Connection
  @State var step: Step
  let close: () -> Void

  @State private var share = LaunchOptions.Share.onlyMe
  @State private var opensAtLogin = true
  @State private var problem: String?

  var body: some View {
    VStack(spacing: 0) {
      Group {
        switch step {
        case .hello: hello
        case .signIn: signIn
        case .done: done
        }
      }
      .id(step)
      .transition(.asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)).combined(with: .opacity))
      .frame(maxWidth: .infinity, alignment: .top)
      Spacer(minLength: 20)
      footer
    }
    .padding(.horizontal, 36)
    .padding(.top, 40)
    .padding(.bottom, 24)
    .frame(width: 480, height: 390)
    .clipped()
    .animation(.smooth(duration: 0.35), value: step)
    .onChange(of: connection.phase) { _, phase in
      if step == .signIn && phase == .online { step = .done }
    }
  }

  // MARK: Steps

  private var hello: some View {
    VStack(spacing: 0) {
      art
      heading(
        "Welcome to RelayRunner",
        "Run GitHub Actions jobs on this Mac, right from the menu bar."
      )
      if !Welcome.inApplications {
        note("RelayRunner works best from your Applications folder, where it can update itself.")
      }
      if let problem { note(problem) }
    }
  }

  private var signIn: some View {
    VStack(spacing: 0) {
      art
      heading("Who can run jobs on this Mac?", "Only me makes it your personal runner: just your jobs. Next, your browser opens to sign this Mac in.")
      if let signIn = connection.signIn {
        SignInBox(signIn: signIn)
          .padding(.top, 22)
      } else {
        VStack(spacing: 8) {
          ShareChoice(title: "Only me", value: .onlyMe, selection: $share)
          ShareChoice(title: "Anyone in my workspaces", value: .anyone, selection: $share)
        }
        .padding(.top, 22)
        .disabled(connection.isOn)
      }
      if let problem = connection.problem {
        note(problem)
      } else if connection.isOn && connection.signIn == nil {
        note(connection.status)
      }
    }
  }

  private var done: some View {
    VStack(spacing: 0) {
      art
      heading(
        "This Mac is ready",
        "\(connection.machineName.map { "Connected as \($0). " } ?? "")RelayRunner lives in the menu bar. Look for the robot at the top of your screen."
      )
      VStack(alignment: .leading, spacing: 10) {
        Toggle("Open RelayRunner at login", isOn: $opensAtLogin)
        NotifyToggle()
      }
      .toggleStyle(.checkbox)
      .padding(.top, 22)
    }
  }

  // MARK: Footer

  @ViewBuilder private var footer: some View {
    HStack {
      if step == .hello && !Welcome.inApplications {
        Button("Not Now") { step = .signIn }
      }
      Spacer()
      switch step {
      case .hello where Welcome.inApplications:
        primary("Get Started") { step = .signIn }
      case .hello:
        primary("Move to Applications") { problem = Welcome.shared.moveToApplications() }
      case .signIn:
        if connection.isOn {
          Button("Cancel") { connection.turnOff() }
        } else {
          primary("Sign In") { connection.turnOn(share: share) }
        }
      case .done:
        primary("Done") {
          if opensAtLogin { AppSettings.opensAtLogin = true }
          close()
        }
      }
    }
  }

  /// The same robot on every step, so each heading sits at the same height.
  private var art: some View {
    Image(nsImage: RobotHead.colorImage(side: 64))
  }

  private func primary(_ title: String, action: @escaping () -> Void) -> some View {
    Button(title, action: action)
      .buttonStyle(.borderedProminent)
      .keyboardShortcut(.defaultAction)
  }

  private func heading(_ title: String, _ body: String) -> some View {
    VStack(spacing: 8) {
      Text(title)
        .font(.system(size: 22, weight: .semibold))
      Text(body)
        .foregroundStyle(.secondary)
        .frame(maxWidth: 380)
        .fixedSize(horizontal: false, vertical: true)
    }
    .multilineTextAlignment(.center)
    .padding(.top, 18)
  }

  private func note(_ text: String) -> some View {
    Text(text)
      .font(.callout)
      .foregroundStyle(.secondary)
      .multilineTextAlignment(.center)
      .frame(maxWidth: 380)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.top, 14)
  }
}

/// One answer to "who can run jobs here", as a card.
private struct ShareChoice: View {
  let title: String
  let value: LaunchOptions.Share
  @Binding var selection: LaunchOptions.Share

  var body: some View {
    let selected = selection == value
    Button {
      selection = value
    } label: {
      HStack(spacing: 10) {
        Image(systemName: selected ? "largecircle.fill.circle" : "circle")
          .foregroundStyle(selected ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
        Text(title)
        Spacer()
      }
      .padding(10)
      .contentShape(Rectangle())
      .background(.quaternary.opacity(selected ? 0.8 : 0.35), in: RoundedRectangle(cornerRadius: 8))
    }
    .buttonStyle(.plain)
  }
}
