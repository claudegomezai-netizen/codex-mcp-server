import SpriteKit
import SwiftUI

struct GameView: View {
    @StateObject private var model = GameModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                SpriteView(
                    scene: scene(for: geometry.size),
                    // The scene is driven entirely by `World`, so there is no
                    // physics or constraint work for SpriteKit to do.
                    options: [.ignoresSiblingOrder, .shouldCullNonVisibleNodes],
                    debugOptions: []
                )
                .ignoresSafeArea()

                HUDView(model: model)
            }
        }
        .background(Color.black)
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .onChange(of: scenePhase) { _, phase in
            // Pause when backgrounded so the wave clock does not run on while
            // the player is elsewhere.
            model.isPaused = phase != .active
        }
    }

    /// Built once and cached; recreating it on every layout pass would restart
    /// the run whenever the HUD changed size.
    @MainActor
    private func scene(for size: CGSize) -> GameScene {
        if let existing = SceneCache.shared.scene {
            return existing
        }
        let scene = GameScene(model: model, size: size)
        SceneCache.shared.scene = scene
        return scene
    }
}

@MainActor
private final class SceneCache {
    static let shared = SceneCache()
    var scene: GameScene?
}
