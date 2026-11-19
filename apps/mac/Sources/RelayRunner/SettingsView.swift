import AppKit
import SwiftUI

/// The Settings window: General, Workspaces, Linux VMs and About.
struct SettingsView: View {
  var body: some View {
    TabView {
      GeneralSettings().tabItem { Label("General", systemImage: "gearshape") }
      WorkspaceSettings().tabItem { Label("Workspaces", systemImage: "person.2") }
      VMSettings().tabItem { Label("Linux VMs", systemImage: "shippingbox") }
      AboutView().tabItem { Label("About", systemImage: "info.circle") }
    }
    .frame(width: 460)
    .onAppear { AppWindows.opened() }
    .onDisappear { AppWindows.closed() }
  }
}

private struct GeneralSettings: View {
  @AppStorage(AppSettings.Key.concurrency) private var concurrency = 0
  @State private var openAtLogin = AppSettings.opensAtLogin
  @State private var checksForUpdates = Updates.shared.updater?.automaticallyChecksForUpdates ?? false

  var body: some View {
    Form {
      Toggle("Open at login", isOn: $openAtLogin)
        .onChange(of: openAtLogin) { _, on in
          AppSettings.opensAtLogin = on
          openAtLogin = AppSettings.opensAtLogin
        }
      if let updater = Updates.shared.updater {
        Toggle("Check for updates automatically", isOn: $checksForUpdates)
          .onChange(of: checksForUpdates) { _, on in updater.automaticallyChecksForUpdates = on }
      }
      NotifyToggle()
      Picker("Jobs at once", selection: $concurrency) {
        Text("Automatic").tag(0)
        ForEach(1...8, id: \.self) { Text("\($0)").tag($0) }
      }
      ApplyNote()
    }
    .formStyle(.grouped)
    .fixedSize(horizontal: false, vertical: true)
  }
}

private struct VMSettings: View {
  @AppStorage(AppSettings.Key.cpus) private var cpus = 0
  @AppStorage(AppSettings.Key.memoryGB) private var memoryGB = 0
  @AppStorage(AppSettings.Key.macOSJobs) private var macOSJobs = false
  @AppStorage(AppSettings.Key.localNetwork) private var localNetwork = false

  var body: some View {
    Form {
      Section {
        Picker("CPUs per job", selection: $cpus) {
          Text("Automatic").tag(0)
          ForEach([2, 4, 6, 8, 12], id: \.self) { Text("\($0)").tag($0) }
        }
        Picker("Memory per job", selection: $memoryGB) {
          Text("Automatic").tag(0)
          ForEach([4, 8, 12, 16, 24], id: \.self) { Text("\($0) GB").tag($0) }
        }
        Toggle("Let jobs reach this Mac and your local network", isOn: $localNetwork)
        Toggle("Also take macOS jobs, which run on this Mac itself", isOn: $macOSJobs)
      } footer: {
        Text("Each job runs in its own Linux VM on a Mac with Apple silicon, macOS 26 and Apple's container tool.")
      }
      ApplyNote()
    }
    .formStyle(.grouped)
    .fixedSize(horizontal: false, vertical: true)
  }
}

private struct ApplyNote: View {
  var body: some View {
    Text("Changes apply the next time you turn it on.")
      .foregroundStyle(.secondary)
  }
}

private struct AboutView: View {
  private let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
  private let cliVersion = Bundle.main.object(forInfoDictionaryKey: "RRCLIVersion") as? String

  var body: some View {
    VStack(spacing: 10) {
      Image(nsImage: NSApp.applicationIconImage)
        .resizable()
        .frame(width: 96, height: 96)
      Text("RelayRunner").font(.title2.weight(.semibold))
      if let version {
        Text(cliVersion.map { "Version \(version) (CLI \($0))" } ?? "Version \(version)")
          .foregroundStyle(.secondary)
      }
      HStack(spacing: 16) {
        Link("Website", destination: URL(string: "https://relayrunner.dev")!)
        Link("Docs", destination: URL(string: "https://relayrunner.dev/docs")!)
        Link("GitHub", destination: URL(string: "https://github.com/relayrunner/relayrunner")!)
      }
      .padding(.top, 4)
      HStack(spacing: 10) {
        if Updates.shared.updater != nil {
          Button("Check for Updates…") { Updates.shared.checkForUpdates() }
        }
        Button("Show Log") { NSWorkspace.shared.open(CLI.log) }
      }
      .padding(.top, 8)
    }
    .frame(maxWidth: .infinity)
    .padding(24)
  }
}
