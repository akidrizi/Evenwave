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

let mode = 'auto';
let detected = null; // side that still has sound, from the last status

chrome.storage.sync.get({ mode: 'auto' }, (v) => { mode = v.mode; paintButtons(); });

buttons.forEach((b) => b.addEventListener('click', () => {
  mode = b.dataset.mode;
  chrome.storage.sync.set({ mode, enabled: mode !== 'off' });
  paintButtons();
  poll();
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
  reload: 'Audio blocked. Reload the page.'
};

function showWarning(reason) {
  warnText.textContent = BLOCKED[reason] || '';
  warn.classList.toggle('show', !!BLOCKED[reason]);
}

// RMS is tiny for normal audio, so scale it into something readable.
const toPercent = (rms) => Math.min(100, Math.round(Math.sqrt(rms) * 220));

function render(s) {
  const l = toPercent(s.level.l);
  const r = toPercent(s.level.r);
  fillL.style.width = l + '%';
  fillR.style.width = r + '%';
  rowL.classList.toggle('silent', s.detected === 'right');
  rowR.classList.toggle('silent', s.detected === 'left');
  detected = s.detected || null;
  paintButtons();

  showWarning(s.blocked);
  if (s.blocked) {
    verdict.textContent = 'Can\u2019t measure this tab.';
  } else if (s.error) {
    verdict.textContent = 'Could not tap this player\u2019s audio: ' + s.error;
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

// Hosts the manifest already covers -- nothing to grant, nothing to offer.
// "https://*.twitch.tv/*" -> "twitch.tv", which covers the bare domain and
// every subdomain, same as the match pattern does.
const BUILT_IN = chrome.runtime.getManifest().host_permissions
  .map((p) => new URL(p.replace('*.', '')).hostname);
const isBuiltIn = (host) => BUILT_IN.some((b) => host === b || host.endsWith('.' + b));

let current = null; // { tabId, host, pattern, granted }

function refreshSite() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    let url = null;
    try { url = new URL(tab && tab.url); } catch (e) { /* chrome:// etc. */ }
    if (!url || !/^https?:$/.test(url.protocol) || isBuiltIn(url.hostname)) {
      site.classList.remove('show');
      current = null;
      return;
    }

    const pattern = url.protocol + '//' + url.hostname + '/*';
    chrome.permissions.contains({ origins: [pattern] }, (granted) => {
      current = { tabId: tab.id, host: url.hostname, pattern, granted };
      siteText.innerHTML = granted
        ? 'Watching <span id="siteHost">' + url.hostname + '</span>.'
        : 'Not watching <span id="siteHost">' + url.hostname + '</span> yet.';
      siteBtn.textContent = granted ? 'Turn off for this site' : 'Turn on for this site';
      site.classList.add('show');
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
    if (ok) { refreshSite(); poll(); }
  });
});

function poll() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: 'ew:status' }, (s) => {
      if (chrome.runtime.lastError || !s) {
        verdict.textContent = current && !current.granted
          ? 'Turn Evenwave on for this site to check its channels.'
          : 'No audio found in this tab.';
        fillL.style.width = fillR.style.width = '0';
        showWarning(null);
        detected = null;
        paintButtons();
        return;
      }
      render(s);
    });
  });
}

refreshSite();
poll();
setInterval(poll, 400);
