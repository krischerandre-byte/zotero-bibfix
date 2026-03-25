/**
 * BibFix - Zotero Plugin for Bibliographic Metadata Optimization
 * Structure follows zotero-format-metadata (Linter) pattern exactly
 */

// Sandbox globals: resolve Zotero and console from the global scope
// (scripts loaded via loadSubScript run in a sandbox where globals aren't directly available)
var Zotero = Components.classes["@zotero.org/Zotero;1"].getService(Components.interfaces.nsISupports).wrappedJSObject;
var console = Zotero.getMainWindow()?.console || { log() {}, warn() {}, error() {} };
var Services = globalThis.Services || Components.utils.import("resource://gre/modules/Services.jsm").Services;

// --- API Modules (inline to avoid loadSubScript issues) ---

var BibFixK10plus = {
    BASE_URL: "https://sru.k10plus.de/opac-de-627",
    async searchByISBN(isbn) {
        return this._search(`pica.isb=${isbn.replace(/[-\s]/g, "")}`);
    },
    async searchByTitleAuthor(title, author) {
        let parts = [];
        if (title) parts.push(`pica.tit="${title.replace(/[:.!?]/g, "").split(/\s+/).slice(0, 5).join(" ")}"`);
        if (author) parts.push(`pica.per="${author.split(",")[0].trim()}"`);
        return parts.length ? this._search(parts.join(" and ")) : null;
    },
    async searchByDOI(doi) { return this._search(`pica.doi="${doi}"`); },
    async _search(query) {
        let url = `${this.BASE_URL}?version=1.1&operation=searchRetrieve&query=${encodeURIComponent(query)}&maximumRecords=5&recordSchema=marcxml`;
        try {
            let resp = await Zotero.HTTP.request("GET", url, { timeout: 15000, responseType: "text" });
            return this._parseMARCXML(resp.responseText, "K10plus");
        } catch (e) { Zotero.debug("[BibFix K10plus] " + e.message); return null; }
    },
    _parseMARCXML(xmlText, source) {
        let parser = new DOMParser();
        let doc = parser.parseFromString(xmlText, "text/xml");
        let marcNS = "http://www.loc.gov/MARC21/slim";
        let records = doc.getElementsByTagNameNS(marcNS, "record");
        if (!records.length) return null;
        let results = [];
        for (let rec of records) { results.push(this._extractFields(rec, marcNS, source)); }
        return results;
    },
    _extractFields(record, ns, source) {
        let sf = (tag, code) => {
            for (let f of record.getElementsByTagNameNS(ns, "datafield")) {
                if (f.getAttribute("tag") === tag)
                    for (let s of f.getElementsByTagNameNS(ns, "subfield"))
                        if (s.getAttribute("code") === code) return s.textContent.trim();
            }
            return "";
        };
        let creators = [];
        for (let tag of ["100", "700"]) {
            for (let f of record.getElementsByTagNameNS(ns, "datafield")) {
                if (f.getAttribute("tag") !== tag) continue;
                let name = "", rel = "";
                for (let s of f.getElementsByTagNameNS(ns, "subfield")) {
                    if (s.getAttribute("code") === "a") name = s.textContent.trim();
                    if (s.getAttribute("code") === "4" || s.getAttribute("code") === "e") rel = s.textContent.trim().toLowerCase();
                }
                if (name) {
                    let p = name.split(",").map(s => s.trim());
                    let type = (rel.includes("hrsg") || rel.includes("edt") || rel === "ed") ? "editor" : "author";
                    creators.push({ lastName: p[0] || "", firstName: p[1] || "", creatorType: type });
                }
            }
        }
        let title = sf("245", "a").replace(/[\s/:]+$/, "");
        let subtitle = sf("245", "b").replace(/[\s/:]+$/, "");
        let place = (sf("264", "a") || sf("260", "a")).replace(/[\s:;,]+$/, "");
        let publisher = (sf("264", "b") || sf("260", "b")).replace(/[\s:;,]+$/, "");
        let dateRaw = sf("264", "c") || sf("260", "c");
        return {
            source, title: subtitle ? `${title}. ${subtitle}` : title, creators,
            date: dateRaw.replace(/[^\d]/g, "").slice(0, 4), place, publisher,
            series: sf("490", "a").replace(/[\s;,]+$/, ""), seriesNumber: sf("490", "v"),
            edition: sf("250", "a"), isbn: sf("020", "a").split(/\s/)[0],
            doi: sf("024", "a"), pages: sf("300", "a"),
            hostTitle: sf("773", "t"), hostPages: sf("773", "g"),
        };
    },
};

