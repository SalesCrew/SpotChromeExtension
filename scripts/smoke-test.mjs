import assert from "node:assert/strict";
import {
  DEFAULT_MODEL,
  buildOpenAIRequest,
  parseReviewPayload
} from "../extension/shared/review-core.js";

const fields = [
  {
    fieldId: "spot-1-1-0",
    question: "Wie war der Eindruck an der Kassa?",
    pageTitle: "Besuchsdetails",
    dimensionTitle: "Service",
    sectionTitle: "Kassa",
    itemLabel: "Bitte beschreiben Sie die Situation.",
    inputType: "textarea",
    maxLength: 2000,
    value: "war ok aber kassiererin bissl unfreundlich"
  }
];

const request = buildOpenAIRequest({
  model: DEFAULT_MODEL,
  page: { title: "Spot Test" },
  fields
});

assert.equal(request.model, DEFAULT_MODEL);
assert.equal(request.input.length, 2);
assert.equal(request.text.format.type, "json_schema");
assert.equal(request.text.format.schema.properties.results.type, "array");

const contextualRequest = buildOpenAIRequest({
  model: DEFAULT_MODEL,
  page: { title: "Spot Test" },
  fields: [{ ...fields[0], selectedOptions: ["dieses Szenario wurde nicht getestet"] }]
});

assert.deepEqual(
  JSON.parse(contextualRequest.input[1].content).fields[0].selectedOptions,
  ["dieses Szenario wurde nicht getestet"]
);

const parsed = parseReviewPayload(JSON.stringify({
  results: [
    {
      fieldId: "spot-1-1-0",
      grammar: {
        status: "suggested",
        keyword: "GRAMMAR_SUGGESTION",
        text: "War ok, aber die Kassiererin war etwas unfreundlich."
      },
      improvement: {
        status: "suggested",
        keyword: "IMPROVEMENT_SUGGESTION",
        problem: "too_informal",
        label: "Formeller",
        text: "Der Ablauf an der Kassa war grundsätzlich in Ordnung. Die Kassiererin wirkte jedoch etwas unfreundlich."
      },
      notes: "Informal wording was adjusted."
    }
  ]
}), fields);

assert.equal(parsed.results[0].improvement.problem, "too_informal");

const punctuationOnly = parseReviewPayload(JSON.stringify({
  results: [
    {
      fieldId: "spot-1-1-0",
      grammar: {
        status: "suggested",
        keyword: "GRAMMAR_SUGGESTION",
        text: "Ok."
      },
      improvement: {
        status: "none",
        keyword: "NOTHING_TO_IMPROVE",
        problem: "none",
        label: "Nichts zu verbessern",
        text: "Ok"
      },
      notes: ""
    }
  ]
}), [{ ...fields[0], value: "Ok" }]);

assert.equal(punctuationOnly.results[0].grammar.keyword, "NO_TYPOS");

const metaAdvice = parseReviewPayload(JSON.stringify({
  results: [
    {
      fieldId: "spot-1-1-0",
      grammar: {
        status: "suggested",
        keyword: "GRAMMAR_SUGGESTION",
        text: "Sie war kacke zu mir."
      },
      improvement: {
        status: "suggested",
        keyword: "IMPROVEMENT_SUGGESTION",
        problem: "too_informal",
        label: "Formeller",
        text: "Bitte bearbeiten Sie die Antwort sachlich."
      },
      notes: ""
    }
  ]
}), [{ ...fields[0], value: "Sie war kacke zu mir" }]);

assert.equal(
  metaAdvice.results[0].improvement.text,
  "Die Mitarbeiterin war mir gegenüber sehr unfreundlich, wodurch die Situation unangenehm wirkte."
);
const copiedQuestionInstruction = parseReviewPayload(JSON.stringify({
  results: [
    {
      fieldId: "spot-1-1-0",
      grammar: {
        status: "suggested",
        keyword: "GRAMMAR_SUGGESTION",
        text: "War super."
      },
      improvement: {
        status: "suggested",
        keyword: "IMPROVEMENT_SUGGESTION",
        problem: "unclear",
        label: "Falscher/unklarer Inhalt",
        text: "Bitte notieren Sie, welches Obst/Gemuese betroffen war und wie der Etikettierungsfehler korrekt erkannt und kassiert wurde."
      },
      notes: ""
    }
  ]
}), [{
  ...fields[0],
  question: "Szenario 4: Die Kassakraft entdeckt den Fehler bei der Etikettierung des Obstes/Gemueses und kassiert dieses korrekt. - Kommentarfeld:",
  value: "war super"
}]);

assert.equal(copiedQuestionInstruction.results[0].improvement.text, "War super.");
assert.equal(copiedQuestionInstruction.results[0].improvement.label, "Verbessert");

const bareQuestionInstruction = parseReviewPayload(JSON.stringify({
  results: [
    {
      fieldId: "spot-1-1-0",
      grammar: {
        status: "clean",
        keyword: "NO_TYPOS",
        text: "war super"
      },
      improvement: {
        status: "suggested",
        keyword: "IMPROVEMENT_SUGGESTION",
        problem: "unclear",
        label: "Falscher/unklarer Inhalt",
        text: "Welches Produkt bzw. welche unterschiedlichen Sorten fuer dieses Testszenario verwendet wurden."
      },
      notes: ""
    }
  ]
}), [{
  ...fields[0],
  question: "Bitte notieren Sie im Kommentarfeld, welches Produkt bzw. welche unterschiedlichen Sorten fuer dieses Testszenario verwendet wurden:",
  value: "war super"
}]);

assert.equal(bareQuestionInstruction.results[0].improvement.text, "War super.");
assert.equal(bareQuestionInstruction.results[0].improvement.label, "Verbessert");

const notTestedReason = parseReviewPayload(JSON.stringify({
  results: [
    {
      fieldId: "spot-1-1-0",
      grammar: {
        status: "suggested",
        keyword: "GRAMMAR_SUGGESTION",
        text: "War müde."
      },
      improvement: {
        status: "suggested",
        keyword: "IMPROVEMENT_SUGGESTION",
        problem: "unclear",
        label: "Antwort beantwortet die Frage nicht",
        text: "Bitte notieren Sie, welches Produkt für dieses Testszenario verwendet wurde."
      },
      notes: "\"War müde\" passt nicht zum Szenario."
    }
  ]
}), [{
  ...fields[0],
  question: "Szenario 3: Bitte notieren Sie im Kommentarfeld, welches Produkt für dieses Testszenario verwendet wurde:",
  selectedOptions: ["dieses Szenario wurde nicht getestet"],
  value: "War müde"
}]);

assert.equal(
  notTestedReason.results[0].improvement.text,
  "Aufgrund meiner Müdigkeit konnte ich dieses Szenario nicht mehr testen."
);
assert.equal(notTestedReason.results[0].improvement.label, "Verbessert");

console.log("Smoke test passed.");
