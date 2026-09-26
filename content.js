const PIECE_FEN = {
  wp: "P", wn: "N", wb: "B", wr: "R", wq: "Q", wk: "K",
  bp: "p", bn: "n", bb: "b", br: "r", bq: "q", bk: "k"
};

const FILES = "abcdefgh";

let settings = { enabled: true, onlyMyTurn: true, showEval: true, depth: 16 };
let lastFen = "";
let lastSearchKey = "";
let debounceTimer = 0;
let currentSeq = 0;
let overlayHost = null;
let hud = null;
let observer = null;
let hintActive = true;
let hudDragPos = { x: null, y: null };

chrome.storage.sync.get(settings, (s) => {
  settings = { ...settings, ...s };
  scheduleRead();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
  lastSearchKey = "";
  scheduleRead();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "engine-info") {
    if (msg.seq !== currentSeq) return;          // #7: bỏ kết quả từ request cũ
    renderHud(msg, false);
  }
  if (msg.type === "engine-best") {
    if (msg.seq !== currentSeq) return;          // #7: bỏ kết quả từ request cũ
    renderHud({ ...msg.info, bestmove: msg.bestmove }, true);
    if (hintActive) drawArrow(msg.bestmove);     // #2: chỉ vẽ khi hint đang bật
  }
  if (msg.type === "engine-error") setHud("Engine lỗi: " + msg.message, true);
});

function getBoardEl() {
  return (
    document.querySelector("wc-chess-board") ||
    document.querySelector("chess-board") ||
    document.querySelector("[class*='board'][id*='board']") ||
    document.querySelector(".board")
  );
}

function isFlipped(board) {
  if (!board) return false;
  return (
    board.classList.contains("flipped") ||
    board.getAttribute("flipped") === "" ||
    board.getAttribute("flipped") === "true"
  );
}

function userColor(board) {
  return isFlipped(board) ? "b" : "w";
}

function isUserTurn() {
  const bottom = document.querySelector(".clock-bottom, [class*='clock-bottom']");
  if (bottom && /clock-player-turn|player-turn|clock-ticking/.test(bottom.className)) {
    return true;
  }
  const top = document.querySelector(".clock-top, [class*='clock-top']");
  if (top && /clock-player-turn|player-turn|clock-ticking/.test(top.className)) {
    return false;
  }
  return null;
}

function queryAll(root, sel) {
  const out = [];
  if (!root) return out;
  try {
    out.push(...root.querySelectorAll(sel));
  } catch (_) {}
  if (root.shadowRoot) {
    try {
      out.push(...root.shadowRoot.querySelectorAll(sel));
    } catch (_) {}
  }
  return out;
}

function tryGameFen(board) {
  try {
    if (board.game && typeof board.game.getFEN === "function") {
      const fen = board.game.getFEN();
      if (fen && typeof fen === "string" && fen.split(" ").length >= 2) return fen;
    }
  } catch (_) {}
  try {
    if (typeof board.getPosition === "function") {
      const pos = board.getPosition();
      if (typeof pos === "string" && pos.includes("/")) return pos;
      if (pos && typeof pos.fen === "string") return pos.fen;
    }
  } catch (_) {}
  return null;
}

function parsePieceEl(el) {
  const cls = el.className || "";
  const sq = /square-([1-8])([1-8])/.exec(cls);
  const pc = /\b([wb][pnbrqk])\b/.exec(cls);
  if (!sq || !pc) return null;
  return {
    file: Number(sq[1]),
    rank: Number(sq[2]),
    code: pc[1]
  };
}

