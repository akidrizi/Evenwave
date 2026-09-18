(() => {
  if (window.__evenwaveLoaded) return;
  window.__evenwaveLoaded = true;

  // --- tuning -------------------------------------------------------------
  const TICK_MS = 200;        // how often we measure
  const CONFIRM_TICKS = 15;   // ~3s of consistent evidence before acting
  const FAST_TICKS = 5;       // ~1s when the quiet side is digitally dead
  const DEAD_FLOOR = 1e-5;    // -100 dBFS: "no signal at all", not just quiet
  const SILENT_RATIO = 0.06;  // quiet/loud amplitude ratio that counts as "dead"
  const NOISE_FLOOR = 0.004;  // below this, treat as silence and measure nothing
  const EMA = 0.25;           // smoothing on the per-channel level
  const RAMP = 0.06;          // gain ramp, in seconds, to avoid clicks

  // --- state --------------------------------------------------------------
  let cfg = { enabled: true, mode: 'auto' }; // auto | mono | left | right | off
  let ctx = null;
  let chain = null;
  let media = null;
  let emaL = 0, emaR = 0, hits = 0, deadHits = 0, clears = 0, deadTicks = 0;
  const bufL = new Float32Array(2048);
  const bufR = new Float32Array(2048);

  const status = {
    attached: false,
    playing: false,
    detected: null,   // null | 'left' | 'right'  (side that still has sound)
    applied: 'off',
    level: { l: 0, r: 0 },
    error: null,
    blocked: null     // null | 'drm' | 'cors' | 'reload' -- popup owns the wording
  };

  chrome.storage.sync.get(cfg, (v) => { cfg = v; applyRouting(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, c] of Object.entries(changes)) cfg[k] = c.newValue;
    applyRouting();
  });

  // --- graph --------------------------------------------------------------
  // src -> splitter -> [analysers]
  //                 -> 4 gain nodes (2x2 matrix) -> merger -> destination
  function teardownChain(c) {
    if (!c) return;
    // Otherwise these keep rendering silence into the graph indefinitely —
    // disconnecting the old source alone doesn't free them.
    [c.splitter, c.merger, c.aL, c.aR, c.g.ll, c.g.lr, c.g.rl, c.g.rr].forEach((node) => {
      try { node.disconnect(); } catch (e) { /* already disconnected */ }
    });
  }

  // createMediaElementSource on cross-origin media that wasn't fetched with
  // CORS taints the graph: every analyser reads 0 and the element goes
  // silent, permanently, because its audio now only flows through our nodes.
  // There is no way back without a page reload, so refuse to touch anything
  // we can't prove is readable.
  function tapBlockedReason(el) {
    // DRM (EME) audio is never exposed to Web Audio -- attaching would just
    // output silence with no way to undo it. Only trustworthy once the
    // element has decoded a frame (see attach()), since keys can be set after
    // metadata loads.
    if (el.mediaKeys) return 'drm';
    const url = el.currentSrc || el.src;
    if (!url) return null;                       // nothing loaded yet, try later
    if (/^(blob:|data:|mediastream:)/.test(url)) return null; // MSE/local, same-origin by definition
    if (el.crossOrigin) return null;             // fetched with CORS on purpose
    try {
      if (new URL(url, location.href).origin === location.origin) return null;
    } catch (e) { /* unparseable src, fall through */ }
    return 'cors';
  }

  // Prefer whatever is actually playing; a page can hold several idle
  // <video>/<audio> elements (previews, hidden players, ad slots).
  const audible = (el) => !el.paused && !el.ended && !el.muted && el.volume > 0;

  // Stick with the current element while it's audible, then prefer anything
  // audible. "Playing" alone isn't enough: YouTube's hover previews and most
  // landing-page hero loops play muted, and grabbing one would pull the
  // graph off the real player.
  function pickMedia() {
    const all = [...document.querySelectorAll('video, audio')];
    const current = media && all.includes(media) ? media : null;
    if (current && audible(current)) return current;
    return all.find((el) => audible(el) && el.readyState >= 2) ||
           current ||
           all.find((el) => el.readyState >= 2) ||
           null;
  }

  function attach(el) {
    if (!el || el === media) return;
    // Encrypted media can't reach HAVE_CURRENT_DATA until its keys are set,
    // so waiting for it makes the DRM check below race-free. Polled again
    // in a second.
    if (el.readyState < 2) return;
    const blocked = tapBlockedReason(el);
    if (blocked) {
      // attach() re-runs every second on this element (it never becomes
      // `media`), so this also catches the moment it actually starts playing.
      // Muted/idle elements are nobody's problem, so they stay unreported.
      if (audible(el)) {
        status.blocked = blocked;
        notifyBlocked(blocked);
      }
      return;
    }
    try {
      ctx = ctx || new AudioContext();
      if (media && media.__ewSrc) media.__ewSrc.disconnect();
      teardownChain(chain);
      chain = null;

      const src = el.__ewSrc || ctx.createMediaElementSource(el);
      el.__ewSrc = src;

      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const aL = ctx.createAnalyser();
      const aR = ctx.createAnalyser();
      aL.fftSize = 2048;
      aR.fftSize = 2048;

      const g = {
        ll: ctx.createGain(), // left in  -> left out
        lr: ctx.createGain(), // left in  -> right out
        rl: ctx.createGain(), // right in -> left out
        rr: ctx.createGain()  // right in -> right out
      };

      src.connect(splitter);
      splitter.connect(aL, 0);
      splitter.connect(aR, 1);
      splitter.connect(g.ll, 0);
      splitter.connect(g.lr, 0);
      splitter.connect(g.rl, 1);
      splitter.connect(g.rr, 1);
      g.ll.connect(merger, 0, 0);
      g.rl.connect(merger, 0, 0);
      g.lr.connect(merger, 0, 1);
      g.rr.connect(merger, 0, 1);
      merger.connect(ctx.destination);

      chain = { splitter, merger, aL, aR, g };
      media = el;
      emaL = emaR = hits = deadHits = clears = 0;
      status.attached = true;
      status.blocked = null;
      status.detected = null;
      status.error = null;
      deadTicks = 0;
      applyRouting();
    } catch (e) {
      status.attached = false;
      status.error = (e && e.message) || String(e);
    }
  }

  function setGain(node, value) {
    node.gain.setTargetAtTime(value, ctx.currentTime, RAMP);
  }

  function applyRouting() {
    if (!chain) return;
    const mode = cfg.enabled ? cfg.mode : 'off';
    let m; // [ll, lr, rl, rr]

    if (mode === 'mono') m = [0.7, 0.7, 0.7, 0.7];
    else if (mode === 'left') m = [1, 1, 0, 0];
    else if (mode === 'right') m = [0, 0, 1, 1];
    else if (mode === 'auto' && status.detected === 'left') m = [1, 1, 0, 0];
    else if (mode === 'auto' && status.detected === 'right') m = [0, 0, 1, 1];
    else m = [1, 0, 0, 1]; // untouched stereo

    setGain(chain.g.ll, m[0]);
    setGain(chain.g.lr, m[1]);
    setGain(chain.g.rl, m[2]);
    setGain(chain.g.rr, m[3]);
    status.applied = m[1] || m[2] ? (mode === 'mono' ? 'mono' : 'duplicated') : 'off';
  }

  // --- measurement --------------------------------------------------------
  function rms(analyser, buf) {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  function tick() {
    status.playing = !!(media && !media.paused && !media.ended);
    if (!chain || !status.playing || media.muted) return;

    const rawL = rms(chain.aL, bufL);
    const rawR = rms(chain.aR, bufR);

    // A tainted graph reads exactly zero, but so does plain digital silence
    // (intros, gaps between sections), so zero alone proves nothing. Only
    // call it blocked if the element *also* turned DRM or cross-origin after
    // we attached -- both signals have to agree.
    if (rawL === 0 && rawR === 0) {
      if (++deadTicks >= CONFIRM_TICKS && !status.blocked) {
        const late = tapBlockedReason(media);
        if (late) {
          status.blocked = late === 'drm' ? 'drm' : 'reload';
          notifyBlocked(status.blocked);
        }
      }
      return;
    }
    deadTicks = 0;
    status.blocked = null; // sound is flowing through us, nothing is blocked

    emaL += (rawL - emaL) * EMA;
    emaR += (rawR - emaR) * EMA;
    status.level = { l: emaL, r: emaR };

    const loud = Math.max(emaL, emaR);
    const quiet = Math.min(emaL, emaR);
    if (loud < NOISE_FLOOR) return; // silent passage, no evidence either way

    if (quiet / loud < SILENT_RATIO) { hits++; clears = 0; }
    else { clears++; hits = 0; }

    // A broken channel is digitally dead, while even hard-panned mixes leak
    // reverb and noise into the other side. So a raw near-zero on the quiet
    // side is strong enough evidence to act on after ~1s instead of ~3s.
    // Clearing back to stereo still takes the full CONFIRM_TICKS.
    const rawQuiet = emaL > emaR ? rawR : rawL;
    deadHits = hits > 0 && rawQuiet < DEAD_FLOOR ? deadHits + 1 : 0;

    if (hits >= CONFIRM_TICKS || deadHits >= FAST_TICKS) {
      const side = emaL > emaR ? 'left' : 'right';
      if (status.detected !== side) {
        status.detected = side;
        applyRouting();
        notifyDetection(side);
      }
    } else if (clears >= CONFIRM_TICKS && status.detected) {
      status.detected = null;
      applyRouting();
    }
  }

  // --- toast notification ---------------------------------------------------
  // A brief, self-dismissing heads-up on the page itself (the popup isn't
  // usually open), built in a closed shadow root so YouTube's CSS can't
  // touch it and it can't touch YouTube's.
  const TOAST_MS = 5000;
  const LOGO_SVG = '<svg viewBox="0 0 64 64" width="20" height="20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<defs><linearGradient id="ebg" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#2d64ff"/><stop offset="1" stop-color="#8c3cf0"/>' +
    '</linearGradient></defs>' +
    '<rect x="2" y="2" width="60" height="60" rx="15" fill="url(#ebg)"/>' +
    '<g fill="#fff">' +
    '<rect x="16" y="27" width="5" height="10" rx="2.5"/>' +
    '<rect x="24" y="20" width="5" height="24" rx="2.5"/>' +
    '<rect x="32" y="12" width="5" height="40" rx="2.5"/>' +
    '<rect x="40" y="20" width="5" height="24" rx="2.5"/>' +
    '<rect x="48" y="27" width="5" height="10" rx="2.5"/>' +
    '</g><circle cx="34.5" cy="32" r="10" fill="#fff"/></svg>';

  let toastHost = null, toastShadow = null, toastTimer = null;

  function ensureToastHost() {
    if (toastHost && document.documentElement.contains(toastHost)) return toastShadow;
    toastHost = document.createElement('div');
    toastHost.id = 'evenwave-toast-host';
    toastHost.style.all = 'initial';
    toastHost.style.position = 'fixed';
    toastHost.style.top = '16px';
    toastHost.style.right = '16px';
    toastHost.style.zIndex = '2147483647';
    document.documentElement.appendChild(toastHost);
    toastShadow = toastHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent =
      '.toast { box-sizing: border-box; display: flex; align-items: center; gap: 11px; width: 290px;' +
      ' padding: 10px 14px 10px 10px; border-radius: 12px; background: #161d26;' +
      ' color: #e8ebee; font: 13px/1.4 system-ui, "Segoe UI", sans-serif;' +
      ' box-shadow: 0 8px 28px rgba(0,0,0,.35); border: 1px solid #2b3541;' +
      ' opacity: 0; transform: translateY(-8px);' +
      ' transition: opacity .2s ease, transform .2s ease; cursor: pointer; }' +
      '.toast.show { opacity: 1; transform: translateY(0); }' +
      '.toast svg { flex: none; }' +
      '.toast b { display: block; color: #fff; font-weight: 600; }' +
      '.toast small { display: block; margin-top: 1px; color: #8b98a6; font-size: 12px; }' +
      '.toast.warn b { color: #e0a24a; }' +
      '.toast em { font-style: normal; font-weight: 600; color: #e0a24a; }';
    toastShadow.appendChild(style);
    return toastShadow;
  }

  function dismissToast(el) {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  }

  // Title on top, the explanation underneath in muted text.
  function showToast(title, body, warn) {
    const shadow = ensureToastHost();
    shadow.querySelectorAll('.toast').forEach((el) => dismissToast(el));
    if (toastTimer) clearTimeout(toastTimer);

    const el = document.createElement('div');
    el.className = warn ? 'toast warn' : 'toast';
    el.innerHTML = LOGO_SVG + '<span><b>' + title + '</b><small>' + body + '</small></span>';
    el.title = 'Open Evenwave';
    el.addEventListener('click', () => {
      dismissToast(el);
      // Content scripts can't touch chrome.action; background.js opens it.
      // Throws if the extension was reloaded under this page -- nothing to open then.
      try { chrome.runtime.sendMessage({ type: 'ew:openPopup' }).catch(() => {}); } catch (e) { /* stale context */ }
    });
    shadow.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));

    toastTimer = setTimeout(() => dismissToast(el), TOAST_MS);
  }

  function notifyDetection(side) {
    const dead = side === 'left' ? 'right' : 'left';
    if (cfg.enabled && cfg.mode === 'auto') {
      showToast('Fixed it', 'The <em>' + dead + '</em> channel was silent. Now playing in both ears.');
    } else if (!cfg.enabled || cfg.mode === 'off') {
      showToast('One side is silent', 'Nothing in the <em>' + dead + '</em> channel. Click here to fix it.');
    }
    // forced mono/left/right: the user is already steering it manually, stay quiet.
  }


  // Once per reason per page: an SPA like Netflix swaps elements every
  // episode, and repeating the same warning each time would be noise.
  const warned = new Set();
  const BLOCKED_TOASTS = {
    drm: ['Can’t adjust this one', 'It’s copy-protected audio.'],
    cors: ['Can’t adjust this one', 'This site blocks access to its audio.'],
    reload: ['Audio blocked', 'Reload the page to get sound back.']
  };

  function notifyBlocked(reason) {
    if (warned.has(reason) || !BLOCKED_TOASTS[reason]) return;
    warned.add(reason);
    showToast(BLOCKED_TOASTS[reason][0], BLOCKED_TOASTS[reason][1], true);
  }

  // --- lifecycle ----------------------------------------------------------
  const resume = () => { if (ctx && ctx.state === 'suspended') ctx.resume(); };
  document.addEventListener('pointerdown', resume, true);
  document.addEventListener('keydown', resume, true);
  document.addEventListener('play', resume, true);

  setInterval(() => {
    const el = pickMedia();
    if (el && el !== media) attach(el);           // survives SPA navigation
  }, 1000);

  setInterval(tick, TICK_MS);

  // With all_frames:true, every youtube.com frame in the tab gets this
  // listener (ads, embeds, the main player...). chrome.tabs.sendMessage has
  // no frameId from the popup, so if more than one frame answered, whichever
  // responded won the race and could stomp the real player's status with
  // "no video here". Only the frame that actually has a video attached
  // should answer; the rest decline so there's nothing to race.
  chrome.runtime.onMessage.addListener((msg, sender, send) => {
    if (!msg || msg.type !== 'ew:status') return false;
    if (!chain && !status.blocked) return false;
    send({ ...status, cfg, ctxState: ctx ? ctx.state : 'none' });
    return true;
  });
})();
