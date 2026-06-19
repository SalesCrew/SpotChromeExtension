import {
  DEFAULT_SETTINGS,
  fetchOpenAIReview,
  normalizeReviewPayload
} from "./shared/review-core.js";

const SETTINGS_KEY = "spotAssistantSettings";
const REQUEST_TIMEOUT_MS = 90000;
const LEGACY_LOCAL_SERVER_URL = "http://localhost:8787/v1/review";

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    return;
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: migrateSettings(stored[SETTINGS_KEY]) });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "SPOT_ASSISTANT_ANALYZE":
      return analyzeFields(message.payload);
    case "SPOT_ASSISTANT_GET_SETTINGS":
      return { ok: true, settings: await getSettings() };
    case "SPOT_ASSISTANT_SAVE_SETTINGS":
      return saveSettings(message.settings);
    case "SPOT_ASSISTANT_OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    case "SPOT_ASSISTANT_TEST_CONNECTION":
      return testConnection();
    default:
      return { ok: false, error: "Unknown Spot Assistant message." };
  }
}

async function analyzeFields(payload) {
  const settings = await getSettings();
  const fields = Array.isArray(payload?.fields) ? payload.fields : [];
  if (!fields.length) {
    return { ok: true, data: { results: [], model: settings.model, source: settings.mode } };
  }

  if (settings.mode === "direct") {
    const data = await withTimeout(
      fetchOpenAIReview({
        apiKey: settings.apiKey,
        model: settings.model,
        page: payload.page,
        fields
      }),
      REQUEST_TIMEOUT_MS
    );
    return { ok: true, data: { ...data, model: settings.model, source: "direct" } };
  }

  const data = await withTimeout(callServer(settings, payload), REQUEST_TIMEOUT_MS);
  return { ok: true, data };
}

async function callServer(settings, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(settings.serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Spot-Assistant-Version": chrome.runtime.getManifest().version
      },
      body: JSON.stringify({
        page: payload.page,
        fields: payload.fields,
        model: settings.model
      }),
      signal: controller.signal
    });

    const bodyText = await response.text();
    const body = bodyText ? JSON.parse(bodyText) : {};

    if (!response.ok || body.ok === false) {
      throw new Error(body.error || `Server request failed with ${response.status}.`);
    }

    const normalized = normalizeReviewPayload(body.data || body);
    return {
      ...normalized,
      model: body.model || body.data?.model || settings.model,
      source: "server"
    };
  } finally {
    clearTimeout(timer);
  }
}

async function testConnection() {
  const settings = await getSettings();
  if (settings.mode === "direct") {
    if (!settings.apiKey) {
      return { ok: false, error: "Direct mode needs an OpenAI API key." };
    }
    return { ok: true, message: "Direct mode is configured." };
  }

  const healthUrl = settings.serverUrl.replace(/\/v1\/review\/?$/, "/health");
  const response = await fetch(healthUrl, { method: "GET" });
  if (!response.ok) {
    return { ok: false, error: `Server health check failed with ${response.status}.` };
  }
  return { ok: true, message: "Server is reachable." };
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = migrateSettings({
    ...DEFAULT_SETTINGS,
    ...(stored[SETTINGS_KEY] || {})
  });
  if (JSON.stringify(settings) !== JSON.stringify(stored[SETTINGS_KEY] || {})) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }
  return settings;
}

async function saveSettings(nextSettings) {
  const current = await getSettings();
  const clean = {
    ...current,
    mode: nextSettings?.mode === "direct" ? "direct" : "server",
    serverUrl: String(nextSettings?.serverUrl || DEFAULT_SETTINGS.serverUrl).trim(),
    model: String(nextSettings?.model || DEFAULT_SETTINGS.model).trim(),
    apiKey: String(nextSettings?.apiKey || "")
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: clean });
  return { ok: true, settings: clean };
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("The AI request timed out.")), timeoutMs);
    })
  ]);
}

function migrateSettings(settings) {
  const next = {
    ...DEFAULT_SETTINGS,
    ...(settings || {})
  };
  if (!next.serverUrl || next.serverUrl === LEGACY_LOCAL_SERVER_URL) {
    next.serverUrl = DEFAULT_SETTINGS.serverUrl;
  }
  return next;
}
