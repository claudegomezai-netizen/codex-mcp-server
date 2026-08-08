import Foundation

/// Minimal 2D vector. Deliberately not CGPoint so the core stays portable.
public struct Vec2: Equatable, Sendable {
    public var x: Double
    public var y: Double

    public init(_ x: Double = 0, _ y: Double = 0) {
        self.x = x
        self.y = y
    }

    public static let zero = Vec2(0, 0)

    public static func + (a: Vec2, b: Vec2) -> Vec2 { Vec2(a.x + b.x, a.y + b.y) }
    public static func - (a: Vec2, b: Vec2) -> Vec2 { Vec2(a.x - b.x, a.y - b.y) }
    public static func * (a: Vec2, s: Double) -> Vec2 { Vec2(a.x * s, a.y * s) }
    public static func / (a: Vec2, s: Double) -> Vec2 { Vec2(a.x / s, a.y / s) }
    public static func += (a: inout Vec2, b: Vec2) { a = a + b }
    public static func -= (a: inout Vec2, b: Vec2) { a = a - b }

    public var lengthSquared: Double { x * x + y * y }
    public var length: Double { (x * x + y * y).squareRoot() }

    public var normalized: Vec2 {
        let l = length
        return l > 1e-9 ? Vec2(x / l, y / l) : .zero
    }

    /// Angle in radians, measured counter-clockwise from +X.
    public var angle: Double { atan2(y, x) }

    public func distance(to other: Vec2) -> Double { (self - other).length }
    public func distanceSquared(to other: Vec2) -> Double { (self - other).lengthSquared }

    public func clampedMagnitude(_ maxLength: Double) -> Vec2 {
        let l = length
        return l > maxLength ? (self / l) * maxLength : self
    }

    public static func fromAngle(_ radians: Double, magnitude: Double = 1) -> Vec2 {
        Vec2(cos(radians) * magnitude, sin(radians) * magnitude)
    }

    /// Smallest signed angle between two directions, in radians.
    public static func angleDelta(_ a: Double, _ b: Double) -> Double {
        var d = (b - a).truncatingRemainder(dividingBy: .pi * 2)
        if d > .pi { d -= .pi * 2 }
        if d < -.pi { d += .pi * 2 }
        return d
    }
}

extension Vec2: CustomStringConvertible {
    public var description: String { String(format: "(%.1f, %.1f)", x, y) }
}
