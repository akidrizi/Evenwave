const fillL = document.getElementById('fillL');
const fillR = document.getElementById('fillR');
const rowL = document.getElementById('rowL');
const rowR = document.getElementById('rowR');
const verdict = document.getElementById('verdict');
const buttons = [...document.querySelectorAll('button[data-mode]')];
const warn = document.getElementById('warn');
const warnText = document.getElementById('warnText');
const site = document.getElementById('site');
const siteText = document.getElementById('siteText');
const siteBtn = document.getElementById('siteBtn');

const STATUS_PORT = 'ew:status';
const STALE_MS = 1500;   // a frame that stopped pushing this long ago is gone
const REFRESH_MS = 500;

let mode = 'auto';
let detected = null; // side that still has sound, from the last status
let current = null;  // { tabId, host, pattern, granted } for the opt-in row
let covered = false; // this tab's host is built in or granted, so a content script should be there
let connState = 'checking'; // checking | ok (port reached a content script) | failed (nothing listening)
let lastKey = '';    // signature of what the DOM currently shows
let lastL = -1, lastR = -1;

chrome.storage.sync.get({ mode: 'auto' }, (v) => { mode = v.mode; lastKey = ''; renderBest(); });

buttons.forEach((b) => b.addEventListener('click', () => {
  mode = b.dataset.mode;
  chrome.storage.sync.set({ mode, enabled: mode !== 'off' });
  lastKey = '';
  renderBest();
}));

function deadSide() { return detected && (detected === 'left' ? 'right' : 'left'); }

// Is the user currently hearing the broken audio? Off leaves it as is, and
// forcing the silent side sends silence to both ears.
function isBroken() { return !!detected && (mode === 'off' || mode === deadSide()); }

function paintButtons() {
  const dead = deadSide();
  const broken = isBroken();
  buttons.forEach((b) => {
    const m = b.dataset.mode;
    b.setAttribute('aria-pressed', String(m === mode));
    // Copying the silent channel to both ears would mean no sound at all.
    // Left enabled if it's the current mode, so it never looks stuck.
    b.disabled = !!dead && m === dead && m !== mode;
    b.title = b.disabled ? 'The ' + dead + ' channel is silent' : '';
    b.classList.toggle('suggest', broken && (m === 'auto' || m === detected));
  });
}

const BLOCKED = {
  drm: 'Copy-protected audio. Can’t be adjusted.',
  cors: 'This site blocks access to its audio.',
  reload: 'Audio blocked. Reload the page.',
  gesture: 'Click the page once so Evenwave can hear it.'
};

function showWarning(reason) {
  warnText.textContent = BLOCKED[reason] || '';
  warn.classList.toggle('show', !!BLOCKED[reason]);
}

// RMS is tiny for normal audio, so scale it into something readable.
const toPercent = (rms) => Math.min(100, Math.round(Math.sqrt(rms) * 220));

// Status arrives twice a second; only touch the DOM when something changed.
function setLevels(l, r) {
  if (l !== lastL) { fillL.style.width = l + '%'; lastL = l; }
  if (r !== lastR) { fillR.style.width = r + '%'; lastR = r; }
}

function render(s) {
  setLevels(toPercent(s.level.l), toPercent(s.level.r));

  const key = ['s', s.attached, s.playing, s.detected, s.blocked, s.error, mode].join('|');
  if (key === lastKey) return;
  lastKey = key;

  rowL.classList.toggle('silent', s.detected === 'right');
  rowR.classList.toggle('silent', s.detected === 'left');
  detected = s.detected || null;
  paintButtons();

  showWarning(s.blocked);
  if (s.blocked) {
    verdict.textContent = 'Can’t measure this tab.';
  } else if (s.error) {
    verdict.textContent = 'Could not tap this player’s audio: ' + s.error;
  } else if (!s.attached) {
    verdict.textContent = 'No audio found in this tab.';
  } else if (!s.playing) {
    verdict.textContent = 'Play the video to measure both channels.';
  } else if (s.detected) {
    const dead = s.detected === 'left' ? 'right' : 'left';
    verdict.innerHTML = 'Nothing is coming out of the <b>' + dead + '</b> channel. ' +
      (isBroken() ? 'Pick a highlighted option to fix it.'
                  : 'Sending the ' + s.detected + ' channel to both ears.');
  } else {
    verdict.textContent = 'Both channels are carrying sound.';
  }
}

