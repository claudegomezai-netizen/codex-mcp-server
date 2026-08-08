import Foundation

public enum UpgradeKind: String, CaseIterable, Hashable, Sendable {
    case heroDamage
    case attackSpeed
    case moveSpeed
    case carryCapacity
    case pickupRadius

    public var displayName: String {
        switch self {
        case .heroDamage: return "Sword"
        case .attackSpeed: return "Swing Speed"
        case .moveSpeed: return "Boots"
        case .carryCapacity: return "Satchel"
        case .pickupRadius: return "Lodestone"
        }
    }

    public var blurb: String {
        switch self {
        case .heroDamage: return "Heavier blade"
        case .attackSpeed: return "Faster swings"
        case .moveSpeed: return "Move quicker"
        case .carryCapacity: return "Carry more tokens"
        case .pickupRadius: return "Pull tokens from further"
        }
    }
}

/// Cost curves and stat curves.
///
/// The design problem this solves: in a conventional idle economy, upgrade
/// costs grow exponentially (~1.12×/level) while damage grows *linearly*. Time
/// to afford the next upgrade then grows like 1.12^n — by level 50 a purchase
/// that once took 30 seconds takes over two hours. That is the exact wall
/// players describe in this genre ("great for three hours, then unbearable").
///
/// Here damage grows geometrically too, at 1.10×/level. Time-to-next-upgrade
/// scales with (costGrowth / powerGrowth)^n = 1.018^n, so it drifts upward
/// gently — roughly 2.4× across fifty levels rather than 289×. The curve still
/// slopes up (progress should feel earned) but it never becomes a wall.
///
/// `EconomyTests.testTimeToNextUpgradeStaysInBand` enforces this.
public struct Economy: Sendable {
    public let balance: Balance

    public init(balance: Balance = Balance()) {
        self.balance = balance
    }

    // MARK: - Upgrade pricing

    /// Price to go from `level` to `level + 1`.
    public func upgradeCost(_ kind: UpgradeKind, level: Int) -> Int {
        let base = Double(balance.upgradeBasePrices[kind] ?? 25)
        return Int((base * pow(balance.costGrowth, Double(level))).rounded())
    }

    /// Price to build or upgrade a tower. Towers use the same curve as hero
    /// upgrades so a token spent is worth comparable progress either way —
    /// otherwise one path silently becomes the only correct choice.
    public func towerCost(level: Int) -> Int {
        Int((Double(balance.towerBuildCost) * pow(balance.costGrowth, Double(level))).rounded())
    }

    // MARK: - Stat curves

    public func heroDamage(level: Int) -> Double {
        balance.swordBaseDamage * pow(balance.powerGrowth, Double(level))
    }

    public func attackInterval(level: Int) -> Double {
        let scaled = balance.swordBaseInterval / pow(balance.attackSpeedGrowth, Double(level))
        return max(balance.swordMinInterval, scaled)
    }

    public func moveSpeed(level: Int) -> Double {
        min(
            balance.heroMaxMoveSpeed,
            balance.heroBaseMoveSpeed + balance.heroMoveSpeedPerLevel * Double(level)
        )
    }

    public func carryCapacity(level: Int) -> Int {
        balance.baseCarryCapacity + balance.carryCapacityPerLevel * level
    }

    public func pickupRadius(level: Int) -> Double {
        balance.basePickupRadius + balance.pickupRadiusPerLevel * Double(level)
    }

    public func towerDamage(level: Int) -> Double {
        // level 0 means "empty plot"; level 1 is a freshly built tower.
        guard level > 0 else { return 0 }
        return balance.towerBaseDamage * pow(balance.powerGrowth, Double(level - 1))
    }

    public func towerInterval(level: Int) -> Double {
        max(balance.towerMinInterval, balance.towerBaseInterval / pow(1.03, Double(max(0, level - 1))))
    }

    // MARK: - Wave scaling

    public func enemyHealth(wave: Int) -> Double {
        balance.enemyBaseHealth * pow(balance.enemyHealthGrowth, Double(wave - 1))
    }

    public func enemyDamage(wave: Int) -> Double {
        // Damage climbs far more slowly than health. Health is the difficulty
        // dial; damage climbing at the same rate would make one stray hit
        // lethal in the late game and turn positioning into memorisation.
        balance.enemyBaseDamage * pow(1.04, Double(wave - 1))
    }

    public func enemyTokenDrop(wave: Int) -> Int {
        max(1, Int((Double(balance.enemyBaseTokenDrop) * pow(balance.tokenDropGrowth, Double(wave - 1))).rounded()))
    }

    public func spawnCount(wave: Int) -> Int {
        Int((Double(balance.baseSpawnsPerWave) * pow(balance.spawnsPerWaveGrowth, Double(wave - 1))).rounded())
    }

    public func isBossWave(_ wave: Int) -> Bool {
        wave > 0 && wave % balance.bossWaveInterval == 0
    }

    // MARK: - Analysis helpers (used by tests and tuning tools)

    /// Rough tokens-per-second the player can earn at a given wave and DPS.
    /// Assumes the player kills what spawns and picks it up — an upper bound,
    /// but a consistent one, which is what makes it useful for comparing
    /// pacing between levels.
    public func estimatedIncomeRate(wave: Int, dps: Double) -> Double {
        let hp = enemyHealth(wave: wave)
        guard hp > 0, dps > 0 else { return 0 }
        let killsPerSecond = dps / hp
        let spawnRate = Double(spawnCount(wave: wave)) / balance.waveDuration
        // Income is limited by whichever is scarcer: killing speed or spawns.
        return min(killsPerSecond, spawnRate) * Double(enemyTokenDrop(wave: wave))
    }

    public struct PacingSample: Sendable {
        public let purchase: Int
        /// Seconds of play needed to afford the next upgrade at this point.
        public let seconds: Double
        public let dps: Double
    }

    /// Models a player who always buys whichever DPS upgrade is cheapest —
    /// what players actually do, and the case that exposes power creep, since
    /// damage and swing speed multiply together.
    ///
    /// Shared by `IronholdTune` and the balance tests so the tool that picks
    /// the numbers and the test that guards them can never disagree.
    public func pacingCurve(purchases: Int) -> [PacingSample] {
        var damageLevel = 0
        var speedLevel = 0
        var out: [PacingSample] = []
        out.reserveCapacity(purchases)

        for p in 0..<purchases {
            let dps = heroDamage(level: damageLevel) / attackInterval(level: speedLevel)
            // Waves advance roughly in step with player investment.
            let income = estimatedIncomeRate(wave: 1 + p / 2, dps: dps)

            let damageCost = upgradeCost(.heroDamage, level: damageLevel)
            let speedCost = upgradeCost(.attackSpeed, level: speedLevel)

            out.append(
                PacingSample(
                    purchase: p,
                    seconds: Double(min(damageCost, speedCost)) / max(income, 1e-9),
                    dps: dps
                )
            )

            if damageCost <= speedCost { damageLevel += 1 } else { speedLevel += 1 }
        }
        return out
    }
}
