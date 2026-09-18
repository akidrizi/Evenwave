(() => {
  if (window.__evenwaveLoaded) return;
  window.__evenwaveLoaded = true;

  // --- tuning -------------------------------------------------------------
  const TICK_MS = 200;        // how often we measure while something is playing
  const CONFIRM_MS = 3000;    // consistent evidence before acting
  const FAST_MS = 1000;       // when the quiet side is digitally dead
  const DEAD_FLOOR = 1e-5;    // -100 dBFS: "no signal at all", not just quiet
  const SILENT_RATIO = 0.06;  // quiet/loud amplitude ratio that counts as "dead"
  const NOISE_FLOOR = 0.004;  // below this, treat as silence and measure nothing
  const EMA = 0.25;           // smoothing on the per-channel level
  const RAMP = 0.06;          // gain ramp, in seconds, to avoid clicks
  // 341ms at 48kHz, longer than a tick, so every sample gets measured. The
  // analyser never computes an FFT unless frequency data is asked for, so a
  // big window only costs the ring buffer.
  const FFT_SIZE = 16384;
  const SCAN_MS = 5000;       // fallback DOM scan; play events do the real work
  const IDLE_SUSPEND_MS = 15000; // paused this long -> stop rendering audio
  const STATUS_MS = 400;      // how often to push status while the popup listens
  const FRAME_ID = Math.random().toString(36).slice(2);

  // --- state --------------------------------------------------------------
  let cfg = { enabled: true, mode: 'auto' }; // auto | mono | left | right | off
  let ctx = null;
  let chain = null;
  let media = null;
  let emaL = 0, emaR = 0;
  let hitSince = 0, clearSince = 0, deadSince = 0, zeroSince = 0; // performance.now() stamps, 0 = not running
  const bufL = new Float32Array(FFT_SIZE);
  const bufR = new Float32Array(FFT_SIZE);
  let tickTimer = null;
  let idleTimer = null;
  let idleSuspended = false; // we suspended ctx ourselves, as opposed to the autoplay policy

  const status = {
    attached: false,
    playing: false,
    detected: null,   // null | 'left' | 'right'  (side that still has sound)
    applied: 'off',
    level: { l: 0, r: 0 },
    error: null,
    blocked: null     // null | 'drm' | 'cors' | 'reload' | 'gesture' -- popup owns the wording
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
    if (!el || el === media || el.__ewFailed) return;
    // Encrypted media can't reach HAVE_CURRENT_DATA until its keys are set,
    // so waiting for it makes the DRM check below race-free. The next play
    // event or scan retries.
    if (el.readyState < 2) return;
    const blocked = tapBlockedReason(el);
    if (blocked) {
      // Muted/idle elements are nobody's problem, so they stay unreported.
      if (audible(el)) {
        status.blocked = blocked;
        notifyBlocked(blocked);
      }
      return;
    }

    try {
      // 'playback' trades a few tens of ms of latency (audio lags video, well
      // under what anyone notices) for bigger buffers and far fewer wakeups.
      ctx = ctx || new AudioContext({ latencyHint: 'playback' });
    } catch (e) {
      status.attached = !!chain;
      status.error = (e && e.message) || String(e);
      return;
    }

    if (ctx.state === 'suspended') {
      if (idleSuspended) {
        resumeCtx();
      } else {
        // Autoplay policy: no user gesture on this page yet, so the context
        // won't render. Tapping the element now would route its audio into a
        // graph that outputs nothing. The gesture handlers below resume and
        // re-scan, so just wait.
        if (audible(el)) {
          status.blocked = 'gesture';
          notifyBlocked('gesture');
        }
        return;
      }
    }

    try {
      // The only call here that can throw (a page that already wired this
      // element to its own AudioContext, for one). Do it before touching the
      // old chain, so a failure leaves the old player exactly as it was.
      const src = el.__ewSrc || ctx.createMediaElementSource(el);
      el.__ewSrc = src;

      if (media && media.__ewSrc) media.__ewSrc.disconnect();
      teardownChain(chain);
      chain = null;

      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const aL = ctx.createAnalyser();
      const aR = ctx.createAnalyser();
      aL.fftSize = FFT_SIZE;
      aR.fftSize = FFT_SIZE;

      const g = {
        ll: ctx.createGain(), // left in  -> left out
        lr: ctx.createGain(), // left in  -> right out
        rl: ctx.createGain(), // right in -> left out
        rr: ctx.createGain()  // right in -> right out
      };

      // Gain nodes are born at 1. Ramping from there would sum L+R into both
      // ears (up to +6 dB) for the first few hundred ms of every attach, so
      // set the matrix outright before anything is connected.
      status.detected = null;
      const m = routingMatrix();
      g.ll.gain.value = m[0];
      g.lr.gain.value = m[1];
      g.rl.gain.value = m[2];
      g.rr.gain.value = m[3];

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
      emaL = emaR = 0;
      hitSince = clearSince = deadSince = zeroSince = 0;
      status.attached = true;
      status.blocked = null;
      status.error = null;
      applyRouting();
      syncTick();
      scheduleIdle();
    } catch (e) {
      // Don't retry this element every scan. Whatever was attached before is
      // untouched (nothing above ran), so `attached` must keep saying so; the
      // error clears on the next tick that hears sound, like `blocked`.
      el.__ewFailed = true;
      status.attached = !!chain;
      status.error = (e && e.message) || String(e);
    }
  }

  function setGain(node, value) {
    node.gain.setTargetAtTime(value, ctx.currentTime, RAMP);
  }

  // [ll, lr, rl, rr] for the current mode and detection.
  function routingMatrix() {
    const mode = cfg.enabled ? cfg.mode : 'off';
    // 0.5 keeps a fully correlated (centre-panned) mix at unity. 0.7 would
    // clip it: the destination hard-limits at 1.0.
    if (mode === 'mono') return [0.5, 0.5, 0.5, 0.5];
    if (mode === 'left' || (mode === 'auto' && status.detected === 'left')) return [1, 1, 0, 0];
    if (mode === 'right' || (mode === 'auto' && status.detected === 'right')) return [0, 0, 1, 1];
    return [1, 0, 0, 1]; // untouched stereo
  }

  function applyRouting() {
    if (!chain) return;
    const mode = cfg.enabled ? cfg.mode : 'off';
    const m = routingMatrix();
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
    if (ctx.state !== 'running') {
      // Missed a play event somewhere; wake the graph back up.
      if (idleSuspended) resumeCtx();
      return;
    }

    const now = performance.now();
    const rawL = rms(chain.aL, bufL);
    const rawR = rms(chain.aR, bufR);

    // A tainted graph reads exactly zero, but so does plain digital silence
    // (intros, gaps between sections), so zero alone proves nothing. Only
    // call it blocked if the element *also* turned DRM or cross-origin after
    // we attached -- both signals have to agree.
    if (rawL === 0 && rawR === 0) {
      zeroSince = zeroSince || now;
      if (now - zeroSince >= CONFIRM_MS && !status.blocked) {
        const late = tapBlockedReason(media);
        if (late) {
          status.blocked = late === 'drm' ? 'drm' : 'reload';
          notifyBlocked(status.blocked);
        }
      }
      return;
    }
    zeroSince = 0;
    status.blocked = null; // sound is flowing through us, nothing is blocked
    status.error = null;

    emaL += (rawL - emaL) * EMA;
    emaR += (rawR - emaR) * EMA;
    status.level = { l: emaL, r: emaR };

    const loud = Math.max(emaL, emaR);
    const quiet = Math.min(emaL, emaR);
    if (loud < NOISE_FLOOR) return; // silent passage, no evidence either way

    // Wall-clock rather than tick counts: background-tab timer throttling
    // stretches the interval, and the confirm window shouldn't stretch with it.
    if (quiet / loud < SILENT_RATIO) { hitSince = hitSince || now; clearSince = 0; }
    else { clearSince = clearSince || now; hitSince = 0; }

    // A broken channel is digitally dead, while even hard-panned mixes leak
    // reverb and noise into the other side. So a raw near-zero on the quiet
    // side is strong enough evidence to act on after ~1s instead of ~3s.
    // Judged on raw levels, not the EMA: the point is to skip the smoothing
    // lag, and a second of true zero on one side with sound on the other is
    // not something a real stereo mix produces. Clearing back to stereo
    // still takes the full CONFIRM_MS.
    const rawQuiet = emaL > emaR ? rawR : rawL;
    const rawLoud = emaL > emaR ? rawL : rawR;
    deadSince = rawQuiet < DEAD_FLOOR && rawLoud >= NOISE_FLOOR ? (deadSince || now) : 0;

    const confirmed = (hitSince && now - hitSince >= CONFIRM_MS) ||
                      (deadSince && now - deadSince >= FAST_MS);
    if (confirmed) {
      const side = emaL > emaR ? 'left' : 'right';
      if (status.detected !== side) {
        status.detected = side;
        applyRouting();
        notifyDetection(side);
      }
    } else if (clearSince && now - clearSince >= CONFIRM_MS && status.detected) {
      status.detected = null;
      applyRouting();
    }
  }

  // The 200ms tick only runs while the attached element is actually playing.
  // Everything else (idle frames, paused players) costs nothing.
  function syncTick() {
    const want = !!chain && !!media && !media.paused && !media.ended;
    if (want && !tickTimer) {
      tickTimer = setInterval(tick, TICK_MS);
    } else if (!want && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
      status.playing = false;
    }
  }

  // --- context lifecycle ----------------------------------------------------
  // A running AudioContext keeps an output stream open and a render thread
  // awake even with nothing to play. Suspend it once the player has sat
  // paused for a while; play resumes it before audio flows.
  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!ctx || !media || !(media.paused || media.ended)) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!ctx || !media || !(media.paused || media.ended) || ctx.state !== 'running') return;
      idleSuspended = true;
      ctx.suspend().catch(() => { idleSuspended = false; });
    }, IDLE_SUSPEND_MS);
  }

  function resumeCtx() {
    if (!ctx || ctx.state !== 'suspended') return Promise.resolve();
    return ctx.resume().then(() => { idleSuspended = false; }).catch(() => {});
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
    // 100vw is this frame's viewport, so inside a small embedded player the
    // toast shrinks to fit instead of running off the edge.
    style.textContent =
      '.toast { box-sizing: border-box; display: flex; align-items: center; gap: 11px;' +
      ' width: min(290px, calc(100vw - 32px));' +
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

  // Content scripts can't touch chrome.action; background.js opens it.
  // Throws if the extension was reloaded under this page -- nothing to open then.
  function openPopup() {
    try { chrome.runtime.sendMessage({ type: 'ew:openPopup' }).catch(() => {}); } catch (e) { /* stale context */ }
  }

  // The nudge toast says "click here to fix it", so do exactly that: switch
  // to Automatic here and now, then persist it so every other tab follows.
  function fixNow() {
    cfg = { ...cfg, enabled: true, mode: 'auto' };
    applyRouting();
    try { chrome.storage.sync.set({ enabled: true, mode: 'auto' }); } catch (e) { /* stale context */ }
    showToast('Fixed it', 'Now playing in both ears. Evenwave is set to Automatic.');
  }

  // Title on top, the explanation underneath in muted text. `onClick` is what
  // a click does after dismissing: open the popup by default, null for nothing.
  function showToast(title, body, warn, onClick = openPopup) {
    const shadow = ensureToastHost();
    shadow.querySelectorAll('.toast').forEach((el) => dismissToast(el));
    if (toastTimer) clearTimeout(toastTimer);

    const el = document.createElement('div');
    el.className = warn ? 'toast warn' : 'toast';
    el.innerHTML = LOGO_SVG + '<span><b>' + title + '</b><small>' + body + '</small></span>';
    el.title = onClick === openPopup ? 'Open Evenwave' : onClick ? 'Fix it now' : '';
    el.addEventListener('click', () => {
      dismissToast(el);
      if (onClick) onClick();
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
      showToast('One side is silent', 'Nothing in the <em>' + dead + '</em> channel. Click here to fix it.', false, fixNow);
    }
    // forced mono/left/right: the user is already steering it manually, stay quiet.
  }


  // Once per reason per page: an SPA like Netflix swaps elements every
  // episode, and repeating the same warning each time would be noise.
  const warned = new Set();
  const BLOCKED_TOASTS = {
    drm: ['Can’t adjust this one', 'It’s copy-protected audio.'],
    cors: ['Can’t adjust this one', 'This site blocks access to its audio.'],
    reload: ['Audio blocked', 'Reload the page to get sound back.'],
    // The click on this toast is itself the gesture that unblocks the context.
    gesture: ['Click to enable', 'Evenwave can’t hear this page until you click it once.']
  };

  function notifyBlocked(reason) {
    if (warned.has(reason) || !BLOCKED_TOASTS[reason]) return;
    warned.add(reason);
    showToast(BLOCKED_TOASTS[reason][0], BLOCKED_TOASTS[reason][1], true, reason === 'gesture' ? null : openPopup);
  }

  // --- lifecycle ----------------------------------------------------------
  // Reloading or updating the extension orphans this script: the page keeps
  // running it, the audio graph keeps working, but every chrome.* call fails
  // and the popup can no longer reach it. Say so once, on the page, and go
  // quiet. Nothing here can hand the tapped element back to the page; only a
  // reload does that.
  let orphaned = false;
  let scanTimer = null;
  function checkContext() {
    let alive = false;
    try { alive = !!(chrome.runtime && chrome.runtime.id); } catch (e) { /* invalidated */ }
    if (alive || orphaned) return alive;
    orphaned = true;
    clearInterval(scanTimer);
    clearInterval(tickTimer);
    tickTimer = null;
    showToast('Evenwave was updated', 'Reload this page to reconnect it.', true, null);
    return false;
  }

  function scan() {
    if (!checkContext()) return;
    const el = pickMedia();
    if (el && el !== media) attach(el);
    syncTick();
  }

  // Media events don't bubble, but capture listeners on the document still
  // see them, so one set of listeners covers every element on the page
  // without polling the DOM.
  const onPlayLike = (e) => {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (idleSuspended) resumeCtx();
    if (e.target === media) syncTick();
    else scan();                              // a new or different element started
  };
  const onPauseLike = (e) => {
    if (e.target !== media) return;
    syncTick();
    scheduleIdle();
  };
  // Same element, new source (YouTube swaps videos in place): the smoothed
  // levels and any half-collected evidence belong to the old video. Without
  // this, a one-sided video after a stereo one takes ~2s longer to confirm
  // while the old level decays. Routing stays as is until real evidence
  // clears it.
  const onSourceChange = (e) => {
    if (e.target !== media) return;
    emaL = emaR = 0;
    hitSince = clearSince = deadSince = zeroSince = 0;
  };
  document.addEventListener('play', onPlayLike, true);
  document.addEventListener('playing', onPlayLike, true);
  document.addEventListener('pause', onPauseLike, true);
  document.addEventListener('ended', onPauseLike, true);
  document.addEventListener('emptied', onSourceChange, true);
  document.addEventListener('volumechange', scan, true); // unmuting can change which element counts

  // A context created before any user gesture starts suspended (autoplay
  // policy). The first gesture unblocks it; re-scan right away so the wait
  // for sound is as short as possible.
  const onGesture = () => {
    if (ctx && ctx.state === 'suspended' && !idleSuspended) resumeCtx().then(scan);
  };
  document.addEventListener('pointerdown', onGesture, true);
  document.addEventListener('keydown', onGesture, true);

  scan();
  scanTimer = setInterval(scan, SCAN_MS);

  // With all_frames:true, every frame in the tab gets this script (ads,
  // embeds, the main player...). The popup opens one port to the whole tab,
  // every frame that has something to say pushes its status on it tagged with
  // FRAME_ID, and the popup picks the frame that actually holds the player.
  // Frames with nothing attached stay silent, so there's nothing to race.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'ew:status') return;
    const push = () => {
      if (!chain && !status.blocked && !status.error) return;
      try {
        port.postMessage({ ...status, cfg, frame: FRAME_ID, ctxState: ctx ? ctx.state : 'none' });
      } catch (e) { /* port gone */ }
    };
    push();
    const timer = setInterval(push, STATUS_MS);
    port.onDisconnect.addListener(() => clearInterval(timer));
  });
})();
