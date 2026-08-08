import Foundation
import IronholdCore

/// Balance inspector. Run with `swift run IronholdTune` to print the pacing
/// curve the economy produces, so growth rates are chosen from evidence rather
/// than intuition.
///
/// The number that matters is "seconds to afford the next upgrade" across a
/// long session. It should drift gently upward. Flat means progression has no
/// weight; steeply upward is the grind wall this genre is notorious for;
/// downward means power creep and the game trivialises itself.

func report(_ label: String, _ balance: Balance) {
    let curve = Economy(balance: balance).pacingCurve(purchases: 80)
    let early = curve.prefix(10).map(\.seconds).reduce(0, +) / 10
    let late = curve.suffix(10).map(\.seconds).reduce(0, +) / 10
    let minimum = curve.map(\.seconds).min() ?? 0
    let maximum = curve.map(\.seconds).max() ?? 0

    print("── \(label)")
    print(
        String(
            format: "   cost %.3f  power %.3f  swing %.3f",
            balance.costGrowth, balance.powerGrowth, balance.attackSpeedGrowth))
    print(
        String(
            format: "   early %.1fs   late %.1fs   drift %.2fx   range %.1f–%.1fs",
            early, late, late / early, minimum, maximum))

    let samples = [0, 10, 20, 40, 60, 79]
    let trail = samples.map { String(format: "#%d:%.0fs", $0, curve[$0].seconds) }
        .joined(separator: "  ")
    print("   \(trail)")
    print("")
}

print("Ironhold balance\n")

playtestReport()

print("seconds to afford the next DPS upgrade\n")

report("shipping values", Balance())

// Sweep the rates that govern pacing, so the shipping choice is a considered
// point in the space rather than the first thing that worked.
for cost in [1.15, 1.18] {
    for swing in [1.03, 1.055] {
        var b = Balance()
        b.costGrowth = cost
        b.attackSpeedGrowth = swing
        report("cost \(cost) / swing \(swing)", b)
    }
}

// Late game is spawn-limited rather than kill-limited: player DPS outgrows how
// fast enemies arrive, so extra damage stops converting into extra income and
// the cost curve pulls away. Token drop growth is the dial that compensates.
for drop in [1.10, 1.125, 1.14] {
    var b = Balance()
    b.tokenDropGrowth = drop
    report("drop growth \(drop)", b)
}
