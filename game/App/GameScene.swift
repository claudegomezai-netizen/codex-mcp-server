import SpriteKit

#if canImport(UIKit)
    import UIKit
#endif

/// Renders the simulation and feeds it input. Holds no game rules of its own —
/// everything it draws comes from `World` state or the events it emits.
final class GameScene: SKScene {

    private let model: GameModel
    private var world: World { model.world }

    private var sprites: Sprites?
    private let worldLayer = SKNode()
    private let groundLayer = SKNode()
    private let effectsLayer = SKNode()
    private let joystick = Joystick()

    private var heroNode = SKSpriteNode()
    private var heroShadow = SKSpriteNode()
    private var stackNode = SKNode()
    private var stackCountLabel = SKLabelNode()

    private var enemyNodes: [EntityID: SKSpriteNode] = [:]
    private var tokenNodes: [EntityID: SKSpriteNode] = [:]
    private var plotNodes: [EntityID: PlotNode] = [:]

    private var lastUpdate: TimeInterval = 0
    private var hudRefreshAccumulator: Double = 0
    private var cameraAnchor: CGPoint = .zero
    private var shakeMagnitude: CGFloat = 0

    /// A station's visuals: the ring, the tower on it, and its progress arc.
    private final class PlotNode {
        let root = SKNode()
        let ring = SKSpriteNode()
        let tower = SKSpriteNode()
        let progress = SKShapeNode()
        let label = SKLabelNode(fontNamed: "AvenirNext-Bold")
        var lastLevel = -1
    }

