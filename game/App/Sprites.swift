import SpriteKit

/// Builds every texture the game needs once, at load, by rasterising shapes.
///
/// Shape nodes are convenient but slow in bulk, and this game routinely has a
/// hundred-plus enemies on screen. Rasterising once and drawing sprites keeps
/// the draw calls batched — and it means the project ships with no art assets
/// at all, so it runs the moment it is opened.
final class Sprites {
    let hero: SKTexture
    let grunt: SKTexture
    let boss: SKTexture
    let token: SKTexture
    let plotEmpty: SKTexture
    let tower: SKTexture
    let bank: SKTexture
    let swingArc: SKTexture
    let shadow: SKTexture

    init(view: SKView, balance: Balance) {
        func disc(radius: CGFloat, fill: SKColor, stroke: SKColor, lineWidth: CGFloat = 3)
            -> SKTexture
        {
            let shape = SKShapeNode(circleOfRadius: radius)
            shape.fillColor = fill
            shape.strokeColor = stroke
            shape.lineWidth = lineWidth
            shape.isAntialiased = true
            return view.texture(from: shape) ?? SKTexture()
        }

        hero = Sprites.makeHero(radius: CGFloat(balance.heroRadius), view: view)
        grunt = disc(
            radius: CGFloat(balance.enemyRadius),
            fill: Theme.grunt,
            stroke: Theme.grunt.mixed(with: .black, amount: 0.35))
        boss = disc(
            radius: CGFloat(balance.enemyRadius * balance.bossRadiusMultiplier),
            fill: Theme.boss,
            stroke: Theme.boss.mixed(with: .black, amount: 0.35),
            lineWidth: 5)
        token = disc(radius: 9, fill: Theme.token, stroke: Theme.tokenEdge, lineWidth: 2.5)

        plotEmpty = Sprites.makeStation(
            radius: CGFloat(balance.plotInteractionRadius),
            fill: Theme.plotEmpty.withAlphaComponent(0.25),
            stroke: Theme.plotEmpty,
            dashed: true,
            view: view)
        tower = Sprites.makeTower(radius: CGFloat(balance.towerRadius), view: view)
        bank = Sprites.makeStation(
            radius: CGFloat(balance.plotInteractionRadius),
            fill: Theme.bank.withAlphaComponent(0.20),
            stroke: Theme.bank,
            dashed: false,
            view: view)

        swingArc = Sprites.makeSwingArc(
            range: CGFloat(balance.swordRange),
            arc: CGFloat(balance.swordArc),
            view: view)

        let shadowShape = SKShapeNode(ellipseOf: CGSize(width: 44, height: 18))
        shadowShape.fillColor = SKColor(white: 0, alpha: 0.28)
        shadowShape.strokeColor = .clear
        shadow = view.texture(from: shadowShape) ?? SKTexture()
    }

    private static func makeHero(radius: CGFloat, view: SKView) -> SKTexture {
        let root = SKNode()

        let body = SKShapeNode(circleOfRadius: radius)
        body.fillColor = Theme.hero
        body.strokeColor = Theme.heroTrim
        body.lineWidth = 3
        root.addChild(body)

        // A notch pointing along +X marks facing, so the swing reads as aimed.
        let notch = SKShapeNode(
            rect: CGRect(x: radius * 0.35, y: -radius * 0.22, width: radius * 0.85, height: radius * 0.44),
            cornerRadius: radius * 0.18)
        notch.fillColor = Theme.blade
        notch.strokeColor = .clear
        root.addChild(notch)

        return view.texture(from: root) ?? SKTexture()
    }

    private static func makeTower(radius: CGFloat, view: SKView) -> SKTexture {
        let root = SKNode()

        let base = SKShapeNode(circleOfRadius: radius)
        base.fillColor = Theme.tower
        base.strokeColor = Theme.tower.mixed(with: .black, amount: 0.4)
        base.lineWidth = 3
        root.addChild(base)

        let merlon = SKShapeNode(
            rect: CGRect(x: -radius * 0.34, y: -radius * 0.34, width: radius * 0.68, height: radius * 0.68),
            cornerRadius: 3)
        merlon.fillColor = Theme.tower.mixed(with: .white, amount: 0.5)
        merlon.strokeColor = .clear
        root.addChild(merlon)

        return view.texture(from: root) ?? SKTexture()
    }

    private static func makeStation(
        radius: CGFloat, fill: SKColor, stroke: SKColor, dashed: Bool, view: SKView
    ) -> SKTexture {
        let circle = CGMutablePath()
        circle.addArc(
            center: .zero, radius: radius, startAngle: 0, endAngle: .pi * 2, clockwise: false)

        let shape = SKShapeNode(path: circle)
        shape.fillColor = fill
        shape.strokeColor = stroke
        shape.lineWidth = 4
        if dashed {
            shape.path = circle.copy(dashingWithPhase: 0, lengths: [14, 10])
        }
        shape.isAntialiased = true
        return view.texture(from: shape) ?? SKTexture()
    }

    private static func makeSwingArc(range: CGFloat, arc: CGFloat, view: SKView) -> SKTexture {
        let path = CGMutablePath()
        path.move(to: .zero)
        path.addArc(
            center: .zero, radius: range, startAngle: -arc / 2, endAngle: arc / 2, clockwise: false)
        path.closeSubpath()

        let shape = SKShapeNode(path: path)
        shape.fillColor = Theme.blade.withAlphaComponent(0.30)
        shape.strokeColor = Theme.blade.withAlphaComponent(0.75)
        shape.lineWidth = 2
        shape.isAntialiased = true
        return view.texture(from: shape) ?? SKTexture()
    }
}
