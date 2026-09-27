# Pokémon Card Scanner

Scan a Pokémon card with your camera (or upload a photo) and the Pokémon appears as an animated 3D model you can rotate.

## Running

```sh
npm install
npm run dev          # https://localhost:5190 and your network address (open that one on your phone)
npm run dev:http     # plain HTTP, for desktop-only work
npm test
npm run build
```

Phones, iOS especially, only allow live camera access on HTTPS pages, so `npm run dev` serves HTTPS with a self-signed certificate. Each device shows a warning the first time; accept it to continue (on iOS: **Show Details → visit this website**). If the page is opened over plain HTTP, **Scan** explains that it needs the https:// address; **Upload** still works.

## Deploying

The site is hosted on Firebase Hosting (project `pkmn-card-scanner`): **https://pkmn-card-scanner.web.app**

```sh
npm run deploy   # builds, then uploads dist/ to Firebase Hosting
```

This needs the Firebase CLI logged in to an account with access to the project (`firebase login`).

## How it works

1. **Read the card name.** [Tesseract.js](https://github.com/naptha/tesseract.js) OCRs the title band at the top of the card. Several crop and scale settings run and vote on the result, because no single setting reads every card design. (`src/recognize.ts`)
2. **Match it to a Pokémon.** The OCR text is fuzzy-matched against all 1,025 species from the [Pokémon 3D API](https://github.com/Pokemon-3D-api). Title words pick the form: Alolan, Galarian, Hisuian or Paldean; Mega or "M"; VMAX (shown as the G-Max model); Primal; Origin; Heat Rotom; Black Kyurem; and so on. Radiant and Shining cards show the shiny model. "Evolves from X" text is ignored, except on VMAX/VSTAR cards, where "Evolves from X V" names the same Pokémon and is used as a backup. (`src/match.ts`)
3. **Show it in 3D.** PixiJS draws the scene: glow, particles and burst rings, tinted by the card's type. three.js loads the Draco-compressed glTF model into an offscreen canvas, and Pixi composites it as a sprite. Drag sideways to rotate; scroll or pinch to zoom. (`src/stage.ts`)
4. **Animations.** Each model's clips get readable names, for example `pm0149_00_00_00030_walk01_loop` becomes "Walk". Play any clip from the row of buttons, or use **Play all** to run through every one. Walk and run clips are pinned in place, so the Pokémon doesn't walk off stage. Models with no idle clip hold a natural pose with a gentle breathing motion. Rigged models that ship without any animation have their T-posed arms lowered; wings, fins and arms meant to be outstretched are left alone. (`src/animations.ts`, `src/pose.ts`)
5. **Card details.** [TCGdex](https://tcgdex.dev) finds the printed card by name and HP, which gives its type, set and artwork; the gallery lists every card printed for the Pokémon with a holo effect matched to its rarity. If TCGdex is unreachable, [pokemontcg.io](https://pokemontcg.io) is used instead; it also provides the sharpest scans. (`src/cards.ts`, `src/gallery.ts`, `src/holo.ts`)
6. **Cries.** Each Pokémon's cry from [PokeAPI/cries](https://github.com/PokeAPI/cries) plays when it appears (the speaker button top-right mutes this; the Cry button replays it). Browsers that can't decode Ogg Vorbis get a small WebAssembly decoder on demand. (`src/cry.ts`)

If the name can't be read, type it in the search box instead.

## Known limitations

- **English cards only.** The OCR model and name list are English.
- **Some models don't exist yet.** The 3D API lists some models that were never uploaded, including most shinies, some Gen 8–9 Pokémon and some regional forms. The app checks against the real file list and falls back to the base model, or says there's no model yet.
- **Paldean Tauros breeds and some other forms can't be told apart from the card title.** The first matching form is shown.
- **The Pokémon 3D API runs on a free host that sleeps.** The first load can take up to a minute. Results are cached in the browser for a week.
- **163 of the Pokémon and forms have animations.** 53 of them have full game sets (39 or more clips: walk, run, attacks, sleep, …), 39 have a handful, and 71 have a single clip. The rest are still poses.
- **Very stylised titles are hard for OCR**, such as some full-art cards. Good light, no glare, and the name inside the yellow band help most.
