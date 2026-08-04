import Foundation

/// SplitMix64. Seeded and reproducible, so a given seed always produces the
/// same run — which is what makes the balance tests meaningful.
public struct RNG: Sendable {
    private var state: UInt64

    public init(seed: UInt64 = 0xA5A5_5A5A_DEAD_BEEF) {
        self.state = seed
    }

    public mutating func nextUInt64() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    public mutating func nextUnit() -> Double {
        Double(nextUInt64() >> 11) * (1.0 / 9_007_199_254_740_992.0)
    }

    public mutating func next(in range: ClosedRange<Double>) -> Double {
        range.lowerBound + nextUnit() * (range.upperBound - range.lowerBound)
    }

    public mutating func next(in range: Range<Int>) -> Int {
        guard range.upperBound > range.lowerBound else { return range.lowerBound }
        let span = UInt64(range.upperBound - range.lowerBound)
        return range.lowerBound + Int(nextUInt64() % span)
    }

    public mutating func nextAngle() -> Double { nextUnit() * .pi * 2 }

    public mutating func chance(_ probability: Double) -> Bool { nextUnit() < probability }
}
