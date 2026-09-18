# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Evenwave: a Manifest V3 Chrome extension that detects media whose audio only
plays in one channel and routes the live channel into both, with a 5-second
on-page toast when it kicks in. A fixed list of video/audio sites (YouTube,
Twitch, Kick, Vimeo, Dailymotion, SoundCloud) is covered out of the box; any other
site is opt-in per host from the popup. Plain JS/HTML/CSS, no bundler, no
npm dependencies for the runtime code.

Standard flat MV3 layout — `manifest.json` and the shipped files sit at the
repo root (what "Load unpacked" and the store zip both expect), `icons/`
holds only the four shipped sizes, and nothing else ships:
- `manifest.json`, `content.js`, `popup.html`, `popup.js`, `icons/` — the
  extension itself. This is exactly the `SHIP` list in the `Makefile`.
- `background.js` — service worker; registers/unregisters the content script
  when a site permission is granted or revoked.
- `Makefile` — the only build tooling. Plain shell, no Python, no npm.
- `docs/*.png` — README screenshots only.
- `brand/icon512.png` — 1024px icon master (store listing art), not
  referenced by the manifest, never shipped.
- `dist/` — build output only (gitignored). Never edit by hand, regenerate
  with `make`.
- `.github/workflows/release.yml` — builds and attaches the zip to a GitHub
  Release whenever a `v*` tag is pushed.

## Commands

- `make build` — copies `SHIP` into `dist/evenwave/` (unpacked, for
  `chrome://extensions` → Load unpacked).
- `make zip` — build + `dist/evenwave-<version>.zip`, manifest at the
  archive root, ready for the Chrome Web Store dashboard. Version is read
  out of `manifest.json`. Uses `zip`, falling back to PowerShell
  `Compress-Archive` on Windows where `zip` isn't installed.
- `make clean` — removes `dist/`.
- Update the `SHIP` variable if a new top-level file needs to ship.
- The icons in `icons/` are committed; there is no generator any more.
  Edit them by hand (or from `brand/icon512.png`) if the mark changes.
- No lint/test tooling exists. Verification is manual: run `make build`,
  load `dist/evenwave/` unpacked in Chrome, open a YouTube video, and check
  the popup + on-page toast.
- Release: push a tag matching `v*` (e.g. `v1.0.1`) — CI runs `make zip` and
  attaches it to a GitHub Release. It does not publish to the Chrome Web
  Store itself (that needs the CWS Publish API + stored credentials, not
  set up here); upload the release zip to the dashboard manually.

## Architecture

**Two runtime contexts, one shared preference.** `content.js` is injected
into every tab on a built-in site (`content_scripts.matches` in
`manifest.json`), or on an opted-in host via `background.js`, and
does the actual detection/routing. `popup.html`/`popup.js` is the toolbar
action — a thin, mostly stateless viewer/remote for whichever tab is
currently focused. They don't talk directly; state flows through
`chrome.storage.sync` (`{enabled, mode}`, synced across tabs *and* devices)
and a one-shot `'ew:status'` message the popup polls every 400ms.

**Multi-instance, not singleton.** `content_scripts.all_frames` is `true`
and every built-in site is matched as `https://*.<domain>/*`, subdomains
included (e.g. `youtube-nocookie.com` exists specifically for third-party
embeds, `player.twitch.tv`/`player.vimeo.com` likewise — so don't narrow
this to top-frame-only). Every matching
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
on a single quiet moment. The exception is a digitally dead side (raw RMS under
`DEAD_FLOOR`, -100 dBFS): that confirms after `FAST_TICKS` (~1s), since real
stereo mixes, even hard-panned ones, leak reverb/noise into the other channel
and never read that low. Clearing back to stereo always takes the full ~3s.

`pickMedia()` prefers whatever is actually playing over the first element in
the DOM — off YouTube a page often holds several idle `<video>`/`<audio>`
nodes (previews, hidden players, ad slots). `attach()` re-runs on every SPA navigation (YouTube swaps `<video>` elements
without a full page load; polled every 1s). It must call `teardownChain()`
on the old chain before building the new one — the old chain's nodes stay
wired to `ctx.destination` otherwise and never get freed, since
disconnecting the media source alone doesn't touch the rest of the graph.

**Toast notifications** are a closed shadow DOM host appended to
`document.documentElement`, built entirely inline in `content.js` (no
`web_accessible_resources` entry) so nothing is exposed for the host page to
fingerprint. Clicking one sends `'ew:openPopup'` to `background.js`, which calls
`chrome.action.openPopup()` (Chrome 127+; content scripts can't reach
`chrome.action` themselves). They fire only on `auto` mode when a new side is detected, or
as a nudge when detection fires while the extension is `off`; manual modes
(`mono`/`left`/`right`) stay quiet since the user is already steering it.

**Permissions**: `storage`, `scripting`, `activeTab`, plus
`host_permissions` for the built-in sites and `optional_host_permissions`
for `*://*/*`. Built-in sites are a static `content_scripts` entry so they
work across every open tab without a click. `host_permissions` and
`content_scripts[0].matches` must stay identical — the popup derives its
"already covered, don't offer opt-in" list from `host_permissions` alone.
Keep DRM services (Netflix, Spotify, Prime Video, Disney+…) off the list:
see the CORS trap below, it applies to them too. Socials (Facebook,
Instagram, X, TikTok, Reddit) are deliberately opt-in: one-sided audio is
rare there (mostly phone recordings), and "read and change your data on
facebook.com" in the install prompt looks wrong for an audio extension. Everything else is granted
one host at a time: the popup calls `chrome.permissions.request()` inside
the click handler (the prompt only appears on a user gesture), and
`background.js` does the actual `registerContentScripts` + one-off
`executeScript` from `permissions.onAdded`. That split is load-bearing —
Chrome can tear the popup down the instant the prompt opens, so anything in
the `request()` callback may never run. `activeTab` is what lets the popup
read `tab.url` to work out which host to offer.

**The CORS trap**: `createMediaElementSource()` on cross-origin media that
wasn't fetched with CORS silently taints the graph — analysers read exactly
0 and the element goes mute *permanently*, since its audio now flows only
through our nodes and nothing short of a page reload undoes it. So
`tapBlockedReason()` refuses to attach unless the source is `blob:`/`data:`,
same-origin, or carries `crossOrigin` — and refuses anything with
`el.mediaKeys` set, since DRM (EME) audio is never exposed to Web Audio and
mutes the same way, despite arriving as a perfectly same-origin `blob:`. `tick()` keeps a second guard: both
channels reading exactly 0 while playing means tainted anyway (real silence
measures small-but-nonzero), which flips `status.blocked` so the popup can
tell the user to reload.

## Branding

The gradient (`#2d64ff` -> `#8c3cf0`) and the waveform+knob mark are
duplicated in three independent places with no shared source of truth —
update all three together if the palette or mark changes:
- `icons/` + `brand/icon512.png` (the PNG icon set and its master)
- `popup.html` (inline `<style>`, wordmark + active-button gradient)
- `content.js` (inline SVG string for the toast icon, `LOGO_SVG`)

Internal naming convention is `ew`/`evenwave` (`window.__evenwaveLoaded`,
`el.__ewSrc`, the `'ew:status'` message type, `#evenwave-toast-host`) —
keep it consistent if the product is ever renamed again.
