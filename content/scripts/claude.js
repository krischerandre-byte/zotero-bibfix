/* Claude API – Intelligent short title generation and metadata validation */

var BibFixClaude = {
    API_URL: "https://api.anthropic.com/v1/messages",

    _getApiKey() {
        return Zotero.Prefs.get("extensions.bibfix.claudeApiKey", true) || "";
    },

    /**
     * Generate an intelligent short title (Kurztitel) for a bibliographic entry.
     *
     * Convention (ZHF-style):
     * - Author surname + 1-3 distinctive title words
     * - "Der Krieg in Bosnien" → "Krieg in Bosnien" (not "Der Krieg")
     * - Drop articles, filler, generic words at the start
     * - Keep proper nouns, distinctive concepts
     * - For editions without author: just the distinctive title
     */
    async generateShortTitle(item) {
        let apiKey = this._getApiKey();
        if (!apiKey) {
            Zotero.debug("[BibFix Claude] No API key configured");
            return null;
        }

        let creators = item.creators || [];
        let authorStr = creators.filter(c => c.creatorType === "author")
            .map(c => c.lastName).join(", ");
        let editorStr = creators.filter(c => c.creatorType === "editor")
            .map(c => c.lastName).join(", ");
        let title = item.title || "";
        let itemType = item.itemType || "book";

        let prompt = `Du bist ein Experte für bibliografische Konventionen in der deutschsprachigen Geschichtswissenschaft.

Erzeuge einen Kurztitel für folgenden bibliografischen Eintrag. Der Kurztitel wird in Fußnoten verwendet.

REGELN:
1. Der Kurztitel besteht aus dem Nachnamen des Verfassers und 1-3 prägnanten Titelwörtern, getrennt durch Komma.
   Beispiel: "Seifert, Weltlicher Staat"
2. NIEMALS Artikel (Der, Die, Das, Ein, Eine, The, A, An) am Anfang der Titelwörter behalten.
   "Der Krieg in Bosnien" → Kurztitel-Teil: "Krieg in Bosnien" (NICHT "Der Krieg")
3. Wähle die semantisch prägnantesten Wörter, die das Werk eindeutig identifizieren.
   "Begriffsbildung und Theoriestatus in der Friedensforschung" → "Begriffsbildung"
4. Bei Quelleneditionen ohne Verfasser entfällt der Verfassername:
   "Hessische Landtagsakten" → Kurztitel: "Hessische Landtagsakten"
5. Bei Sammelbänden: Herausgebernachname(n) + prägnante Titelwörter:
   "Deutsche Frage und europäisches Gleichgewicht" hrsg. v. Hildebrand/Pommerin → "Hildebrand/Pommerin, Deutsche Frage"
6. Eigennamen und Ortsnamen immer behalten.
7. Maximal 3-4 Wörter im Titelteil.

EINTRAG:
- Typ: ${itemType}
- Titel: ${title}
- Verfasser: ${authorStr || "(kein Verfasser)"}
- Herausgeber: ${editorStr || "(kein Herausgeber)"}

Antworte NUR mit dem Kurztitel, ohne Anführungszeichen, ohne Erklärung.`;

        try {
            let response = await Zotero.HTTP.request("POST", this.API_URL, {
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify({
                    model: "claude-sonnet-4-20250514",
                    max_tokens: 100,
                    messages: [{ role: "user", content: prompt }],
                }),
                timeout: 30000,
                responseType: "json",
            });

            let result = response.response;
            if (result.content && result.content[0] && result.content[0].text) {
                let shortTitle = result.content[0].text.trim();
                Zotero.debug(`[BibFix Claude] Short title: "${shortTitle}"`);
                return shortTitle;
            }
            return null;
        } catch (e) {
            Zotero.debug(`[BibFix Claude] Error: ${e.message}`);
            return null;
        }
    },

    /**
     * Validate and suggest corrections for metadata.
     * Takes existing item data and found results, asks Claude to pick the best match
     * and identify corrections.
     */
    async validateMetadata(existingItem, foundResults) {
        let apiKey = this._getApiKey();
        if (!apiKey) return null;

        let prompt = `Du bist ein Experte für bibliografische Metadaten in der Geschichtswissenschaft.

Vergleiche den bestehenden Zotero-Eintrag mit den gefundenen Katalogdaten und identifiziere Korrekturen.

BESTEHENDER EINTRAG:
${JSON.stringify(existingItem, null, 2)}

GEFUNDENE KATALOGDATEN:
${JSON.stringify(foundResults.slice(0, 3), null, 2)}

Antworte als JSON-Objekt mit folgender Struktur:
{
  "bestMatchIndex": 0,
  "confidence": "high|medium|low",
  "corrections": {
    "fieldName": "korrigierter Wert",
    ...
  },
  "notes": "kurze Erklärung der Änderungen"
}

Regeln:
- Wähle den besten Treffer aus den Katalogdaten (bestMatchIndex)
- Titel IMMER mit vollständigem Untertitel, getrennt durch ". "
- Autorennamen IMMER ausgeschrieben (Vorname Nachname), keine Abkürzungen
- Verlagsorte ohne Länderzusatz, aber mit allen Orten bei Mehrfachorten
- Seitenzahlen bei Aufsätzen sind essentiell
- Reihentitel und Bandnummer in separate Felder
- Unterscheide klar zwischen Autor und Herausgeber
- Wenn confidence "low" ist, schlage keine Änderungen vor

Antworte NUR mit dem JSON-Objekt.`;

        try {
            let response = await Zotero.HTTP.request("POST", this.API_URL, {
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify({
                    model: "claude-sonnet-4-20250514",
                    max_tokens: 1000,
                    messages: [{ role: "user", content: prompt }],
                }),
                timeout: 45000,
                responseType: "json",
            });

            let result = response.response;
            if (result.content && result.content[0] && result.content[0].text) {
                let text = result.content[0].text.trim();
                // Extract JSON from potential markdown code block
                let jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    return JSON.parse(jsonMatch[0]);
                }
            }
            return null;
        } catch (e) {
            Zotero.debug(`[BibFix Claude] Validation error: ${e.message}`);
            return null;
        }
    },
};
