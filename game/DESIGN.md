# Ironhold — design notes

A hero who auto-attacks, enemies that drop tokens, a stack of tokens carried
above the head, and stations where that stack is spent on towers and upgrades.

This document records what the reference games actually do, what the numbers in
`Balance.swift` are, and why they are what they are. It is meant to stay honest:
where a decision was made from measurement, the measurement is here.

---

## 1. What the reference game actually is

[XP Hero](https://apps.apple.com/us/app/xp-hero/id6740618570) (Supercent, Feb
2025) presents as an action RPG. It isn't one. AppMagic classifies it as
**Hypercasual / Arcade / Idle Arcade / Hybridcasual**, and the loop underneath
the dungeon skin is a textbook **arcade idle** — a genre Homa Games named and
industrialised.

That reframing matters, because it tells you where the design effort goes.
Combat is not the product; combat is the *faucet*. The product is the loop:

> collect → carry → deposit → unlock → collect faster

Numbers worth knowing about the target genre:

| Metric | Genre benchmark |
|---|---|
| D1 retention | 35–50% |
| D0 playtime | ~25 min |
| CPI | ~$0.40 |
| XP Hero installs | 10M+ on Google Play, ~35k/day |
| XP Hero rating | 4.7★ (18k iOS ratings) |

Playtime roughly doubles hypercasual. That gap is the entire commercial reason
the genre exists.

## 2. The three ancestors

**Kingdom / Kingdom Two Crowns (2015)** is the loop, already solved, a decade
early. Collect coins, carry them, drop them on a build site, an archer tower
rises, archers fire on their own. An archer tower costs 3 coins on a rock pile,
and the tower's *height* is what extends archer range. Pressure comes from a
day/night clock.

**Vampire Survivors / Survivor.io** is the auto-attack half. One verb: move.
Weapons fire on fixed cooldowns and never aim. Because the player never presses
attack, positioning and wave composition carry 100% of the design weight.

**Alien Invasion: RPG Idle Space, My Perfect Hotel, Burger Please** are the idle
half: proximity auto-collect, a visible stack, a central deposit point,
exponential upgrade costs, zones gated behind level.

## 3. What this build takes, and what it refuses

**Taken — carry capacity as an upgradeable stat.** The genre's smartest sink,
because it converts a menu number into a visible change on screen. The stack is
also the game's main feedback channel and its ad creative.

**Taken — the stack as the primary read.** Coins arc in, pile above the head,
and the counter turns amber the moment the satchel fills. That colour change is
the entire tutorial for the carry-capacity upgrade.

**Refused — the mid-game wall.** XP Hero's own reviews and the published
teardown of Alien Invasion land on the same complaint: *"great for the first
three hours, then unbearable"* and *"I didn't understand where I was supposed to
pay."* That wall is not a mystery — it is arithmetic, and section 5 is about
refusing it.

## 4. The loop as built

1. The hero moves on a floating joystick. Nothing else is an input.
2. The sword swings on a cooldown at the nearest enemy in range, in a wide arc.
   The hero turns to face the target automatically — the player never aims, so
   the hero aims for them.
3. Dead enemies drop tokens, which magnetise inside the pickup radius and land
   on the stack.
4. The stack is capped. Once full, loose tokens stop attracting and wait on the
   ground.
5. Seven stations sit on a ring around the centre: one **bank**, six **tower
   plots**. Standing on one drains the stack into it.
6. Bank deposits buy hero upgrades. Plot deposits build and level towers, which
   fire on their own.
7. Waves escalate on a clock. Every fifth wave is a boss.

The centre of the arena is deliberately *neutral ground* — see section 6.

## 5. The economy, and the wall it is built to avoid

### The failure mode

The conventional idle economy grows upgrade costs exponentially (~1.12×/level)
while player damage grows **linearly**. Time to afford the next upgrade then
grows like 1.12ⁿ. By level 50, a purchase that once took 30 seconds takes over
two hours. That is the wall, and it is why the genre has the reputation it has.

