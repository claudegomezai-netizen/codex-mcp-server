import Foundation

/// Every tunable number in the game, in one place.
///
/// The two growth rates at the top are the most important numbers here — see
/// `Economy` and DESIGN.md for why they are set so close together. Changing
/// `costGrowth` or `powerGrowth` independently will reshape the entire
/// mid-game pacing, and `EconomyTests` will fail if the gap gets too wide.
public struct Balance: Sendable {

    // MARK: - Growth rates (the heart of the economy)

    /// Multiplier applied to an upgrade's price per level owned.
    ///
    /// 1.18 is not arbitrary. Because damage and swing speed multiply into DPS,
    /// a conventional 1.12 curve is *outrun* by combined player power: upgrades
    /// get cheaper in real terms and the game trivialises itself. Sweeping the
    /// space with `IronholdTune` shows 1.18 paired with a 1.03 swing curve is
    /// the point where time-to-next-upgrade drifts gently upward (~1.6× across
    /// eighty purchases) instead of collapsing or exploding.
    public var costGrowth: Double = 1.18
    /// Multiplier applied to damage-type stats per level owned.
    public var powerGrowth: Double = 1.10
    /// Multiplier applied to attack *rate* per level owned. Deliberately much
    /// smaller than `powerGrowth`: damage and rate multiply into DPS, so if
    /// both grew at the same pace, DPS would outrun `costGrowth` and the game
    /// would trivialise itself. See `IronholdTune`.
    public var attackSpeedGrowth: Double = 1.03
    /// Per-wave multiplier on enemy health.
    public var enemyHealthGrowth: Double = 1.10
    /// Per-wave multiplier on how many tokens an enemy drops.
    ///
    /// This is the counterweight to `costGrowth`. Late game is spawn-limited
    /// rather than kill-limited — player DPS outgrows how fast enemies arrive,
    /// so extra damage stops converting into extra income and the cost curve
    /// pulls away into a wall. Raising what each kill pays keeps income tracking
    /// costs. Swept in `IronholdTune`: 1.10 gives a 4.1× blow-out, 1.14 goes
    /// flat and drains all sense of progress, 1.125 lands at 1.8×.
    public var tokenDropGrowth: Double = 1.125

    // MARK: - Arena

    public var arenaSize = Vec2(1600, 1600)
    /// Where the hero spawns and respawns. Centred so the spawn ring is never
    /// clipped by an arena edge, which would bias enemies to one side.
    ///
    /// Note this is *neutral ground*, not a deposit point. An earlier layout
    /// put the bank here and the carry loop quietly collapsed: the hero spawned
    /// on the bank, fought on the bank, and every token auto-deposited the
    /// instant it was picked up — so the player never carried anything
    /// anywhere, which is the entire genre.
    public var basePosition = Vec2(800, 800)

    /// Deposit stations sit on a ring around the centre: one bank (hero
    /// upgrades) and the rest tower plots. Every deposit is therefore a
    /// deliberate trip, and choosing *which* station to walk to is the
    /// moment-to-moment decision the game is built on.
    public var plotRingRadius: Double = 300
    public var stationCount: Int = 7
    /// Which station on the ring is the bank; the others are tower plots.
    public var bankStationIndex: Int = 0

    public func stationPosition(_ index: Int) -> Vec2 {
        let angle = (Double(index) / Double(stationCount)) * .pi * 2 - .pi / 2
        return basePosition + Vec2.fromAngle(angle, magnitude: plotRingRadius)
    }

    public var bankPosition: Vec2 { stationPosition(bankStationIndex) }

    /// Enemies spawn on this ring — just outside a phone's view, so they walk
    /// in from offscreen rather than appearing on top of the player. Pulled in
    /// deliberately tight: at the previous distance the first enemy took over
    /// ten seconds to arrive, which is a dead opening for a game that has to
    /// prove itself in the first few seconds.
    public var spawnRingInner: Double = 420
    public var spawnRingOuter: Double = 520

    // MARK: - Hero

    public var heroMaxHealth: Double = 150
    /// Passive regeneration. The genre is forgiving by design — dying is a
    /// pacing beat, not a punishment — and without this a player who stops to
    /// deposit bleeds out over a few waves with no way to recover.
    public var heroHealthRegenPerSecond: Double = 3.5
    public var heroRadius: Double = 26
    public var heroBaseMoveSpeed: Double = 235
    public var heroMoveSpeedPerLevel: Double = 12
    public var heroMaxMoveSpeed: Double = 420

