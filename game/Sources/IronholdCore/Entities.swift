import Foundation

public typealias EntityID = Int

// MARK: - Hero

public struct Hero: Sendable {
    public var position: Vec2
    public var facing: Double = -.pi / 2
    public var health: Double
    public var maxHealth: Double

    /// Tokens currently stacked above the hero's head.
    public var carried: Int = 0

    public var attackCooldown: Double = 0
    /// Counts down through the windup; the swing lands when it hits zero.
    public var pendingSwingTimer: Double = -1
    public var invulnerability: Double = 0
    public var respawnTimer: Double = 0

    public var isDown: Bool { respawnTimer > 0 }

    public init(position: Vec2, maxHealth: Double) {
        self.position = position
        self.health = maxHealth
        self.maxHealth = maxHealth
    }
}

// MARK: - Enemies

public enum EnemyKind: String, Sendable {
    case grunt
    case boss
}

public struct Enemy: Sendable, Identifiable {
    public let id: EntityID
    public var kind: EnemyKind
    public var position: Vec2
    public var velocity: Vec2 = .zero
    public var health: Double
    public var maxHealth: Double
    public var damage: Double
    public var speed: Double
    public var radius: Double
    public var tokenValue: Int
    public var attackCooldown: Double = 0
    /// Decays to zero; while non-zero the enemy is being pushed back.
    public var knockback: Vec2 = .zero
    /// Drives the hit-flash in the renderer.
    public var hitFlash: Double = 0

    public var isAlive: Bool { health > 0 }
}

// MARK: - Dropped tokens

/// Coins come in denominations so a payout reads as treasure rather than as a
/// pile of identical chips, and so a good kill can visibly produce something
/// rarer than the last one.
///
/// The values are gameplay numbers, not a nod to any real market: the point is
/// four clearly distinct tiers that make exact change. The largest is
/// deliberately no more than half of the *base* carry capacity, because coins
/// are picked up whole — a denomination bigger than an unupgraded satchel
/// could never be lifted at all. `EconomyTests` holds that invariant.
public enum CoinKind: String, CaseIterable, Sendable, Comparable {
    case sat
    case eth
    case sol
    case btc

    /// Short label for the HUD and for floating pickup text.
    public var ticker: String { rawValue.uppercased() }

    public static func < (a: CoinKind, b: CoinKind) -> Bool {
        (allCases.firstIndex(of: a) ?? 0) < (allCases.firstIndex(of: b) ?? 0)
    }
}

/// Timed boons that appear on the field and are collected by walking over them.
///
/// They exist to break the rhythm of a loop that is otherwise very even: the
/// hero's power only ever changes at a deposit station, so a run has no spikes.
/// Each of these is a spike, and each pulls the player somewhere they were not
/// already going.
public enum PowerUpKind: String, CaseIterable, Sendable {
    /// Swing far faster for a few seconds.
    case frenzy
    /// Enormous pickup radius — the reward is a floor swept clean.
    case magnet
    /// Kills pay double while it lasts.
    case greed
    /// Immune to contact damage, so a swarm can be waded into.
    case bulwark
    /// Instant: a shockwave that damages everything nearby. No duration.
    case surge

    /// Instant effects resolve on pickup and never enter the active set.
    public var isInstant: Bool { self == .surge }

    public var label: String {
        switch self {
        case .frenzy: return "Frenzy"
        case .magnet: return "Magnet"
        case .greed: return "Greed"
        case .bulwark: return "Bulwark"
        case .surge: return "Surge"
        }
    }
}

public struct PowerUpDrop: Sendable, Identifiable {
    public let id: EntityID
    public var position: Vec2
    public var kind: PowerUpKind
    /// Counts up; the drop vanishes once it passes the ground lifetime.
    public var age: Double = 0
}

public struct TokenDrop: Sendable, Identifiable {
    public let id: EntityID
    public var position: Vec2
    public var velocity: Vec2
    public var kind: CoinKind
    public var value: Int
    public var age: Double = 0
    /// Brief delay after dropping before the token can be magnetised, so the
    /// scatter is visible instead of snapping straight back to the hero.
    public var settleTimer: Double
    public var isMagnetised: Bool = false
    public var magnetSpeed: Double = 0
}

// MARK: - Build plots and towers

public enum PlotState: Equatable, Sendable {
    case empty
    case built
}

public struct BuildPlot: Sendable, Identifiable {
    public let id: EntityID
    public var position: Vec2
    public var state: PlotState = .empty
    /// 0 = nothing built. 1+ = tower level.
    public var level: Int = 0
    /// Tokens deposited toward the next level.
    public var deposited: Double = 0

    public var fireCooldown: Double = 0

    public init(id: EntityID, position: Vec2) {
        self.id = id
        self.position = position
    }

    public var isBuilt: Bool { state == .built }
}

// MARK: - Events emitted by the simulation

/// The simulation never draws or plays audio; it reports what happened and the
/// rendering layer decides how to present it. Keeping this boundary strict is
/// what lets the entire game be tested without a graphics context.
public enum SimEvent: Sendable {
    case swordSwing(origin: Vec2, facing: Double, arc: Double, range: Double)
    case enemyHit(id: EntityID, position: Vec2, damage: Double, killed: Bool)
    case enemyDied(position: Vec2, kind: EnemyKind, tokensDropped: Int)
    case tokenCollected(position: Vec2, value: Int, carriedAfter: Int)
    case stackFull(position: Vec2)
    case towerFired(from: Vec2, to: Vec2, damage: Double)
    case towerBuilt(plot: EntityID, position: Vec2, level: Int)
    case depositTick(plot: EntityID, position: Vec2, amount: Int)
    case heroDamaged(position: Vec2, amount: Double, healthAfter: Double)
    case heroDowned(position: Vec2, tokensLost: Int)
    case heroRespawned(position: Vec2)
    case powerUpSpawned(position: Vec2, kind: PowerUpKind)
    case powerUpCollected(position: Vec2, kind: PowerUpKind, duration: Double)
    case powerUpExpired(kind: PowerUpKind)
    case surgeDetonated(position: Vec2, radius: Double, damage: Double)
    /// Fires once per whole second of the pre-session countdown, ending with 0.
    case countdownTick(secondsRemaining: Int)
    case waveStarted(wave: Int, isBoss: Bool)
    case waveCleared(wave: Int)
    case upgradePurchased(kind: UpgradeKind, level: Int, cost: Int)
}
