import ServiceManagement
import SwiftUI

struct SettingsView: View {
  @AppStorage(AppSettings.Key.concurrency) private var concurrency = 0
  @AppStorage(AppSettings.Key.cpus) private var cpus = 0
  @AppStorage(AppSettings.Key.memoryGB) private var memoryGB = 0
  @AppStorage(AppSettings.Key.macOSJobs) private var macOSJobs = false
  @AppStorage(AppSettings.Key.localNetwork) private var localNetwork = false
  @State private var openAtLogin = SMAppService.mainApp.status == .enabled

  var body: some View {
    Form {
      Toggle("Open at login", isOn: $openAtLogin)
        .onChange(of: openAtLogin) { _, on in
          if on { try? SMAppService.mainApp.register() } else { try? SMAppService.mainApp.unregister() }
          openAtLogin = SMAppService.mainApp.status == .enabled
        }
      Picker("Jobs at once", selection: $concurrency) {
        Text("Automatic").tag(0)
        ForEach(1...8, id: \.self) { Text("\($0)").tag($0) }
      }

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
      } header: {
        Text("Linux VMs")
      } footer: {
        Text("Each job runs in its own Linux VM on a Mac with Apple silicon, macOS 26 and Apple's container tool.")
      }

      Text("Changes apply the next time you turn it on.")
        .foregroundStyle(.secondary)
    }
    .formStyle(.grouped)
    .frame(width: 460)
    .fixedSize(horizontal: false, vertical: true)
  }
}