    init(model: GameModel, size: CGSize) {
        self.model = model
        super.init(size: size)
        scaleMode = .resizeFill
        backgroundColor = Theme.ground
        anchorPoint = CGPoint(x: 0.5, y: 0.5)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    // MARK: - Setup

    override func didMove(to view: SKView) {
        removeAllChildren()
        enemyNodes.removeAll()
        tokenNodes.removeAll()
        plotNodes.removeAll()

        let sprites = Sprites(view: view, balance: world.balance)
        self.sprites = sprites

        addChild(worldLayer)
        worldLayer.addChild(groundLayer)
        worldLayer.addChild(effectsLayer)

        buildGround()
        buildStations(sprites)
        buildHero(sprites)

        let camera = SKCameraNode()
        self.camera = camera
        addChild(camera)
        camera.addChild(joystick)
        joystick.zPosition = 1000

        updateCameraScale()
        cameraAnchor = point(world.hero.position)
        camera.position = cameraAnchor
    }

    override func didChangeSize(_ oldSize: CGSize) {
        super.didChangeSize(oldSize)
        updateCameraScale()
        joystick.layout(in: size, cameraScale: camera?.xScale ?? 1)
    }

    private func updateCameraScale() {
        guard let camera, size.width > 0 else { return }
        // Keep a consistent slice of the world visible regardless of device.
        let scale = Theme.visibleWorldWidth / min(size.width, size.height)
        camera.setScale(scale)
        joystick.layout(in: size, cameraScale: scale)
    }

    private func point(_ v: Vec2) -> CGPoint { CGPoint(x: v.x, y: v.y) }

    private func buildGround() {
        let arenaWidth = CGFloat(world.balance.arenaSize.x)
        let arenaHeight = CGFloat(world.balance.arenaSize.y)

        let floor = SKSpriteNode(
            color: Theme.ground.mixed(with: .white, amount: 0.04),
            size: CGSize(width: arenaWidth, height: arenaHeight))
        floor.position = CGPoint(x: arenaWidth / 2, y: arenaHeight / 2)
        floor.zPosition = -100
        groundLayer.addChild(floor)

        // A grid gives the eye something to track movement against; without it
        // a flat field makes the hero feel like it is sliding in place.
        let spacing: CGFloat = 100
        let grid = CGMutablePath()
        var x: CGFloat = 0
        while x <= arenaWidth {
            grid.move(to: CGPoint(x: x, y: 0))
            grid.addLine(to: CGPoint(x: x, y: arenaHeight))
            x += spacing
        }
        var y: CGFloat = 0
        while y <= arenaHeight {
            grid.move(to: CGPoint(x: 0, y: y))
            grid.addLine(to: CGPoint(x: arenaWidth, y: y))
            y += spacing
        }
        let gridNode = SKShapeNode(path: grid)
        gridNode.strokeColor = Theme.groundGrid
        gridNode.lineWidth = 1
        gridNode.alpha = 0.5
        gridNode.zPosition = -99
        groundLayer.addChild(gridNode)

        let border = SKShapeNode(
            rect: CGRect(x: 0, y: 0, width: arenaWidth, height: arenaHeight))
        border.strokeColor = Theme.groundGrid.mixed(with: .white, amount: 0.25)
        border.lineWidth = 6
        border.fillColor = .clear
        border.zPosition = -98
        groundLayer.addChild(border)
    }

    private func buildStations(_ sprites: Sprites) {
        // The bank.
        let bank = SKSpriteNode(texture: sprites.bank)
        bank.position = point(world.balance.bankPosition)
        bank.zPosition = -50
        groundLayer.addChild(bank)

        let bankLabel = SKLabelNode(fontNamed: "AvenirNext-Bold")
        bankLabel.text = "BANK"
        bankLabel.fontSize = 20
        bankLabel.fontColor = Theme.bank
        bankLabel.verticalAlignmentMode = .center
        bankLabel.position = point(world.balance.bankPosition)
        bankLabel.zPosition = -49
        groundLayer.addChild(bankLabel)

        // Tower plots.
        for plot in world.plots {
            let node = PlotNode()
            node.root.position = point(plot.position)
            node.root.zPosition = -50

            node.ring.texture = sprites.plotEmpty
            node.ring.size = sprites.plotEmpty.size()
            node.root.addChild(node.ring)

            node.tower.texture = sprites.tower
            node.tower.size = sprites.tower.size()
            node.tower.isHidden = true
            node.tower.zPosition = 2
            node.root.addChild(node.tower)

            node.progress.strokeColor = Theme.token
            node.progress.lineWidth = 6
            node.progress.lineCap = .round
            node.progress.zPosition = 3
            node.root.addChild(node.progress)

            node.label.fontSize = 18
            node.label.fontColor = .white
            node.label.verticalAlignmentMode = .center
            node.label.position = CGPoint(
                x: 0, y: -CGFloat(world.balance.plotInteractionRadius) - 16)
            node.label.zPosition = 3
            node.root.addChild(node.label)

            groundLayer.addChild(node.root)
            plotNodes[plot.id] = node
        }
    }

    private func buildHero(_ sprites: Sprites) {
        heroShadow.texture = sprites.shadow
        heroShadow.size = sprites.shadow.size()
        heroShadow.zPosition = 9
        worldLayer.addChild(heroShadow)

        heroNode.texture = sprites.hero
        heroNode.size = sprites.hero.size()
        heroNode.zPosition = 10
        worldLayer.addChild(heroNode)

        stackNode.zPosition = 20
        worldLayer.addChild(stackNode)

        stackCountLabel.fontSize = 22
        stackCountLabel.fontName = "AvenirNext-Bold"
        stackCountLabel.fontColor = .white
        stackCountLabel.verticalAlignmentMode = .center
        stackCountLabel.zPosition = 21
        worldLayer.addChild(stackCountLabel)
    }

    // MARK: - Loop

    override func update(_ currentTime: TimeInterval) {
        if lastUpdate == 0 { lastUpdate = currentTime }
        // Clamp so a stall (backgrounding, a slow first frame) cannot advance
        // the simulation by a huge step and teleport everything.
        let dt = min(1.0 / 20.0, max(0, currentTime - lastUpdate))
        lastUpdate = currentTime

        guard !model.isPaused else { return }

        world.step(dt, input: World.Input(move: joystick.direction))
        consumeEvents(world.drainEvents())
        syncNodes()
        followCamera(dt)

        hudRefreshAccumulator += dt
        if hudRefreshAccumulator >= 0.1 {
            hudRefreshAccumulator = 0
            model.refresh()
        }
    }

    private func followCamera(_ dt: Double) {
        guard let camera else { return }
        let target = point(world.hero.position)
        // Critically-damped-ish follow: quick enough to keep up, soft enough
        // that the frame does not snap on every direction change.
        let t = CGFloat(1 - pow(0.001, dt))
        cameraAnchor = CGPoint(
            x: cameraAnchor.x + (target.x - cameraAnchor.x) * t,
            y: cameraAnchor.y + (target.y - cameraAnchor.y) * t
        )

        // Shake is applied as an offset on top of the follow position rather
        // than as an action, so the two cannot fight over camera.position.
        let step = CGFloat(dt)
        shakeMagnitude = max(0, shakeMagnitude - shakeMagnitude * 9 * step - 0.4 * step)
        let offset =
            shakeMagnitude > 0.05
            ? CGPoint(
                x: CGFloat.random(in: -shakeMagnitude...shakeMagnitude),
                y: CGFloat.random(in: -shakeMagnitude...shakeMagnitude))
            : .zero

        camera.position = CGPoint(x: cameraAnchor.x + offset.x, y: cameraAnchor.y + offset.y)
    }

    // MARK: - Syncing entities

    private func syncNodes() {
        guard let sprites else { return }

        heroNode.position = point(world.hero.position)
        heroNode.zRotation = CGFloat(world.hero.facing)
        heroNode.alpha = world.hero.isDown ? 0.25 : (world.hero.invulnerability > 0 ? 0.6 : 1.0)
        heroShadow.position = CGPoint(x: heroNode.position.x, y: heroNode.position.y - 18)
        heroShadow.alpha = world.hero.isDown ? 0.1 : 0.28

        syncStack(sprites)

        // Enemies.
        var seenEnemies = Set<EntityID>()
        for enemy in world.enemies {
            seenEnemies.insert(enemy.id)
            let node: SKSpriteNode
            if let existing = enemyNodes[enemy.id] {
                node = existing
            } else {
                let texture = enemy.kind == .boss ? sprites.boss : sprites.grunt
                node = SKSpriteNode(texture: texture)
                node.size = texture.size()
                node.zPosition = enemy.kind == .boss ? 8 : 5
                worldLayer.addChild(node)
                enemyNodes[enemy.id] = node
                // A quick pop-in reads as "arrived" rather than "was always there".
                node.setScale(0.4)
                node.run(.scale(to: 1.0, duration: 0.18))
            }
            node.position = point(enemy.position)
            node.color = .white
            node.colorBlendFactor = CGFloat(min(1, enemy.hitFlash / 0.12)) * 0.85
        }
        for (id, node) in enemyNodes where !seenEnemies.contains(id) {
            enemyNodes.removeValue(forKey: id)
            node.removeFromParent()
        }

        // Loose tokens.
        var seenTokens = Set<EntityID>()
        for token in world.tokens {
            seenTokens.insert(token.id)
            let node: SKSpriteNode
            if let existing = tokenNodes[token.id] {
                node = existing
            } else {
                node = SKSpriteNode(texture: sprites.token)
                node.size = sprites.token.size()
                node.zPosition = 4
                worldLayer.addChild(node)
                tokenNodes[token.id] = node
            }
            node.position = point(token.position)
            // Fade out as they approach despawning, so vanishing is not abrupt.
            let remaining = world.balance.tokenLifetime - token.age
            node.alpha = remaining < 3 ? CGFloat(max(0.15, remaining / 3)) : 1
        }
        for (id, node) in tokenNodes where !seenTokens.contains(id) {
            tokenNodes.removeValue(forKey: id)
            node.removeFromParent()
        }

        syncPlots()
    }

    /// The stack above the hero's head — the genre's signature read, and the
    /// main feedback that killing things is paying off.
    private func syncStack(_ sprites: Sprites) {
        let carried = world.hero.carried
        let visible = min(carried, 10)

        while stackNode.children.count < visible {
            let coin = SKSpriteNode(texture: sprites.token)
            coin.size = sprites.token.size()
            stackNode.addChild(coin)
        }
        while stackNode.children.count > visible {
            stackNode.children.last?.removeFromParent()
        }

        let baseX = CGFloat(world.hero.position.x)
        let baseY = CGFloat(world.hero.position.y + world.balance.heroRadius + 14)
        let coinSpacing: CGFloat = 7

        for (index, coin) in stackNode.children.enumerated() {
            // Slight horizontal wobble so the stack looks hand-piled.
            let wobble = CGFloat(sin(Double(index) * 1.7 + world.elapsed * 3) * 2.2)
            coin.position = CGPoint(
                x: baseX + wobble, y: baseY + CGFloat(index) * coinSpacing)
        }

        stackCountLabel.isHidden = carried == 0
        stackCountLabel.text = "\(carried)"
        stackCountLabel.position = CGPoint(
            x: baseX, y: baseY + CGFloat(visible) * coinSpacing + 18)
        // Turns amber when the satchel is full — the moment that sells the
        // carry-capacity upgrade without a word of tutorial text.
        stackCountLabel.fontColor = carried >= world.carryCapacity ? Theme.token : .white
    }

    private func syncPlots() {
        for plot in world.plots {
            guard let node = plotNodes[plot.id] else { continue }

            if plot.level != node.lastLevel {
                node.lastLevel = plot.level
                node.tower.isHidden = !plot.isBuilt
                node.label.text = plot.isBuilt ? "LV \(plot.level)" : ""
                if plot.isBuilt {
                    node.tower.removeAllActions()
                    node.tower.setScale(1.35)
                    node.tower.run(.scale(to: 1.0, duration: 0.22))
                }
            }

            let target = Double(world.economy.towerCost(level: plot.level))
            let fraction = target > 0 ? min(1, plot.deposited / target) : 0
            if fraction > 0.001 {
                let radius = CGFloat(world.balance.plotInteractionRadius) - 8
                let start = CGFloat.pi / 2
                let end = start - CGFloat.pi * 2 * CGFloat(fraction)
                let path = CGMutablePath()
                path.addArc(
                    center: .zero,
                    radius: radius,
                    startAngle: start,
                    endAngle: end,
                    clockwise: true)
                node.progress.path = path
            } else {
                node.progress.path = nil
            }
        }
    }

    // MARK: - Events → juice

    private func consumeEvents(_ events: [SimEvent]) {
        guard let sprites else { return }

        for event in events {
            switch event {
            case .swordSwing(let origin, let facing, _, _):
                let arc = SKSpriteNode(texture: sprites.swingArc)
                arc.size = sprites.swingArc.size()
                // The arc texture is drawn centred on the hero's origin, so
                // shift its anchor to pivot around the hero rather than itself.
                arc.anchorPoint = CGPoint(x: 0.5, y: 0.5)
                arc.position = point(origin)
                arc.zRotation = CGFloat(facing)
                arc.zPosition = 11
                arc.alpha = 0.9
                effectsLayer.addChild(arc)
                arc.run(
                    .sequence([
                        .group([.fadeOut(withDuration: 0.16), .scale(to: 1.12, duration: 0.16)]),
                        .removeFromParent(),
                    ]))

            case .enemyDied(let position, let kind, _):
                spawnBurst(at: position, color: kind == .boss ? Theme.boss : Theme.grunt,
                           count: kind == .boss ? 18 : 6)
                if kind == .boss { shakeCamera(intensity: 14) }

            case .tokenCollected(_, let value, _):
                if value > 0 { model.playCollect() }

            case .stackFull(let position):
                flashText("SATCHEL FULL", at: position, color: Theme.token, rise: 46)

            case .towerFired(let from, let to, _):
                drawTracer(from: from, to: to)

            case .towerBuilt(_, let position, let level):
                flashText(level == 1 ? "TOWER BUILT" : "TOWER LV \(level)",
                          at: position, color: Theme.tower, rise: 54)
                spawnBurst(at: position, color: Theme.tower, count: 14)
                shakeCamera(intensity: 6)

            case .heroDamaged:
                shakeCamera(intensity: 5)

            case .heroDowned(let position, let lost):
                if lost > 0 {
                    flashText("-\(lost)", at: position, color: Theme.grunt, rise: 60)
                }
                shakeCamera(intensity: 20)

            case .waveStarted(let wave, let isBoss):
                model.announce(isBoss ? "BOSS — WAVE \(wave)" : "WAVE \(wave)")

            default:
                break
            }
        }
    }

    private func drawTracer(from: Vec2, to: Vec2) {
        let path = CGMutablePath()
        path.move(to: point(from))
        path.addLine(to: point(to))

        let line = SKShapeNode(path: path)
        line.strokeColor = Theme.tower.mixed(with: .white, amount: 0.4)
        line.lineWidth = 3
        line.lineCap = .round
        line.zPosition = 7
        effectsLayer.addChild(line)
        line.run(
            .sequence([
                .fadeOut(withDuration: world.balance.towerTracerDuration),
                .removeFromParent(),
            ]))
    }

    private func spawnBurst(at position: Vec2, color: SKColor, count: Int) {
        for _ in 0..<count {
            let bit = SKSpriteNode(color: color, size: CGSize(width: 6, height: 6))
            bit.position = point(position)
            bit.zPosition = 12
            effectsLayer.addChild(bit)

            let angle = CGFloat.random(in: 0..<(.pi * 2))
            let distance = CGFloat.random(in: 22...70)
            bit.run(
                .sequence([
                    .group([
                        .move(
                            by: CGVector(dx: cos(angle) * distance, dy: sin(angle) * distance),
                            duration: 0.32),
                        .fadeOut(withDuration: 0.32),
                        .scale(to: 0.2, duration: 0.32),
                    ]),
                    .removeFromParent(),
                ]))
        }
    }

    private func flashText(_ text: String, at position: Vec2, color: SKColor, rise: CGFloat) {
        guard !text.isEmpty else { return }
        let label = SKLabelNode(fontNamed: "AvenirNext-Bold")
        label.text = text
        label.fontSize = 22
        label.fontColor = color
        label.position = point(position)
        label.zPosition = 30
        effectsLayer.addChild(label)
        label.run(
            .sequence([
                .group([
                    .moveBy(x: 0, y: rise, duration: 0.7),
                    .sequence([.wait(forDuration: 0.35), .fadeOut(withDuration: 0.35)]),
                ]),
                .removeFromParent(),
            ]))
    }

    /// Shakes stack rather than replace, so a boss dying mid-swarm hits harder
    /// than either event alone, and decay is handled in `followCamera`.
    private func shakeCamera(intensity: CGFloat) {
        shakeMagnitude = min(26, shakeMagnitude + intensity)
    }

    // MARK: - Input

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let camera, let touch = touches.first else { return }
        joystick.begin(at: touch.location(in: camera))
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let camera, let touch = touches.first else { return }
        joystick.move(to: touch.location(in: camera))
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        joystick.end()
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        joystick.end()
    }
}