function reconstructFen(board, sideToMove) {
  const grid = Array.from({ length: 8 }, () => Array(8).fill(""));
  const pieces = queryAll(board, ".piece").concat(queryAll(document, ".piece"));
  const seen = new Set();
  const unique = [];
  for (const el of pieces) {
    const p = parsePieceEl(el);
    if (!p) continue;
    const key = p.file + ":" + p.rank + ":" + p.code;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
    grid[8 - p.rank][p.file - 1] = PIECE_FEN[p.code] || "";
  }
  if (unique.length < 2) return null;

  const ranks = grid.map((row) => {
    let s = "";
    let empty = 0;
    for (const cell of row) {
      if (!cell) empty += 1;
      else {
        if (empty) s += empty;
        empty = 0;
        s += cell;
      }
    }
    if (empty) s += empty;
    return s;
  });

  const codes = new Set(unique.map((p) => p.file + p.rank + p.code));
  let castle = "";
  if (codes.has("51wk")) {
    if (codes.has("81wr")) castle += "K";
    if (codes.has("11wr")) castle += "Q";
  }
  if (codes.has("58bk")) {
    if (codes.has("88br")) castle += "k";
    if (codes.has("18br")) castle += "q";
  }
  if (!castle) castle = "-";

  const ep = detectEnPassant(unique, sideToMove);
  return ranks.join("/") + " " + sideToMove + " " + castle + " " + ep + " 0 1";
}

function detectEnPassant(pieces, sideToMove) {
  const highlights = queryAll(document, ".highlight");
  const squares = [];
  for (const el of highlights) {
    const m = /square-([1-8])([1-8])/.exec(el.className || "");
    if (m) squares.push({ file: Number(m[1]), rank: Number(m[2]) });
  }
  if (squares.length !== 2) return "-";
  const [a, b] = squares;
  if (a.file !== b.file) return "-";
  const hi = a.rank > b.rank ? a : b;
  const lo = a.rank > b.rank ? b : a;
  if (hi.rank - lo.rank !== 2) return "-";
  if (sideToMove === "b" && lo.rank === 2 && hi.rank === 4) {
    const pawn = pieces.find((p) => p.code === "wp" && p.file === a.file && p.rank === 4);
    if (pawn) return FILES[a.file - 1] + "3";
  }
  if (sideToMove === "w" && lo.rank === 5 && hi.rank === 7) {
    const pawn = pieces.find((p) => p.code === "bp" && p.file === a.file && p.rank === 5);
    if (pawn) return FILES[a.file - 1] + "6";
  }
  return "-";
}

function sideToMoveFromBoard(board, user) {
  const fen = tryGameFen(board);
  if (fen) {
    const parts = fen.split(" ");
    if (parts[1] === "w" || parts[1] === "b") return parts[1];
  }
  const turn = isUserTurn();
  if (turn === true) return user;
  if (turn === false) return user === "w" ? "b" : "w";
  return user;
}

function readPosition() {
  const board = getBoardEl();
  if (!board) return null;
  const user = userColor(board);
  const fromGame = tryGameFen(board);
  let fen = fromGame;
  const stm = fen ? fen.split(" ")[1] : sideToMoveFromBoard(board, user);
  if (!fen) fen = reconstructFen(board, stm);
  if (!fen) return null;
  return { board, fen, user, stm, flipped: isFlipped(board) };
}

function scheduleRead() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(tick, 350);
}

function tick() {
  ensureUi();
  if (!settings.enabled) {
    clearOverlay();
    setHud("Đã tắt", false);
    chrome.runtime.sendMessage({ type: "stop" }).catch(() => {});
    lastSearchKey = "";
    return;
  }

  // #1: nếu người dùng tạm tắt gợi ý thì không phân tích, xoá mũi tên
  if (!hintActive) {
    clearOverlay();
    if (lastSearchKey !== "") {
      chrome.runtime.sendMessage({ type: "stop" }).catch(() => {});
      lastSearchKey = "";
    }
    return;
  }

  const pos = readPosition();
  if (!pos) {
    setHud("Không thấy bàn cờ", false);
    return;
  }

  const myTurn = pos.stm === pos.user;
  if (settings.onlyMyTurn && !myTurn) {
    clearOverlay();
    setHud(
      pos.user === "w" ? "Bạn: trắng — chờ đối thủ" : "Bạn: đen — chờ đối thủ",
      false
    );
    if (lastFen !== pos.fen) {
      chrome.runtime.sendMessage({ type: "stop" }).catch(() => {});
      lastFen = pos.fen;
      lastSearchKey = "";
    }
    return;
  }

  const key = pos.fen + "|" + settings.depth;
  if (key === lastSearchKey) return;
  lastSearchKey = key;
  lastFen = pos.fen;

  // #3/#7: mỗi request mới có seq riêng — engine-info/best cũ sẽ bị lọc
  currentSeq++;
  setHud((pos.user === "w" ? "Trắng" : "Đen") + " · đang tính…", false);
  chrome.runtime.sendMessage({
    type: "analyze",
    fen: pos.fen,
    depth: settings.depth,
    seq: currentSeq
  }).catch((err) => setHud(String(err), true));
}

