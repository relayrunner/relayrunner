import RelayRunnerKit
import SwiftUI

/// Settings › Workspaces: which workspaces this Mac takes jobs from, and who can run them. Both go
/// through the bundled CLI (`relayrunner workspaces` and `relayrunner share`) and apply right away.
struct WorkspaceSettings: View {
  private enum Load {
    case loading
    case loaded(MachineWorkspaces)
    case failed(String)
  }

  @State private var load = Load.loading
  @State private var busy = false
  @State private var problem: String?

  var body: some View {
    Group {
      if !Connection.shared.isEnrolled {
        Message("Turn RelayRunner on once to sign this Mac in. Then you can pick its workspaces here.")
      } else {
        switch load {
        case .loading:
          ProgressView().frame(maxWidth: .infinity, minHeight: 120)
        case .failed(let reason):
          VStack(spacing: 10) {
            Message("Couldn't load this Mac's workspaces. \(reason)")
            Button("Try Again") { Task { await reload() } }
          }
          .padding(.bottom, 16)
        case .loaded(let choice):
          form(choice)
        }
      }
    }
    .task { await reload() }
  }

  private func form(_ choice: MachineWorkspaces) -> some View {
    Form {
      Section {
        if choice.all.isEmpty {
          Text("No workspaces yet. This Mac takes jobs once RelayRunner is installed on a GitHub account or org you belong to.")
            .foregroundStyle(.secondary)
        }
        ForEach(choice.all) { item in
          Toggle(item.workspace.name, isOn: Binding(get: { item.on }, set: { set(item.workspace, on: $0) }))
        }
      } header: {
        Text("Take jobs from")
      } footer: {
        Text("Each workspace holds the GitHub accounts and orgs RelayRunner is installed on.")
      }

      Section {
        Picker("Who can run jobs on this Mac", selection: Binding(get: { choice.machine.sharing }, set: share)) {
          Text("Only me").tag(MachineWorkspaces.Sharing.onlyMe)
          Text("Anyone in these workspaces").tag(MachineWorkspaces.Sharing.anyone)
        }
        .pickerStyle(.radioGroup)
      } footer: {
        Text(
          choice.machine.sharing == .onlyMe
            ? "Only jobs you started run here."
            : "Teammates' and bots' jobs run here too."
        )
      }

      if let problem {
        Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
      }
    }
    .formStyle(.grouped)
    .disabled(busy)
    .fixedSize(horizontal: false, vertical: true)
  }

  private func reload() async {
    guard Connection.shared.isEnrolled else { return }
    do {
      let output = try await CLI.run(["workspaces", "list", "--json"])
      if output.status == 0, let choice = MachineWorkspaces.parse(output.stdout) {
        load = .loaded(choice)
      } else {
        load = .failed(output.problem)
      }
    } catch {
      load = .failed(error.localizedDescription)
    }
  }

  private func set(_ workspace: MachineWorkspaces.Workspace, on: Bool) {
    change(["workspaces", on ? "add" : "remove", workspace.id])
  }

  private func share(_ sharing: MachineWorkspaces.Sharing) {
    change(["share", sharing.argument])
  }

  /// Runs a change, then reads the workspaces again so the switches show what the gateway has.
  private func change(_ arguments: [String]) {
    busy = true
    problem = nil
    Task {
      defer { busy = false }
      do {
        let output = try await CLI.run(arguments)
        if output.status != 0 { problem = output.problem }
      } catch {
        problem = error.localizedDescription
      }
      await reload()
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
      .frame(maxWidth: .infinity)
      .padding(24)
  }
}