`EconomyTests.testLinearDamageGrowthWouldProduceAWall` asserts this blow-up
still happens under the naive curve, so the comparison stays meaningful.

### The fix, and the second failure it exposed

Damage here grows geometrically too, so cost and power race each other rather
than one outrunning the other. The first attempt used cost 1.12 / power 1.10 —
and the guardrail test immediately failed in the *opposite* direction.

The reason: damage and swing speed **multiply** into DPS. A player levelling
both grows power at 1.16ⁿ against a 1.12ⁿ cost curve, so upgrades get *cheaper*
in real terms and the game trivialises itself. This is power creep, and it is
just as fatal as a wall — it is simply less complained about.

`IronholdTune` sweeps the space. Seconds to afford the next DPS upgrade,
measured across 80 purchases by a player who always buys the cheapest:

| cost growth | swing growth | early | late | drift |
|---|---|---|---|---|
| 1.12 | 1.030 | 38.5s | 9.2s | **0.24×** — trivialises |
| 1.12 | 1.055 | 38.5s | 5.2s | **0.13×** — trivialises |
| 1.15 | 1.030 | 41.2s | 25.3s | 0.62× |
| 1.15 | 1.055 | 41.2s | 14.5s | 0.35× |
| 1.18 | 1.055 | 43.6s | 39.5s | 0.91× |
| **1.18** | **1.030** | 43.6s | 68.0s | **1.56×** ✅ |

Only 1.18 / 1.03 drifts *upward*. That is the shipping pair.

### The third problem: spawn-limited income

Lowering spawn growth to 1.11 (section 6) made the game winnable but broke the
economy a second way. Once player DPS outgrows how fast enemies arrive, income
stops tracking damage — extra DPS buys nothing, because there is nothing extra
to kill. Costs keep compounding, and a wall re-forms from the other side.

Token drop growth is the counterweight. Sweeping it:

| drop growth | early | late | drift |
|---|---|---|---|
| 1.10 | 4.6s | 18.7s | 4.06× — wall re-forming |
| 1.115 | 4.5s | 11.3s | 2.53× |
| 1.12 | 4.5s | 9.6s | 2.14× |
| **1.125** | 4.5s | 8.2s | **1.82×** ✅ |
| 1.13 | 4.5s | 6.9s | 1.54× |
| 1.14 | 4.5s | 5.0s | 1.11× — flat, no sense of progress |
| 1.18 | 4.1s | 1.4s | 0.34× — trivialises |

### Shipping curve

```
cost 1.180   power 1.100   swing 1.030   drop 1.125
early 13.6s   late 24.5s   drift 1.80x   range 12.0–26.1s
#0:12s  #10:13s  #20:15s  #40:17s  #60:21s  #79:26s
```

Monotonic, gently upward, and it never leaves a 12–26 second band. Progress
still costs something at purchase 79; it just never becomes a wall.

`EconomyTests.testTimeToNextUpgradeStaysInBand` enforces every purchase landing
between 8 and 90 seconds, with total drift between 1.1× and 3.0×. Retune any
growth rate in isolation and that test is what catches it.

## 6. Balance problems found by playing it headlessly

`IronholdTune` runs a five-minute session with a scripted player and reports
what happened. Every one of these was found that way, not by reading the code.

**The arena was empty.** One enemy on screen at a time. Spawn count was below
kill rate, so a crowd never formed — and a crowd is the point, since the sword
arc hits several at once. Spawns per wave: 5 → 24.

**The first fight took eleven seconds.** Enemies spawned 620–760 units out and
walked in at 62/s. For a game that has to prove itself in the opening seconds,
that is a dead start. The ring came in to 420–520, enemy speed went to 100, and
wave 1 spawns at 55% of that radius — on-screen and immediate. First kill is now
3.7s.

