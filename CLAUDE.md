# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Evenwave: a Manifest V3 Chrome extension that detects YouTube videos whose
audio only plays in one channel and routes the live channel into both, with
a 5-second on-page toast when it kicks in. Plain JS/HTML/CSS, no bundler, no
npm dependencies for the runtime code.

- `extension/` — the canonical, current source (what actually ships).
- `files.zip` — the original delivered archive, kept for provenance. Not
  kept in sync with `extension/`; don't treat it as a source of truth.
- `dist/` — build output only (gitignored). Never edit by hand, regenerate
  with `build.py`.

## Commands

- `python build.py` — packages `extension/` into `dist/evenwave/` (unpacked,
  for `chrome://extensions` → Load unpacked) and `dist/evenwave-<version>.zip`
  (manifest at the archive root, ready to upload to the Chrome Web Store
  dashboard). Excludes dev-only files (`icons/make_icons.py`,
  `icons/icon512.png`).
- `python extension/icons/make_icons.py` (run from `extension/icons/`) —
  regenerates `icon16/32/48/128/512.png` from the gradient/bar spec in that
  script. Needs Pillow + numpy. Run this after changing the brand palette or
  mark, not part of the normal build.
- No lint/test tooling exists. Verification is manual: run `build.py`, load
  `dist/evenwave/` unpacked in Chrome, open a YouTube video, and check the
  popup + on-page toast.

## Architecture

**Two runtime contexts, one shared preference.** `content.js` is injected
into every YouTube tab (`content_scripts.matches` in `manifest.json`) and
does the actual detection/routing. `popup.html`/`popup.js` is the toolbar
action — a thin, mostly stateless viewer/remote for whichever tab is
currently focused. They don't talk directly; state flows through
`chrome.storage.sync` (`{enabled, mode}`, synced across tabs *and* devices)
and a one-shot `'ew:status'` message the popup polls every 400ms.

**Multi-instance, not singleton.** `content_scripts.all_frames` is `true`
and `host_permissions` covers `youtube.com`/`m.youtube.com`/
`youtube-nocookie.com` broadly (the nocookie domain is specifically for
third-party embeds, so don't narrow this to top-frame-only). Every matching
frame in every matching tab runs its own independent copy of the script with
its own `AudioContext` and gain-node graph — there is no cross-tab or
cross-frame coordination. Because of this, the `'ew:status'` message
listener only calls `send()` if this frame actually has a video attached
(`chain` is truthy); other frames (ads, embeds) return `false` instead of
responding. This is load-bearing: `chrome.tabs.sendMessage` from the popup
has no `frameId`, so if more than one frame answered it'd be a race and an
irrelevant frame could stomp the real player's status.

**Audio graph** (built in `attach()`):
```
<video> -> MediaElementSource -> ChannelSplitter -> AnalyserNode L/R (measurement only)
                                                   -> 4 GainNodes (ll/lr/rl/rr) -> ChannelMerger -> destination
```
The 2x2 gain matrix is how routing actually happens — `applyRouting()` just
picks one of four `[ll, lr, rl, rr]` presets per mode and ramps to it with
`setTargetAtTime` (`auto`/`mono`/`left`/`right`/`off`, see the table there).
Detection (`tick()`) is independent of mode: EMA-smoothed RMS per channel,
a quiet/loud ratio threshold (`SILENT_RATIO`), and a hit-counter hysteresis
(`CONFIRM_TICKS`, ~3s) before flagging or clearing a side, so it never flaps
on a single quiet moment.

`attach()` re-runs on every SPA navigation (YouTube swaps `<video>` elements
without a full page load; polled every 1s). It must call `teardownChain()`
on the old chain before building the new one — the old chain's nodes stay
wired to `ctx.destination` otherwise and never get freed, since
disconnecting the media source alone doesn't touch the rest of the graph.

**Toast notifications** are a closed shadow DOM host appended to
`document.documentElement`, built entirely inline in `content.js` (no
`web_accessible_resources` entry) so nothing is exposed for the host page to
fingerprint. They fire only on `auto` mode when a new side is detected, or
as a nudge when detection fires while the extension is `off`; manual modes
(`mono`/`left`/`right`) stay quiet since the user is already steering it.

**Permissions are deliberately minimal**: `storage` only. No `activeTab` —
`host_permissions` already grants persistent access to the YouTube origins,
and the extension must keep working across every open YouTube tab, not just
the focused one, so `activeTab` wouldn't be sufficient anyway.

## Branding

The gradient (`#2d64ff` -> `#8c3cf0`) and the waveform+knob mark are
duplicated in three independent places with no shared source of truth —
update all three together if the palette or mark changes:
- `extension/icons/make_icons.py` (generates the PNG icon set)
- `extension/popup.html` (inline `<style>`, wordmark + active-button gradient)
- `extension/content.js` (inline SVG string for the toast icon, `LOGO_SVG`)

Internal naming convention is `ew`/`evenwave` (`window.__evenwaveLoaded`,
`el.__ewSrc`, the `'ew:status'` message type, `#evenwave-toast-host`) —
keep it consistent if the product is ever renamed again.
