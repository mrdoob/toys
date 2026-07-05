# Toys

A little toy maker. Snap wooden pieces together, make parts spin, then switch to Play and watch your toys come alive.

https://mrdoob.github.io/toys/

## How to play

**Build** — Drag pieces from the palette onto the floor or onto your toy. Click a piece to select it: drag the orange handles to resize, `S` to make it spin, drag the teal pin to move the spin axis, `D` to duplicate onto the opposite side, `delete` to remove. Drag pieces to re-attach them, or drag the base piece to move the whole toy.

**Play** — `space`. Toys drop onto the floor and their motors start. Click a toy to focus the camera, `R` to reset. The eye in the toys list picks who's on stage.

**Share** — Records a five second clip and copies a link with the toys encoded in the URL. Everything is also saved to localStorage as you build.

## Tech

- [three.js](https://threejs.org) — WebGPURenderer, TSL wood material, GTAO
- [box3d.js](https://github.com/isaac-mason/box3d.js) — physics
- WebCodecs and the three.js editor's MP4 muxer — video export