var BibFixDNB = {
    BASE_URL: "https://services.dnb.de/sru/dnb",
    async searchByISBN(isbn) { return this._search(`num=${isbn.replace(/[-\s]/g, "")}`); },
    async searchByTitleAuthor(title, author) {
        let parts = [];
        if (title) parts.push(`tit="${title.replace(/[:.!?]/g, "").split(/\s+/).slice(0, 4).join(" ")}"`);
        if (author) parts.push(`per="${author.split(",")[0].trim()}"`);
        return parts.length ? this._search(parts.join(" and ")) : null;
    },
    async _search(query) {
        let url = `${this.BASE_URL}?version=1.1&operation=searchRetrieve&query=${encodeURIComponent(query)}&maximumRecords=5&recordSchema=MARC21-xml`;
        try {
            let resp = await Zotero.HTTP.request("GET", url, { timeout: 15000, responseType: "text" });
            return BibFixK10plus._parseMARCXML(resp.responseText, "DNB");
        } catch (e) { Zotero.debug("[BibFix DNB] " + e.message); return null; }
    },
};

var BibFixCrossRef = {
    BASE_URL: "https://api.crossref.org",
    async searchByDOI(doi) {
        if (!doi) return null;
        try {
            let resp = await Zotero.HTTP.request("GET", `${this.BASE_URL}/works/${encodeURIComponent(doi.trim())}`, {
                headers: { "Accept": "application/json" }, timeout: 15000, responseType: "json",
            });
            return [this._map(resp.response.message)];
        } catch (e) { return null; }
    },
    async searchByTitleAuthor(title, author) {
        if (!title) return null;
        let p = new URLSearchParams(); p.set("query.bibliographic", title);
        if (author) p.set("query.author", author.split(",")[0].trim());
        p.set("rows", "5");
        try {
            let resp = await Zotero.HTTP.request("GET", `${this.BASE_URL}/works?${p}`, {
                headers: { "Accept": "application/json" }, timeout: 15000, responseType: "json",
            });
            return (resp.response.message.items || []).map(w => this._map(w));
        } catch (e) { return null; }
    },
    _map(w) {
        let creators = [];
        if (w.author) for (let a of w.author) creators.push({ firstName: a.given || "", lastName: a.family || "", creatorType: "author" });
        if (w.editor) for (let e of w.editor) creators.push({ firstName: e.given || "", lastName: e.family || "", creatorType: "editor" });
        let title = Array.isArray(w.title) ? w.title[0] : (w.title || "");
        let sub = w.subtitle ? (Array.isArray(w.subtitle) ? w.subtitle[0] : w.subtitle) : "";
        let dp = w.issued?.["date-parts"]?.[0] || w.published?.["date-parts"]?.[0];
        let ct = Array.isArray(w["container-title"]) ? w["container-title"][0] : (w["container-title"] || "");
        return {
            source: "CrossRef", title: sub ? `${title}. ${sub}` : title, creators,
            date: dp ? String(dp[0]) : "", place: w["publisher-location"] || "",
            publisher: w.publisher || "", series: "", seriesNumber: "",
            edition: w.edition || "", isbn: w.ISBN?.[0] || "", doi: w.DOI || "",
            pages: w.page || "", volume: w.volume || "", issue: w.issue || "",
            containerTitle: ct, hostTitle: ct,
        };
    },
};

