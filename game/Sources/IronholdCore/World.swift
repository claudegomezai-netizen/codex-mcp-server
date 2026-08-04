import Foundation

/// The whole game, with no rendering attached.
///
/// Call `step(dt:input:)` once per frame and read the resulting state and
/// events. Given the same seed and the same input sequence this produces the
/// same run every time, which is what the balance tests rely on.
public final class World {
    public let balance: Balance
    public let economy: Economy

    public private(set) var hero: Hero
    public private(set) var enemies: [Enemy] = []
    public private(set) var tokens: [TokenDrop] = []
    public private(set) var plots: [BuildPlot] = []
    public private(set) var director: WaveDirector

    public private(set) var upgradeLevels: [UpgradeKind: Int] = [:]
    /// Tokens banked by depositing at the base. Spent on hero upgrades.
    public private(set) var bank: Int = 0

    public private(set) var elapsed: Double = 0
    public private(set) var totalTokensEarned: Int = 0
    public private(set) var enemiesKilled: Int = 0

    /// Drained by the renderer each frame.
    public private(set) var events: [SimEvent] = []

    private var rng: RNG
    private var nextID: EntityID = 1

    public struct Input: Sendable {
        /// Joystick direction. Magnitude above 1 is clamped.
        public var move: Vec2
        public init(move: Vec2 = .zero) { self.move = move }
    }

    public init(balance: Balance = Balance(), seed: UInt64 = 0xA5A5_5A5A_DEAD_BEEF) {
        self.balance = balance
        self.economy = Economy(balance: balance)
        self.hero = Hero(position: balance.basePosition, maxHealth: balance.heroMaxHealth)
        self.director = WaveDirector(economy: economy)
        self.rng = RNG(seed: seed)
        for kind in UpgradeKind.allCases { upgradeLevels[kind] = 0 }
        layoutPlots()
    }

    private func allocateID() -> EntityID {
        defer { nextID += 1 }
        return nextID
    }

    /// Plots sit in a ring around the base. Fixed positions, per the
    /// stat-based tower design: the decision is *which* to build and when to
    /// upgrade, not where to put it.
    private func layoutPlots() {
        for i in 0..<balance.stationCount where i != balance.bankStationIndex {
            plots.append(BuildPlot(id: allocateID(), position: balance.stationPosition(i)))
        }
    }

    // MARK: - Derived hero stats

    public func level(of kind: UpgradeKind) -> Int { upgradeLevels[kind] ?? 0 }

    public var heroDamage: Double { economy.heroDamage(level: level(of: .heroDamage)) }
    public var heroAttackInterval: Double { economy.attackInterval(level: level(of: .attackSpeed)) }
    public var heroMoveSpeed: Double { economy.moveSpeed(level: level(of: .moveSpeed)) }
    public var carryCapacity: Int { economy.carryCapacity(level: level(of: .carryCapacity)) }
    public var pickupRadius: Double { economy.pickupRadius(level: level(of: .pickupRadius)) }

    /// Hero damage per second, ignoring overkill and travel time.
    public var heroDPS: Double { heroDamage / heroAttackInterval }

    public var towerDPS: Double {
        plots.filter(\.isBuilt).reduce(0) { total, plot in
            total + economy.towerDamage(level: plot.level) / economy.towerInterval(level: plot.level)
        }
    }

    public var totalDPS: Double { heroDPS + towerDPS }

    public func upgradeCost(_ kind: UpgradeKind) -> Int {
        economy.upgradeCost(kind, level: level(of: kind))
    }

    public func canAfford(_ kind: UpgradeKind) -> Bool {
        bank >= upgradeCost(kind)
    }

    @discardableResult
    public func purchase(_ kind: UpgradeKind) -> Bool {
        let cost = upgradeCost(kind)
        guard bank >= cost else { return false }
        bank -= cost
        let newLevel = level(of: kind) + 1
        upgradeLevels[kind] = newLevel
        events.append(.upgradePurchased(kind: kind, level: newLevel, cost: cost))
        return true
    }

    public func drainEvents() -> [SimEvent] {
        defer { events.removeAll(keepingCapacity: true) }
        return events
    }

    // MARK: - Step

    public func step(_ dt: Double, input: Input) {
        elapsed += dt

        stepWaves(dt)
        stepHero(dt, input: input)
        stepSword(dt)
        stepTowers(dt)
        stepEnemies(dt)
        stepTokens(dt)
        stepDeposits(dt)
        cleanup()
    }

    // MARK: - Waves and spawning

    private func stepWaves(_ dt: Double) {
        let (spawns, waveEvents) = director.step(dt, activeEnemyCount: enemies.count)
        events.append(contentsOf: waveEvents)
        for _ in 0..<spawns { spawnEnemy() }
    }

