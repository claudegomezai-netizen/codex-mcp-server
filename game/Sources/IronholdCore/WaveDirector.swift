import Foundation

/// Decides what spawns and when.
///
/// Spawns are spread across the wave rather than dumped at the start, so the
/// player is never idle waiting for the next batch — the token faucet runs
/// continuously and the carry/deposit loop keeps its rhythm.
public struct WaveDirector: Sendable {
    public private(set) var wave: Int = 0
    public private(set) var timeInWave: Double = 0
    public private(set) var isBreak: Bool = true
    public private(set) var spawnsRemaining: Int = 0

    private var spawnAccumulator: Double = 0
    private var breakTimer: Double

    private let economy: Economy
    private var balance: Balance { economy.balance }

    public init(economy: Economy) {
        self.economy = economy
        // Only a brief beat before wave 1 — the opening seconds are the most
        // expensive seconds in a casual game, so the fight starts almost at once.
        self.breakTimer = 0.8
    }

    public var isBossWave: Bool { economy.isBossWave(wave) }

    /// Advances wave state and returns how many enemies to spawn this tick.
    public mutating func step(_ dt: Double, activeEnemyCount: Int) -> (spawns: Int, events: [SimEvent]) {
        var events: [SimEvent] = []

        if isBreak {
            breakTimer -= dt
            guard breakTimer <= 0 else { return (0, events) }
            wave += 1
            isBreak = false
            timeInWave = 0
            spawnAccumulator = 0
            spawnsRemaining = economy.isBossWave(wave) ? 1 : economy.spawnCount(wave: wave)
            events.append(.waveStarted(wave: wave, isBoss: economy.isBossWave(wave)))
            return (0, events)
        }

        timeInWave += dt

        var spawns = 0
        if spawnsRemaining > 0 {
            if economy.isBossWave(wave) {
                // Bosses arrive immediately; the wave is the fight.
                spawns = spawnsRemaining
                spawnsRemaining = 0
            } else {
                // Spread the wave's spawns across 80% of its duration.
                let window = balance.waveDuration * 0.8
                let rate = Double(economy.spawnCount(wave: wave)) / window
                spawnAccumulator += rate * dt
                while spawnAccumulator >= 1, spawnsRemaining > 0 {
                    spawnAccumulator -= 1
                    spawnsRemaining -= 1
                    spawns += 1
                }
            }
        }

        // Respect the concurrency ceiling; anything held back stays queued.
        let room = max(0, balance.maxConcurrentEnemies - activeEnemyCount)
        if spawns > room {
            spawnsRemaining += spawns - room
            spawns = room
        }

        // The wave ends once everything has spawned and the field is clear —
        // or once the clock runs out, so a stalled player still progresses.
        let everythingSpawned = spawnsRemaining == 0
        let fieldClear = activeEnemyCount + spawns == 0
        let timedOut = timeInWave >= balance.waveDuration * 2.5

        if (everythingSpawned && fieldClear) || timedOut {
            events.append(.waveCleared(wave: wave))
            isBreak = true
            breakTimer = balance.waveBreak
        }

        return (spawns, events)
    }
}
