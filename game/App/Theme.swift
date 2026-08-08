import SpriteKit

/// Palette and sizing. Everything is drawn procedurally, so this file is
/// effectively the game's entire art direction.
enum Theme {
    static let ground = SKColor(red: 0.13, green: 0.15, blue: 0.20, alpha: 1)
    static let groundGrid = SKColor(red: 0.17, green: 0.20, blue: 0.26, alpha: 1)

    static let hero = SKColor(red: 0.42, green: 0.78, blue: 1.00, alpha: 1)
    static let heroTrim = SKColor(red: 0.85, green: 0.94, blue: 1.00, alpha: 1)
    static let blade = SKColor(red: 0.92, green: 0.96, blue: 1.00, alpha: 1)

    static let grunt = SKColor(red: 0.89, green: 0.36, blue: 0.42, alpha: 1)
    static let boss = SKColor(red: 0.78, green: 0.30, blue: 0.86, alpha: 1)

    static let token = SKColor(red: 1.00, green: 0.80, blue: 0.24, alpha: 1)
    static let tokenEdge = SKColor(red: 0.78, green: 0.55, blue: 0.08, alpha: 1)

    static let plotEmpty = SKColor(red: 0.30, green: 0.34, blue: 0.42, alpha: 1)
    static let tower = SKColor(red: 0.44, green: 0.82, blue: 0.62, alpha: 1)
    static let bank = SKColor(red: 1.00, green: 0.72, blue: 0.32, alpha: 1)

    static let health = SKColor(red: 0.40, green: 0.86, blue: 0.50, alpha: 1)
    static let healthBacking = SKColor(white: 0, alpha: 0.45)
    static let damageText = SKColor(red: 1.00, green: 0.88, blue: 0.55, alpha: 1)

    /// How many world units fit across the narrow edge of the screen. Larger
    /// shows more of the field; this is the main "feel" dial for the camera.
    /// How much world the short screen edge shows. At 780 the hero was 26pt
    /// across on a phone — legible, but the arena read as empty and far away.
    /// 520 puts the hero at roughly a tenth of the screen width, which is
    /// where the genre sits.
    static let visibleWorldWidth: CGFloat = 520
}

extension SKColor {
    func mixed(with other: SKColor, amount: CGFloat) -> SKColor {
        var r1: CGFloat = 0, g1: CGFloat = 0, b1: CGFloat = 0, a1: CGFloat = 0
        var r2: CGFloat = 0, g2: CGFloat = 0, b2: CGFloat = 0, a2: CGFloat = 0
        getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        other.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        let t = max(0, min(1, amount))
        return SKColor(
            red: r1 + (r2 - r1) * t,
            green: g1 + (g2 - g1) * t,
            blue: b1 + (b2 - b1) * t,
            alpha: a1 + (a2 - a1) * t
        )
    }
}
