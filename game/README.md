# Ironhold

An arcade-idle prototype in the shape of
[XP Hero](https://apps.apple.com/us/app/xp-hero/id6740618570): a hero whose
sword auto-attacks, enemies that drop tokens, a stack carried above the head,
and stations where that stack becomes archer towers and upgrades.

`DESIGN.md` covers the genre research and every balance decision, including the
three separate economy failures the tooling caught and how they were fixed.

## Playing it in a browser

`web/index.html` is a self-contained playable build — open the file, no server,
no build step. Drag to move on touch, WASD or arrows on desktop.

It is a **second implementation of the same rules**, ported to JavaScript so the
game can be played without a Mac. `Balance.swift` remains the source of truth;
the constants in `web/index.html` sit in one marked block at the top so
re-syncing is a copy-paste. Anyone changing balance needs to change both, and
nothing enforces that — worth knowing before either side is edited.

The port was checked against the Swift core by running the same scripted
playtest headlessly:

| | Swift core | Browser build |
|---|---|---|
| First kill | 3.5s | 3.3s |
| First tower | 12.1s | 14.0s |
| Upgrades bought | 20 | 20 |
| Waves reached | 9 | 9 |
| Deaths | 10 | 11 |

## Running the iOS app

Open `Ironhold.xcodeproj` and press ⌘R. Portrait iPhone or iPad, iOS 17+.

Set your signing team on the `Ironhold` target before running on a device
(`DEVELOPMENT_TEAM` is intentionally blank). The Simulator needs no signing.

There are **no art assets** — every sprite is generated procedurally at load, so
the project runs the moment it opens.

### How to play

Drag anywhere to move; the joystick appears under your thumb. The sword swings
on its own. Kill things, let the tokens pile above your head, then walk to a
station on the ring:

- **BANK** (amber ring) — converts the stack into hero upgrades. Open
  **Upgrades** in the top right to spend.
- **Tower plots** (dashed rings) — pour the stack in to raise an archer tower,
  and again to level it up. Towers fire on their own.

The counter above your head turns amber when the satchel is full. That is the
game telling you to buy a bigger one.

## Working on the simulation

The game logic lives in `Sources/IronholdCore` and has no SpriteKit, UIKit, or
SwiftUI in it. It builds and tests on any platform with a Swift toolchain,
including Linux — which is how the balance was tuned without a device.

```bash
swift test            # 42 tests: simulation behaviour + economy guardrails
swift run IronholdTune # balance inspector — pacing curves and a headless playtest
```

`IronholdTune` plays a five-minute session with a scripted player and reports
time-to-first-kill, time-to-first-tower, deaths, and the shape of the upgrade
pacing curve. Change a number in `Balance.swift` and re-run it; that loop is how
every value in the game was chosen.

## Layout

| Path | What it is |
|---|---|
| `Sources/IronholdCore/` | The entire game. Portable, deterministic, tested. |
| `Sources/IronholdCore/Balance.swift` | Every tunable number, with reasoning. |
| `Sources/IronholdCore/Economy.swift` | Cost and stat curves, and the pacing model. |
| `Sources/IronholdCore/World.swift` | The simulation step. |
| `Sources/IronholdTune/` | Balance inspector and headless playtest harness. |
| `App/` | SpriteKit rendering, joystick, SwiftUI HUD. No game rules. |
| `web/index.html` | Self-contained playable browser build. |
| `Tests/` | Simulation and economy tests. |

The Xcode target compiles `App/` and `Sources/IronholdCore/` together into one
module, so app code refers to `World` and friends without an `import`.

## Status

The simulation core is verified: 42 tests pass against a real Swift 6.3
toolchain, and the balance figures in `DESIGN.md` are measured output, not
estimates.

**The SpriteKit layer in `App/` has never been compiled.** It was written in a
Linux container with no Apple SDK, so it is syntax-checked only — expect to fix
some type errors on first build. The simulation underneath it is the part that
carries real confidence.

**The visual pass described in `DESIGN.md` §8 is browser-only.** Lighting,
contact shadows, the drawn sword, tower silhouettes and floor detail all live
in `web/index.html`. `App/` received the camera-distance change and nothing
else, so the iOS build still looks like the flat first version.