**Pressure outran the player.** Spawn count grew at 1.18×/wave while player
power grew slower — an unwinnable race by the mid-game. Spawn growth dropped to
1.11×, below power growth. (This is what created the spawn-limited income
problem in section 5; the two are linked, and tuning one without the other
reopens a hole.)

**The carry loop silently did not exist.** The most valuable thing the harness
found. The bank sat at the centre of the arena, which is also where the hero
spawns, respawns, and fights. Every token auto-banked the instant it was picked
up. The hero never carried anything anywhere — the entire premise of the genre
was absent, and nothing in the code was wrong.

The fix: the centre is neutral ground, and all seven deposit stations sit on a
ring around it. Every deposit is now a deliberate trip, and choosing *which*
station to walk to is the moment-to-moment decision the game is built on.
`SimulationTests.testHeroDoesNotSpawnOnADepositStation` makes sure it cannot
regress.

**Dying every twenty seconds.** 15 deaths in five minutes for a player who never
dodges. The genre is forgiving by design — a death is a pacing beat, not a
punishment. Health went to 150, invulnerability after a hit to 0.55s, and
passive regeneration to 3.5/s.

**Crowds collapsed into a single stack, and the code that should have stopped
it was already there.** I had written down that enemies "do not push each other
apart." That was wrong — a separation force had existed since the first commit.
It could not work, for two compounding reasons.

The push was added to the pursuit heading and the sum was then *normalised*:

```swift
desired += push * (separationStrength / speed)
velocity = desired.normalized * speed          // magnitude thrown away
```

Normalising discards the push's magnitude entirely, so no matter how large
`separationStrength` grew it could only ever *rotate* an enemy — never slow its
approach, never hold it at a distance. Turning the strength up did nothing,
which is presumably why it read as absent.

Fixing that alone still failed the test at 0.63 overlap, because of the second
reason: **steering cannot clear a pile.** An enemy in the middle of one gets
pushed from every side at once, those pushes cancel to nearly zero, and it
keeps driving inward while the crowd closes over it. Separation is now a
velocity added *after* pursuit is scaled to full speed, and a positional
relaxation pass moves overlapping bodies apart directly, weighted by size so a
boss shrugs off minions instead of being herded by them.

`SimulationTests.testCrowdedEnemiesDoNotStackOnTopOfEachOther` holds the line
on both properties: no pair more than half sunk into each other, and the crowd
occupying real area rather than one point. The second assertion is the one that
matters — the first can pass on a crowd that is merely *thin*.

The lesson worth keeping: a feature that exists in the code and does nothing is
harder to find than one that is missing, because reading the code confirms it
is handled. Only playing it, or testing the property rather than the presence,
catches it.

### Where it landed

```
first kill      3.7s
first tower     13.7s
towers built    5
upgrades bought 21
waves reached   9
deaths          10
tokens earned   2187
```

10 deaths still reads high, but that is a bot that never dodges and stands still
whenever it is not commuting — a genuine worst case. Worth re-checking against a
real player before touching survivability again.

## 7. Coins, boons, and a beat before the bell

Three additions, all constrained by the same rule: the economy in section 5 was
measured, so nothing here is allowed to quietly move it.

**Denominations.** Kills used to pay in identical chips. They now pay in four
tiers — SAT 1, ETH 2, SOL 5, BTC 10 — decomposed greedily, largest first. The
total a kill pays is *exactly* what it paid before; this is making change, not
extra income, which is what lets every pacing number above stand.

Two constraints fell out of the design rather than being imposed on it. A
denomination of 1 has to exist or greedy change cannot always land exactly. And
the largest coin has to fit an *unupgraded* satchel, because coins are picked up
whole — a coin bigger than base capacity could never be collected at all.
`EconomyTests` asserts both, plus exact change across every amount from 0 to
20,000.

Picking up whole rather than partially is the interesting half. Nibbling a
10-coin down to 3 would leave a BTC on the floor worth the same as a SAT, and
the denomination would stop meaning anything. Instead a coin too big for the
satchel is left lying there — which is the clearest argument the Satchel upgrade
can make, and it costs no tutorial text.