    private func spawnEnemy() {
        let wave = max(1, director.wave)
        let isBoss = economy.isBossWave(wave)

        // Spawn on a ring outside the play area around the base so enemies
        // always walk *in* toward the player rather than appearing on top.
        let angle = rng.nextAngle()
        // Wave 1 spawns close and on-screen. The opening seconds decide whether
        // a casual player stays, so the first enemy walks into range almost
        // immediately rather than approaching from offscreen.
        let ringScale = wave == 1 ? 0.55 : 1.0
        let distance = rng.next(
            in: (balance.spawnRingInner * ringScale)...(balance.spawnRingOuter * ringScale))
        // Spawn around the hero, not the base, so walking away from the base
        // does not outrun the fight.
        var position = hero.position + Vec2.fromAngle(angle, magnitude: distance)
        position.x = min(max(position.x, 40), balance.arenaSize.x - 40)
        position.y = min(max(position.y, 40), balance.arenaSize.y - 40)

        var health = economy.enemyHealth(wave: wave)
        var damage = economy.enemyDamage(wave: wave)
        var speed = balance.enemyBaseSpeed * rng.next(in: 0.9...1.15)
        var radius = balance.enemyRadius
        var tokens = economy.enemyTokenDrop(wave: wave)

        if isBoss {
            health *= balance.bossHealthMultiplier
            damage *= balance.bossDamageMultiplier
            speed *= balance.bossSpeedMultiplier
            radius *= balance.bossRadiusMultiplier
            tokens = Int(Double(tokens) * balance.bossTokenMultiplier)
        }

        enemies.append(
            Enemy(
                id: allocateID(),
                kind: isBoss ? .boss : .grunt,
                position: position,
                health: health,
                maxHealth: health,
                damage: damage,
                speed: speed,
                radius: radius,
                tokenValue: tokens
            )
        )
    }

    // MARK: - Hero

    private func stepHero(_ dt: Double, input: Input) {
        hero.invulnerability = max(0, hero.invulnerability - dt)

        if hero.isDown {
            hero.respawnTimer -= dt
            if hero.respawnTimer <= 0 {
                hero.respawnTimer = 0
                hero.position = balance.basePosition
                hero.health = hero.maxHealth
                hero.invulnerability = 1.2
                events.append(.heroRespawned(position: hero.position))
            }
            return
        }

        if hero.health < hero.maxHealth {
            hero.health = min(hero.maxHealth, hero.health + balance.heroHealthRegenPerSecond * dt)
        }

        let move = input.move.clampedMagnitude(1)
        if move.lengthSquared > 1e-6 {
            hero.position += move * (heroMoveSpeed * dt)
            hero.facing = move.angle
        }

        // Keep the hero inside the arena.
        hero.position.x = min(max(hero.position.x, balance.heroRadius), balance.arenaSize.x - balance.heroRadius)
        hero.position.y = min(max(hero.position.y, balance.heroRadius), balance.arenaSize.y - balance.heroRadius)
    }

    // MARK: - Sword

    private func stepSword(_ dt: Double) {
        guard !hero.isDown else { return }

        hero.attackCooldown = max(0, hero.attackCooldown - dt)

        // Resolve a swing that is mid-windup.
        if hero.pendingSwingTimer >= 0 {
            hero.pendingSwingTimer -= dt
            if hero.pendingSwingTimer <= 0 {
                hero.pendingSwingTimer = -1
                resolveSwing()
            }
            return
        }

        guard hero.attackCooldown <= 0 else { return }
        guard let target = nearestEnemy(to: hero.position, within: balance.swordRange) else { return }

        // Face the target, then wind up. The player never aims, so the hero
        // aims for them — this is what makes "just move" feel competent.
        hero.facing = (target.position - hero.position).angle
        hero.attackCooldown = heroAttackInterval
        hero.pendingSwingTimer = min(balance.swordWindup, heroAttackInterval * 0.4)

        events.append(
            .swordSwing(
                origin: hero.position,
                facing: hero.facing,
                arc: balance.swordArc,
                range: balance.swordRange
            )
        )
    }

    private func resolveSwing() {
        let damage = heroDamage
        let halfArc = balance.swordArc / 2
        let reachSquared = pow(balance.swordRange + balance.heroRadius, 2)

        for index in enemies.indices {
            guard enemies[index].isAlive else { continue }
            let offset = enemies[index].position - hero.position
            guard offset.lengthSquared <= reachSquared + pow(enemies[index].radius, 2) else { continue }
            guard abs(Vec2.angleDelta(hero.facing, offset.angle)) <= halfArc else { continue }

            enemies[index].health -= damage
            enemies[index].hitFlash = 0.12
            enemies[index].knockback = offset.normalized * balance.swordKnockback

            let killed = !enemies[index].isAlive
            events.append(
                .enemyHit(
                    id: enemies[index].id,
                    position: enemies[index].position,
                    damage: damage,
                    killed: killed
                )
            )
        }
    }

