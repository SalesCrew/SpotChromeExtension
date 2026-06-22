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
  "- Treat the current answer as the only source text. Preserve its core meaning, sentiment, subject, negation, and facts 1:1.",
  "- Use the question context only to understand what the existing answer likely refers to. Never use the question text to create missing details.",
  "- Selected options are part of the answer context. If a selected option says a scenario was not tested, rewrite a short reason in the answer as a professional reason for not testing that scenario.",
  "- Customer-ready prose answers must normally be written in German Präteritum because the visit already happened.",
  "- If a prose answer is in Präsens, Perfekt, or Futur, convert it to Präteritum while preserving the exact same content.",
  "- Do not force Präteritum for dates, times, IDs, numbers, names, codes, product names, or other structured short answers.",
  "- If the answer does not contain the detail requested by the question, do not ask for it, do not mention that it is missing, and do not invent it.",
  "- If an answer cannot be improved while preserving the exact same content, set improvement.status to none.",
  "- Decide whether the answer is prose or a structured short answer.",
  "- If the answer is a date, time, ID, number, name, location, code, or another short answer that fits the question, do not expand it.",
  "- Grammar section: fix real typos, grammar, punctuation inside sentences, casing, and obvious sentence structure only. If no correction is needed, set keyword NO_TYPOS.",
  "- Grammar section: if a prose answer is otherwise correct but not in Präteritum, return a grammar suggestion in Präteritum.",
  "- Do not create a grammar suggestion just to add a final period to a one-word answer, short fragment, name, code, number, date, or time.",
  "- Improvement section: write the final replacement answer that can be sent to the customer. Never write advice, instructions, critique, or placeholders.",
  "- Improvement section: all prose replacement answers must be in Präteritum unless the answer is a structured short answer.",
  "- If the answer contains slang, profanity, insults, or emotional wording, convert it into a professional mystery-shopper observation with the same meaning.",
  "- Example: for an answer like 'Sie war kacke zu mir', the improved text should be like 'Die Mitarbeiterin war mir gegenueber sehr unfreundlich, wodurch die Situation unangenehm wirkte.'",
  "- Never return text like 'Bitte sachlich formulieren', 'Bitte bearbeiten', 'Bitte notieren...', 'Formulieren Sie...', 'Der Text sollte...', 'Die Antwort sollte...', or 'Ich kann das nicht bewerten' as a suggestion.",
  "- Never copy the questionnaire instruction as the replacement answer.",
  "- Suggest a concise better business version only if the answer is too informal, unclear, too wordy, or not customer-ready and can be rewritten without adding facts.",
  "- If the problem is too_short, make the smallest professional rewrite of the original answer. Do not add extra observations, explanations, products, varieties, people, causes, emotions, ratings, names, dates, prices, or details.",
  "- Keep the improved text close to the original length unless the original contains informal or abusive language that needs neutral wording.",
  "- If you rewrite an answer, keep the meaning faithful to the original and avoid generic filler.",
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
            task: "Rewrite only each field's current answer text. The replacement must never be an instruction to the worker or copied questionnaire prompt text.",
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
    selectedOptions: Array.isArray(field.selectedOptions)
      ? field.selectedOptions.map((option) => limitText(String(option || ""), 220)).filter(Boolean).slice(0, 6)
      : [],
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

      let next = result;

      if (isOnlyUnneededFinalPunctuation(field.value, result.grammar?.text)) {
        next = {
          ...next,
          grammar: {
            status: "clean",
            keyword: "NO_TYPOS",
            text: String(field.value || "")
          },
          notes: result.notes || "Kurze Antwort passt ohne zusätzlichen Schlusspunkt."
        };
      }

      if (next.improvement?.status === "suggested") {
        if (isMetaEditingAdvice(next.improvement.text) || isQuestionInstructionLeak(next.improvement.text, field)) {
          return applyPreteriteRules({
            ...next,
            improvement: {
              ...next.improvement,
              label: cleanImprovementLabel(next.improvement.label),
              text: makeDirectReplacement(field, next)
            },
            notes: ""
          }, field);
        }
      }

      return applyPreteriteRules(next, field);
    })
  };
}

function applyPreteriteRules(result, field) {
  if (!shouldUsePreterite(field)) {
    return result;
  }

  const next = {
    ...result,
    grammar: { ...(result?.grammar || {}) },
    improvement: { ...(result?.improvement || {}) }
  };

  if (next.grammar?.status === "suggested" && next.grammar.text) {
    next.grammar.text = toSimplePreterite(next.grammar.text);
  }

  if (next.improvement?.status === "suggested" && next.improvement.text) {
    next.improvement.text = toSimplePreterite(next.improvement.text);
  }

  if (next.grammar?.status !== "suggested") {
    const original = polishOriginalAnswer(field.value);
    const preterite = toSimplePreterite(original);
    if (preterite !== original) {
      next.grammar = {
        status: "suggested",
        keyword: "GRAMMAR_SUGGESTION",
        text: preterite
      };
    }
  }

  return next;
}

