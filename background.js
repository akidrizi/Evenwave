// The popup can be torn down the moment Chrome shows the permission prompt,
// so registration can't live in its callback. These events fire regardless of
// who asked or whether the popup is still open -- including when the user
// grants or revokes a site from chrome://extensions itself.

const scriptId = (pattern) => 'ew:' + pattern;

function hostsOf(perms) {
  return (perms.origins || []).filter((o) => /^https?:/.test(o));
}

chrome.permissions.onAdded.addListener(async (perms) => {
  for (const pattern of hostsOf(perms)) {
    try {
      await chrome.scripting.registerContentScripts([{
        id: scriptId(pattern),
        matches: [pattern],
        js: ['content.js'],
        allFrames: true,
        runAt: 'document_idle'
      }]);
    } catch (e) { /* already registered */ }

    // Pages open right now predate the registration, so inject them once.
    const tabs = await chrome.tabs.query({ url: pattern });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.js']
        });
      } catch (e) { /* frame refused injection */ }
    }
  }
});

// Clicking the on-page toast opens the toolbar popup for that window. Needs
// Chrome 127+ and a focused window, which a click on the page guarantees;
// on anything older the toast just dismisses.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'ew:openPopup' || !sender.tab) return;
  chrome.action.openPopup({ windowId: sender.tab.windowId }).catch(() => {});
});

chrome.permissions.onRemoved.addListener(async (perms) => {
  for (const pattern of hostsOf(perms)) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [scriptId(pattern)] });
    } catch (e) { /* never registered */ }
  }
});