// ─── UI bootstrap ────────────────────────────────────────────────────────────

function ensureUi() {
  const board = getBoardEl();
  if (!board) return;

  // Overlay: fixed fullpage SVG container attached to body/html
  if (!overlayHost || !overlayHost.isConnected) {
    overlayHost = document.getElementById("voss-chess-overlay");
    if (!overlayHost) {
      overlayHost = document.createElement("div");
      overlayHost.id = "voss-chess-overlay";
      overlayHost.innerHTML = `
<svg id="voss-svg" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="voss-glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <g id="voss-arrow-layer"></g>
</svg>`;
      (document.body || document.documentElement).appendChild(overlayHost);
    }
  }

  // HUD: fixed panel
  if (!hud || !hud.isConnected) {
    hud = document.getElementById("voss-chess-hud");
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "voss-chess-hud";
      hud.innerHTML = '<div class="muted">Chess Coach</div>';
      (document.body || document.documentElement).appendChild(hud);
    }
  }

  if (!observer) {
    observer = new MutationObserver(() => scheduleRead());
    // #5: ưu tiên observe bàn cờ (attributes + childList) — ít nhiễu hơn toàn trang
    const boardEl = getBoardEl();
    if (boardEl) {
      observer.observe(boardEl, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class", "style"]
      });
    }
    // Luôn watch document root với childList-only để bắt board xuất hiện/biến mất (SPA nav)
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true
    });
  }
}

// ─── Pixel-space arrow calculation ───────────────────────────────────────────

/**
 * Given a UCI square string ("e2") and the board's DOMRect + flip state,
 * return the pixel center of that square in viewport coordinates.
 */
function squarePx(uciSq, rect, flipped) {
  const fileIdx = FILES.indexOf(uciSq[0]); // 0–7, a=0
  const rankIdx = Number(uciSq[1]) - 1;    // 0–7, 1=0

  const sqW = rect.width / 8;
  const sqH = rect.height / 8;

  // Unflipped: file 0 (a) is leftmost column, rank 7 (8) is topmost row
  const col = flipped ? 7 - fileIdx : fileIdx;
  const row = flipped ? rankIdx     : 7 - rankIdx;

  return {
    x: rect.left + (col + 0.5) * sqW,
    y: rect.top  + (row + 0.5) * sqH
  };
}

/**
 * Creates clean aerodynamic arrow polygon path matching modern tournament aesthetic
 */
