import Darwin
import Foundation

/// How much of this Mac's memory is in use.
enum HostMemory {
  /// The share in use, 0 to 1, the way Activity Monitor counts it: app memory, wired and
  /// compressed. Nil when the system won't say.
  static func shareInUse() -> Double? {
    var stats = vm_statistics64()
    var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &stats) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
      }
    }
    guard result == KERN_SUCCESS else { return nil }
    let anonymous = UInt64(stats.internal_page_count)
    let purgeable = UInt64(stats.purgeable_count)
    let app = anonymous > purgeable ? anonymous - purgeable : 0
    let used = (app + UInt64(stats.wire_count) + UInt64(stats.compressor_page_count)) * UInt64(vm_kernel_page_size)
    return Double(used) / Double(max(ProcessInfo.processInfo.physicalMemory, 1))
  }
}
