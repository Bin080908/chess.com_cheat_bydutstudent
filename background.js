const OFFSCREEN_URL = "offscreen.html";
const DEFAULTS = {
  enabled: true,
  depth: 16,
  onlyMyTurn: true,
  showEval: true
};

let creatingOffscreen = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, (cur) => {
    chrome.storage.sync.set({ ...DEFAULTS, ...cur });
  });
});

async function ensureOffscreen() {
  let exists = false;
  try {
    if (chrome.offscreen.hasDocument) {
      exists = await chrome.offscreen.hasDocument();
    } else {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
      });
      exists = contexts.length > 0;
    }
  } catch (_) {
    exists = false;
  }
  if (exists) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["WORKERS"],
    justification: "Run Stockfish WASM worker for local chess analysis"
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === "offscreen") return;

  if (msg.type === "analyze" || msg.type === "stop") {
    (async () => {
      await ensureOffscreen();
      const tabId = sender.tab && sender.tab.id;
      chrome.runtime.sendMessage({
        target: "offscreen",
        type: msg.type,
        fen: msg.fen,
        depth: msg.depth,
        seq: msg.seq,   // #3/#7: giữ nguyên seq ID để lọc stale response
        tabId
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "engine-info" || msg.type === "engine-best" || msg.type === "engine-ready" || msg.type === "engine-error") {
    if (typeof msg.tabId === "number") {
      chrome.tabs.sendMessage(msg.tabId, msg).catch(() => {});
    }
  }
});
