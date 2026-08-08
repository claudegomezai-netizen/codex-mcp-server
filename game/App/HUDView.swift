import SwiftUI

/// Everything overlaid on the scene. Kept in SwiftUI rather than SpriteKit
/// nodes so the shop can use real controls and adapt to Dynamic Type.
struct HUDView: View {
    @ObservedObject var model: GameModel

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                topBar
                Spacer()
                if model.isShopOpen { shop }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)

            if let banner = model.banner {
                Text(banner)
                    .font(.system(size: 34, weight: .heavy, design: .rounded))
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.6), radius: 6, y: 2)
                    .transition(.scale.combined(with: .opacity))
                    .allowsHitTesting(false)
            }

            if model.snapshot.isDown {
                Text("DOWNED")
                    .font(.system(size: 28, weight: .heavy, design: .rounded))
                    .foregroundStyle(.red.opacity(0.9))
                    .offset(y: 70)
                    .allowsHitTesting(false)
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: model.banner)
        .animation(.easeInOut(duration: 0.2), value: model.isShopOpen)
    }

    // MARK: - Top bar

    private var topBar: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text("WAVE \(max(1, model.snapshot.wave))")
                    .font(.system(size: 17, weight: .heavy, design: .rounded))
                    .foregroundStyle(.white)

                healthBar
                    .frame(width: 132, height: 9)

                Label("\(model.snapshot.bank)", systemImage: "circle.hexagongrid.fill")
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                    .foregroundStyle(Color(red: 1, green: 0.8, blue: 0.24))
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 6) {
                Text("\(model.snapshot.carried)/\(model.snapshot.capacity)")
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                    .foregroundStyle(
                        model.snapshot.carried >= model.snapshot.capacity
                            ? Color(red: 1, green: 0.8, blue: 0.24) : .white)

                Text("\(model.snapshot.towersBuilt) towers")
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.7))

                Button {
                    model.isShopOpen.toggle()
                } label: {
                    Label(
                        model.isShopOpen ? "Close" : "Upgrades",
                        systemImage: model.isShopOpen ? "xmark.circle.fill" : "arrow.up.circle.fill"
                    )
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(.ultraThinMaterial, in: Capsule())
                }
                .tint(.white)
            }
        }
    }

    private var healthBar: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(.black.opacity(0.45))
                Capsule()
                    .fill(
                        model.snapshot.healthFraction < 0.3
                            ? Color.red : Color(red: 0.4, green: 0.86, blue: 0.5)
                    )
                    .frame(width: geometry.size.width * model.snapshot.healthFraction)
            }
        }
        .animation(.easeOut(duration: 0.15), value: model.snapshot.healthFraction)
    }

    // MARK: - Shop

    private var shop: some View {
        VStack(spacing: 8) {
            HStack {
                Text("HERO UPGRADES")
                    .font(.system(size: 13, weight: .heavy, design: .rounded))
                    .foregroundStyle(.white.opacity(0.6))
                Spacer()
                Text("Deposit at the BANK to earn tokens")
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.45))
            }

            ForEach(UpgradeKind.allCases, id: \.self) { kind in
                upgradeRow(kind)
            }
        }
        .padding(14)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(.bottom, 24)
    }

    private func upgradeRow(_ kind: UpgradeKind) -> some View {
        let cost = model.snapshot.costs[kind] ?? 0
        let level = model.snapshot.levels[kind] ?? 0
        let affordable = model.snapshot.bank >= cost

        return Button {
            model.purchase(kind)
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(kind.displayName)
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                    Text(kind.blurb)
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text("LV \(level)")
                    .font(.system(size: 12, weight: .heavy, design: .rounded))
                    .foregroundStyle(.secondary)
                Text("\(cost)")
                    .font(.system(size: 15, weight: .heavy, design: .rounded))
                    .foregroundStyle(affordable ? Color(red: 1, green: 0.8, blue: 0.24) : .secondary)
                    .frame(minWidth: 52, alignment: .trailing)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(affordable ? Color.white.opacity(0.14) : Color.white.opacity(0.04))
            )
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
        .disabled(!affordable)
    }
}
