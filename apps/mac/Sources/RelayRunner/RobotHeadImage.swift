import AppKit
import RelayRunnerKit

extension RobotHead {
  /// The menu bar icon: the one-color head as a template image, faded while it isn't taking jobs,
  /// with a dot while a job runs.
  static func menuBarImage(faded: Bool, busy: Bool) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { rect in
      guard let context = NSGraphicsContext.current?.cgContext else { return false }
      context.setAlpha(faded ? 0.45 : 1)
      draw(template, in: context, side: rect.width)
      if busy {
        context.setAlpha(1)
        context.setFillColor(.black)
        context.fillEllipse(in: CGRect(x: 12.5, y: 0, width: 5.5, height: 5.5))
      }
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "RelayRunner"
    return image
  }

  /// The color head, for the panel.
  static func colorImage(side: CGFloat) -> NSImage {
    NSImage(size: NSSize(width: side, height: side), flipped: true) { rect in
      guard let context = NSGraphicsContext.current?.cgContext else { return false }
      draw(color, in: context, side: rect.width)
      return true
    }
  }

  private static func draw(_ layers: [Layer], in context: CGContext, side: CGFloat) {
    context.saveGState()
    defer { context.restoreGState() }
    context.scaleBy(x: side / size, y: side / size)
    context.setLineJoin(.round)
    for layer in layers {
      guard let segments = SVGPath.parse(layer.d) else { continue }
      let path = cgPath(segments)
      if let fill = layer.fill {
        context.addPath(path)
        context.setFillColor(cgColor(fill))
        context.fillPath(using: layer.evenOdd ? .evenOdd : .winding)
      }
      if let stroke = layer.stroke {
        context.addPath(path)
        context.setStrokeColor(cgColor(stroke))
        context.setLineWidth(layer.lineWidth)
        context.setLineCap(layer.roundCaps ? .round : .butt)
        context.strokePath()
      }
    }
  }

  private static func cgPath(_ segments: [SVGPath.Segment]) -> CGPath {
    func cg(_ p: SVGPath.Point) -> CGPoint { CGPoint(x: p.x, y: p.y) }
    let path = CGMutablePath()
    for segment in segments {
      switch segment {
      case .move(let p): path.move(to: cg(p))
      case .line(let p): path.addLine(to: cg(p))
      case .quad(let c, let p): path.addQuadCurve(to: cg(p), control: cg(c))
      case .cubic(let c1, let c2, let p): path.addCurve(to: cg(p), control1: cg(c1), control2: cg(c2))
      case .close: path.closeSubpath()
      }
    }
    return path
  }

  private static func cgColor(_ hex: UInt32) -> CGColor {
    CGColor(
      srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255, alpha: 1
    )
  }
}
