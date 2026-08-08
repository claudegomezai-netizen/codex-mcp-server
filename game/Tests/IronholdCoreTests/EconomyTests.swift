import XCTest

@testable import IronholdCore

final class EconomyTests: XCTestCase {

    // MARK: - Cost curves

    func testUpgradeCostGrowsGeometrically() {
        let economy = Economy()
        let base = Double(economy.balance.upgradeBasePrices[.heroDamage]!)
        let growth = economy.balance.costGrowth

        XCTAssertEqual(economy.upgradeCost(.heroDamage, level: 0), Int(base.rounded()))
        XCTAssertEqual(
            economy.upgradeCost(.heroDamage, level: 1), Int((base * growth).rounded()))
        XCTAssertEqual(
            economy.upgradeCost(.heroDamage, level: 10), Int((base * pow(growth, 10)).rounded()))
        XCTAssertGreaterThan(
            economy.upgradeCost(.heroDamage, level: 10),
            economy.upgradeCost(.heroDamage, level: 1))
    }

    func testTowerCostUsesTheSameCurveAsHeroUpgrades() {
        let economy = Economy()
        // A token spent on a tower should buy comparable progress to a token
        // spent on the hero, or one path becomes strictly correct.
        let towerRatio = Double(economy.towerCost(level: 6)) / Double(economy.towerCost(level: 0))
        let heroRatio =
            Double(economy.upgradeCost(.heroDamage, level: 6))
            / Double(economy.upgradeCost(.heroDamage, level: 0))
        // Loose tolerance: prices are rounded to whole tokens, so the two
        // curves diverge slightly at the same level.
        XCTAssertEqual(towerRatio, heroRatio, accuracy: 0.05)
    }

    func testAttackIntervalHasAFloor() {
        let economy = Economy()
        let interval = economy.attackInterval(level: 500)
        XCTAssertEqual(interval, economy.balance.swordMinInterval, accuracy: 1e-9)
        XCTAssertGreaterThan(interval, 0)
    }

    func testMoveSpeedIsCapped() {
        let economy = Economy()
        XCTAssertEqual(economy.moveSpeed(level: 10_000), economy.balance.heroMaxMoveSpeed)
    }

    func testEmptyPlotDealsNoDamage() {
        let economy = Economy()
        XCTAssertEqual(economy.towerDamage(level: 0), 0)
        XCTAssertGreaterThan(economy.towerDamage(level: 1), 0)
    }

    // MARK: - The anti-grind guardrail

    /// This is the most important test in the project.
    ///
    /// The failure mode this genre is known for is that upgrade costs grow
    /// exponentially while player damage grows linearly, so time-to-next-upgrade
    /// balloons and the mid-game turns into a wall. Because damage here also
    /// grows geometrically, the ratio (costGrowth / powerGrowth) governs pacing
    /// and stays near 1.
    ///
    /// If someone later retunes `costGrowth` or `powerGrowth` independently and
    /// reopens that gap, this test is what catches it.
    func testTimeToNextUpgradeStaysInBand() {
        let curve = Economy().pacingCurve(purchases: 80)

        for sample in curve {
            XCTAssertGreaterThan(
                sample.seconds, 8,
                """
                purchase \(sample.purchase) costs only \(sample.seconds)s of play — \
                player power is outrunning the cost curve and the game will trivialise itself
                """
            )
            XCTAssertLessThan(
                sample.seconds, 90,
                """
                purchase \(sample.purchase) takes \(sample.seconds)s — this is the grind \
                wall the economy is designed to avoid
                """
            )
        }

        // The curve should slope gently upward: progress stays earned, but
        // never becomes a wall.
        let early = curve.prefix(10).map(\.seconds).reduce(0, +) / 10
        let late = curve.suffix(10).map(\.seconds).reduce(0, +) / 10
        let drift = late / early

        XCTAssertGreaterThan(
            drift, 1.1,
            "drift is \(drift)× — late upgrades got cheaper in real terms; that is power creep"
        )
        XCTAssertLessThan(
            drift, 3.0,
            "drift is \(drift)× across eighty purchases; the curve is running away"
        )
    }

    /// A sanity check on the claim above: with linear damage growth (the naive
    /// design) the same span blows out far worse. This documents *why* the
    /// growth rates are set the way they are.
    func testLinearDamageGrowthWouldProduceAWall() {
        let economy = Economy()
        var naive: [Double] = []

        for level in 0..<60 {
            // Linear damage instead of geometric — the conventional approach.
            let dps = (economy.balance.swordBaseDamage * (1 + Double(level) * 0.1))
                / economy.balance.swordBaseInterval
            let income = economy.estimatedIncomeRate(wave: 1 + level, dps: dps)
            let cost = Double(economy.upgradeCost(.heroDamage, level: level))
            naive.append(cost / max(income, 1e-9))
        }

        let earlyNaive = naive.prefix(10).reduce(0, +) / 10
        let lateNaive = naive.suffix(10).reduce(0, +) / 10
        let naiveBlowup = lateNaive / earlyNaive

        XCTAssertGreaterThan(
            naiveBlowup, 15.0,
            "expected the naive linear curve to blow up; if it doesn't, the comparison is no longer meaningful"
        )
    }