function isMetaEditingAdvice(value) {
  const text = normalizeForRules(value);
  if (!text) {
    return false;
  }

  return [
    "bitte ",
    "formulieren sie",
    "der text sollte",
    "die antwort sollte",
    "sachlich formul",
    "bearbeiten sie",
    "ueberarbeiten sie",
    "uberarbeiten sie",
    "notieren sie",
    "geben sie",
    "tragen sie",
    "überarbeiten sie",
    "ich kann",
    "als ki"
  ].some((pattern) => text.includes(pattern));
}

function isQuestionInstructionLeak(value, field) {
  const text = normalizeForRules(value);
  if (!text) {
    return false;
  }

  const instructionPatterns = [
    /\bbitte\b.*\b(notieren|beschreiben|angeben|kommentieren|erklaren)\b/,
    /\bwelche[rsn]?\b.*\b(produkt|sorte|obst|gemuse|fehler|etikett)\b/,
    /\bprodukt\b.*\bverwendet\b/,
    /\bkommentarfeld\b/,
    /\btestszenario\b/,
    /\bantwort\b.*\bpasst nicht\b/,
    /\bpasst nicht\b.*\b(kommentarfeld|szenario|frage)\b/,
    /\bgeforderten\b.*\b(kommentarfeld|frage|szenario)\b/
  ];

  if (instructionPatterns.some((pattern) => pattern.test(text))) {
    return true;
  }

  const questionText = normalizeForRules([
    field?.question,
    field?.itemLabel,
    field?.sectionTitle,
    field?.dimensionTitle
  ].filter(Boolean).join(" "));
  const answerText = normalizeForRules(field?.value);

  return isMostlyCopiedFromContext(text, questionText, answerText);
}

function cleanImprovementLabel(value) {
  const label = String(value || "").trim();
  const normalized = normalizeForRules(label);
  if (
    !label ||
    isMetaEditingAdvice(label) ||
    /(falsch|unklar|inhalt|passt nicht|beantwortet|frage nicht|kommentarfeld|testszenario)/.test(normalized)
  ) {
    return "Verbessert";
  }
  return label;
}

function makeDirectReplacement(field, result) {
  const original = String(field.value || "").trim();
  const lower = original.toLocaleLowerCase("de-AT");
  const notTestedReason = makeNotTestedReasonReplacement(field, original);
  if (notTestedReason) {
    return notTestedReason;
  }

  if (/\bsie\b.*\b(kacke|scheisse|scheiße|beschissen|mies)\b.*\b(zu mir|mir gegenueber|mir gegenüber)\b/.test(lower)) {
    return "Die Mitarbeiterin war mir gegenüber sehr unfreundlich, wodurch die Situation unangenehm wirkte.";
  }

  if (/\ber\b.*\b(kacke|scheisse|scheiße|beschissen|mies)\b.*\b(zu mir|mir gegenueber|mir gegenüber)\b/.test(lower)) {
    return "Der Mitarbeiter war mir gegenüber sehr unfreundlich, wodurch die Situation unangenehm wirkte.";
  }

  if (/\b(kacke|scheisse|scheiße|beschissen|mies)\b/.test(lower)) {
    return "Die Situation wirkte sehr unfreundlich und hinterließ keinen professionellen Eindruck.";
  }

  const grammarText = String(result?.grammar?.text || "").trim();
  if (
    result?.grammar?.status === "suggested" &&
    grammarText &&
    !isMetaEditingAdvice(grammarText) &&
    !isQuestionInstructionLeak(grammarText, field)
  ) {
    return grammarText;
  }

  return polishOriginalAnswer(original);
}

function makeNotTestedReasonReplacement(field, original) {
  if (!hasNotTestedContext(field)) {
    return "";
  }

  const text = normalizeForRules(original);
  if (/\b(mude|muede|muedigkeit|erschopft|fertig)\b/.test(text)) {
    return "Aufgrund meiner Müdigkeit konnte ich dieses Szenario nicht mehr testen.";
  }

  if (/\b(keine zeit|zeitmangel|nicht geschafft|nicht mehr geschafft|zu lange|lange gedauert)\b/.test(text)) {
    return "Aufgrund des langen Einsatzverlaufs konnte ich dieses Szenario nicht mehr testen.";
  }

  return "";
}

