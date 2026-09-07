# Void Salvage

A canvas twin-stick survival shooter. No build step, no libraries, no network
calls -- three files and a browser.

**Play it:** https://zachhippo.github.io/void-salvage/

## Controls

| Action | Input |
| --- | --- |
| Move | `W` `A` `S` `D` or arrow keys |
| Aim | mouse |
| Fire | click, or hold to keep firing |
| Gravity pulse | `E`, once the pulse bar is full |
| Pause | `P` or `Esc` |
| Restart | `R` or click, after you die |

## How it plays

Survive. Enemies stream in from the edges of the screen and get faster, tougher
and more varied the longer you last. Every kill drops salvage orbs -- collect
them to charge the gravity pulse, which clears out everything around you.

## The enemies

| Enemy | Behaviour |
| --- | --- |
| **Drifter** | Pink shard. Straight-line chase. The baseline threat, present from the start. |
| **Darter** | Green dart. Fast and fragile, weaves as it closes, so it is hard to lead. Appears from 15s. |
| **Spitter** | Orange ring. Keeps its distance and shoots at you instead of ramming. Appears from 35s. |
| **Brute** | Purple hex. Slow and heavy: it survives a ram and shoves you clear, survives the gravity pulse, and splits into two Drifters when it finally goes down. Appears from 55s. |

Threat level ticks up every 20 seconds. Spawn rate and enemy stats ramp over the
first 60-90 seconds, so early runs are quiet and late ones are not.

## Local use

Open `index.html` directly, or serve it over HTTP:

    powershell -ExecutionPolicy Bypass -File _serve.ps1

then visit <http://localhost:5500>.

High scores live in `localStorage`, per browser. Some browsers block storage on
`file://` pages, so scoring falls back to memory for the session there -- serve
it over HTTP (or use the Pages link above) if you want your best run to stick.