Rarity is emergent, not rolled: a three-token drop *cannot* contain a BTC, and a
two-hundred token drop *must*. Late waves and bosses therefore produce visibly
better coins without a separate loot table.

**Power-ups.** Frenzy, Magnet, Greed, Bulwark and an instant Surge, spawning on
a 16–26 second timer around the hero. They exist because the loop is otherwise
very even: hero power only ever changes at a deposit station, so a run has no
spikes. Each of these is a spike, and each pulls the player somewhere they were
not already going.

Greed is the only one that touches income, and it is safe for a specific
reason: the pacing guardrail measures a *ratio* between early and late
purchases, so a uniform income lift shifts every time down together and leaves
the drift untouched. The tuned curve stays the floor; this is upside on top of
it. The headless bot never detours to collect one, which means the measured
numbers in section 5 remain a genuine floor rather than an average.

Multipliers apply to the upgraded value, not in place of it, so a boon is worth
the same proportion whatever the build looks like — and the game's own limits
still bind: `testFrenzyCannotSwingFasterThanTheMinimumInterval` pins that.

**The countdown.** Three seconds before wave 1, with the hero already free to
move and nothing spawning. It is not a pause for its own sake: it is the only
moment the player can see where the bank is and where the plots are without
something chasing them. It runs once — `testCountdownDoesNotRepeatBetweenWaves`
pins the exact tick sequence — and the balance harness sets it to zero so its
timings stay comparable to the runs recorded above.

## 8. How it looks, and why it didn't

The first playable build was flat discs on a grid, and it read as badly as
that sounds. Screenshotting it in Chromium made three separate causes
obvious, none of which were about art:

**The camera was twice as far out as it should have been.** The short screen
edge showed 780 world units, which put the hero at 26 pixels across on a
phone — about 6% of the screen width. The genre sits nearer 10%. Dropping to
520 changed more than any drawing change did: the station ring now fits on
screen, so the loop is legible without moving.

**Nothing was lit.** A flat-filled circle reads as a hole punched in the
floor. Every body is now a vertical gradient with a rim on the lower arc and
one specular highlight, and everything that touches the ground gets a soft
contact shadow. Same shapes, but they sit *on* the floor instead of in front
of it.

**Towers were circles.** They are now drawn as structures rising from their
ground point, with a parapet that overhangs the shaft and one course line per
level — so a tower's level is readable from its silhouette without reading
the label. Faking height like this is the whole difference between a tower
and a green dot.

Smaller things that each turned out to matter: the sword is drawn rather than
implied, with a crossguard clear of the body and parallel sides (a blade that
tapers all the way from the hand reads as a needle); the floor has hashed
flagstones so movement has texture to cross; enemies get a per-instance tint
and a hard outline, because identical fills turn a crowd into one pink mass;
and only the *nearest* empty plot is tagged BUILD, since six labels at once
is noise.

Cost was watched throughout — a canvas-call counter runs in the headless
harness. The first pass hit ~7,800 calls per frame with a swarm on screen,
almost all of it loose tokens carrying a gradient shadow and an additive
bloom each. Viewport culling plus a flat shadow on ground tokens brought it
under 4,000. The bloom budget went to the stack above the head instead, which
is the read that actually matters.

## 9. What persists, and what deliberately does not

The browser build saves the things you *bought* — upgrade levels, tower levels,
the bank — and nothing else. The wave you reached, the enemies on the field and
the coins in your satchel all reset.

That split is a design choice, not a shortcut. Restoring a run mid-fight would
make reloading the page a way to escape a bad wave. And dropping a returning
player straight back into wave 40 is a worse opening than wave 1 with the towers
they earned still standing — the towers are the reward, and starting a fresh
wave 1 next to them is the moment that shows it.

