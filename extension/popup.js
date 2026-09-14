const fillL = document.getElementById('fillL');
const fillR = document.getElementById('fillR');
const rowL = document.getElementById('rowL');
const rowR = document.getElementById('rowR');
const verdict = document.getElementById('verdict');
const buttons = [...document.querySelectorAll('button[data-mode]')];

let mode = 'auto';

chrome.storage.sync.get({ mode: 'auto' }, (v) => { mode = v.mode; paintButtons(); });

buttons.forEach((b) => b.addEventListener('click', () => {
  mode = b.dataset.mode;
  chrome.storage.sync.set({ mode, enabled: mode !== 'off' });
  paintButtons();
  poll();
}));

function paintButtons() {
  buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
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

  if (s.error) {
    verdict.textContent = 'Could not tap this player\u2019s audio: ' + s.error;
  } else if (!s.attached) {
    verdict.textContent = 'No video found in this tab.';
  } else if (!s.playing) {
    verdict.textContent = 'Play the video to measure both channels.';
  } else if (s.detected) {
    const dead = s.detected === 'left' ? 'right' : 'left';
    verdict.innerHTML = 'Nothing is coming out of the <b>' + dead + '</b> channel. ' +
      (mode === 'off' ? 'Turn on Automatic to send the other side to both ears.'
                      : 'Sending the ' + s.detected + ' channel to both ears.');
  } else {
    verdict.textContent = 'Both channels are carrying sound.';
  }
}

function poll() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: 'ew:status' }, (s) => {
      if (chrome.runtime.lastError || !s) {
        verdict.textContent = 'Open a YouTube video to check its channels.';
        fillL.style.width = fillR.style.width = '0';
        return;
      }
      render(s);
    });
  });
}

poll();
setInterval(poll, 400);
