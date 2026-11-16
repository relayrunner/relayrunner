import Foundation

/// What `relayrunner workspaces list --json` prints (apps/cli/machine-workspaces.ts): the
/// workspaces this Mac takes jobs in, its owner's other ones, and who can run jobs on it.
public struct MachineWorkspaces: Equatable, Decodable {
  public struct Machine: Equatable, Decodable {
    public var id: String
    public var name: String
    public var sharing: Sharing
  }

  public enum Sharing: String, Equatable, Decodable {
    case onlyMe = "only_me"
    case anyone

    /// How `relayrunner share` spells it.
    public var argument: String { self == .onlyMe ? "only-me" : "anyone" }
  }

  public struct Workspace: Equatable, Decodable, Identifiable {
    public var id: String
    public var name: String
    public var slug: String?
  }

  public var machine: Machine
  public var workspaces: [Workspace]
  public var others: [Workspace]

  public struct Item: Equatable, Identifiable {
    public var workspace: Workspace
    /// This Mac takes jobs in it.
    public var on: Bool
    public var id: String { workspace.id }
  }

  /// Every workspace, by name, with whether this Mac takes jobs in it.
  public var all: [Item] {
    (workspaces.map { Item(workspace: $0, on: true) } + others.map { Item(workspace: $0, on: false) })
      .sorted { $0.workspace.name.localizedCaseInsensitiveCompare($1.workspace.name) == .orderedAscending }
  }

  public static func parse(_ data: Data) -> MachineWorkspaces? {
    try? JSONDecoder().decode(MachineWorkspaces.self, from: data)
  }
}
