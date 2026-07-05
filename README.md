# Clanker Wars

Build wacky battle bots out of wood and steel, pick their armour, weapons and driving style — then drop them in the arena and let them fight. Nobody drives; the bots run on seeded instinct, so the same seed replays the same battle and a new seed plays out differently.

A fork of [mrdoob/toys](https://github.com/mrdoob/toys).

## How to play

**First visit** — hit **See sample bots fight** and watch two of the house bots go at it, or **Build your own**. The five sample bots land in your garage either way as starting points.

**Build** — Drag pieces from the palette onto the floor or onto your robot. Chassis pieces (block, plank, wheel, ball, wedge) hold you together; weapons (bar, saw, spike, mace) do the damage — especially when spinning. Click a piece to select it: drag the orange handles to resize, `S` to make it spin, `A` to cycle armour (wood → steel → titanium), drag the teal pin to move the spin axis, `D` to duplicate onto the opposite side, `delete` to remove. The card at the bottom left shows your bot's name, weight and AI style (Brawler / Circler / Skirmisher).

**Strategy** — armour is a trade: titanium is ~4× tougher and hits ~1.6× harder, but it's heavy, and weight drags down your top speed. Wood is light and fast but it *burns*. Damage grows with impact speed and the mass behind the blow, so a slow heavy wedge and a light whirling saw are both viable. Lose a piece and everything bolted to it snaps off too. Lose your chassis and the whole bot lets go of itself.

**Battle** — `space`. Flag which bots fight with the ⚔ toggle in the garage list (a lone bot gets a house opponent). Ways to lose: ground past the damage limit, chassis destroyed, counted out while immobile, thrown **out of the arena**, or the judges' decision at the timer. Two arena walls bite. `R` rematches on the same seed; the seed button rerolls it.

**Share** — Records a five-second clip of the fight and copies a link with the roster encoded in the URL. Everything is saved to localStorage as you build.

**Community** — Publish your bots (no login — a random key minted per browser marks what's yours) and import what other people made public.

## Deploying (Vercel + Postgres)

The app is static files plus two serverless functions under `api/`. To deploy:

1. Push this repo to GitHub and import it into [Vercel](https://vercel.com) (no build step, no config needed).
2. Add a Postgres database — Vercel Marketplace → **Neon** (or any Postgres integration that sets `POSTGRES_URL`).
3. That's it. The `robots` table creates itself on first request.

Without a database everything still works; the Community panel just reports itself offline.

Local dev: `vercel dev` (with the database env pulled via `vercel env pull`), or any static server (`npx serve .`) if you don't need the API.

## Tech

- [three.js](https://threejs.org) — WebGPURenderer, TSL wood material, GTAO
- [box3d.js](https://github.com/isaac-mason/box3d.js) — physics: every rigid assembly is one body, every spinner a motorised hinge; parts that break off become debris bodies mid-fight
- WebCodecs and the three.js editor's MP4 muxer — video export
- `@vercel/postgres` — the community garage