    public var heroInvulnerabilityAfterHit: Double = 0.55
    public var heroRespawnDelay: Double = 3.0
    /// Fraction of the carried stack lost when the hero goes down.
    public var heroDeathTokenLoss: Double = 0.5

    // MARK: - Sword (the auto-attack)

    public var swordBaseDamage: Double = 14
    public var swordBaseInterval: Double = 0.80
    /// Attack interval never drops below this, no matter how many levels.
    public var swordMinInterval: Double = 0.16
    public var swordRange: Double = 96
    /// Total width of the swing arc, in radians. Generous on purpose — the
    /// player never aims, so the swing has to forgive sloppy facing.
    public var swordArc: Double = .pi * 0.75
    /// Windup before the swing lands, so the animation reads as a cause.
    public var swordWindup: Double = 0.12
    public var swordKnockback: Double = 90

    // MARK: - Carrying

    public var baseCarryCapacity: Int = 20
    public var carryCapacityPerLevel: Int = 8
    public var basePickupRadius: Double = 78
    public var pickupRadiusPerLevel: Double = 14
    /// How fast a magnetised token flies toward the hero.
    public var tokenMagnetSpeed: Double = 620
    public var tokenMagnetAcceleration: Double = 1800
    /// Tokens left on the ground this long despawn, so the field stays clean.
    public var tokenLifetime: Double = 45

    // MARK: - Depositing

    /// Tokens per second drained from the stack into a build plot.
    public var depositRate: Double = 14
    public var plotInteractionRadius: Double = 62

    // MARK: - Towers

    public var towerBaseDamage: Double = 6
    public var towerBaseInterval: Double = 1.0
    public var towerMinInterval: Double = 0.2
    public var towerRange: Double = 265
    public var towerRadius: Double = 30
    /// Tower shots are hitscan; this is only how long the tracer is shown.
    public var towerTracerDuration: Double = 0.12

    // MARK: - Enemies

    public var enemyBaseHealth: Double = 20
    public var enemyBaseDamage: Double = 8
    public var enemyBaseSpeed: Double = 100
    public var enemyRadius: Double = 22
    public var enemyAttackInterval: Double = 1.1
    public var enemyBaseTokenDrop: Int = 5
    /// Enemies push each other apart so they never stack into one sprite.
    public var enemySeparationStrength: Double = 140

    // MARK: - Waves

    public var waveDuration: Double = 30
    public var waveBreak: Double = 5
    /// Sized so spawn rate slightly exceeds the opening kill rate — otherwise
    /// the arena reads as empty and the auto-attack has nothing to chew on.
    /// A crowd is the point: the sword arc hits several at once, so density is
    /// what makes the hero feel strong.
    public var baseSpawnsPerWave: Int = 24
    /// Must stay *below* the rate player power grows, or pressure outruns the
    /// player and the mid-game becomes unwinnable regardless of the economy.
    /// Total incoming health per wave is this times `enemyHealthGrowth`.
    public var spawnsPerWaveGrowth: Double = 1.11
    public var maxConcurrentEnemies: Int = 140
    /// Every Nth wave is a boss wave.
    public var bossWaveInterval: Int = 5
    public var bossHealthMultiplier: Double = 14
    public var bossDamageMultiplier: Double = 2.2
    public var bossSpeedMultiplier: Double = 0.62
    public var bossTokenMultiplier: Double = 12
    public var bossRadiusMultiplier: Double = 2.1

    // MARK: - Upgrade base prices

    /// Kept low so the first few purchases land quickly and teach the loop;
    /// `costGrowth` is what carries the long game.
    public var upgradeBasePrices: [UpgradeKind: Int] = [
        .heroDamage: 48,
        .attackSpeed: 78,
        .moveSpeed: 66,
        .carryCapacity: 60,
        .pickupRadius: 60,
    ]

    /// Price of building on an empty plot, before any tower upgrades.
    /// The cheapest thing in the game, and deposited directly at the plot with
    /// no trip back to base — so the very first goal a player completes is the
    /// one that shows off the build mechanic.
    public var towerBuildCost: Int = 35

    public init() {}
}