The save is validated rather than trusted: every value is coerced to an integer
and clamped to a sane range, an unknown version is ignored, and anything
unparseable starts a clean run. Six corrupt payloads — wrong types, junk text,
a bare `null`, negative and `1e308` values, an array where an object belongs —
were each seeded before page load and each produced a clean, finite world. The
whole path also degrades silently when storage throws, which is the normal case
in private browsing and some embedded frames.

**Offline earnings are missing on purpose.** Paying out for time away needs an
income rate, and that rate has to survive the pacing model in section 5 — a
wrong number there quietly breaks the curve the entire economy is tuned around,
in the direction that is hardest to notice. It belongs with that model and its
guardrail test, not bolted onto the save file. This is the genre's other
retention pillar and it is still a gap; it is just not a gap worth filling
carelessly.

## 10. Architecture

`IronholdCore` has no SpriteKit, UIKit, or SwiftUI in it. The whole game —
combat, economy, wave pacing — is plain Swift that builds and tests on Linux,
which is how the balance work above was possible without a device.

The simulation never draws or plays audio. It reports what happened through
`SimEvent`, and the rendering layer decides how to present it. That boundary is
what makes a five-minute session testable in 30 milliseconds.

Given a seed and an input sequence, a run is reproducible — the balance tests
depend on it.

## 11. Known gaps

- No offline progression, the genre's other retention pillar. Section 9 says
  why it is absent rather than merely unfinished.
- Persistence is browser-only; the Swift core has no save/load.
- Towers are stat-based by choice: fixed plots, the decision is which to build
  and when to level. The spatial alternative — towers that hold ground and let
  you push out, as in Kingdom — is the more interesting design and remains
  unexplored here.
- One enemy type plus a boss variant.
- No audio. `GameModel.playCollect()` is the hook, deliberately silent: firing a
  haptic per token would buzz continuously during a swarm.
- The SpriteKit layer has never been compiled. See the README.
- **Everything since the first build landed in the browser only** — the second
  visual pass, coin denominations, power-ups, the countdown and persistence.
  The SpriteKit renderer has the camera distance and nothing else, so on iOS
  the game still looks and plays like the first version. The *simulation*
  changes (separation, denominations, power-ups, countdown) are all in
  `IronholdCore` and tested, so the iOS build inherits those; it is the
  rendering and the save layer that lag.
- ~~Enemies do not push each other apart~~ — this was wrong. Separation was
  there all along; it just could not work. See section 6.
- `web/index.html` duplicates the simulation in JavaScript so the game is
  playable without a Mac. Its behaviour was verified against the Swift core
  (first kill 3.9s vs 3.7s, first tower 13.2s vs 13.7s, same wave and death
  counts), but the two implementations can drift and nothing enforces that they
  don't. `Balance.swift` is the source of truth.

## Sources

- [XP Hero on the App Store](https://apps.apple.com/us/app/xp-hero/id6740618570)
- [XP Hero data overview — AppMagic](https://appmagic.rocks/google-play/XP+Hero/io.supercent.weaponrpg/)
- [Arcade Idle: analysing the trending hybrid casual genre — Udonis](https://www.blog.udonis.co/mobile-marketing/mobile-games/arcade-idle)
- [Arcade Idle: a new hybridcasual genre — Homa Games](https://www.homagames.com/blog/arcade-idle-a-new-hybridcasual-genre-enters-the-game)
- [How to make an arcade idle game — Mind Studios](https://games.themindstudios.com/post/how-to-make-arcade-idle-game/)
- [Deconstruction of Alien Invasion — PlayDucky](https://playducky.com/recentpress/deconstruction-of-alien-invasion)
- [The Math of Idle Games, Part I — Kongregate](https://blog.kongregate.com/the-math-of-idle-games-part-i/)
- [Archer tower — Kingdom Wiki](https://kingdomthegame.fandom.com/wiki/Archer_tower)
- [Cooldown — Vampire Survivors Wiki](https://vampire.survivors.wiki/w/Cooldown)
