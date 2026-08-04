import Foundation
import IronholdCore

/// Runs a full session headlessly with a scripted player and reports what
/// actually happened. This is the fastest way to answer "does the loop close?"
/// without a device, and it doubles as a regression check on pacing.
enum Playtest {

    struct Report {
        var secondsToFirstKill: Double?
        var secondsToFirstTower: Double?
        var towersBuilt = 0
        var upgradesBought = 0
        var deaths = 0
        var wavesReached = 0
        var tokensEarned = 0
        var finalDPS: Double = 0
    }

    /// A simple bot: gather until the stack is worth carrying, then deliver.
    /// Prefers an unbuilt plot, otherwise banks at base for hero upgrades.
    static func run(
        balance: Balance = Balance(),
        seconds: Double,
        seed: UInt64 = 7,
        traceUntil: Double = 0
    ) -> Report {
        let world = World(balance: balance, seed: seed)
        var report = Report()
        let tick = 1.0 / 60.0
        var elapsed = 0.0

        while elapsed < seconds {
            let target = deliveryTarget(for: world)
            let move: Vec2
            if let target {
                let offset = target - world.hero.position
                move = offset.length < 6 ? .zero : offset.normalized
            } else {
                move = .zero
            }

            world.step(tick, input: World.Input(move: move))
            elapsed += tick

            if elapsed < traceUntil, Int(elapsed * 60) % 30 == 0 {
                let plot = world.plots[0]
                print(
                    String(
                        format:
                            "   t=%5.1f  carried=%2d/%2d  bank=%3d  plot0=%.0f/%d  hero=%@  enemies=%d  hp=%.0f",
                        elapsed, world.hero.carried, world.carryCapacity, world.bank,
                        plot.deposited, world.economy.towerCost(level: plot.level),
                        world.hero.position.description, world.enemies.count, world.hero.health))
            }

            for event in world.drainEvents() {
                switch event {
                case .enemyDied:
                    if report.secondsToFirstKill == nil { report.secondsToFirstKill = elapsed }
                case .towerBuilt:
                    report.towersBuilt += 1
                    if report.secondsToFirstTower == nil { report.secondsToFirstTower = elapsed }
                case .heroDowned:
                    report.deaths += 1
                case .waveStarted(let wave, _):
                    report.wavesReached = wave
                default:
                    break
                }
            }

            // Spend banked tokens as soon as they cover the cheapest upgrade.
            while let cheapest = UpgradeKind.allCases.min(by: {
                world.upgradeCost($0) < world.upgradeCost($1)
            }), world.canAfford(cheapest) {
                world.purchase(cheapest)
                report.upgradesBought += 1
                _ = world.drainEvents()
            }
        }

        report.tokensEarned = world.totalTokensEarned
        report.finalDPS = world.totalDPS
        return report
    }

    /// Where the bot should take its stack, or nil if it should keep fighting.
    private static func deliveryTarget(for world: World) -> Vec2? {
        // Carry at least a third of capacity before making the trip, so the
        // bot is not commuting with two tokens in hand.
        guard world.hero.carried >= max(4, world.carryCapacity / 3) else { return nil }

        // Get a few towers up first, then split spend toward hero upgrades —
        // roughly what a reasonable player does, and it exercises both sinks.
        let built = world.plots.filter(\.isBuilt).count
        if built < 3, let plot = world.plots.first(where: { !$0.isBuilt }) {
            return plot.position
        }
        return world.balance.bankPosition
    }
}

func playtestReport() {
    print("── headless playtest (5 minutes, scripted player)")
    let report = Playtest.run(seconds: 300, traceUntil: ProcessInfo.processInfo.environment["TRACE"] != nil ? 60 : 0)

    func fmt(_ value: Double?) -> String {
        guard let value else { return "never" }
        return String(format: "%.1fs", value)
    }

    print("   first kill      \(fmt(report.secondsToFirstKill))")
    print("   first tower     \(fmt(report.secondsToFirstTower))")
    print("   towers built    \(report.towersBuilt)")
    print("   upgrades bought \(report.upgradesBought)")
    print("   waves reached   \(report.wavesReached)")
    print("   deaths          \(report.deaths)")
    print("   tokens earned   \(report.tokensEarned)")
    print(String(format: "   final DPS       %.1f", report.finalDPS))
    print("")
}
