import SpriteKit

/// Floating virtual joystick: it appears wherever the thumb lands rather than
/// sitting in a fixed corner. On a one-verb game where movement *is* the whole
/// input, forcing the player to find a fixed pad is the single most common way
/// to make good controls feel bad.
final class Joystick: SKNode {

    private let ring = SKShapeNode(circleOfRadius: 62)
    private let knob = SKShapeNode(circleOfRadius: 28)
    private let hint = SKLabelNode(fontNamed: "AvenirNext-Bold")

    private var origin: CGPoint = .zero
    private var isActive = false
    private let maxTravel: CGFloat = 62

    /// Current input as a unit-ish vector, ready to hand to `World.Input`.
    private(set) var direction = Vec2.zero

    override init() {
        super.init()

        ring.fillColor = SKColor(white: 1, alpha: 0.06)
        ring.strokeColor = SKColor(white: 1, alpha: 0.28)
        ring.lineWidth = 3
        ring.isAntialiased = true
        ring.alpha = 0
        addChild(ring)

        knob.fillColor = SKColor(white: 1, alpha: 0.30)
        knob.strokeColor = SKColor(white: 1, alpha: 0.55)
        knob.lineWidth = 2
        knob.isAntialiased = true
        knob.alpha = 0
        addChild(knob)

        hint.text = "DRAG TO MOVE"
        hint.fontSize = 17
        hint.fontColor = SKColor(white: 1, alpha: 0.5)
        hint.verticalAlignmentMode = .center
        addChild(hint)

        isUserInteractionEnabled = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    /// Keeps the hint readable regardless of device size and camera zoom.
    func layout(in size: CGSize, cameraScale: CGFloat) {
        hint.position = CGPoint(x: 0, y: -size.height * cameraScale * 0.36)
    }

    func begin(at location: CGPoint) {
        origin = location
        isActive = true
        ring.position = location
        knob.position = location
        ring.alpha = 1
        knob.alpha = 1
        hint.run(.fadeOut(withDuration: 0.2))
        update(to: location)
    }

    func move(to location: CGPoint) {
        guard isActive else { return }
        update(to: location)
    }

    func end() {
        isActive = false
        direction = .zero
        ring.run(.fadeOut(withDuration: 0.15))
        knob.run(.fadeOut(withDuration: 0.15))
    }

    private func update(to location: CGPoint) {
        let dx = location.x - origin.x
        let dy = location.y - origin.y
        let distance = (dx * dx + dy * dy).squareRoot()

        if distance <= 0.001 {
            direction = .zero
            knob.position = origin
            return
        }

        let clamped = min(distance, maxTravel)
        let nx = dx / distance
        let ny = dy / distance
        knob.position = CGPoint(x: origin.x + nx * clamped, y: origin.y + ny * clamped)

        // A small dead zone stops a resting thumb from drifting the hero, and
        // full magnitude is reached before the knob hits the ring so the player
        // does not have to stretch for top speed.
        let magnitude = clamped / maxTravel
        let shaped = magnitude < 0.12 ? 0 : min(1, (magnitude - 0.12) / 0.58)
        direction = Vec2(Double(nx * shaped), Double(ny * shaped))
    }
}
