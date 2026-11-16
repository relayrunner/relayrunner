import Darwin
import Foundation

/// A running `relayrunner connect --events`. It runs in its own process group, the way a terminal
/// runs it, so SIGINT to the group reaches a running job's runner too and lets it clean up.
/// stdout is read line by line; stderr, what `connect` would print for a person, goes to a log file.
final class CLIProcess {
  struct SpawnError: LocalizedError {
    let code: Int32
    var errorDescription: String? { String(cString: strerror(code)) }
  }

  let pid: pid_t
  private let input: FileHandle

  /// `onLine` gets each line of stdout and `onExit` the exit code once stdout has closed too, both
  /// on the main queue.
  init(
    executable: URL,
    arguments: [String],
    environment: [String: String],
    log: URL,
    onLine: @escaping (Data) -> Void,
    onExit: @escaping (Int32) -> Void
  ) throws {
    var stdinPipe: [Int32] = [0, 0]
    var stdoutPipe: [Int32] = [0, 0]
    guard pipe(&stdinPipe) == 0 else { throw SpawnError(code: errno) }
    guard pipe(&stdoutPipe) == 0 else {
      close(stdinPipe[0])
      close(stdinPipe[1])
      throw SpawnError(code: errno)
    }

    var actions: posix_spawn_file_actions_t? = nil
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_adddup2(&actions, stdinPipe[0], 0)
    posix_spawn_file_actions_adddup2(&actions, stdoutPipe[1], 1)
    posix_spawn_file_actions_addopen(&actions, 2, log.path, O_WRONLY | O_CREAT | O_TRUNC, 0o600)

    var attributes: posix_spawnattr_t? = nil
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    // Its own process group, and only stdin, stdout and stderr: the app's other files stay its own.
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
    posix_spawnattr_setpgroup(&attributes, 0)

    let argv = ([executable.path] + arguments).map { strdup($0) } + [nil]
    let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer {
      argv.forEach { free($0) }
      envp.forEach { free($0) }
    }
    var pid: pid_t = 0
    let status = posix_spawn(&pid, executable.path, &actions, &attributes, argv, envp)
    close(stdinPipe[0])
    close(stdoutPipe[1])
    guard status == 0 else {
      close(stdinPipe[1])
      close(stdoutPipe[0])
      throw SpawnError(code: status)
    }
    self.pid = pid
    input = FileHandle(fileDescriptor: stdinPipe[1], closeOnDealloc: true)

    // Exit is reported after the last line, so nothing that came before it is lost.
    let done = DispatchGroup()
    done.enter()
    done.enter()
    var buffer = Data()
    let output = FileHandle(fileDescriptor: stdoutPipe[0], closeOnDealloc: true)
    output.readabilityHandler = { handle in
      let chunk = handle.availableData
      if chunk.isEmpty {
        handle.readabilityHandler = nil
        done.leave()
        return
      }
      buffer.append(chunk)
      while let end = buffer.firstIndex(of: UInt8(ascii: "\n")) {
        let line = buffer.subdata(in: buffer.startIndex..<end)
        buffer.removeSubrange(buffer.startIndex...end)
        DispatchQueue.main.async { onLine(line) }
      }
    }
    var exitCode: Int32 = 0
    DispatchQueue.global().async {
      var status: Int32 = 0
      while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
      // WIFEXITED / WEXITSTATUS: a signal's number is in the low bits, an exit code in the next 8.
      exitCode = status & 0x7f == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
      done.leave()
    }
    done.notify(queue: .main) { onExit(exitCode) }
  }

  /// A command for `connect` on stdin, such as `pause`. Does nothing once it has exited.
  func send(_ command: String) {
    try? input.write(contentsOf: Data("\(command)\n".utf8))
  }

  /// Ctrl-C: goes offline, and a job that's running stops. A second one exits at once.
  func interrupt() {
    kill(-pid, SIGINT)
  }
}
