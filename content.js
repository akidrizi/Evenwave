(() => {
  if (window.__evenwaveLoaded) return;
  window.__evenwaveLoaded = true;

  // --- tuning -------------------------------------------------------------
  const TICK_MS = 200;        // how often we measure
  const CONFIRM_TICKS = 15;   // ~3s of consistent evidence before acting
  const SILENT_RATIO = 0.06;  // quiet/loud amplitude ratio that counts as "dead"
  const NOISE_FLOOR = 0.004;  // below this, treat as silence and measure nothing
  const EMA = 0.25;           // smoothing on the per-channel level
  const RAMP = 0.06;          // gain ramp, in seconds, to avoid clicks

  // --- state --------------------------------------------------------------
  let cfg = { enabled: true, mode: 'auto' }; // auto | mono | left | right | off
  let ctx = null;
  let chain = null;
  let media = null;
  let emaL = 0, emaR = 0, hits = 0, clears = 0;
  const bufL = new Float32Array(2048);
  const bufR = new Float32Array(2048);

  const status = {
    attached: false,
    playing: false,
    detected: null,   // null | 'left' | 'right'  (side that still has sound)
    applied: 'off',
    level: { l: 0, r: 0 },
    error: null
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

  function attach(el) {
    if (!el || el === media) return;
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
      emaL = emaR = hits = clears = 0;
      status.attached = true;
      status.detected = null;
      status.error = null;
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

    emaL += (rms(chain.aL, bufL) - emaL) * EMA;
    emaR += (rms(chain.aR, bufR) - emaR) * EMA;
    status.level = { l: emaL, r: emaR };

    const loud = Math.max(emaL, emaR);
    const quiet = Math.min(emaL, emaR);
    if (loud < NOISE_FLOOR) return; // silent passage, no evidence either way

    if (quiet / loud < SILENT_RATIO) { hits++; clears = 0; }
    else { clears++; hits = 0; }

    if (hits >= CONFIRM_TICKS) {
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
      '.toast { display: flex; align-items: center; gap: 10px; max-width: 300px;' +
      ' padding: 10px 14px 10px 10px; border-radius: 12px; background: #161d26;' +
      ' color: #e8ebee; font: 13px/1.4 system-ui, "Segoe UI", sans-serif;' +
      ' box-shadow: 0 8px 28px rgba(0,0,0,.35); border: 1px solid #2b3541;' +
      ' opacity: 0; transform: translateY(-8px);' +
      ' transition: opacity .2s ease, transform .2s ease; cursor: pointer; }' +
      '.toast.show { opacity: 1; transform: translateY(0); }' +
      '.toast b { color: #fff; }';
    toastShadow.appendChild(style);
    return toastShadow;
  }

  function dismissToast(el) {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  }

  function showToast(message) {
    const shadow = ensureToastHost();
    shadow.querySelectorAll('.toast').forEach((el) => dismissToast(el));
    if (toastTimer) clearTimeout(toastTimer);

    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = LOGO_SVG + '<span>' + message + '</span>';
    el.addEventListener('click', () => dismissToast(el));
    shadow.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));

    toastTimer = setTimeout(() => dismissToast(el), TOAST_MS);
  }

  function notifyDetection(side) {
    const dead = side === 'left' ? 'right' : 'left';
    if (cfg.enabled && cfg.mode === 'auto') {
      showToast('<b>Fixed it</b> — the ' + dead + ' channel was silent, now playing in both ears.');
    } else if (!cfg.enabled || cfg.mode === 'off') {
      showToast('Nothing in the <b>' + dead + '</b> channel — click the Evenwave icon to fix it.');
    }
    // forced mono/left/right: the user is already steering it manually, stay quiet.
  }

  // --- lifecycle ----------------------------------------------------------
  const resume = () => { if (ctx && ctx.state === 'suspended') ctx.resume(); };
  document.addEventListener('pointerdown', resume, true);
  document.addEventListener('keydown', resume, true);
  document.addEventListener('play', resume, true);

  setInterval(() => {
    const el = document.querySelector('video');
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
    if (!chain) return false;
    send({ ...status, cfg, ctxState: ctx ? ctx.state : 'none' });
    return true;
  });
})();
