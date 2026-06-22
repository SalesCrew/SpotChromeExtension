(() => {
  const CARD_CLASS = "spot-ai-card";
  const FIELD_SELECTOR = "textarea, input:not([type]), input[type='text'], input[type='search'], input[type='email'], input[type='url'], input[type='tel'], input[type='number'], input[type='date'], input[type='time'], input[type='datetime-local']";
  const IGNORED_TYPES = new Set(["hidden", "button", "submit", "reset", "checkbox", "radio", "file", "password"]);
  const STRUCTURED_TYPES = new Set(["date", "time", "datetime-local"]);

  const state = {
    fields: [],
    results: new Map(),
    running: false,
    fieldCount: null
  };

  boot();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "SPOT_ASSISTANT_PING") {
      const fields = collectFields();
      state.fieldCount = fields.length;
      updatePanel();
      sendResponse({
        ok: true,
        isSpotPage: isSpotPage(),
        fieldCount: fields.length,
        url: location.href,
        title: document.title
      });
      return false;
    }

    if (message?.type === "SPOT_ASSISTANT_RUN") {
      runAnalysis("popup")
        .then((summary) => sendResponse({ ok: true, summary }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message?.type === "SPOT_ASSISTANT_CLEAR") {
      clearCards();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  function boot() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
      init();
    }
  }

  function init() {
    if (!isSpotPage()) {
      return;
    }
    ensurePanel();
    updatePanel("Bereit. Klicke auf Prüfen, wenn die Seite fertig geladen ist.");
  }

  function isSpotPage() {
    return Boolean(document.querySelector("article.interview")) || /\/controlling\//i.test(location.pathname);
  }

  function ensurePanel() {
    if (document.getElementById("spot-ai-panel")) {
      return;
    }

    const panel = document.createElement("aside");
    const version = chrome.runtime.getManifest?.().version || "";
    panel.id = "spot-ai-panel";
    panel.innerHTML = `
      <div class="spot-ai-panel-top">
        <div class="spot-ai-brand">
          <p class="spot-ai-title">Textprüfung${version ? ` v${version}` : ""}</p>
          <p class="spot-ai-subtitle" data-role="field-count">Bereit</p>
        </div>
      </div>
      <div class="spot-ai-actions">
        <button class="spot-ai-button spot-ai-button-primary" type="button" data-action="run">Prüfen</button>
        <button class="spot-ai-button" type="button" title="Vorschläge entfernen" data-action="clear">Leeren</button>
        <button class="spot-ai-button" type="button" title="Einstellungen" data-action="settings">Optionen</button>
      </div>
      <div class="spot-ai-status" data-role="status">Bereit.</div>
    `;

    panel.querySelector("[data-action='run']").addEventListener("click", () => runAnalysis("panel"));
    panel.querySelector("[data-action='clear']").addEventListener("click", clearCards);
    panel.querySelector("[data-action='settings']").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "SPOT_ASSISTANT_OPEN_OPTIONS" });
    });
    document.body.appendChild(panel);
  }

  function updatePanel(statusText) {
    const panel = document.getElementById("spot-ai-panel");
    if (!panel) {
      return;
    }
    const count = panel.querySelector("[data-role='field-count']");
    const status = panel.querySelector("[data-role='status']");
    const button = panel.querySelector("[data-action='run']");
    count.textContent = state.fieldCount === null ? "Bereit" : `${state.fieldCount} prüfbare Felder`;
    status.textContent = statusText || summarizeResults();
    button.disabled = state.running;
    button.textContent = state.running ? "Prüft..." : "Prüfen";
  }

  function summarizeResults() {
    if (!state.results.size) {
      return "Bereit.";
    }
    let grammar = 0;
    let improvements = 0;
    for (const result of state.results.values()) {
      if (result.grammar?.status === "suggested") {
        grammar += 1;
      }
      if (result.improvement?.status === "suggested") {
        improvements += 1;
      }
    }
    return `${grammar} Korrekturen, ${improvements} Verbesserungen gefunden.`;
  }

  async function runAnalysis() {
    if (state.running) {
      return { running: true };
    }

    state.running = true;
    state.results.clear();
    clearCards({ keepResults: true, quiet: true });
    updatePanel("Felder werden gelesen...");

    try {
      const fields = collectFields();
      state.fields = fields;
      state.fieldCount = fields.length;

      if (!fields.length) {
        updatePanel("Keine passenden Textfelder gefunden.");
        return { fieldCount: 0 };
      }

      const localResults = fields.filter((field) => !needsAiReview(field)).map(makeLocalResult);
      for (const result of localResults) {
        state.results.set(result.fieldId, result);
      }
      renderResults(fields, localResults, true);

      const aiFields = fields.filter(needsAiReview);
      if (!aiFields.length) {
        updatePanel("Keine KI-Prüfung nötig.");
        return { fieldCount: fields.length, reviewedCount: 0 };
      }

      updatePanel(`${aiFields.length} Felder werden geprüft...`);
      renderLoading(aiFields);

      const response = await chrome.runtime.sendMessage({
        type: "SPOT_ASSISTANT_ANALYZE",
        payload: {
          page: collectPageContext(),
          fields: aiFields
        }
      });

      if (!response?.ok) {
        throw new Error(response?.error || "AI review failed.");
      }

      const aiResults = response.data?.results || [];
      for (const result of aiResults) {
        state.results.set(result.fieldId, result);
      }

      renderResults(fields, [...localResults, ...aiResults], false);
      updatePanel();
      return {
        fieldCount: fields.length,
        reviewedCount: aiFields.length,
        resultCount: aiResults.length
      };
    } catch (error) {
      showToast(error.message || String(error));
      updatePanel(error.message || "Prüfung fehlgeschlagen.");
      throw error;
    } finally {
      state.running = false;
      updatePanel();
    }
  }

  function collectFields() {
    const root = document.querySelector("article.interview") || document;
    const elements = [...root.querySelectorAll(FIELD_SELECTOR)];
    const fields = [];
    const seenIds = new Set();

    for (const element of elements) {
      if (!isCandidateElement(element)) {
        continue;
      }
      const section = element.closest("section.table");
      if (!section) {
        continue;
      }
      const field = buildField(element, section, fields.length);
      if (!field || seenIds.has(field.fieldId)) {
        continue;
      }
      seenIds.add(field.fieldId);
      element.dataset.spotAssistantFieldId = field.fieldId;
      fields.push(field);
    }

    return fields;
  }

  function isCandidateElement(element) {
    if (element.closest(`.${CARD_CLASS}`) || element.closest("#spot-ai-panel")) {
      return false;
    }
    const type = getInputType(element);
    if (IGNORED_TYPES.has(type)) {
      return false;
    }
    if (element.offsetParent === null && type !== "hidden") {
      const rect = element.getBoundingClientRect();
      if (!rect.width && !rect.height) {
        return false;
      }
    }
    return true;
  }

  function buildField(element, section, index) {
    const row = element.closest(".tr") || element.closest("tr") || section;
    const sectionTitle = cleanText(section.querySelector("header.caption")?.textContent);
    const itemLabel = cleanText(row.querySelector(".item-text")?.textContent);
    const dimensionTitle = cleanText(section.closest(".Dimension")?.querySelector(".PageSubroutine")?.textContent);
    const pageTitle = cleanText((document.querySelector("article.interview > .PageSubroutine") || document.querySelector(".nd .PageSubroutine"))?.textContent);
    const question = [sectionTitle, itemLabel].filter(Boolean).join(" - ") || itemLabel || sectionTitle || "Frage";
    const inputType = getInputType(element);
    const value = getElementValue(element);
    const itemId = row?.dataset?.item || element.name || element.id || index;
    const questionId = section?.dataset?.question || "question";
    const fieldId = `spot-${questionId}-${itemId}-${index}`;
    const selectedOptions = collectSelectedOptions(row, section, element);

    return {
      fieldId,
      question,
      pageTitle,
      dimensionTitle,
      sectionTitle,
      itemLabel,
      selectedOptions,
      inputType,
      maxLength: Number(element.getAttribute("maxlength") || -1),
      value,
      disabled: Boolean(element.disabled),
      readOnly: Boolean(element.readOnly)
    };
  }

  function collectPageContext() {
    return {
      url: location.href,
      title: document.title,
      heading: cleanText(document.querySelector(".page-heading")?.textContent),
      questionnaire: cleanText(document.querySelector(".property .property-value")?.textContent),
      page: cleanText(document.querySelector("article.interview > .PageSubroutine")?.textContent)
    };
  }

  function collectSelectedOptions(row, section, currentElement) {
    const scopes = [row, section].filter(Boolean);
    const selected = [];
    const seen = new Set();

    for (const scope of scopes) {
      const controls = [...scope.querySelectorAll("input[type='checkbox']:checked, input[type='radio']:checked")];
      for (const control of controls) {
        if (control === currentElement) {
          continue;
        }
        const label = cleanChoiceLabel(control);
        const key = label.toLocaleLowerCase("de-AT");
        if (label && !seen.has(key)) {
          seen.add(key);
          selected.push(label);
        }
      }
      if (selected.length) {
        break;
      }
    }

    return selected.slice(0, 6);
  }

  function cleanChoiceLabel(control) {
    const direct = cleanText(control.getAttribute("aria-label") || control.getAttribute("title"));
    if (direct) {
      return direct;
    }

    if (control.id) {
      const explicitLabel = document.querySelector(`label[for="${cssEscape(control.id)}"]`);
      const text = cleanText(explicitLabel?.textContent);
      if (text) {
        return text;
      }
    }

    const label = control.closest("label");
    const labelText = cleanText(label?.textContent);
    if (labelText) {
      return labelText;
    }

    const container = control.closest(".item-value, .answer, .option, .checkbox, .form-check, .td, td, li, div");
    if (!container) {
      return cleanText(control.value);
    }

    const clone = container.cloneNode(true);
    clone.querySelectorAll("input, textarea, select, button, .spot-ai-card").forEach((node) => node.remove());
    return cleanText(clone.textContent || control.value).slice(0, 180);
  }

  function needsAiReview(field) {
    if (!field.value.trim()) {
      return false;
    }
    if (STRUCTURED_TYPES.has(field.inputType)) {
      return false;
    }
    return true;
  }

  function makeLocalResult(field) {
    const empty = !field.value.trim();
    return {
      fieldId: field.fieldId,
      grammar: {
        status: "not_applicable",
        keyword: "NOT_TEXT",
        text: field.value
      },
      improvement: {
        status: "none",
        keyword: "NOTHING_TO_IMPROVE",
        problem: "none",
        label: empty ? "Keine Eingabe" : "Nichts zu verbessern",
        text: field.value
      },
      notes: empty ? "Das Feld ist leer." : "Strukturfeld, keine Textverbesserung nötig."
    };
  }

  function renderLoading(fields) {
    for (const field of fields) {
      const element = findFieldElement(field.fieldId);
      if (!element) {
        continue;
      }
      const card = createCard(field);
      const section = document.createElement("div");
      section.className = "spot-ai-section";
      section.innerHTML = `
        <div class="spot-ai-section-title">
          <span>Analyse</span>
          <span class="spot-ai-pill">Prüft...</span>
        </div>
        <p class="spot-ai-copy spot-ai-muted">Text wird geprüft.</p>
      `;
      card.appendChild(section);
      insertCard(element, card);
    }
  }

  function renderResults(fields, results, preserveMissing) {
    const fieldMap = new Map(fields.map((field) => [field.fieldId, field]));
    for (const result of results) {
      const field = fieldMap.get(result.fieldId);
      if (!field) {
        continue;
      }
      state.results.set(result.fieldId, result);
      renderResult(field, result);
    }

    if (!preserveMissing) {
      for (const field of fields) {
        if (!state.results.has(field.fieldId)) {
          renderResult(field, makeLocalResult(field));
        }
      }
    }
  }

  function renderResult(field, result) {
    const element = findFieldElement(field.fieldId);
    if (!element) {
      return;
    }

    const safeResult = sanitizeResultForDisplay(field, result);
    const card = createCard(field);
    card.appendChild(renderGrammarSection(field, safeResult.grammar));
    card.appendChild(renderImprovementSection(field, safeResult.improvement));
    if (safeResult.notes) {
      const notes = document.createElement("p");
      notes.className = "spot-ai-copy spot-ai-muted";
      notes.textContent = safeResult.notes;
      card.appendChild(notes);
    }
    insertCard(element, card);
  }

  function createCard(field) {
    const card = document.createElement("div");
    card.className = CARD_CLASS;
    card.dataset.fieldId = field.fieldId;

    const header = document.createElement("div");
    header.className = "spot-ai-card-header";

    const question = document.createElement("p");
    question.className = "spot-ai-question";
    question.textContent = field.question || "Frage";

    const pill = document.createElement("span");
    pill.className = "spot-ai-pill";
    pill.textContent = field.inputType;

    header.append(question, pill);
    card.appendChild(header);
    return card;
  }

  function renderGrammarSection(field, grammar) {
    const section = document.createElement("div");
    section.className = "spot-ai-section";
    const status = grammar?.status === "suggested" ? "GRAMMAR_SUGGESTION" : grammar?.keyword;
    section.appendChild(makeSectionTitle("Grammatik", labelForGrammar(grammar), grammar?.status === "suggested" ? "warn" : "ok"));

    if (grammar?.status === "suggested" && grammar.text) {
      section.appendChild(makeSuggestion(field, grammar.text, "Einsetzen"));
    } else {
      const text = document.createElement("p");
      text.className = "spot-ai-copy spot-ai-muted";
      text.textContent = status === "NOT_TEXT" ? "Kein freier Text." : "Keine Tippfehler";
      section.appendChild(text);
    }
    return section;
  }

  function renderImprovementSection(field, improvement) {
    const section = document.createElement("div");
    section.className = "spot-ai-section";
    const isSuggestion = improvement?.status === "suggested" && improvement.text;
    const label = isSuggestion ? problemLabel(improvement) : improvement?.label || "Nichts zu verbessern";
    section.appendChild(makeSectionTitle("Verbesserung", label, isSuggestion ? "warn" : "ok"));

    if (isSuggestion) {
      section.appendChild(makeSuggestion(field, improvement.text, "Einsetzen"));
    } else {
      const text = document.createElement("p");
      text.className = "spot-ai-copy spot-ai-muted";
      text.textContent = improvement?.label || "Nichts zu verbessern";
      section.appendChild(text);
    }
    return section;
  }

  function makeSectionTitle(title, pillText, tone) {
    const wrapper = document.createElement("div");
    wrapper.className = "spot-ai-section-title";
    const titleEl = document.createElement("span");
    titleEl.textContent = title;
    const pill = document.createElement("span");
    pill.className = `spot-ai-pill ${tone === "warn" ? "spot-ai-pill-warn" : "spot-ai-pill-ok"}`;
    pill.textContent = pillText;
    wrapper.append(titleEl, pill);
    return wrapper;
  }

  function makeSuggestion(field, text, buttonLabel) {
    const suggestion = document.createElement("div");
    suggestion.className = "spot-ai-suggestion";

    const copy = document.createElement("p");
    copy.className = "spot-ai-copy";
    copy.textContent = text;

    const footer = document.createElement("div");
    footer.className = "spot-ai-suggestion-footer";

    const count = document.createElement("span");
    count.className = "spot-ai-char-count";
    const max = field.maxLength > 0 ? ` / ${field.maxLength}` : "";
    count.textContent = `${text.length}${max} Zeichen`;

    const button = document.createElement("button");
    button.className = "spot-ai-suggestion-button";
    button.type = "button";
    button.textContent = buttonLabel;
    button.addEventListener("click", () => replaceFieldValue(field.fieldId, text, button));

    footer.append(count, button);
    suggestion.append(copy, footer);
    return suggestion;
  }

  function insertCard(element, card) {
    removeCard(element.dataset.spotAssistantFieldId);
    const container = element.closest(".item-value") || element.parentElement;
    container.appendChild(card);
  }

  function removeCard(fieldId) {
    if (!fieldId) {
      return;
    }
    document.querySelectorAll(`.${CARD_CLASS}[data-field-id="${cssEscape(fieldId)}"]`).forEach((node) => node.remove());
  }

  function clearCards(options = {}) {
    document.querySelectorAll(`.${CARD_CLASS}`).forEach((node) => node.remove());
    document.querySelectorAll(".spot-ai-input-mark").forEach((node) => node.classList.remove("spot-ai-input-mark"));
    if (!options.keepResults) {
      state.results.clear();
    }
    if (!options.quiet) {
      updatePanel("Vorschläge entfernt.");
    }
  }

  function replaceFieldValue(fieldId, value, button) {
    const element = findFieldElement(fieldId);
    if (!element) {
      showToast("Feld nicht gefunden.");
      return;
    }

    element.disabled = false;
    element.readOnly = false;
    setNativeValue(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.classList.add("spot-ai-input-mark");

    button.textContent = "Eingesetzt";
    showToast("Text eingesetzt.");
  }

  function findFieldElement(fieldId) {
    return document.querySelector(`[data-spot-assistant-field-id="${cssEscape(fieldId)}"]`);
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function getElementValue(element) {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.value || "";
    }
    return element.textContent || "";
  }

  function getInputType(element) {
    if (element instanceof HTMLTextAreaElement) {
      return "textarea";
    }
    return String(element.getAttribute("type") || "text").toLowerCase();
  }

  function labelForGrammar(grammar) {
    if (grammar?.status === "suggested") {
      return "Korrektur";
    }
    if (grammar?.keyword === "NOT_TEXT") {
      return "Nicht nötig";
    }
    return "Keine Tippfehler";
  }

  function problemLabel(improvement) {
    if (improvement?.label) {
      return improvement.label;
    }
    const labels = {
      too_short: "Zu kurz",
      too_informal: "Formeller",
      unclear: "Klarer",
      too_wordy: "Kürzer",
      other: "Verbessert",
      none: "Nichts zu verbessern"
    };
    return labels[improvement?.problem] || "Verbessert";
  }

  function sanitizeResultForDisplay(field, result) {
    const next = {
      ...result,
      grammar: { ...(result?.grammar || {}) },
      improvement: { ...(result?.improvement || {}) },
      notes: String(result?.notes || "")
    };

    if (next.improvement?.status === "suggested") {
      const badText = isInstructionLikeText(next.improvement.text, field);
      const badLabel = isInstructionLikeLabel(next.improvement.label);
      if (badText || badLabel) {
        next.improvement = {
          ...next.improvement,
          label: "Verbessert",
          text: replacementFromOriginal(field, next)
        };
      }
    }

    if (isInstructionLikeText(next.notes, field) || isInstructionLikeNote(next.notes)) {
      next.notes = "";
    }

    applyPreteriteRulesForDisplay(next, field);

    return next;
  }

  function applyPreteriteRulesForDisplay(result, field) {
    if (!shouldUsePreterite(field)) {
      return;
    }

    if (result.grammar?.status === "suggested" && result.grammar.text) {
      result.grammar.text = toSimplePreterite(result.grammar.text);
    }

    if (result.improvement?.status === "suggested" && result.improvement.text) {
      result.improvement.text = toSimplePreterite(result.improvement.text);
    }

    if (result.grammar?.status !== "suggested") {
      const original = polishOriginalAnswer(field.value);
      const preterite = toSimplePreterite(original);
      if (preterite !== original) {
        result.grammar = {
          status: "suggested",
          keyword: "GRAMMAR_SUGGESTION",
          text: preterite
        };
      }
    }
  }

  function replacementFromOriginal(field, result) {
    const notTestedReason = makeNotTestedReasonReplacement(field);
    if (notTestedReason) {
      return notTestedReason;
    }

    const grammarText = String(result?.grammar?.text || "").trim();
    if (
      result?.grammar?.status === "suggested" &&
      grammarText &&
      !isInstructionLikeText(grammarText, field)
    ) {
      return grammarText;
    }
    return polishOriginalAnswer(field.value);
  }

  function makeNotTestedReasonReplacement(field) {
    if (!hasNotTestedContext(field)) {
      return "";
    }

    const text = normalizeForRules(field?.value);
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

  function polishOriginalAnswer(value) {
    const original = String(value || "").replace(/\s+/g, " ").trim();
    if (!original) {
      return original;
    }

    const text = `${original.charAt(0).toLocaleUpperCase("de-AT")}${original.slice(1)}`;
    if (text.trim().split(/\s+/).filter(Boolean).length > 1 && /[A-Za-z]/.test(text) && !/[.!?]$/.test(text)) {
      return `${text}.`;
    }
    return text;
  }

  function shouldUsePreterite(field) {
    const value = String(field?.value || "").trim();
    if (!value || value.trim().split(/\s+/).filter(Boolean).length < 2) {
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
    if (text.trim().split(/\s+/).filter(Boolean).length > 1 && /[A-Za-z]/.test(text) && !/[.!?]$/.test(text)) {
      return `${text}.`;
    }
    return text;
  }

  function isInstructionLikeLabel(value) {
    const text = normalizeForRules(value);
    return /(antwort passt nicht|beantwortet|frage nicht|falsch|unklar|inhalt|kommentarfeld|testszenario|szenario)/.test(text);
  }

  function isInstructionLikeNote(value) {
    const text = normalizeForRules(value);
    return /(beantwortet die frage nicht|keine produktangabe|kundengeeigneter inhalt|konkrete obst|konkrete gemuse|passt nicht)/.test(text);
  }

  function isInstructionLikeText(value, field) {
    const text = normalizeForRules(value);
    if (!text) {
      return false;
    }

    const instructionPatterns = [
      /\bbitte\b.*\b(notieren|beschreiben|angeben|kommentieren|erklaren|eintragen|nennen)\b/,
      /\bnotieren\b.*\b(welche|welches|welcher|was|wie)\b/,
      /\bwelche[rsn]?\b.*\b(produkt|sorte|obst|gemuse|fehler|etikett)\b/,
      /\bprodukt\b.*\b(verwendet|angegeben|notiert)\b/,
      /\bkommentarfeld\b/,
      /\btestszenario\b/,
      /\bantwort\b.*\b(passt nicht|sollte|muss|fehlt)\b/,
      /\b(beantwortet|beantworte)\b.*\bfrage\b.*\bnicht\b/,
      /\bkeine\b.*\b(produktangabe|angabe)\b/,
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

  function normalizeForRules(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\u00df/g, "ss")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase("de-AT");
  }

  function cleanText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function showToast(message) {
    const existing = document.querySelector(".spot-ai-toast");
    if (existing) {
      existing.remove();
    }
    const toast = document.createElement("div");
    toast.className = "spot-ai-toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2600);
  }

  function cssEscape(value) {
    if (window.CSS?.escape) {
      return CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }
})();
