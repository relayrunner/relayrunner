// What kind of device a connected machine is, as its CLI reported it (DeviceKind in
// @relayrunner/machine-protocol, which validates it before the API stores it).
export type DeviceKind = "laptop" | "desktop" | "server" | "vm" | "unknown";
