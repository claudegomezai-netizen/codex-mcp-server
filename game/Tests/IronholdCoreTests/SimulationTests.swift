import XCTest

@testable import IronholdCore

/// These tests play the game with no renderer attached — the point of keeping
/// the core free of SpriteKit.
final class SimulationTests: XCTestCase {

    private let tick = 1.0 / 60.0

    /// Runs the world forward, optionally steering the hero each frame.
    @discardableResult
    private func run(
        _ world: World,
        seconds: Double,
        steer: ((World) -> Vec2)? = nil
    ) -> [SimEvent] {
        var collected: [SimEvent] = []
        var remaining = seconds
        while remaining > 0 {
            let move = steer?(world) ?? .zero
            world.step(tick, input: World.Input(move: move))
            collected.append(contentsOf: world.drainEvents())
            remaining -= tick
        }
        return collected
    }

    /// Walks the hero toward a point, stopping once close enough.
    private func steerToward(_ target: Vec2, from world: World) -> Vec2 {
        let offset = target - world.hero.position
        return offset.length < 8 ? .zero : offset.normalized
    }

    // MARK: - Core loop

    func testHeroAutoAttacksWithoutInput() {
        let world = World(seed: 1)
        let events = run(world, seconds: 12)

        let swings = events.filter { if case .swordSwing = $0 { return true } else { return false } }
        XCTAssertFalse(swings.isEmpty, "hero never swung; auto-attack is not firing")

        let hits = events.filter { if case .enemyHit = $0 { return true } else { return false } }
        XCTAssertFalse(hits.isEmpty, "swings never connected")
    }

    func testKillingEnemiesDropsTokensThatCanBeCollected() {
        let world = World(seed: 2)
        let events = run(world, seconds: 25)

        let deaths = events.compactMap { event -> Int? in
            if case .enemyDied(_, _, let dropped) = event { return dropped }
            return nil
        }
        XCTAssertFalse(deaths.isEmpty, "nothing died in 25 seconds")
        XCTAssertTrue(deaths.allSatisfy { $0 > 0 }, "an enemy died without dropping tokens")

        let collections = events.filter {
            if case .tokenCollected = $0 { return true } else { return false }
        }
        XCTAssertFalse(collections.isEmpty, "tokens dropped but were never picked up")
        XCTAssertGreaterThan(world.totalTokensEarned, 0)
    }

    func testCarriedStackNeverExceedsCapacity() {
        let world = World(seed: 3)
        // Sit still in the middle of the fight and let the stack fill.
        run(world, seconds: 60)
        XCTAssertLessThanOrEqual(
            world.hero.carried, world.carryCapacity,
            "stack overflowed capacity — the Satchel upgrade would be meaningless"
        )
    }

    func testDepositingAtTheBankConvertsTheStackToSpendableTokens() {
        let world = World(seed: 4)
        // Fight in the middle of the arena, away from any station.
        run(world, seconds: 20, steer: { w in self.steerToward(w.balance.basePosition, from: w) })
        XCTAssertGreaterThan(world.hero.carried, 0, "no tokens gathered to deposit")

        // Walk to the bank station and stand on it.
        run(world, seconds: 15, steer: { w in self.steerToward(w.balance.bankPosition, from: w) })

        XCTAssertGreaterThan(world.bank, 0, "standing on the bank did not bank anything")
    }

    /// The failure this guards against is subtle and cost the design once
    /// already: if the hero spawns on a deposit station, tokens bank the
    /// instant they are picked up and the player never carries anything
    /// anywhere — which removes the entire point of the genre.
    func testHeroDoesNotSpawnOnADepositStation() {
        let world = World(seed: 13)
        let radius = world.balance.plotInteractionRadius

        XCTAssertGreaterThan(
            world.balance.basePosition.distance(to: world.balance.bankPosition), radius,
            "hero spawns on the bank; the carry loop will collapse"
        )
        for plot in world.plots {
            XCTAssertGreaterThan(
                world.balance.basePosition.distance(to: plot.position), radius,
                "hero spawns on a tower plot; the carry loop will collapse"
            )
        }
    }

    func testDepositStationsDoNotOverlap() {
        let world = World(seed: 14)
        var stations = world.plots.map(\.position)
        stations.append(world.balance.bankPosition)
        let radius = world.balance.plotInteractionRadius

        for i in stations.indices {
            for j in stations.indices where j > i {
                XCTAssertGreaterThan(
                    stations[i].distance(to: stations[j]), radius * 2,
                    "stations \(i) and \(j) overlap; a deposit would land ambiguously"
                )
            }
        }
    }

