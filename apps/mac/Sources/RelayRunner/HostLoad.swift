import Darwin
import Foundation
import Observation

/// This Mac's CPU and memory use, sampled every couple of seconds while the menu is open.
@MainActor
@Observable
final class HostLoad {
  static let shared = HostLoad()

  /// The share of every core's time spent working since the last sample, 0 to 1.
  private(set) var cpu: Double?
  /// Memory in use (app, wired and compressed), and the Mac's total, in bytes.
  private(set) var memoryUsed: UInt64?
  let memoryTotal = ProcessInfo.processInfo.physicalMemory

  private var timer: Timer?
  private var lastTicks: (busy: UInt64, total: UInt64)?

  func start() {
    guard timer == nil else { return }
    sample()
    timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
      Task { @MainActor in HostLoad.shared.sample() }
    }
  }

  func stop() {
    timer?.invalidate()
    timer = nil
  }

  private func sample() {
    if let ticks = Self.cpuTicks() {
      if let last = lastTicks, ticks.total > last.total {
        cpu = Double(ticks.busy - last.busy) / Double(ticks.total - last.total)
      }
      lastTicks = ticks
    }
    memoryUsed = Self.memoryInUse()
  }

  /// Every core's busy and total ticks since boot.
  private static func cpuTicks() -> (busy: UInt64, total: UInt64)? {
    var count: natural_t = 0
    var info: processor_info_array_t?
    var infoCount: mach_msg_type_number_t = 0
    guard
      host_processor_info(mach_host_self(), PROCESSOR_CPU_LOAD_INFO, &count, &info, &infoCount) == KERN_SUCCESS,
      let info
    else { return nil }
    defer {
      vm_deallocate(
        mach_task_self_, vm_address_t(UInt(bitPattern: info)), vm_size_t(Int(infoCount) * MemoryLayout<integer_t>.stride))
    }
    var busy: UInt64 = 0
    var total: UInt64 = 0
    for core in 0..<Int(count) {
      let base = core * Int(CPU_STATE_MAX)
      let user = UInt64(info[base + Int(CPU_STATE_USER)])
      let system = UInt64(info[base + Int(CPU_STATE_SYSTEM)])
      let nice = UInt64(info[base + Int(CPU_STATE_NICE)])
      let idle = UInt64(info[base + Int(CPU_STATE_IDLE)])
      busy += user + system + nice
      total += user + system + nice + idle
    }
    return (busy, total)
  }

  /// Memory in use the way Activity Monitor counts it: app memory, wired and compressed.
  private static func memoryInUse() -> UInt64? {
    var stats = vm_statistics64()
    var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &stats) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
      }
    }
    guard result == KERN_SUCCESS else { return nil }
    let page = UInt64(vm_kernel_page_size)
    let anonymous = UInt64(stats.internal_page_count)
    let purgeable = UInt64(stats.purgeable_count)
    let app = anonymous > purgeable ? anonymous - purgeable : 0
    return (app + UInt64(stats.wire_count) + UInt64(stats.compressor_page_count)) * page
  }
}
