# README GIFs

Sources for `../hero.gif` and `../approve.gif`. Both are rendered frame by
frame with Playwright and turned into GIFs with ffmpeg.

- `hero.html` is a scripted scene (not a screen recording): `render(t)` draws
  the frame at `t` seconds.
- `approve.gif` uses the real approval pages from a local `wrangler dev`,
  shown in a phone frame (`stage.html`).

```bash
# hero.gif
node frames.cjs hero.html hero-frames 12 2 960 540
ffmpeg -framerate 12 -i hero-frames/f%04d.png -vf palettegen=max_colors=64:stats_mode=full pal.png
ffmpeg -framerate 12 -i hero-frames/f%04d.png -i pal.png -lavfi paletteuse=dither=none -loop 0 ../hero.gif

# approve.gif: with `npm run dev` running on :8787 and fresh local state
node seed.mjs
node approve.cjs
ffmpeg -framerate 12 -i approve-frames/f%04d.png -vf palettegen=max_colors=96:stats_mode=full pal.png
ffmpeg -framerate 12 -i approve-frames/f%04d.png -i pal.png -lavfi paletteuse=dither=none -loop 0 ../approve.gif
```

Frame folders and `pal.png` are scratch files; do not commit them.