    func testStandingOnAPlotBuildsATower() {
        let world = World(seed: 5)
        let plot = world.plots[0]

        // Gather, then park on the plot until it pays for itself.
        let events = run(world, seconds: 90, steer: { w in
            return self.steerToward(plot.position, from: w)
        })

        let built = events.contains { if case .towerBuilt = $0 { return true } else { return false } }
        XCTAssertTrue(built, "never managed to build a tower in 90 seconds of depositing")

        let rebuilt = world.plots.first { $0.id == plot.id }
        XCTAssertEqual(rebuilt?.isBuilt, true)
        XCTAssertGreaterThanOrEqual(rebuilt?.level ?? 0, 1)
        XCTAssertGreaterThan(world.towerDPS, 0, "a built tower contributes no DPS")
    }

    func testBuiltTowersShootOnTheirOwn() {
        let world = World(seed: 6)
        let plot = world.plots[0]
        run(world, seconds: 90, steer: { w in
            return self.steerToward(plot.position, from: w)
        })
        guard world.plots.contains(where: \.isBuilt) else {
            return XCTFail("precondition failed: no tower was built")
        }

        // Now stand well away and confirm the tower still fires.
        let events = run(world, seconds: 20, steer: { w in
            self.steerToward(Vec2(w.balance.arenaSize.x - 80, w.balance.arenaSize.y - 80), from: w)
        })
        let shots = events.filter { if case .towerFired = $0 { return true } else { return false } }
        XCTAssertFalse(shots.isEmpty, "tower did not fire while the hero was away")
    }

    // MARK: - Upgrades

    func testPurchasingAnUpgradeSpendsBankAndRaisesStats() {
        let world = World(seed: 7)
        // Gather in the open, then commute to the bank and keep depositing.
        run(world, seconds: 25, steer: { w in self.steerToward(w.balance.basePosition, from: w) })
        run(world, seconds: 60, steer: { w in self.steerToward(w.balance.bankPosition, from: w) })

        guard world.bank >= world.upgradeCost(.heroDamage) else {
            return XCTFail("did not bank enough to test a purchase (bank: \(world.bank))")
        }

        let damageBefore = world.heroDamage
        let bankBefore = world.bank
        let cost = world.upgradeCost(.heroDamage)

        XCTAssertTrue(world.purchase(.heroDamage))
        XCTAssertEqual(world.bank, bankBefore - cost)
        XCTAssertGreaterThan(world.heroDamage, damageBefore)
        XCTAssertEqual(world.level(of: .heroDamage), 1)
        XCTAssertGreaterThan(world.upgradeCost(.heroDamage), cost, "price did not rise after purchase")
    }

    func testCannotPurchaseWithoutFunds() {
        let world = World(seed: 8)
        XCTAssertEqual(world.bank, 0)
        XCTAssertFalse(world.purchase(.heroDamage))
        XCTAssertEqual(world.level(of: .heroDamage), 0)
    }

    // MARK: - Waves

    func testWavesAdvanceAndReachABoss() {
        var balance = Balance()
        balance.waveDuration = 3
        balance.waveBreak = 0.5
        let world = World(balance: balance, seed: 9)

        let events = run(world, seconds: 200)
        let started = events.compactMap { event -> Int? in
            if case .waveStarted(let wave, _) = event { return wave }
            return nil
        }

        XCTAssertGreaterThanOrEqual(started.count, 3, "waves are not advancing")
        XCTAssertEqual(started, started.sorted(), "waves arrived out of order")
        XCTAssertEqual(Array(Set(started)).count, started.count, "a wave started twice")

        let bosses = events.filter {
            if case .waveStarted(_, let isBoss) = $0 { return isBoss } else { return false }
        }
        XCTAssertFalse(bosses.isEmpty, "never reached a boss wave")
    }

    func testEnemyCountRespectsTheConcurrencyCeiling() {
        var balance = Balance()
        balance.maxConcurrentEnemies = 25
        balance.waveDuration = 2
        balance.waveBreak = 0.2
        let world = World(balance: balance, seed: 10)

        var peak = 0
        var remaining = 120.0
        while remaining > 0 {
            world.step(tick, input: World.Input())
            _ = world.drainEvents()
            peak = max(peak, world.enemies.count)
            remaining -= tick
        }
        XCTAssertLessThanOrEqual(peak, balance.maxConcurrentEnemies)
    }

