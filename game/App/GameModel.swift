import Combine
import SwiftUI

#if canImport(UIKit)
    import UIKit
#endif

/// Bridges the simulation to SwiftUI.
///
/// The scene owns the frame loop; this republishes a snapshot roughly ten times
/// a second. Publishing every frame would rebuild the HUD sixty times a second
/// for numbers that change far more slowly.
@MainActor
final class GameModel: ObservableObject {

    let world = World()

    struct Snapshot: Equatable {
        var bank = 0
        var carried = 0
        var capacity = 0
        var wave = 0
        var health: Double = 0
        var maxHealth: Double = 1
        var towersBuilt = 0
        var totalDPS: Double = 0
        var enemiesKilled = 0
        var isDown = false
        var costs: [UpgradeKind: Int] = [:]
        var levels: [UpgradeKind: Int] = [:]

        var healthFraction: Double { maxHealth > 0 ? max(0, health / maxHealth) : 0 }
        var carryFraction: Double { capacity > 0 ? Double(carried) / Double(capacity) : 0 }
    }

    @Published private(set) var snapshot = Snapshot()
    @Published var isPaused = false
    @Published var isShopOpen = false
    @Published private(set) var banner: String?

    private var bannerClearTask: Task<Void, Never>?

    #if canImport(UIKit)
        private let collectHaptic = UIImpactFeedbackGenerator(style: .light)
        private let buildHaptic = UIImpactFeedbackGenerator(style: .medium)
    #endif

    init() {
        refresh()
        #if canImport(UIKit)
            collectHaptic.prepare()
            buildHaptic.prepare()
        #endif
    }

    func refresh() {
        var next = Snapshot()
        next.bank = world.bank
        next.carried = world.hero.carried
        next.capacity = world.carryCapacity
        next.wave = world.director.wave
        next.health = world.hero.health
        next.maxHealth = world.hero.maxHealth
        next.towersBuilt = world.plots.filter(\.isBuilt).count
        next.totalDPS = world.totalDPS
        next.enemiesKilled = world.enemiesKilled
        next.isDown = world.hero.isDown
        for kind in UpgradeKind.allCases {
            next.costs[kind] = world.upgradeCost(kind)
            next.levels[kind] = world.level(of: kind)
        }
        if next != snapshot { snapshot = next }
    }

    func purchase(_ kind: UpgradeKind) {
        guard world.purchase(kind) else { return }
        _ = world.drainEvents()
        #if canImport(UIKit)
            buildHaptic.impactOccurred()
        #endif
        refresh()
    }

    func playCollect() {
        // Deliberately silent for now; the hook exists so audio and haptics
        // land in one place when assets arrive. Firing a haptic per token
        // would buzz continuously during a swarm.
    }

    func announce(_ text: String) {
        banner = text
        bannerClearTask?.cancel()
        bannerClearTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.banner = nil }
        }
    }
}
