import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODEL,
  fetchOpenAIReview
} from "../extension/shared/review-core.js";

loadLocalEnv();

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "";
const API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const MAX_FIELDS = Number(process.env.MAX_FIELDS || 40);
const MAX_FIELD_CHARS = Number(process.env.MAX_FIELD_CHARS || 2200);

const server = createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, {
      ok: true,
      model: MODEL || DEFAULT_MODEL,
      hasApiKey: Boolean(API_KEY)
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/review") {
    await handleReview(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found." });
});

server.listen(PORT, () => {
  console.log(`Spot Assistant server listening on http://localhost:${PORT}`);
});

function loadLocalEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    if (!key || process.env[key]) {
      continue;
    }
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

async function handleReview(req, res) {
  try {
    if (!API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }

    const body = await readJson(req);
    const fields = sanitizeFields(body.fields || []);
    const model = MODEL || body.model || DEFAULT_MODEL;

    const review = await fetchOpenAIReview({
      apiKey: API_KEY,
      model,
      page: sanitizePage(body.page || {}),
      fields,
      apiBase: API_BASE
    });

    sendJson(res, 200, {
      ok: true,
      model,
      data: review
    });
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: error.message || String(error)
    });
  }
}

function sanitizeFields(fields) {
  if (!Array.isArray(fields)) {
    return [];
  }

  return fields.slice(0, MAX_FIELDS).map((field) => ({
    ...field,
    fieldId: String(field.fieldId || ""),
    question: limit(String(field.question || ""), 800),
    pageTitle: limit(String(field.pageTitle || ""), 300),
    dimensionTitle: limit(String(field.dimensionTitle || ""), 300),
    sectionTitle: limit(String(field.sectionTitle || ""), 300),
    itemLabel: limit(String(field.itemLabel || ""), 500),
    inputType: limit(String(field.inputType || "text"), 40),
    maxLength: Number(field.maxLength || -1),
    value: limit(String(field.value || ""), MAX_FIELD_CHARS)
  }));
}

function sanitizePage(page) {
  return {
    url: limit(String(page.url || ""), 1000),
    title: limit(String(page.title || ""), 300),
    heading: limit(String(page.heading || ""), 300),
    questionnaire: limit(String(page.questionnaire || ""), 300),
    page: limit(String(page.page || ""), 300)
  };
}

function limit(value, maxLength) {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 750000) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Spot-Assistant-Version");
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