function buildArrowSvgPath(x1, y1, x2, y2, shaftW, headW, headL) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 10) return "";

  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;

  // Retract tip slightly so it lands right in the target center without sticking out
  const actualHeadL = Math.min(len * 0.44, headL);
  const bx = x2 - ux * actualHeadL;
  const by = y2 - uy * actualHeadL;

  const hw = headW / 2;
  const sw = shaftW / 2;

  // 7 key polygon vertices for a crisp, symmetrical arrow
  const p1x = x1 + nx * sw;
  const p1y = y1 + ny * sw;
  const p2x = x1 - nx * sw;
  const p2y = y1 - ny * sw;
  const p3x = bx - nx * sw;
  const p3y = by - ny * sw;
  const p4x = bx - nx * hw;
  const p4y = by - ny * hw;
  const p5x = x2;
  const p5y = y2;
  const p6x = bx + nx * hw;
  const p6y = by + ny * hw;
  const p7x = bx + nx * sw;
  const p7y = by + ny * sw;

  return `M ${p1x.toFixed(1)} ${p1y.toFixed(1)} ` +
         `L ${p2x.toFixed(1)} ${p2y.toFixed(1)} ` +
         `L ${p3x.toFixed(1)} ${p3y.toFixed(1)} ` +
         `L ${p4x.toFixed(1)} ${p4y.toFixed(1)} ` +
         `L ${p5x.toFixed(1)} ${p5y.toFixed(1)} ` +
         `L ${p6x.toFixed(1)} ${p6y.toFixed(1)} ` +
         `L ${p7x.toFixed(1)} ${p7y.toFixed(1)} Z`;
}

function drawArrow(uci) {
  ensureUi();
  const layer = document.getElementById("voss-arrow-layer");
  if (!layer) return;

  if (!uci || uci.length < 4) {
    layer.innerHTML = "";
    return;
  }

  const board = getBoardEl();
  if (!board) {
    layer.innerHTML = "";
    return;
  }

  const rect = board.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    layer.innerHTML = "";
    return;
  }

  const flipped = isFlipped(board);
  const from = squarePx(uci.slice(0, 2), rect, flipped);
  const to   = squarePx(uci.slice(2, 4), rect, flipped);

  const sqW = rect.width / 8;
  const shaftW = sqW * 0.16;
  const headW  = sqW * 0.40;
  const headL  = sqW * 0.36;

  const arrowPath = buildArrowSvgPath(from.x, from.y, to.x, to.y, shaftW, headW, headL);
  if (!arrowPath) {
    layer.innerHTML = "";
    return;
  }

  // Render vector arrow with classes styled in content.css
  layer.innerHTML = `
    <!-- Subtle glow shadow -->
    <path class="voss-arrow-glow" d="${arrowPath}" />
    <!-- Crisp main arrow with rounded join & contrast border -->
    <path class="voss-arrow-body" d="${arrowPath}" />
    <!-- Origin square anchor ring -->
    <circle class="voss-origin-outer" cx="${from.x.toFixed(1)}" cy="${from.y.toFixed(1)}" r="${(shaftW * 0.72).toFixed(1)}" />
    <circle class="voss-origin-inner" cx="${from.x.toFixed(1)}" cy="${from.y.toFixed(1)}" r="${(shaftW * 0.36).toFixed(1)}" />
  `;
}

function clearOverlay() {
  drawArrow(null);
}

function makeDraggable(el, handle) {
  let drag = false, ox = 0, oy = 0, ix = 0, iy = 0;
  handle.addEventListener('mousedown', (e) => {
    drag = true; ox = e.clientX; oy = e.clientY;
    const r = el.getBoundingClientRect(); ix = r.left; iy = r.top;
    el.style.top = iy + 'px'; el.style.left = ix + 'px';
    el.style.bottom = 'auto'; el.style.right = 'auto';
    const mv = (e) => { if (!drag) return;
      const p=8, nx=Math.max(p,Math.min(window.innerWidth-el.offsetWidth-p,ix+e.clientX-ox));
      const ny=Math.max(p,Math.min(window.innerHeight-el.offsetHeight-p,iy+e.clientY-oy));
      el.style.left=nx+'px'; el.style.top=ny+'px'; hudDragPos={x:nx,y:ny}; };
    const up = () => { drag=false; document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); };
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
    e.preventDefault();
  });
}

function toggleHint() {
  hintActive = !hintActive;
  lastSearchKey = '';
  scheduleRead();
}

