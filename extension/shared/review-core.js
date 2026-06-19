export const DEFAULT_MODEL = "gpt-5.4-nano";

export const DEFAULT_SETTINGS = {
  mode: "server",
  serverUrl: "https://spotchromeextension-production.up.railway.app/v1/review",
  model: DEFAULT_MODEL,
  apiKey: ""
};

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fieldId", "grammar", "improvement", "notes"],
        properties: {
          fieldId: { type: "string" },
          grammar: {
            type: "object",
            additionalProperties: false,
            required: ["status", "keyword", "text"],
            properties: {
              status: {
                type: "string",
                enum: ["clean", "suggested", "not_applicable"]
              },
              keyword: {
                type: "string",
                enum: ["NO_TYPOS", "GRAMMAR_SUGGESTION", "NOT_TEXT"]
              },
              text: { type: "string" }
            }
          },
          improvement: {
            type: "object",
            additionalProperties: false,
            required: ["status", "keyword", "problem", "label", "text"],
            properties: {
              status: {
                type: "string",
                enum: ["none", "suggested"]
              },
              keyword: {
                type: "string",
                enum: ["NOTHING_TO_IMPROVE", "IMPROVEMENT_SUGGESTION"]
              },
              problem: {
                type: "string",
                enum: ["none", "too_short", "too_informal", "unclear", "too_wordy", "other"]
              },
              label: { type: "string" },
              text: { type: "string" }
            }
          },
          notes: { type: "string" }
        }
      }
    }
  }
};

const SYSTEM_PROMPT = [
  "You are a quality-control assistant for German/Austrian mystery shopping questionnaires.",
  "Your job is to make answers customer-ready without inventing facts.",
  "",
  "For every field:",
  "- Use the question context to decide whether the answer is prose or a structured short answer.",
  "- If the answer is a date, time, ID, number, name, location, code, or another short answer that fits the question, do not expand it.",
  "- Grammar section: fix real typos, grammar, punctuation inside sentences, casing, and obvious sentence structure only. If no correction is needed, set keyword NO_TYPOS.",
  "- Do not create a grammar suggestion just to add a final period to a one-word answer, short fragment, name, code, number, date, or time.",
  "- Improvement section: suggest a concise better business version only if the answer is too short for a prose question, too informal, unclear, too wordy, or not customer-ready.",
  "- If the problem is too_short, rewrite the original answer as if you were the mystery shopper and explain the same observation in one or two additional concise sentences.",
  "- Too-short expansions must use only the original answer plus question context. Do not add new facts, guesses, causes, emotions, ratings, names, dates, prices, or details that are not implied by the text.",
  "- If you expand an answer, keep the meaning faithful to the original and avoid generic filler.",
  "- Keep the language of the original answer and question. Usually this is German.",
  "- Use a professional, neutral Austrian/German business tone.",
  "- Do not add filler, marketing language, unverifiable details, names, dates, prices, ratings, or claims not present in the original.",
  "- Return only data that matches the JSON schema."
].join("\n");

export function buildOpenAIRequest({ model = DEFAULT_MODEL, page, fields }) {
  return {
    model,
    input: [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: "Review these Spot questionnaire answers.",
            page,
            fields: fields.map(toModelField)
          },
          null,
          2
        )
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "spot_field_review",
        schema: REVIEW_SCHEMA,
        strict: true
      }
    }
  };
}

export function toModelField(field) {
  return {
    fieldId: String(field.fieldId || ""),
    question: String(field.question || ""),
    pageTitle: String(field.pageTitle || ""),
    dimensionTitle: String(field.dimensionTitle || ""),
    sectionTitle: String(field.sectionTitle || ""),
    itemLabel: String(field.itemLabel || ""),
    inputType: String(field.inputType || "text"),
    maxLength: Number.isFinite(field.maxLength) ? field.maxLength : -1,
    answer: limitText(String(field.value || ""), 2200)
  };
}