    private func nearestEnemy(to point: Vec2, within range: Double) -> Enemy? {
        var best: Enemy?
        var bestDistance = Double.greatestFiniteMagnitude
        for enemy in enemies where enemy.isAlive {
            let reach = range + enemy.radius
            let d = enemy.position.distanceSquared(to: point)
            if d <= reach * reach, d < bestDistance {
                bestDistance = d
                best = enemy
            }
        }
        return best
    }

    // MARK: - Towers

    private func stepTowers(_ dt: Double) {
        for index in plots.indices {
            guard plots[index].isBuilt else { continue }
            plots[index].fireCooldown = max(0, plots[index].fireCooldown - dt)
            guard plots[index].fireCooldown <= 0 else { continue }

            let origin = plots[index].position
            guard let target = nearestEnemy(to: origin, within: balance.towerRange) else { continue }
            guard let targetIndex = enemies.firstIndex(where: { $0.id == target.id }) else { continue }

            let damage = economy.towerDamage(level: plots[index].level)
            plots[index].fireCooldown = economy.towerInterval(level: plots[index].level)

            enemies[targetIndex].health -= damage
            enemies[targetIndex].hitFlash = 0.1

            events.append(.towerFired(from: origin, to: enemies[targetIndex].position, damage: damage))
            events.append(
                .enemyHit(
                    id: enemies[targetIndex].id,
                    position: enemies[targetIndex].position,
                    damage: damage,
                    killed: !enemies[targetIndex].isAlive
                )
            )
        }
    }

    // MARK: - Enemies

    private func stepEnemies(_ dt: Double) {
        let heroPosition = hero.position

        for index in enemies.indices {
            guard enemies[index].isAlive else { continue }

            enemies[index].hitFlash = max(0, enemies[index].hitFlash - dt)

            // Knockback decays fast, then normal pursuit resumes.
            if enemies[index].knockback.lengthSquared > 1 {
                enemies[index].position += enemies[index].knockback * dt
                enemies[index].knockback = enemies[index].knockback * max(0, 1 - dt * 8)
            }

            // Enemies always walk toward the hero. Towers are damage, not
            // aggro — that keeps the hero the centre of attention.
            var desired = (heroPosition - enemies[index].position).normalized

            // Cheap separation so a crowd reads as a crowd, not one sprite.
            var push = Vec2.zero
            for other in enemies where other.id != enemies[index].id && other.isAlive {
                let offset = enemies[index].position - other.position
                let minimum = enemies[index].radius + other.radius
                let distanceSquared = offset.lengthSquared
                if distanceSquared < minimum * minimum, distanceSquared > 1e-6 {
                    let distance = distanceSquared.squareRoot()
                    push += offset.normalized * ((minimum - distance) / minimum)
                }
            }
            desired += push * (balance.enemySeparationStrength / max(1, enemies[index].speed))

            enemies[index].velocity = desired.normalized * enemies[index].speed
            enemies[index].position += enemies[index].velocity * dt

            // Contact damage.
            enemies[index].attackCooldown = max(0, enemies[index].attackCooldown - dt)
            let contactRange = enemies[index].radius + balance.heroRadius
            if !hero.isDown,
                enemies[index].position.distanceSquared(to: heroPosition) <= contactRange * contactRange,
                enemies[index].attackCooldown <= 0,
                hero.invulnerability <= 0
            {
                enemies[index].attackCooldown = balance.enemyAttackInterval
                applyHeroDamage(enemies[index].damage)
            }
        }
    }

    private func applyHeroDamage(_ amount: Double) {
        hero.health -= amount
        hero.invulnerability = balance.heroInvulnerabilityAfterHit
        events.append(.heroDamaged(position: hero.position, amount: amount, healthAfter: max(0, hero.health)))

        guard hero.health <= 0 else { return }

        hero.health = 0
        hero.respawnTimer = balance.heroRespawnDelay
        let lost = Int(Double(hero.carried) * balance.heroDeathTokenLoss)
        hero.carried -= lost
        events.append(.heroDowned(position: hero.position, tokensLost: lost))
    }

    // MARK: - Tokens

    private func dropTokens(at position: Vec2, count: Int) {
        // Drop as a few clustered pickups rather than one per token, so the
        // scatter stays readable when a boss pays out a hundred at once.
        let pickups = min(max(1, count), 8)
        let per = count / pickups
        let remainder = count % pickups

        for i in 0..<pickups {
            let angle = rng.nextAngle()
            let speed = rng.next(in: 60...170)
            tokens.append(
                TokenDrop(
                    id: allocateID(),
                    position: position,
                    velocity: Vec2.fromAngle(angle, magnitude: speed),
                    value: per + (i < remainder ? 1 : 0),
                    settleTimer: rng.next(in: 0.12...0.3)
                )
            )
        }
    }

