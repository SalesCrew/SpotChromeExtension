const statusEl = document.getElementById("status");
const countEl = document.getElementById("fieldCount");
const runButton = document.getElementById("run");
const clearButton = document.getElementById("clear");
const settingsButton = document.getElementById("settings");

let activeTabId = null;

init();

runButton.addEventListener("click", async () => {
  await sendToTab({ type: "SPOT_ASSISTANT_RUN" }, true);
});

clearButton.addEventListener("click", async () => {
  await sendToTab({ type: "SPOT_ASSISTANT_CLEAR" });
});

settingsButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "SPOT_ASSISTANT_OPEN_OPTIONS" });
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;
  if (!activeTabId) {
    setStatus("Keine aktive Seite gefunden.");
    return;
  }

  const response = await sendToTab({ type: "SPOT_ASSISTANT_PING" });
  if (!response?.ok || !response.isSpotPage) {
    countEl.textContent = "0";
    runButton.disabled = true;
    clearButton.disabled = true;
    setStatus("Keine Spot-Fragebogenseite erkannt.");
    return;
  }

  countEl.textContent = String(response.fieldCount || 0);
  setStatus("Bereit.");
}

async function sendToTab(message, keepBusy = false) {
  try {
    if (keepBusy) {
      runButton.disabled = true;
      runButton.textContent = "Prüft...";
      setStatus("Analyse läuft...");
    }
    const response = await chrome.tabs.sendMessage(activeTabId, message);
    if (!response?.ok) {
      throw new Error(response?.error || "Aktion fehlgeschlagen.");
    }
    if (message.type === "SPOT_ASSISTANT_RUN") {
      setStatus("Vorschläge wurden in die Seite eingefügt.");
    }
    return response;
  } catch (error) {
    setStatus(error.message || String(error));
    return null;
  } finally {
    if (keepBusy) {
      runButton.disabled = false;
      runButton.textContent = "Prüfen";
    }
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}
