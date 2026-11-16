/// Reads the `d` of an SVG path, so the app can draw the robot head from the same paths as the
/// site's `runner-head.svg`. Covers M, L, H, V, Q, C and Z, absolute and relative.
public enum SVGPath {
  public struct Point: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public init(_ x: Double, _ y: Double) {
      self.x = x
      self.y = y
    }
  }

  public enum Segment: Equatable, Sendable {
    case move(Point)
    case line(Point)
    case quad(Point, to: Point)
    case cubic(Point, Point, to: Point)
    case close
  }

  /// The path's segments in absolute coordinates, or nil when `d` uses something not covered.
  public static func parse(_ d: String) -> [Segment]? {
    var tokens = Tokens(d)
    var segments: [Segment] = []
    var current = Point(0, 0)
    var start = current
    var command: Character?

    while !tokens.atEnd {
      if let letter = tokens.letter() { command = letter }
      guard let letter = command else { return nil }
      let relative = letter.isLowercase
      func point() -> Point? {
        guard let x = tokens.number(), let y = tokens.number() else { return nil }
        return relative ? Point(current.x + x, current.y + y) : Point(x, y)
      }

      switch letter.uppercased() {
      case "M":
        guard let p = point() else { return nil }
        segments.append(.move(p))
        current = p
        start = p
        // Pairs after a move are lines.
        while tokens.nextIsNumber {
          guard let p = point() else { return nil }
          segments.append(.line(p))
          current = p
        }
      case "L":
        guard let p = point() else { return nil }
        segments.append(.line(p))
        current = p
      case "H":
        guard let x = tokens.number() else { return nil }
        current = Point(relative ? current.x + x : x, current.y)
        segments.append(.line(current))
      case "V":
        guard let y = tokens.number() else { return nil }
        current = Point(current.x, relative ? current.y + y : y)
        segments.append(.line(current))
      case "Q":
        guard let c = point(), let p = point() else { return nil }
        segments.append(.quad(c, to: p))
        current = p
      case "C":
        guard let c1 = point(), let c2 = point(), let p = point() else { return nil }
        segments.append(.cubic(c1, c2, to: p))
        current = p
      case "Z":
        segments.append(.close)
        current = start
        // Numbers right after Z don't mean anything.
        command = nil
      default:
        return nil
      }
    }
    return segments
  }

  private struct Tokens {
    private let chars: [Character]
    private var index = 0

    init(_ d: String) { chars = Array(d) }

    var atEnd: Bool {
      mutating get {
        skipSeparators()
        return index == chars.count
      }
    }

    var nextIsNumber: Bool {
      mutating get {
        skipSeparators()
        guard index < chars.count else { return false }
        let c = chars[index]
        return c.isNumber || c == "-" || c == "+" || c == "."
      }
    }

    mutating func letter() -> Character? {
      skipSeparators()
      guard index < chars.count, chars[index].isLetter else { return nil }
      defer { index += 1 }
      return chars[index]
    }

    /// One number. "2.3-.8" is two numbers, and so is ".5.5".
    mutating func number() -> Double? {
      guard nextIsNumber else { return nil }
      var text = ""
      if chars[index] == "-" || chars[index] == "+" {
        text.append(chars[index])
        index += 1
      }
      var seenDot = false
      while index < chars.count {
        let c = chars[index]
        if c.isNumber {
          text.append(c)
        } else if c == ".", !seenDot {
          seenDot = true
          text.append(c)
        } else {
          break
        }
        index += 1
      }
      return Double(text)
    }

    private mutating func skipSeparators() {
      while index < chars.count, chars[index] == " " || chars[index] == "," || chars[index].isNewline || chars[index] == "\t" {
        index += 1
      }
    }
  }
}