    private func stepTokens(_ dt: Double) {
        let capacity = carryCapacity
        let radius = pickupRadius
        var collected: [(Vec2, Int)] = []
        var announcedFull = false

        for index in tokens.indices {
            tokens[index].age += dt

            if tokens[index].settleTimer > 0 {
                tokens[index].settleTimer -= dt
                tokens[index].position += tokens[index].velocity * dt
                tokens[index].velocity = tokens[index].velocity * max(0, 1 - dt * 5)
                continue
            }

            // A full stack stops attracting; the tokens wait on the ground.
            // This is the moment the Satchel upgrade sells itself.
            guard hero.carried < capacity, !hero.isDown else {
                if hero.carried >= capacity, !announcedFull,
                    tokens[index].position.distanceSquared(to: hero.position) <= radius * radius
                {
                    announcedFull = true
                    events.append(.stackFull(position: hero.position))
                }
                continue
            }

            let toHero = hero.position - tokens[index].position
            if tokens[index].isMagnetised || toHero.lengthSquared <= radius * radius {
                tokens[index].isMagnetised = true
                tokens[index].magnetSpeed = min(
                    balance.tokenMagnetSpeed,
                    tokens[index].magnetSpeed + balance.tokenMagnetAcceleration * dt
                )
                tokens[index].position += toHero.normalized * (tokens[index].magnetSpeed * dt)

                if toHero.length <= balance.heroRadius {
                    let space = capacity - hero.carried
                    let taken = min(space, tokens[index].value)
                    if taken > 0 {
                        hero.carried += taken
                        totalTokensEarned += taken
                        tokens[index].value -= taken
                        collected.append((tokens[index].position, taken))
                    }
                }
            }
        }

        for (position, value) in collected {
            events.append(.tokenCollected(position: position, value: value, carriedAfter: hero.carried))
        }

        tokens.removeAll { $0.value <= 0 || $0.age > balance.tokenLifetime }
    }

    // MARK: - Deposits

    private func stepDeposits(_ dt: Double) {
        guard !hero.isDown, hero.carried > 0 else { return }

        // Standing on the bank station converts the stack into hero upgrades.
        let baseRange = balance.plotInteractionRadius
        if hero.position.distanceSquared(to: balance.bankPosition) <= baseRange * baseRange {
            let amount = min(Double(hero.carried), balance.depositRate * dt)
            let whole = depositWhole(amount)
            if whole > 0 {
                hero.carried -= whole
                bank += whole
                events.append(.depositTick(plot: 0, position: balance.bankPosition, amount: whole))
            }
            return
        }

        // Otherwise, standing on a plot pours tokens into that tower.
        for index in plots.indices {
            let plot = plots[index]
            guard hero.position.distanceSquared(to: plot.position) <= baseRange * baseRange else { continue }

            let target = Double(economy.towerCost(level: plot.level))
            let needed = target - plot.deposited
            guard needed > 0 else { continue }

            let amount = min(min(Double(hero.carried), needed), balance.depositRate * dt)
            let whole = depositWhole(amount)
            guard whole > 0 else { return }

            hero.carried -= whole
            plots[index].deposited += Double(whole)
            events.append(.depositTick(plot: plot.id, position: plot.position, amount: whole))

            if plots[index].deposited >= target {
                plots[index].deposited = 0
                plots[index].level += 1
                plots[index].state = .built
                events.append(
                    .towerBuilt(plot: plot.id, position: plot.position, level: plots[index].level)
                )
            }
            return
        }
    }

    /// Deposits run at a rate but tokens are discrete. Accumulate the
    /// fractional remainder so slow rates still pay out instead of rounding
    /// to zero every frame.
    private var depositRemainder: Double = 0
    private func depositWhole(_ amount: Double) -> Int {
        depositRemainder += amount
        let whole = Int(depositRemainder)
        depositRemainder -= Double(whole)
        return whole
    }

    // MARK: - Cleanup

    private func cleanup() {
        var survivors: [Enemy] = []
        survivors.reserveCapacity(enemies.count)

        for enemy in enemies {
            if enemy.isAlive {
                survivors.append(enemy)
            } else {
                enemiesKilled += 1
                dropTokens(at: enemy.position, count: enemy.tokenValue)
                events.append(
                    .enemyDied(
                        position: enemy.position,
                        kind: enemy.kind,
                        tokensDropped: enemy.tokenValue
                    )
                )
            }
        }

        enemies = survivors
    }
}