// Reposition HUD to board's actual location in viewport
function positionHud() {
  if (!hud) return;
  if (hudDragPos.x !== null) {
    hud.style.left=hudDragPos.x+'px'; hud.style.top=hudDragPos.y+'px';
    hud.style.bottom='auto'; hud.style.right='auto'; return;
  }
  const board = getBoardEl();
  if (!board) return;
  const rect = board.getBoundingClientRect();
  hud.style.left  = (rect.left  + 8) + "px";
  hud.style.bottom = (window.innerHeight - rect.bottom + 8) + "px";
  hud.style.top   = "auto";
  hud.style.right = "auto";
}

function formatEval(info, user, stm) {
  if (!info) return "—";
  if (info.mate != null) {
    const m = Number(info.mate);
    return m === 0 ? "M0" : (m > 0 ? "+" : "") + "M" + m;
  }
  if (info.cp == null) return "—";
  let cp = Number(info.cp);
  if (stm === "b") cp = -cp;
  const pawns = (cp / 100).toFixed(2);
  return (cp > 0 ? "+" : "") + pawns;
}

function prettyMove(uci) {
  if (!uci || uci.length < 4) return "—";
  const promo = uci[4] ? "=" + uci[4].toUpperCase() : "";
  return uci.slice(0, 2) + " → " + uci.slice(2, 4) + promo;
}

function renderHud(info, done) {
  const pos = readPosition();
  const user = pos ? pos.user : "?";
  const stm = pos ? pos.stm : "?";
  const ev = settings.showEval ? formatEval(info, user, stm) : "";
  const move = prettyMove(info && (info.bestmove || (info.pv && info.pv[0])));
  const depth = info && info.depth ? "d" + info.depth : "";
  const evClass =
    info && ((info.cp != null && (stm === "b" ? -info.cp : info.cp) >= 0) || (info.mate != null && info.mate > 0))
      ? "eval-good"
      : "eval-bad";
  if (!hud) return;
  const _bl = hintActive ? '⏸ Tắt gợi ý' : '▶ Bật gợi ý';
  hud.innerHTML =
    '<div class="voss-handle" id="voss-h">⠿</div>' +
    '<div class="row"><span class="label">' +
    (user === "w" ? "Bạn: trắng" : user === "b" ? "Bạn: đen" : "Bàn cờ") +
    "</span><span class=\"" +
    evClass +
    '">' +
    (settings.showEval ? ev : "") +
    "</span></div>" +
    '<div class="move">' +
    move +
    "</div>" +
    '<div class="label">' +
    (hintActive ? (done ? "best" : "đang tính") + (depth ? " · " + depth : "") : "tạm dừng") +
    "</div>" +
    '<button class="voss-btn ' + (hintActive ? 'voss-on' : 'voss-off') + '" id="voss-tb">' + _bl + '</button>';
  const _h = hud.querySelector('#voss-h');
  if (_h) makeDraggable(hud, _h);
  const _b = hud.querySelector('#voss-tb');
  if (_b) _b.addEventListener('click', (e) => { e.stopPropagation(); toggleHint(); });
  positionHud();
}

function setHud(text, isError) {
  if (!hud) return;
  const _bl2 = hintActive ? '⏸ Tắt gợi ý' : '▶ Bật gợi ý';
  hud.innerHTML =
    '<div class="voss-handle" id="voss-h2">⠿</div>' +
    '<div class="' + (isError ? 'eval-bad' : 'muted') + '">' + text + '</div>' +
    '<button class="voss-btn ' + (hintActive ? 'voss-on' : 'voss-off') + '" id="voss-tb2">' + _bl2 + '</button>';
  const _h2 = hud.querySelector('#voss-h2');
  if (_h2) makeDraggable(hud, _h2);
  const _b2 = hud.querySelector('#voss-tb2');
  if (_b2) _b2.addEventListener('click', (e) => { e.stopPropagation(); toggleHint(); });
  positionHud();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", scheduleRead);
} else {
  scheduleRead();
}

setInterval(scheduleRead, 900);