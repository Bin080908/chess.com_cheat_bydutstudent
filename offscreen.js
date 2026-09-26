const engine = new Worker(chrome.runtime.getURL("vendor/stockfish.wasm.js"));

let ready = false;
let currentTabId = null;
let currentSeq = null;   // #3/#7: echo lại seq ID trong mọi engine response
let lastInfo = null;

function uci(cmd) {
  engine.postMessage(cmd);
}

engine.addEventListener("message", (ev) => {
  const line = String(ev.data || "");

  if (line.startsWith("id name") || line === "uciok") {
    if (line === "uciok") {
      uci("setoption name Hash value 32");
      uci("isready");
    }
    return;
  }

  if (line === "readyok") {
    ready = true;
    chrome.runtime.sendMessage({ type: "engine-ready", tabId: currentTabId });
    return;
  }

  if (line.startsWith("info ")) {
    const depth = / depth (\d+)/.exec(line);
    const mate = / score mate (-?\d+)/.exec(line);
    const cp = / score cp (-?\d+)/.exec(line);
    const pv = / pv (.+)$/.exec(line);
    const nps = / nps (\d+)/.exec(line);
    lastInfo = {
      depth: depth ? Number(depth[1]) : null,
      mate: mate ? Number(mate[1]) : null,
      cp: cp ? Number(cp[1]) : null,
      pv: pv ? pv[1].trim().split(/\s+/) : [],
      nps: nps ? Number(nps[1]) : null
    };
    chrome.runtime.sendMessage({
      type: "engine-info",
      tabId: currentTabId,
      seq: currentSeq,    // #7: gắn seq để content.js lọc stale
      ...lastInfo
    });
    return;
  }

  if (line.startsWith("bestmove ")) {
    const parts = line.split(/\s+/);
    const best = parts[1] === "(none)" ? null : parts[1];
    const ponder = parts[2] === "ponder" ? parts[3] : null;
    chrome.runtime.sendMessage({
      type: "engine-best",
      tabId: currentTabId,
      seq: currentSeq,    // #7: gắn seq để content.js lọc stale
      bestmove: best,
      ponder,
      info: lastInfo
    });
  }
});

engine.addEventListener("error", (err) => {
  chrome.runtime.sendMessage({
    type: "engine-error",
    tabId: currentTabId,
    message: String(err.message || err)
  });
});

uci("uci");

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "offscreen") return;

  if (msg.type === "stop") {
    uci("stop");
    return;
  }

  if (msg.type === "analyze") {
    currentTabId = msg.tabId;
    currentSeq = msg.seq ?? null;   // #3/#7: lưu seq để gắn vào mọi response
    const depth = Math.max(4, Math.min(22, Number(msg.depth) || 16));
    uci("stop");
    // #6: bỏ ucinewgame — không cần xoá hash vì dùng "position fen" trực tiếp,
    //     giữ lại hash table giúp engine tính nhanh hơn ở các position liên tiếp
    uci("position fen " + msg.fen);
    uci("go depth " + depth);
  }
});
