# Evenwave

Detects YouTube videos whose audio only plays on one side and routes the live channel into both ears — with a quick 5-second on-page heads-up the moment it kicks in.

## Install

1. `chrome://extensions` → turn on Developer mode.
2. Load unpacked → pick this folder.
3. Open a YouTube video and click the extension icon.

## How it works

```
<video> → MediaElementSource → ChannelSplitter ─┬→ AnalyserNode L ┐ measure
                                                └→ AnalyserNode R ┘
                                                ↓
                                 4 GainNodes (2×2 matrix) → ChannelMerger → speakers
```

Every 200 ms it takes the RMS of each channel. If one side stays below 6% of the
other for ~3 seconds while there is actual signal, it flags that side as dead and
sets the gain matrix to copy the live channel into both outputs. Gains ramp with
`setTargetAtTime`, so switching is silent. When normal stereo returns, it reverts.

The moment it flags a side, a small branded toast slides in from the top-right of
the page for 5 seconds (click it to dismiss early): "Fixed it" when Automatic just
applied the fix, or a nudge to turn Automatic on if the extension is currently Off.
Manual modes (Mono / Use left / Use right) stay quiet since you're already steering it.

## Modes

- **Automatic** – fix only when one-sided audio is detected.
- **Mono** – always sum both channels (0.7 each) into both ears.
- **Use left / Use right** – manual override when detection is unsure, e.g. one
  channel is very quiet rather than truly silent.
- **Off** – pass through untouched. (The audio still flows through the graph.)

## Known limits

- Only fixes audio that is one-sided *in the file*. A Windows/macOS balance
  slider, a dead earbud, or a broken jack is upstream of the browser and can't be
  corrected here.
- Genuine hard-panned stereo (some live recordings, old rock mixes) can trip
  detection. Raise `SILENT_RATIO` / `CONFIRM_TICKS` in `content.js` or use Off.
- `createMediaElementSource` can only be called once per element, so this may
  conflict with other audio extensions (volume boosters, equalizers) on the same tab.
- Mono mode adds ~3 dB when content is already centered; drop the 0.7 values to
  0.5 if you hear clipping.
- Extend to other sites by adding hosts to `matches` in `manifest.json` — the
  content script itself is site-agnostic, it just grabs the first `<video>`.