    // MARK: - Hero survival

    func testHeroGoesDownAndRespawnsAtBase() {
        var balance = Balance()
        // Make the hero fragile and the enemies dangerous so this resolves fast.
        balance.heroMaxHealth = 12
        balance.enemyBaseDamage = 30
        balance.swordBaseDamage = 0.01
        let world = World(balance: balance, seed: 11)

        let events = run(world, seconds: 90)

        let downed = events.filter { if case .heroDowned = $0 { return true } else { return false } }
        XCTAssertFalse(downed.isEmpty, "hero never went down despite being one-shot fragile")

        let respawned = events.compactMap { event -> Vec2? in
            if case .heroRespawned(let position) = event { return position }
            return nil
        }
        XCTAssertFalse(respawned.isEmpty, "hero went down but never came back")
        // Respawns happen at the centre, not wherever the hero fell.
        for position in respawned {
            XCTAssertEqual(position, balance.basePosition)
        }
    }

    func testHeroStaysInsideTheArena() {
        let world = World(seed: 12)
        // Push hard into a corner for a while.
        run(world, seconds: 30, steer: { _ in Vec2(-1, -1).normalized })
        XCTAssertGreaterThanOrEqual(world.hero.position.x, world.balance.heroRadius - 0.001)
        XCTAssertGreaterThanOrEqual(world.hero.position.y, world.balance.heroRadius - 0.001)

        run(world, seconds: 40, steer: { _ in Vec2(1, 1).normalized })
        XCTAssertLessThanOrEqual(
            world.hero.position.x, world.balance.arenaSize.x - world.balance.heroRadius + 0.001)
        XCTAssertLessThanOrEqual(
            world.hero.position.y, world.balance.arenaSize.y - world.balance.heroRadius + 0.001)
    }

    // MARK: - Determinism

    func testSameSeedProducesTheSameRun() {
        let a = World(seed: 4242)
        let b = World(seed: 4242)
        run(a, seconds: 45)
        run(b, seconds: 45)

        XCTAssertEqual(a.enemiesKilled, b.enemiesKilled)
        XCTAssertEqual(a.totalTokensEarned, b.totalTokensEarned)
        XCTAssertEqual(a.hero.position, b.hero.position)
        XCTAssertEqual(a.enemies.count, b.enemies.count)
    }

    func testDifferentSeedsDiverge() {
        let a = World(seed: 1)
        let b = World(seed: 999_983)
        run(a, seconds: 45)
        run(b, seconds: 45)

        // The hero does not move without input, so compare what the seed
        // actually drives: where enemies spawned and how the fight unfolded.
        let positionsA = a.enemies.map(\.position)
        let positionsB = b.enemies.map(\.position)
        XCTAssertNotEqual(
            positionsA, positionsB,
            "different seeds produced identical enemy layouts; the RNG is not seeded"
        )
    }

    // MARK: - Stability

    func testNoNaNsOrRunawayValuesInALongRun() {
        let world = World(seed: 77)
        run(world, seconds: 300, steer: { w in
            // Wander so the hero keeps interacting with plots and the base.
            let phase = w.elapsed * 0.4
            return Vec2(cos(phase), sin(phase * 0.7))
        })

        XCTAssertTrue(world.hero.position.x.isFinite)
        XCTAssertTrue(world.hero.position.y.isFinite)
        XCTAssertTrue(world.hero.health.isFinite)
        XCTAssertGreaterThanOrEqual(world.hero.carried, 0)
        XCTAssertGreaterThanOrEqual(world.bank, 0)

        for enemy in world.enemies {
            XCTAssertTrue(enemy.position.x.isFinite, "enemy position went non-finite")
            XCTAssertTrue(enemy.position.y.isFinite)
            XCTAssertTrue(enemy.health.isFinite)
        }
        for token in world.tokens {
            XCTAssertTrue(token.position.x.isFinite)
            XCTAssertGreaterThan(token.value, 0, "a spent token was left in the world")
        }
    }

    func testTokensDoNotAccumulateForever() {
        let world = World(seed: 88)
        // Never move, so most tokens are left on the ground to expire.
        run(world, seconds: 240)
        XCTAssertLessThan(
            world.tokens.count, 900,
            "ground tokens are not being cleaned up; this will leak memory and frame time"
        )
    }
}