function hasNotTestedContext(field) {
  const context = normalizeForRules([
    field?.question,
    field?.itemLabel,
    field?.sectionTitle,
    ...(Array.isArray(field?.selectedOptions) ? field.selectedOptions : [])
  ].filter(Boolean).join(" "));

  return /szenario/.test(context) && /(nicht getestet|wurde nicht getestet|nicht durchgefuehrt|nicht durchgefuhrt)/.test(context);
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

function polishOriginalAnswer(value) {
  const original = String(value || "").replace(/\s+/g, " ").trim();
  if (!original) {
    return original;
  }

  const first = original.charAt(0);
  const text = `${first.toLocaleUpperCase("de-AT")}${original.slice(1)}`;
  if (countWords(text) > 1 && /[A-Za-z]/.test(text) && !/[.!?]$/.test(text)) {
    return `${text}.`;
  }
  return text;
}

function shouldUsePreterite(field) {
  const value = String(field?.value || "").trim();
  if (!value || countWords(value) < 2) {
    return false;
  }

  const inputType = String(field?.inputType || "text").toLowerCase();
  if (["date", "time", "datetime-local", "number"].includes(inputType)) {
    return false;
  }

  if (/^\d+([:.,/-]\d+)*$/.test(value) || /^[A-Z0-9_-]{2,}$/i.test(value)) {
    return false;
  }

  return true;
}

function toSimplePreterite(value) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return text;
  }

  const replacements = [
    [/\bich bin\b/gi, "ich war"],
    [/\bdu bist\b/gi, "du warst"],
    [/\ber ist\b/gi, "er war"],
    [/\bsie ist\b/gi, "sie war"],
    [/\bes ist\b/gi, "es war"],
    [/\bwir sind\b/gi, "wir waren"],
    [/\bihr seid\b/gi, "ihr wart"],
    [/\bsie sind\b/gi, "sie waren"],
    [/\bich habe\b/gi, "ich hatte"],
    [/\bdu hast\b/gi, "du hattest"],
    [/\ber hat\b/gi, "er hatte"],
    [/\bsie hat\b/gi, "sie hatte"],
    [/\bes hat\b/gi, "es hatte"],
    [/\bwir haben\b/gi, "wir hatten"],
    [/\bihr habt\b/gi, "ihr hattet"],
    [/\bsie haben\b/gi, "sie hatten"],
    [/\bist\b/gi, "war"],
    [/\bsind\b/gi, "waren"],
    [/\bhat\b/gi, "hatte"],
    [/\bhabe\b/gi, "hatte"],
    [/\bhaben\b/gi, "hatten"],
    [/\bwird\b/gi, "wurde"],
    [/\bwerden\b/gi, "wurden"],
    [/\bwirkt\b/gi, "wirkte"],
    [/\bwirken\b/gi, "wirkten"],
    [/\bgeht\b/gi, "ging"],
    [/\bgehen\b/gi, "gingen"],
    [/\bmacht\b/gi, "machte"],
    [/\bmachen\b/gi, "machten"],
    [/\bkommt\b/gi, "kam"],
    [/\bkommen\b/gi, "kamen"],
    [/\bsagt\b/gi, "sagte"],
    [/\bsagen\b/gi, "sagten"],
    [/\bfragt\b/gi, "fragte"],
    [/\bfragen\b/gi, "fragten"],
    [/\bzeigt\b/gi, "zeigte"],
    [/\bzeigen\b/gi, "zeigten"],
    [/\berkennt\b/gi, "erkannte"],
    [/\berkennen\b/gi, "erkannten"],
    [/\bkassieren\b/gi, "kassierten"],
    [/\breagieren\b/gi, "reagierten"]
  ];

  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }

  text = `${text.charAt(0).toLocaleUpperCase("de-AT")}${text.slice(1)}`;
  if (countWords(text) > 1 && /[A-Za-z]/.test(text) && !/[.!?]$/.test(text)) {
    return `${text}.`;
  }
  return text;
}

function normalizeForRules(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00df/g, "ss")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("de-AT");
}

function isMostlyCopiedFromContext(suggestion, questionText, answerText) {
  const suggestionTokens = meaningfulTokens(suggestion);
  if (suggestionTokens.length < 5) {
    return false;
  }

  const questionTokens = new Set(meaningfulTokens(questionText));
  if (questionTokens.size < 5) {
    return false;
  }

  const answerTokens = new Set(meaningfulTokens(answerText));
  let contextMatches = 0;
  let answerMatches = 0;

  for (const token of suggestionTokens) {
    if (questionTokens.has(token)) {
      contextMatches += 1;
    }
    if (answerTokens.has(token)) {
      answerMatches += 1;
    }
  }

  return contextMatches >= 4 && contextMatches / suggestionTokens.length >= 0.55 && answerMatches <= 1;
}

function meaningfulTokens(value) {
  const stopWords = new Set([
    "aber",
    "als",
    "am",
    "an",
    "auch",
    "auf",
    "bei",
    "das",
    "den",
    "der",
    "des",
    "die",
    "dies",
    "diese",
    "diesem",
    "diesen",
    "dieser",
    "dieses",
    "ein",
    "eine",
    "einem",
    "einen",
    "einer",
    "es",
    "fuer",
    "im",
    "in",
    "ist",
    "mit",
    "sie",
    "und",
    "war",
    "wurde",
    "zu",
    "zum",
    "zur"
  ]);

  return normalizeForRules(value)
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stopWords.has(token));
}