var BibFixClaude = {
    API_URL: "https://api.anthropic.com/v1/messages",
    _getApiKey() { return Zotero.Prefs.get("extensions.zotero.bibfix.claudeApiKey", true) || ""; },
    async generateShortTitle(item) {
        let apiKey = this._getApiKey();
        if (!apiKey) return null;
        let authors = (item.creators || []).filter(c => c.creatorType === "author").map(c => c.lastName).join(", ");
        let editors = (item.creators || []).filter(c => c.creatorType === "editor").map(c => c.lastName).join(", ");
        let prompt = `Du bist Experte für bibliografische Konventionen der deutschsprachigen Geschichtswissenschaft.
Erzeuge einen Kurztitel für diesen Eintrag. REGELN:
1. Nachname des Verfassers + Komma + 1-3 prägnante Titelwörter. Beispiel: "Seifert, Weltlicher Staat"
2. KEINE Artikel am Anfang (Der/Die/Das/Ein/The). "Der Krieg in Bosnien" -> "Krieg in Bosnien"
3. Eigennamen und Ortsnamen behalten.
4. Ohne Verfasser: nur prägnante Titelwörter. "Hessische Landtagsakten" -> "Hessische Landtagsakten"
5. Sammelbände: Herausgebernachname(n) + Titelwörter.
EINTRAG: Typ: ${item.itemType}, Titel: ${item.title}, Verfasser: ${authors || "(keiner)"}, Hrsg.: ${editors || "(keiner)"}
Antworte NUR mit dem Kurztitel.`;
        try {
            let resp = await Zotero.HTTP.request("POST", this.API_URL, {
                headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
                body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 100, messages: [{ role: "user", content: prompt }] }),
                timeout: 30000, responseType: "json",
            });
            return resp.response?.content?.[0]?.text?.trim() || null;
        } catch (e) { Zotero.debug("[BibFix Claude] " + e.message); return null; }
    },
    async validateMetadata(existing, found) {
        let apiKey = this._getApiKey();
        if (!apiKey) return null;
        let prompt = `Vergleiche diesen Zotero-Eintrag mit Katalogdaten. Antworte als JSON: {"bestMatchIndex":0,"confidence":"high|medium|low","corrections":{"field":"wert"},"notes":"..."}
EINTRAG: ${JSON.stringify(existing)}
KATALOG: ${JSON.stringify(found.slice(0, 3))}`;
        try {
            let resp = await Zotero.HTTP.request("POST", this.API_URL, {
                headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
                body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
                timeout: 45000, responseType: "json",
            });
            let text = resp.response?.content?.[0]?.text?.trim();
            let m = text?.match(/\{[\s\S]*\}/);
            return m ? JSON.parse(m[0]) : null;
        } catch (e) { return null; }
    },
};

//

console.log("[BibFix] Initializing ToolkitGlobal modules");