function renderNone() {
  setLevels(0, 0);
  const needsGrant = !!current && !current.granted;
  // A covered site with nothing listening means the script isn't running in
  // that tab: it was open before the extension was installed or reloaded.
  const needsReload = covered && connState === 'failed';
  const key = ['none', needsGrant, needsReload, connState, mode].join('|');
  if (key === lastKey) return;
  lastKey = key;

  verdict.textContent = needsGrant
    ? 'Turn Evenwave on for this site to check its channels.'
    : needsReload
    ? 'Can’t reach this tab. Tabs opened before Evenwave was installed or updated need a reload.'
    : connState === 'checking'
    ? 'Checking this tab…'
    : 'No audio found in this tab.';
  rowL.classList.remove('silent');
  rowR.classList.remove('silent');
  showWarning(null);
  detected = null;
  paintButtons();
}

// --- status port ------------------------------------------------------------
// One port to the whole tab; every frame with a player (or a blocked one)
// pushes its status on it. Pick the frame that matters most: an attached
// player beats a blocked one beats an error, and anything that stopped
// pushing is dropped.
const frames = new Map(); // frame id -> { s, at }
let port = null;
let portTab = null;

function pickBest() {
  const now = Date.now();
  let best = null, bestRank = 0;
  for (const [id, f] of frames) {
    if (now - f.at > STALE_MS) { frames.delete(id); continue; }
    const rank = f.s.attached ? 3 : f.s.blocked ? 2 : f.s.error ? 1 : 0;
    if (rank > bestRank) { best = f.s; bestRank = rank; }
  }
  return best;
}

function renderBest() {
  const s = pickBest();
  if (s) render(s); else renderNone();
}

function connect() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || (port && portTab === tab.id)) return;
    if (port) { try { port.disconnect(); } catch (e) { /* already gone */ } }
    port = null;
    portTab = null;
    frames.clear();

    let p;
    try {
      p = chrome.tabs.connect(tab.id, { name: STATUS_PORT });
    } catch (e) {
      renderBest();
      return;
    }
    port = p;
    portTab = tab.id;
    p.onMessage.addListener((s) => {
      if (!s || !s.frame) return;
      connState = 'ok';
      frames.set(s.frame, { s, at: Date.now() });
      renderBest();
    });
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // no content script in that tab; retried on the next refresh
      if (port === p) { port = null; portTab = null; }
      connState = 'failed';
      frames.clear();
      renderBest();
    });
    // Chrome gives no "connected" event. A port that survives this long has
    // a listener on the other end, even if that frame has nothing to report.
    setTimeout(() => {
      if (port === p && connState !== 'failed') { connState = 'ok'; renderBest(); }
    }, 300);
  });
}

// --- per-site opt-in ------------------------------------------------------
// Hosts the manifest already covers -- nothing to grant, nothing to offer.
// "https://*.twitch.tv/*" -> "twitch.tv", which covers the bare domain and
// every subdomain, same as the match pattern does.
const BUILT_IN = chrome.runtime.getManifest().host_permissions
  .map((p) => new URL(p.replace('*.', '')).hostname);
const isBuiltIn = (host) => BUILT_IN.some((b) => host === b || host.endsWith('.' + b));

function refreshSite() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    let url = null;
    try { url = new URL(tab && tab.url); } catch (e) { /* chrome:// etc. */ }
    if (!url || !/^https?:$/.test(url.protocol) || isBuiltIn(url.hostname)) {
      site.classList.remove('show');
      current = null;
      covered = !!url && /^https?:$/.test(url.protocol);
      renderBest();
      return;
    }

    const pattern = url.protocol + '//' + url.hostname + '/*';
    chrome.permissions.contains({ origins: [pattern] }, (granted) => {
      current = { tabId: tab.id, host: url.hostname, pattern, granted };
      covered = granted;
      siteText.innerHTML = granted
        ? 'Watching <span id="siteHost">' + url.hostname + '</span>.'
        : 'Not watching <span id="siteHost">' + url.hostname + '</span> yet.';
      siteBtn.textContent = granted ? 'Turn off for this site' : 'Turn on for this site';
      site.classList.add('show');
      renderBest();
    });
  });
}

siteBtn.addEventListener('click', () => {
  if (!current) return;
  const { host, pattern, granted } = current;

  if (granted) {
    chrome.permissions.remove({ origins: [pattern] }, () => {
      siteText.textContent = 'Off for ' + host + '. Reload the tab to release its audio.';
      refreshSite();
    });
    return;
  }

  // Must stay in the click handler: Chrome only prompts on a user gesture.
  // background.js registers and injects on permissions.onAdded, because the
  // prompt can close this popup before any callback here would run.
  chrome.permissions.request({ origins: [pattern] }, (ok) => {
    if (ok) refreshSite();
  });
});

refreshSite();
connect();
renderBest();
setInterval(() => { connect(); renderBest(); }, REFRESH_MS);
