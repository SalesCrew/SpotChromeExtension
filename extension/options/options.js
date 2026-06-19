const modeInputs = [...document.querySelectorAll("input[name='mode']")];
const serverUrlInput = document.getElementById("serverUrl");
const modelInput = document.getElementById("model");
const apiKeyInput = document.getElementById("apiKey");
const saveButton = document.getElementById("save");
const testButton = document.getElementById("test");
const statusEl = document.getElementById("status");

init();

saveButton.addEventListener("click", save);
testButton.addEventListener("click", test);

async function init() {
  const response = await chrome.runtime.sendMessage({ type: "SPOT_ASSISTANT_GET_SETTINGS" });
  if (!response?.ok) {
    setStatus(response?.error || "Einstellungen konnten nicht geladen werden.");
    return;
  }
  fill(response.settings);
}

function fill(settings) {
  const mode = settings.mode === "direct" ? "direct" : "server";
  modeInputs.forEach((input) => {
    input.checked = input.value === mode;
  });
  serverUrlInput.value = settings.serverUrl || "";
  modelInput.value = settings.model || "";
  apiKeyInput.value = settings.apiKey || "";
}

async function save() {
  const settings = readForm();
  const response = await chrome.runtime.sendMessage({
    type: "SPOT_ASSISTANT_SAVE_SETTINGS",
    settings
  });
  if (!response?.ok) {
    setStatus(response?.error || "Speichern fehlgeschlagen.");
    return;
  }
  setStatus("Gespeichert.");
}

async function test() {
  await save();
  const response = await chrome.runtime.sendMessage({ type: "SPOT_ASSISTANT_TEST_CONNECTION" });
  setStatus(response?.ok ? response.message || "Verbindung OK." : response?.error || "Test fehlgeschlagen.");
}

function readForm() {
  return {
    mode: modeInputs.find((input) => input.checked)?.value || "server",
    serverUrl: serverUrlInput.value.trim(),
    model: modelInput.value.trim(),
    apiKey: apiKeyInput.value.trim()
  };
}

function setStatus(text) {
  statusEl.textContent = text;
}
