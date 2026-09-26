const ids = ["enabled", "onlyMyTurn", "showEval", "depth"];

function apply(settings) {
  document.getElementById("enabled").checked = !!settings.enabled;
  document.getElementById("onlyMyTurn").checked = !!settings.onlyMyTurn;
  document.getElementById("showEval").checked = !!settings.showEval;
  document.getElementById("depth").value = String(settings.depth ?? 16);
  document.getElementById("depthVal").textContent = String(settings.depth ?? 16);
}

chrome.storage.sync.get(
  { enabled: true, onlyMyTurn: true, showEval: true, depth: 16 },
  apply
);

ids.forEach((id) => {
  document.getElementById(id).addEventListener("input", () => {
    const payload = {
      enabled: document.getElementById("enabled").checked,
      onlyMyTurn: document.getElementById("onlyMyTurn").checked,
      showEval: document.getElementById("showEval").checked,
      depth: Number(document.getElementById("depth").value)
    };
    document.getElementById("depthVal").textContent = String(payload.depth);
    chrome.storage.sync.set(payload);
  });
});