    // MARK: - Wave scaling

    func testTokenDropsOutgrowEnemyHealth() {
        let economy = Economy()
        // Drops deliberately climb faster than health. Once player DPS outgrows
        // the spawn rate, income stops tracking damage and would fall behind the
        // cost curve; paying more per kill is what closes that gap.
        let healthRatio = economy.enemyHealth(wave: 20) / economy.enemyHealth(wave: 1)
        let dropRatio =
            Double(economy.enemyTokenDrop(wave: 20)) / Double(economy.enemyTokenDrop(wave: 1))

        XCTAssertGreaterThan(
            dropRatio, healthRatio,
            "drops are not outpacing health; late income will fall behind costs"
        )
        // But not so much faster that kills become trivially lucrative.
        XCTAssertLessThan(dropRatio, healthRatio * 2.5)
    }

    func testEnemyDamageClimbsSlowerThanHealth() {
        let economy = Economy()
        let healthRatio = economy.enemyHealth(wave: 30) / economy.enemyHealth(wave: 1)
        let damageRatio = economy.enemyDamage(wave: 30) / economy.enemyDamage(wave: 1)
        XCTAssertGreaterThan(
            healthRatio, damageRatio * 2,
            "enemy damage is keeping pace with health; late hits will be instantly lethal"
        )
    }

    // MARK: - Coin denominations

    /// Denominations are a presentation layer over the same income. The moment
    /// making change stops being exact, every pacing number above becomes a
    /// lie, so this is checked across the whole range a run can produce —
    /// including boss payouts in the thousands.
    func testMakingChangeAlwaysPaysExactlyTheDropAmount() {
        let world = World(balance: Balance(), seed: 1)
        for amount in Array(0...400) + [512, 999, 1_500, 4_096, 20_000] {
            let coins = world.makeChange(for: amount)
            let paid = coins.reduce(0) { $0 + $1.value }
            XCTAssertEqual(paid, amount, "change for \(amount) paid \(paid)")
        }
    }

    /// Coins are picked up whole, so a denomination larger than an unupgraded
    /// satchel could never be lifted and would sit on the floor forever.
    func testNoDenominationIsTooBigForAnUnupgradedSatchel() {
        let balance = Balance()
        let largest = balance.coinValues.values.max() ?? 0
        XCTAssertGreaterThan(largest, 0)
        XCTAssertLessThanOrEqual(
            largest, balance.baseCarryCapacity / 2,
            "the biggest coin does not comfortably fit a starting satchel, so it can never be collected"
        )
        XCTAssertTrue(
            balance.coinValues.values.contains(1),
            "without a coin worth 1, some payouts cannot be made exactly"
        )
    }

    /// A boss dropping hundreds should still scatter a handful of pickups, not
    /// carpet the floor.
    func testLargePayoutsStayReadable() {
        let world = World(balance: Balance(), seed: 1)
        let coins = world.makeChange(for: 5_000)
        XCTAssertLessThanOrEqual(
            coins.count, CoinKind.allCases.count * Balance().maxPickupsPerDenomination,
            "a boss payout is spawning more pickups than the cap allows"
        )
        XCTAssertEqual(coins.reduce(0) { $0 + $1.value }, 5_000)
    }

    /// Rarity should come out of the maths rather than a separate roll: a
    /// small early payout cannot contain a top-tier coin, a large one must.
    func testHigherDenominationsOnlyAppearInLargerPayouts() {
        let world = World(balance: Balance(), seed: 1)
        let balance = Balance()
        let top = CoinKind.allCases.max { (balance.coinValues[$0] ?? 0) < (balance.coinValues[$1] ?? 0) }!

        XCTAssertFalse(
            world.makeChange(for: 3).contains { $0.kind == top },
            "a three-token drop produced a top-tier coin"
        )
        XCTAssertTrue(
            world.makeChange(for: 200).contains { $0.kind == top },
            "a two-hundred token drop produced no top-tier coin"
        )
    }

    func testBossWaveCadence() {
        let economy = Economy()
        XCTAssertFalse(economy.isBossWave(1))
        XCTAssertFalse(economy.isBossWave(4))
        XCTAssertTrue(economy.isBossWave(5))
        XCTAssertTrue(economy.isBossWave(10))
        XCTAssertFalse(economy.isBossWave(0))
    }
}