export function extractOpenAIText(responseJson) {
  if (typeof responseJson?.output_text === "string") {
    return responseJson.output_text;
  }

  const chunks = [];
  for (const outputItem of responseJson?.output || []) {
    if (typeof outputItem?.text === "string") {
      chunks.push(outputItem.text);
    }

    for (const contentItem of outputItem?.content || []) {
      if (typeof contentItem?.text === "string") {
        chunks.push(contentItem.text);
      }
      if (typeof contentItem?.refusal === "string") {
        throw new Error(`OpenAI refused the request: ${contentItem.refusal}`);
      }
    }
  }

  const text = chunks.join("\n").trim();
  if (!text) {
    throw new Error("OpenAI response did not contain output text.");
  }
  return text;
}

export function parseReviewPayload(rawText, fields = []) {
  const trimmed = rawText.trim();
  const jsonText = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim()
    : trimmed;
  const parsed = JSON.parse(jsonText);
  return normalizeReviewPayload(parsed, fields);
}

export function normalizeReviewPayload(payload, fields = []) {
  if (!payload || !Array.isArray(payload.results)) {
    throw new Error("Review payload is missing a results array.");
  }

  const normalized = {
    results: payload.results.map((result) => ({
      fieldId: String(result.fieldId || ""),
      grammar: {
        status: safeEnum(result.grammar?.status, ["clean", "suggested", "not_applicable"], "clean"),
        keyword: safeEnum(result.grammar?.keyword, ["NO_TYPOS", "GRAMMAR_SUGGESTION", "NOT_TEXT"], "NO_TYPOS"),
        text: String(result.grammar?.text || "")
      },
      improvement: {
        status: safeEnum(result.improvement?.status, ["none", "suggested"], "none"),
        keyword: safeEnum(
          result.improvement?.keyword,
          ["NOTHING_TO_IMPROVE", "IMPROVEMENT_SUGGESTION"],
          "NOTHING_TO_IMPROVE"
        ),
        problem: safeEnum(
          result.improvement?.problem,
          ["none", "too_short", "too_informal", "unclear", "too_wordy", "other"],
          "none"
        ),
        label: String(result.improvement?.label || ""),
        text: String(result.improvement?.text || "")
      },
      notes: String(result.notes || "")
    }))
  };

  return applyLocalReviewRules(normalized, fields);
}

export async function fetchOpenAIReview({ apiKey, model, page, fields, apiBase = "https://api.openai.com" }) {
  if (!apiKey) {
    throw new Error("Missing OpenAI API key.");
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    return { results: [] };
  }

  const response = await fetch(`${apiBase.replace(/\/$/, "")}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(buildOpenAIRequest({ model, page, fields }))
  });

  const responseText = await response.text();
  let responseJson = null;
  try {
    responseJson = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseJson = null;
  }

  if (!response.ok) {
    const message = responseJson?.error?.message || responseText || `OpenAI request failed with ${response.status}.`;
    throw new Error(message);
  }

  return parseReviewPayload(extractOpenAIText(responseJson), fields);
}

export function limitText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function safeEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function applyLocalReviewRules(review, fields) {
  const fieldMap = new Map((fields || []).map((field) => [String(field.fieldId || ""), field]));
  return {
    results: review.results.map((result) => {
      const field = fieldMap.get(result.fieldId);
      if (!field) {
        return result;
      }

      if (isOnlyUnneededFinalPunctuation(field.value, result.grammar?.text)) {
        return {
          ...result,
          grammar: {
            status: "clean",
            keyword: "NO_TYPOS",
            text: String(field.value || "")
          },
          notes: result.notes || "Kurze Antwort passt ohne zusätzlichen Schlusspunkt."
        };
      }

      return result;
    })
  };
}

function isOnlyUnneededFinalPunctuation(originalValue, suggestionValue) {
  const original = String(originalValue || "").trim();
  const suggestion = String(suggestionValue || "").trim();
  if (!original || !suggestion || original === suggestion) {
    return false;
  }

  if (countWords(original) > 3 || original.length > 40) {
    return false;
  }

  return normalizeShortAnswer(original) === normalizeShortAnswer(suggestion);
}

function normalizeShortAnswer(value) {
  return value
    .trim()
    .replace(/[.!?;:]+$/g, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("de-AT");
}

function countWords(value) {
  return value.trim().split(/\s+/).filter(Boolean).length;
}
