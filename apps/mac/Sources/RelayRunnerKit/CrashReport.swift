import Foundation

/// A crash of the app or its bundled CLI, read from the report macOS writes to
/// ~/Library/Logs/DiagnosticReports (a `.ips` file: a JSON header line, then the report as JSON).
///
/// Only what helps find the bug is kept: versions, macOS, the exception and the crashed thread's
/// frames. Paths, user and machine ids, the crash reporter key and every other thread are left
/// out, so `text` is exactly what a person sees before they send it.
public struct CrashReport: Equatable, Sendable {
  public struct Frame: Equatable, Sendable {
    public var image: String
    /// The symbol and offset into it, or the offset into the image when it has no symbol.
    public var location: String
  }

  public var origin: Origin
  public var appVersion: String?
  public var osVersion: String?
  public var model: String?
  public var date: Date?
  public var exception: String?
  public var reason: String?
  public var message: String?
  public var thread: String?
  public var frames: [Frame]

  public enum Origin: Equatable, Sendable {
    case app
    case cli

    public var name: String { self == .app ? "the app" : "the bundled CLI" }
  }

  /// The most frames kept: enough to see where it crashed and what called it.
  public static let frameLimit = 24

  /// Reads a `.ips` crash report. Nil for anything else, such as a hang, or a crash of a process
  /// that isn't RelayRunner for Mac's: the standalone `relayrunner` CLI writes reports by the same
  /// name, and those aren't the app's to send.
  public init?(ips data: Data) {
    guard let text = String(data: data, encoding: .utf8),
      let newline = text.firstIndex(of: "\n"),
      let header = Self.object(text[..<newline]),
      let body = Self.object(text[text.index(after: newline)...]),
      (header["bug_type"] as? String) == "309"
    else { return nil }

    let path = body["procPath"] as? String ?? ""
    if path.hasSuffix("RelayRunner.app/Contents/MacOS/RelayRunner") {
      origin = .app
    } else if path.hasSuffix("RelayRunner.app/Contents/Helpers/relayrunner") {
      origin = .cli
    } else {
      return nil
    }

    let bundle = body["bundleInfo"] as? [String: Any]
    appVersion = bundle?["CFBundleShortVersionString"] as? String ?? header["app_version"] as? String
    osVersion = header["os_version"] as? String
    model = body["modelCode"] as? String
    date = (body["captureTime"] as? String ?? header["timestamp"] as? String).flatMap(Self.parseDate)

    let exception = body["exception"] as? [String: Any]
    self.exception = (exception?["type"] as? String).map { type in
      var text = (exception?["signal"] as? String).map { "\(type) (\($0))" } ?? type
      if let subtype = exception?["subtype"] as? String { text += ", \(Self.clean(subtype))" }
      return text
    }
    let termination = body["termination"] as? [String: Any]
    reason = (termination?["indicator"] as? String).map(Self.clean)
    // Application-specific information: a Swift fatal error's or a Rust panic's message.
    message = (body["asi"] as? [String: Any])?.values
      .compactMap { $0 as? [String] }
      .flatMap { $0 }
      .map(Self.clean)
      .first { !$0.isEmpty }

    let images = (body["usedImages"] as? [[String: Any]] ?? []).map { image in
      image["name"] as? String ?? (image["path"] as? String).map { ($0 as NSString).lastPathComponent } ?? "???"
    }
    let threads = body["threads"] as? [[String: Any]] ?? []
    let crashed =
      (body["faultingThread"] as? Int).flatMap { threads.indices.contains($0) ? threads[$0] : nil }
      ?? threads.first { $0["triggered"] as? Bool == true }
    thread = (crashed?["queue"] as? String) ?? (crashed?["name"] as? String)
    frames = (crashed?["frames"] as? [[String: Any]] ?? []).prefix(Self.frameLimit).map { frame in
      let index = frame["imageIndex"] as? Int ?? -1
      let image = images.indices.contains(index) ? images[index] : "???"
      let location: String
      if let symbol = frame["symbol"] as? String {
        location = "\(symbol) + \(frame["symbolLocation"] as? Int ?? 0)"
      } else {
        location = String(format: "0x%llx", frame["imageOffset"] as? Int ?? 0)
      }
      return Frame(image: Self.clean(image), location: Self.clean(location))
    }
  }