Zotero.BibFix = {
    addedElementIDs: [],
    rootURI: null,

    hooks: {
        async onStartup() {
            console.log("[BibFix] onStartup");
            Zotero.BibFix.rootURI = _globalThis.rootURI;

            Zotero.PreferencePanes.register({
                pluginID: "bibfix@zotero-plugin.org",
                src: Zotero.BibFix.rootURI + "content/preferences.xhtml",
                label: "BibFix",
            });
        },

        onMainWindowLoad(window) {
            console.log("[BibFix] onMainWindowLoad");
            Zotero.BibFix._addMenuItems(window);
        },

        onMainWindowUnload(window) {
            Zotero.BibFix._removeMenuItems(window);
        },

        onShutdown() {
            console.log("[BibFix] onShutdown");
            Zotero.BibFix = undefined;
        },
    },

    //

    _addMenuItems(window) {
        let doc = window.document;
        if (doc.getElementById("bibfix-optimize-item")) return;

        let menu = doc.getElementById("zotero-itemmenu");
        if (!menu) {
            console.log("[BibFix] ERROR: zotero-itemmenu not found");
            return;
        }

        let sep = doc.createXULElement("menuseparator");
        sep.id = "bibfix-separator";
        menu.appendChild(sep);

        let m1 = doc.createXULElement("menuitem");
        m1.id = "bibfix-optimize-item";
        m1.setAttribute("label", "BibFix: Eintrag optimieren");
        m1.addEventListener("command", () => {
            let items = window.ZoteroPane.getSelectedItems();
            if (items.length) Zotero.BibFix.processItems(items, window);
        });
        menu.appendChild(m1);

        let m2 = doc.createXULElement("menuitem");
        m2.id = "bibfix-generate-shorttitle";
        m2.setAttribute("label", "BibFix: Kurztitel generieren");
        m2.addEventListener("command", () => {
            let items = window.ZoteroPane.getSelectedItems();
            if (items.length) Zotero.BibFix.generateShortTitles(items, window);
        });
        menu.appendChild(m2);

        console.log("[BibFix] Menu items added");
    },

    _removeMenuItems(window) {
        let doc = window.document;
        for (let id of ["bibfix-separator", "bibfix-optimize-item", "bibfix-generate-shorttitle"]) {
            doc.getElementById(id)?.remove();
        }
    },

    //

    async processItems(items, window) {
        items = items.filter(i => i.isRegularItem());
        if (!items.length) { window.alert("Keine bearbeitbaren Einträge ausgewählt."); return; }

        let pw = new Zotero.ProgressWindow({ closeOnClick: false });
        pw.changeHeadline("BibFix"); pw.addDescription(`Verarbeite ${items.length} Einträge...`); pw.show();

        try {
            let allChanges = [];
            for (let i = 0; i < items.length; i++) {
                let item = items[i];
                pw.addDescription(`[${i + 1}/${items.length}] ${item.getField("title").substring(0, 50)}...`);
                let changes = await this._analyzeItem(item);
                if (changes && Object.keys(changes.fields).length > 0) allChanges.push({ item, changes });
            }
            pw.close();
            if (!allChanges.length) { window.alert("Keine Verbesserungen gefunden."); return; }
            this._showPreviewAlert(allChanges, window);
        } catch (e) { pw.close(); window.alert("BibFix Fehler: " + e.message); }
    },

    async generateShortTitles(items, window) {
        items = items.filter(i => i.isRegularItem());
        if (!items.length) return;
        let apiKey = Zotero.Prefs.get("extensions.zotero.bibfix.claudeApiKey", true);
        if (!apiKey) { window.alert("Bitte Claude API Key in BibFix-Einstellungen eintragen."); return; }

        let pw = new Zotero.ProgressWindow({ closeOnClick: false });
        pw.changeHeadline("BibFix"); pw.addDescription("Generiere Kurztitel..."); pw.show();

        try {
            let changes = [];
            for (let i = 0; i < items.length; i++) {
                let item = items[i];
                let existing = item.getField("shortTitle");
                let data = this._extractItemData(item);
                pw.addDescription(`[${i + 1}/${items.length}] ${data.title.substring(0, 50)}...`);
                let shortTitle = await BibFixClaude.generateShortTitle(data);
                if (shortTitle && shortTitle !== existing) {
                    changes.push({ item, changes: { fields: { shortTitle: { old: existing, new: shortTitle } }, creators: null, source: "Claude AI" } });
                }
            }
            pw.close();
            if (!changes.length) { window.alert("Keine neuen Kurztitel generiert."); return; }
            this._showPreviewAlert(changes, window);
        } catch (e) { pw.close(); window.alert("BibFix Fehler: " + e.message); }
    },

    //

    async _analyzeItem(item) {
        let data = this._extractItemData(item);
        let results = await this._searchCatalogs(data);
        if (!results?.length) {
            let fields = {};
            let apiKey = Zotero.Prefs.get("extensions.zotero.bibfix.claudeApiKey", true);
            if (apiKey && !data.shortTitle) {
                let st = await BibFixClaude.generateShortTitle(data);
                if (st) fields.shortTitle = { old: "", new: st };
            }
            return { fields, creators: null, source: "Claude AI" };
        }
        let best = results[0];
        let apiKey = Zotero.Prefs.get("extensions.zotero.bibfix.claudeApiKey", true);
        if (apiKey) {
            let v = await BibFixClaude.validateMetadata(data, results);
            if (v?.confidence !== "low") {
                best = results[v?.bestMatchIndex || 0] || best;
                if (v?.corrections) for (let [k, val] of Object.entries(v.corrections)) if (val) best[k] = val;
            }
        }
        return this._buildChanges(item, data, best);
    },

    _extractItemData(item) {
        let creators = item.getCreators().map(c => ({
            firstName: c.firstName || "", lastName: c.lastName || "",
            creatorType: Zotero.CreatorTypes.getName(c.creatorTypeID),
        }));
        let d = {
            itemType: Zotero.ItemTypes.getName(item.itemTypeID),
            title: item.getField("title") || "", shortTitle: item.getField("shortTitle") || "",
            date: item.getField("date") || "", creators,
            place: item.getField("place") || "", publisher: item.getField("publisher") || "",
            isbn: item.getField("ISBN") || "", doi: item.getField("DOI") || "",
            pages: item.getField("pages") || "", series: item.getField("series") || "",
            seriesNumber: item.getField("seriesNumber") || "", edition: item.getField("edition") || "",
            volume: "", issue: "", publicationTitle: "", bookTitle: "",
        };
        try { d.volume = item.getField("volume") || ""; } catch (e) {}
        try { d.issue = item.getField("issue") || ""; } catch (e) {}
        try { d.publicationTitle = item.getField("publicationTitle") || ""; } catch (e) {}
        try { d.bookTitle = item.getField("bookTitle") || ""; } catch (e) {}
        return d;
    },

    async _searchCatalogs(data) {
        let results = [], isbn = data.isbn, doi = data.doi, title = data.title;
        let author = data.creators.find(c => c.creatorType === "author");
        let name = author ? author.lastName : "";
        let useK = Zotero.Prefs.get("extensions.zotero.bibfix.searchK10plus", true);
        let useD = Zotero.Prefs.get("extensions.zotero.bibfix.searchDNB", true);
        let useC = Zotero.Prefs.get("extensions.zotero.bibfix.searchCrossRef", true);

        if (isbn) {
            let p = [];
            if (useK) p.push(BibFixK10plus.searchByISBN(isbn));
            if (useD) p.push(BibFixDNB.searchByISBN(isbn));
            for (let s of await Promise.allSettled(p)) if (s.status === "fulfilled" && s.value) results.push(...s.value);
        }
        if (doi && !results.length) {
            let p = [];
            if (useC) p.push(BibFixCrossRef.searchByDOI(doi));
            for (let s of await Promise.allSettled(p)) if (s.status === "fulfilled" && s.value) results.push(...s.value);
        }
        if (!results.length && title) {
            let p = [];
            if (useK) p.push(BibFixK10plus.searchByTitleAuthor(title, name));
            if (useD) p.push(BibFixDNB.searchByTitleAuthor(title, name));
            if (useC) p.push(BibFixCrossRef.searchByTitleAuthor(title, name));
            for (let s of await Promise.allSettled(p)) if (s.status === "fulfilled" && s.value) results.push(...s.value);
        }
        return results;
    },

    _buildChanges(item, data, match) {
        let fields = {};
        let s = match.source || "Katalog";
        if (match.title && match.title.length > data.title.length + 3) fields.title = { old: data.title, new: match.title };
        if (match.date && !data.date) fields.date = { old: "", new: match.date };
        if (match.place && !data.place) fields.place = { old: "", new: match.place };
        if (match.publisher && !data.publisher) fields.publisher = { old: "", new: match.publisher };
        if (match.pages && !data.pages) fields.pages = { old: "", new: match.pages };
        if (match.volume && !data.volume) fields.volume = { old: "", new: match.volume };
        if (match.issue && !data.issue) fields.issue = { old: "", new: match.issue };
        if (match.series && !data.series) fields.series = { old: "", new: match.series };
        if (match.seriesNumber && !data.seriesNumber) fields.seriesNumber = { old: "", new: match.seriesNumber };
        if (match.edition && !data.edition) fields.edition = { old: "", new: match.edition };
        if (match.isbn && !data.isbn) fields.ISBN = { old: "", new: match.isbn };
        if (match.doi && !data.doi) fields.DOI = { old: "", new: match.doi };
        let ct = match.containerTitle || match.hostTitle;
        if (ct && data.itemType === "journalArticle" && !data.publicationTitle) fields.publicationTitle = { old: "", new: ct };
        if (ct && data.itemType === "bookSection" && !data.bookTitle) fields.bookTitle = { old: "", new: ct };
        return { fields, creators: null, source: s };
    },

    //

    _showPreviewAlert(allChanges, window) {
        let lines = [];
        for (let { item, changes } of allChanges) {
            lines.push(`--- ${item.getField("title").substring(0, 60)} ---`);
            lines.push(`Quelle: ${changes.source}`);
            for (let [field, ch] of Object.entries(changes.fields)) {
                let label = { title: "Titel", shortTitle: "Kurztitel", date: "Jahr", place: "Ort", publisher: "Verlag", pages: "Seiten", volume: "Band", issue: "Heft", series: "Reihe", seriesNumber: "Reihennr.", edition: "Auflage", ISBN: "ISBN", DOI: "DOI", publicationTitle: "Zeitschrift", bookTitle: "Sammelband" }[field] || field;
                lines.push(`  ${label}: "${ch.old || "(leer)}" -> "${ch.new}"`);
            }
            lines.push("");
        }
        let msg = lines.join("\n");
        let ok = Services.prompt.confirm(window, "BibFix – Änderungen übernehmen?", msg);
        if (ok) {
            this._applyChanges(allChanges);
        }
    },

    async _applyChanges(allChanges) {
        await Zotero.DB.executeTransaction(async () => {
            for (let { item, changes } of allChanges) {
                for (let [field, ch] of Object.entries(changes.fields)) {
                    try { item.setField(field, ch.new); } catch (e) { Zotero.debug("[BibFix] " + e.message); }
                }
                await item.save();
            }
        });
        console.log("[BibFix] Changes applied");
    },
};
