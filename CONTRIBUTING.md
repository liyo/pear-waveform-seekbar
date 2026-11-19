# Contributing to Waveform Seekbar

Thanks for your interest! This is a plugin for
[Pear Desktop](https://github.com/pear-devs/pear-desktop) (an Electron/TypeScript
fork of YouTube Music). Bug reports, ideas, and pull requests are all welcome.

## Reporting bugs / requesting features

Open an issue with:

- Your OS and Pear Desktop version.
- What you did, what you expected, and what happened.
- For rendering bugs, a screenshot helps a lot, plus the output of
  `window.__waveformDebug` from the DevTools console.

## Development setup

The plugin only builds *inside* Pear Desktop, so you develop against a checkout
of the app.

1. Fork and clone this repo.
2. Clone Pear Desktop next to it:
   ```bash
   git clone https://github.com/pear-devs/pear-desktop
   cd pear-desktop
   corepack pnpm@latest install   # needs pnpm >= 12
   ```
3. Copy the plugin into the app (a real copy — a symlink/junction breaks the
   plugin loader):
   ```bash
   mkdir -p src/plugins/waveform-seekbar
   cp /path/to/pear-waveform-seekbar/{index,lib,backend}.ts \
      /path/to/pear-waveform-seekbar/style.css \
      src/plugins/waveform-seekbar/
   ```
   Re-copy whenever you edit the plugin.
4. Run it:
   ```bash
   pnpm dev      # hot-reloading dev build
   # or: pnpm build && pnpm start
   ```
5. Enable **Plugins → Waveform Seekbar** in the app.

From the Pear Desktop checkout, type-check, lint, and format the plugin (the app
has unrelated pre-existing TS errors, so filter type-check output):

```bash
node_modules/.bin/tsc -p tsconfig.json --noEmit 2>&1 | grep waveform-seekbar
node_modules/.bin/oxlint --type-aware src/plugins/waveform-seekbar   # must be clean
node_modules/.bin/oxfmt --check src/plugins/waveform-seekbar         # must be clean
```

> Note on style: `oxfmt` strips "redundant" parentheses while `oxlint`'s
> `no-mixed-operators` rule asks for them, so prefer intermediate variables (or
> parentheses that change precedence) over `a + b * c`-style expressions — that
> keeps both tools happy.

## Pull requests

1. Branch off `main`: `git checkout -b fix/short-description`.
2. Keep changes focused; match the existing code style (2-space indent, single
   quotes, no `any`).
3. Make sure the plugin type-checks, lints, and formats cleanly (commands above),
   builds, and that `npm test` passes.
4. Describe the change and how you tested it. Screenshots/GIFs for visual changes.
5. Open the PR against `main`. By contributing you agree your work is licensed
   under the repo's [MIT license](LICENSE).

## Tests

The pure logic lives in `lib.ts` and is unit-tested with [vitest](https://vitest.dev):
the audio / colour maths (init-segment detection, RMS + 3-band analysis, the
Rekordbox-RGB colour mapping, timeline mapping) in `lib.test.ts`, and the progressive
capture bookkeeping (append routing, run rollover at the byte cap, which run to decode
next, continuation placement, when chunks can be freed) in `runs.test.ts`, including a
simulation of a long track.

```bash
npm install
npm test        # or: npm run test:watch
```

`lib.ts` has no DOM/Web-Audio imports, so the tests run standalone. Add a case for any
change to that logic. What can't be unit-tested — real MSE appends, `decodeAudioData`,
`video.buffered` — has to be checked in the running app; `window.__waveformLog = true` in
DevTools prints `[WF]` diagnostics (runs, placement, coverage).

## Code layout

- `index.ts` — the plugin (config, menu, renderer: capture + decode + draw).
- `lib.ts` — pure, unit-tested maths (`looksLikeInitSegment`, `analyzeBucket`,
  `computeFullPeaks`, `bandColor`, timeline mapping).
- `backend.ts` — main-process audio fetch for the optional full-waveform mode
  (PoToken-authed Innertube; tree-shaken out of the renderer bundle).
- `style.css` — the injected stylesheet (canvas positioning, hides the native
  progress bar).

There's no build step in this repo itself; the app compiles it.
