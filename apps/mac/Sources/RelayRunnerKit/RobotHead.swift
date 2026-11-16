/// The robot head from `apps/site/public/assets/runner-head.svg` (color) and `runner-head-black.svg`
/// (one color, for the menu bar), on the same 36 by 36 grid.
public enum RobotHead {
  public struct Layer: Sendable {
    public var d: String
    public var fill: UInt32?
    public var stroke: UInt32?
    public var lineWidth = 1.0
    public var roundCaps = false
    /// Fill with the even-odd rule, so an inner shape cuts a hole.
    public var evenOdd = false
  }

  public static let size = 36.0

  private static let antenna = "m12 8 2.3-.8 2.3 6-2.3.8z"
  private static let cube = "m7.5 3.5 4.6-2.3 4.6 2.1v4.8l-4.6 2.4-4.6-2.3z"
  private static let head =
    "M3 18q0-2.2 2-3.3l5.2-2.8q1.5-.8 3.4-1l11.3-1.3q1.6-.2 3.1.6l4.4 2.3q2.1 1.1 2.1 3.8v11.4q0 2.9-3 3.4l-17.4 2.7q-1.6.2-3-.5l-6.4-3.1Q3 29.4 3 27.6z"
  private static let face = "M13.1 20.4q0-2.8 2.8-3.3l13.6-2.2q2.7-.4 2.7 2.4v8.8q0 2.5-2.5 3l-13.8 2.2q-2.8.4-2.8-2.4z"
  private static let eyes = "M20.3 21.7v4.1m7-5.2v4.1"

  private static let ink: UInt32 = 0x174C33
  private static let cream: UInt32 = 0xFFF5DC
  private static let leaf: UInt32 = 0xB5D888

  public static let color: [Layer] = [
    Layer(d: antenna, fill: ink, stroke: ink),
    Layer(d: cube, fill: cream, stroke: ink),
    Layer(d: "m8 4 4.1 2 .1 3.8L8 7.9z", fill: leaf),
    Layer(d: head, fill: cream, stroke: ink),
    Layer(d: "m3.6 17.2 7.8 3.3v10.2q0 1.2.4 2l-7-3.4q-1.2-.6-1.2-1.9z", fill: leaf),
    Layer(d: face, fill: 0x06472B),
    Layer(d: eyes, stroke: cream, lineWidth: 2.6, roundCaps: true),
  ]

  /// Black on clear, for a template image.
  public static let template: [Layer] = [
    Layer(d: antenna, fill: 0),
    Layer(d: cube, fill: 0),
    Layer(d: head + " " + face, fill: 0, evenOdd: true),
    Layer(d: eyes, stroke: 0, lineWidth: 2.6, roundCaps: true),
  ]
}