  /// The first line, which the report's email takes as its subject.
  public var summary: String {
    let app = "RelayRunner for Mac\(appVersion.map { " \($0)" } ?? "")"
    let what = origin == .app ? "\(app) crashed" : "\(app): the bundled CLI crashed"
    return exception.map { "\(what): \($0)" } ?? what
  }

  /// What's sent, in full.
  public var text: String {
    var lines = [summary, ""]
    func add(_ label: String, _ value: String?) {
      if let value, !value.isEmpty { lines.append("\(label): \(value)") }
    }
    add("Process", origin.name)
    add("macOS", osVersion.map { $0.replacingOccurrences(of: "macOS ", with: "") })
    add("Mac", model)
    add("When", date.map(Self.formatDate))
    add("Exception", exception)
    add("Reason", reason)
    add("Message", message)
    if !frames.isEmpty {
      lines.append("")
      lines.append("Crashed thread\(thread.map { " (\($0))" } ?? ""):")
      let width = frames.map(\.image.count).max() ?? 0
      for (index, frame) in frames.enumerated() {
        let number = String(index).padding(toLength: 3, withPad: " ", startingAt: 0)
        let image = frame.image.padding(toLength: width, withPad: " ", startingAt: 0)
        lines.append("\(number)\(image)  \(frame.location)")
      }
    }
    return lines.joined(separator: "\n")
  }

  // MARK: - Reading

  private static func object(_ text: Substring) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
  }

  /// A path under someone's home folder names them, so it becomes `~`. Control characters go too.
  private static let homePath = try! NSRegularExpression(pattern: #"/(?:Users|home)/[^/\s:]+"#)

  static func clean(_ text: String) -> String {
    let home = homePath.stringByReplacingMatches(
      in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "~")
    let visible = home.unicodeScalars.filter { $0 == "\n" || !CharacterSet.controlCharacters.contains($0) }
    let line = String(String.UnicodeScalarView(visible))
      .replacingOccurrences(of: "\n", with: " ")
      .trimmingCharacters(in: .whitespaces)
    return line.count > 500 ? String(line.prefix(499)) + "…" : line
  }

  // "2026-11-23 14:02:12.4567 -0800"
  private static func parseDate(_ value: String) -> Date? {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    // One report per launch at most, so a formatter each time is fine.
    for format in ["yyyy-MM-dd HH:mm:ss.SSSS Z", "yyyy-MM-dd HH:mm:ss.SS Z", "yyyy-MM-dd HH:mm:ss Z"] {
      formatter.dateFormat = format
      if let date = formatter.date(from: value) { return date }
    }
    return nil
  }

  // UTC, so the time doesn't say where someone is.
  private static func formatDate(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.dateFormat = "yyyy-MM-dd HH:mm 'UTC'"
    return formatter.string(from: date)
  }
}

extension CrashReport {
  /// The newest report of RelayRunner for Mac's crashes in `folder` written after `since`, and how
  /// many report files there are since then. Only the newest that reads is parsed.
  public static func latest(in folder: URL, since: Date) -> (report: CrashReport, count: Int)? {
    let keys: [URLResourceKey] = [.contentModificationDateKey]
    let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)) ?? []
    let recent = files
      .filter { url in
        let name = url.lastPathComponent
        return url.pathExtension == "ips" && (name.hasPrefix("RelayRunner-") || name.hasPrefix("relayrunner-"))
      }
      .compactMap { url -> (Date, URL)? in
        guard let modified = try? url.resourceValues(forKeys: Set(keys)).contentModificationDate,
          modified > since
        else { return nil }
        return (modified, url)
      }
      .sorted { $0.0 > $1.0 }
    for (_, url) in recent {
      if let data = try? Data(contentsOf: url), let report = CrashReport(ips: data) {
        return (report, recent.count)
      }
    }
    return nil
  }
}
