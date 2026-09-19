# Void Salvage

A bullet-hell boss rush on a canvas. One ship against bosses built from blocks:
shred the armour, expose the core, blow it, then spend the salvage in the hangar
before the next fight. No build step, no libraries, no network calls.

**Play it:** https://zachhippo.github.io/void-salvage/

## Controls

| Action | Input |
| --- | --- |
| Move | `W` `A` `S` `D` or arrow keys |
| Aim | mouse |
| Fire | click, or hold to keep firing |
| Pulse | `E`, once the pulse bar is full |
| Rocket | right-click or `Q` (needs the Rocket Pod upgrade) |
| Pause | `P` or `Esc` |
| Fullscreen | `F`, or the button on any menu screen |
| Launch (hangar) | `Enter`, or click LAUNCH |
| Reset save (hangar) | `R` |
| Pick level (hangar) | `<` `>` beside FIGHT, or arrow keys |
| Level map (hangar) | the LEVEL MAP button, or `M` |

## The loop

Each level builds a boss out of blocks on a rotating grid. Three kinds:

- **Armour** (purple) -- bulk. It is what seals the core.
- **Guns** (orange) -- each one runs a fire pattern. Destroy it and that pattern
  stops for good, so what you shoot first shapes the whole fight.
- **Core** (cyan) -- shielded by the blocks around it. Tunnel in: any round
  that reaches the core damages it, and once a neighbouring block is gone it
  is exposed to splash and the pulse too. Blow it to clear the level.

Clearing a level for the first time is the only way to earn white crystals.
You can go back and replay any level you have unlocked for more red and blue,
and the bigger the boss, the bigger the payout.

The boss hunts you: it sits and tracks you, charges up while a warning line and
crosshair lock onto your ship, then rams straight
through the spot you were in when the charge ended, and sits again. Move when it lunges. An arrow over its core shows where it is aimed -- white while it sits,
orange while it charges, red while it dashes. Aimed guns lead your movement, so change
direction rather than drifting.

When the core blows, the rest of the boss shatters in a chain reaction and every
drop flies to your ship before the win screen appears. The level map (from the
hangar) shows every level in sectors of five, with each boss previewed, what you
have cleared, what is next, and what a fight pays.

Fights happen inside a glowing ring. Leave it and poison eats your hull, straight
past the shield, until you get back in.

Every block you break pays out salvage. Drops are pulled in once you get close
(Tractor Coil widens the range); collecting them charges the pulse and banks
currency. Once the core dies, every drop flies to you from anywhere. Clearing a level auto-salvages the wreck, so
the core's payout is never stranded -- but **dying only banks what you actually
picked up**, which is the whole risk.

## Gun patterns

They unlock as the levels climb. Every pattern is fixed and repeats, and each
level always builds the same boss, so a barrage can be learned and dodged.

| Pattern | From | Behaviour |
| --- | --- | --- |
| Aimed | 1 | a line of three rounds down one heading -- sidestep it |
| Spread | 3 | a ring of ten that shifts half a gap each volley -- sit in a gap |
| Spiral | 5 | two arms turning at a steady rate -- circle with them |
| Seeker | 7 | two slow homing missiles, launched up and down |
| Laser | 9 | telegraphed beam -- thin line while charging, then it fires |

Bosses grow with the level, and every 5th is a **Guardian**: bigger, more guns,
and roughly double core health.

There are 36 levels. Level 36 is the **Final Boss**: a giant copy of your own
ship built from blocks, with 14 guns and triple core health. Beat it to win the
game; after that every level stays open for replays.

## Upgrades

The hangar is an upgrade tree rooted at FIGHT, with 25 nodes across four branches:

- **Weapons** (up) -- damage, fire rate, bullet speed, split barrel, rocket pod
  (one rocket per fight per level; rockets fly straight), crits, penetrator rounds,
  volatile rounds, and bonus damage to
  gun blocks and cores
- **Defence** (left) -- plating, nanite repair, deflector shields, faster
  recharge
- **Pulse and drones** (right) -- pulse charge rate, radius and damage; turret
  drones plus their fire rate and damage
- **Salvage and engines** (down) -- pickup range, top speed, and refineries
  that raise red, blue and white yields

A node unlocks once its parent has a level. Anything you can afford right now
is highlighted green; owned nodes are gold, maxed ones teal. Hover a node for
its next level and price. Salvage and upgrades persist across runs -- dying
costs you the fight, not the progress.

## Local use

Open `index.html` directly, or serve it over HTTP:

    powershell -ExecutionPolicy Bypass -File _serve.ps1

then visit <http://localhost:5500>.

Progress lives in `localStorage` under `voidsalvage:save:v2`, per browser. Some
browsers block storage on `file://` pages, so a run there scores in memory only
-- serve it over HTTP (or use the Pages link above) if you want it to stick.
