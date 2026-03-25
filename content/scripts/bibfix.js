/* BibFix – Main Plugin Logic */

var BibFix = {
    id: null,
    version: null,
    rootURI: null,
    initialized: false,
    addedElementIDs: [],
    _progressWindow: null,

    init({ id, version, rootURI }) {
        if (this.initialized) return;
        this.id = id;
        this.version = version;
        this.rootURI = rootURI;
        this.initialized = true;
        Zotero.debug("[BibFix] Initialized v" + version);
    },

    // ─── Window Management ────────────────────────────────────────

    addToWindow(window) {
        let doc = window.document;

        // Context menu: "Eintrag optimieren"
        let menuitem = doc.createXULElement("menuitem");
        menuitem.id = "bibfix-optimize-item";
        menuitem.setAttribute("label", "BibFix: Eintrag optimieren");
        menuitem.addEventListener("command", () => {
            let items = window.ZoteroPane.getSelectedItems();
            if (items.length > 0) {
                this.processItems(items, window);
            }
        });
        doc.getElementById("zotero-itemmenu").appendChild(menuitem);
        this.addedElementIDs.push(menuitem.id);

        // Context menu: "Kurztitel generieren"
        let menuitem2 = doc.createXULElement("menuitem");
        menuitem2.id = "bibfix-generate-shorttitle";
        menuitem2.setAttribute("label", "BibFix: Kurztitel generieren");
        menuitem2.addEventListener("command", () => {
            let items = window.ZoteroPane.getSelectedItems();
            if (items.length > 0) {
                this.generateShortTitles(items, window);
            }
        });
        doc.getElementById("zotero-itemmenu").appendChild(menuitem2);
        this.addedElementIDs.push(menuitem2.id);

        // Separator before our items
        let sep = doc.createXULElement("menuseparator");
        sep.id = "bibfix-separator";
        let menu = doc.getElementById("zotero-itemmenu");
        let firstBibfix = doc.getElementById("bibfix-optimize-item");
        menu.insertBefore(sep, firstBibfix);
        this.addedElementIDs.push(sep.id);
    },

    removeFromWindow(window) {
        let doc = window.document;
        for (let id of this.addedElementIDs) {
            doc.getElementById(id)?.remove();
        }
    },

    addToAllWindows() {
        for (let win of Zotero.getMainWindows()) {
            if (!win.ZoteroPane) continue;
            this.addToWindow(win);
        }
    },

    removeFromAllWindows() {
        for (let win of Zotero.getMainWindows()) {
            if (!win.ZoteroPane) continue;
            this.removeFromWindow(win);
        }
    },

    // ─── Progress Indicator ───────────────────────────────────────

    _showProgress(message, window) {
        let pw = new Zotero.ProgressWindow({ closeOnClick: false });
        pw.changeHeadline("BibFix");
        pw.addDescription(message);
        pw.show();
        return pw;
    },

    _updateProgress(pw, message) {
        if (pw) {
            pw.addDescription(message);
        }
    },

    // ─── Main Processing Pipeline ─────────────────────────────────

    /**
     * Process selected items: search catalogs, compare, show preview, apply
     */
    async processItems(items, window) {
        // Filter to regular items only (not attachments/notes)
        items = items.filter(item => item.isRegularItem());
        if (items.length === 0) {
            window.alert("Keine bearbeitbaren Einträge ausgewählt.");
            return;
        }

        let pw = this._showProgress(`Verarbeite ${items.length} Eintrag/Einträge...`, window);

        try {
            let allChanges = [];

            for (let i = 0; i < items.length; i++) {
                let item = items[i];
                let title = item.getField("title");
                this._updateProgress(pw, `[${i + 1}/${items.length}] ${title.substring(0, 50)}...`);

                let changes = await this._analyzeItem(item);
                if (changes && Object.keys(changes.fields).length > 0) {
                    allChanges.push({ item, changes });
                }
            }

            pw.close();

            if (allChanges.length === 0) {
                window.alert("Keine Verbesserungen gefunden. Alle Einträge scheinen vollständig.");
                return;
            }

            // Show preview dialog
            this._showPreviewDialog(allChanges, window);

        } catch (e) {
            pw.close();
            Zotero.debug(`[BibFix] Error: ${e.message}\n${e.stack}`);
            window.alert(`BibFix Fehler: ${e.message}`);
        }
    },

    /**
     * Generate short titles only (without full metadata optimization)
     */
    async generateShortTitles(items, window) {
        items = items.filter(item => item.isRegularItem());
        if (items.length === 0) return;

        let apiKey = Zotero.Prefs.get("extensions.bibfix.claudeApiKey", true);
        if (!apiKey) {
            window.alert("Bitte zuerst einen Claude API Key in den BibFix-Einstellungen hinterlegen.");
            return;
        }

        let pw = this._showProgress(`Generiere Kurztitel für ${items.length} Einträge...`, window);

        try {
            let changes = [];
            for (let i = 0; i < items.length; i++) {
                let item = items[i];
                let title = item.getField("title");
                let existing = item.getField("shortTitle");

                this._updateProgress(pw, `[${i + 1}/${items.length}] ${title.substring(0, 50)}...`);

                let itemData = this._extractItemData(item);
                let shortTitle = await BibFixClaude.generateShortTitle(itemData);

                if (shortTitle && shortTitle !== existing) {
                    changes.push({
                        item,
                        changes: {
                            fields: { shortTitle: { old: existing, new: shortTitle } },
                            creators: null,
                            source: "Claude AI",
                        },
                    });
                }
            }

            pw.close();

            if (changes.length === 0) {
                window.alert("Keine neuen Kurztitel generiert.");
                return;
            }

            this._showPreviewDialog(changes, window);
        } catch (e) {
            pw.close();
            window.alert(`BibFix Fehler: ${e.message}`);
        }
    },

    // ─── Item Analysis ────────────────────────────────────────────

    /**
     * Analyze a single item: search catalogs, compare fields, return changes
     */
    async _analyzeItem(item) {
        let itemData = this._extractItemData(item);
        let results = await this._searchCatalogs(itemData);

        if (!results || results.length === 0) {
            Zotero.debug(`[BibFix] No catalog results for: ${itemData.title}`);
            // Still try to generate short title if missing
            return this._buildChangesFromNothing(item, itemData);
        }

        // Use Claude to validate and pick best match (if API key available)
        let apiKey = Zotero.Prefs.get("extensions.bibfix.claudeApiKey", true);
        let bestMatch;
        let claudeValidation = null;

        if (apiKey) {
            claudeValidation = await BibFixClaude.validateMetadata(itemData, results);
        }

        if (claudeValidation && claudeValidation.confidence !== "low") {
            bestMatch = results[claudeValidation.bestMatchIndex || 0];
            // Apply Claude's corrections on top
            if (claudeValidation.corrections) {
                for (let [field, value] of Object.entries(claudeValidation.corrections)) {
                    if (value) bestMatch[field] = value;
                }
            }
        } else {
            // Without Claude, use first result with highest field coverage
            bestMatch = this._pickBestMatch(results, itemData);
        }

        if (!bestMatch) return null;

        return this._compareAndBuildChanges(item, itemData, bestMatch);
    },

    /**
     * Extract current data from Zotero item into a plain object
     */
    _extractItemData(item) {
        let creators = item.getCreators().map(c => ({
            firstName: c.firstName || "",
            lastName: c.lastName || "",
            creatorType: Zotero.CreatorTypes.getName(c.creatorTypeID),
        }));

        let data = {
            itemType: Zotero.ItemTypes.getName(item.itemTypeID),
            title: item.getField("title") || "",
            shortTitle: item.getField("shortTitle") || "",
            date: item.getField("date") || "",
            creators,
            place: item.getField("place") || "",
            publisher: item.getField("publisher") || "",
            isbn: item.getField("ISBN") || "",
            doi: item.getField("DOI") || "",
            pages: item.getField("pages") || "",
            volume: "",
            issue: "",
            series: item.getField("series") || "",
            seriesNumber: item.getField("seriesNumber") || "",
            edition: item.getField("edition") || "",
            publicationTitle: "",
        };

        // Fields that may not exist on all item types
        try { data.volume = item.getField("volume") || ""; } catch (e) {}
        try { data.issue = item.getField("issue") || ""; } catch (e) {}
        try { data.publicationTitle = item.getField("publicationTitle") || ""; } catch (e) {}
        try { data.bookTitle = item.getField("bookTitle") || ""; } catch (e) {}
        try { data.numPages = item.getField("numPages") || ""; } catch (e) {}

        return data;
    },

    // ─── Catalog Search ───────────────────────────────────────────

    /**
     * Search all enabled catalogs for metadata
     */
    async _searchCatalogs(itemData) {
        let results = [];
        let isbn = itemData.isbn;
        let doi = itemData.doi;
        let title = itemData.title;
        let author = itemData.creators.find(c => c.creatorType === "author");
        let authorName = author ? author.lastName : "";

        let searchK10plus = Zotero.Prefs.get("extensions.bibfix.searchK10plus", true);
        let searchDNB = Zotero.Prefs.get("extensions.bibfix.searchDNB", true);
        let searchCrossRef = Zotero.Prefs.get("extensions.bibfix.searchCrossRef", true);

        // Search by ISBN first (most reliable)
        if (isbn) {
            let promises = [];
            if (searchK10plus) promises.push(BibFixK10plus.searchByISBN(isbn));
            if (searchDNB) promises.push(BibFixDNB.searchByISBN(isbn));
            if (searchCrossRef) promises.push(BibFixCrossRef.searchByDOI(doi)); // DOI for CrossRef

            let settled = await Promise.allSettled(promises);
            for (let s of settled) {
                if (s.status === "fulfilled" && s.value) {
                    results.push(...s.value);
                }
            }
        }

        // Search by DOI (especially for journal articles)
        if (doi && results.length === 0) {
            let promises = [];
            if (searchCrossRef) promises.push(BibFixCrossRef.searchByDOI(doi));
            if (searchK10plus) promises.push(BibFixK10plus.searchByDOI(doi));

            let settled = await Promise.allSettled(promises);
            for (let s of settled) {
                if (s.status === "fulfilled" && s.value) {
                    results.push(...s.value);
                }
            }
        }

        // Fallback: search by title + author
        if (results.length === 0 && title) {
            let promises = [];
            if (searchK10plus) promises.push(BibFixK10plus.searchByTitleAuthor(title, authorName));
            if (searchDNB) promises.push(BibFixDNB.searchByTitleAuthor(title, authorName));
            if (searchCrossRef) promises.push(BibFixCrossRef.searchByTitleAuthor(title, authorName));

            let settled = await Promise.allSettled(promises);
            for (let s of settled) {
                if (s.status === "fulfilled" && s.value) {
                    results.push(...s.value);
                }
            }
        }

        Zotero.debug(`[BibFix] Found ${results.length} catalog results`);
        return results;
    },

    // ─── Matching & Comparison ────────────────────────────────────

    /**
     * Pick the best match from catalog results based on field coverage
     */
    _pickBestMatch(results, itemData) {
        if (!results || results.length === 0) return null;

        let scored = results.map(r => {
            let score = 0;
            // Title similarity
            if (r.title && this._similarStrings(r.title, itemData.title) > 0.5) score += 3;
            // Has creators
            if (r.creators && r.creators.length > 0) score += 2;
            // Has date
            if (r.date) score += 1;
            // Has place
            if (r.place) score += 1;
            // Has pages
            if (r.pages) score += 2;
            // Has series
            if (r.series) score += 1;
            // Has edition
            if (r.edition) score += 1;
            // ISBN match
            if (r.isbn && itemData.isbn &&
                r.isbn.replace(/[-\s]/g, "") === itemData.isbn.replace(/[-\s]/g, "")) score += 5;
            return { result: r, score };
        });

        scored.sort((a, b) => b.score - a.score);
        return scored[0].result;
    },

    /**
     * Simple string similarity (Jaccard on word sets)
     */
    _similarStrings(a, b) {
        if (!a || !b) return 0;
        let wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
        let wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
        let intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
        let union = new Set([...wordsA, ...wordsB]);
        return union.size > 0 ? intersection.size / union.size : 0;
    },

    /**
     * Compare existing item with best match and build change set
     */
    _compareAndBuildChanges(item, itemData, match) {
        let fields = {};
        let source = match.source || "Katalog";

        // Title: prefer longer/more complete title
        if (match.title && match.title.length > itemData.title.length + 3) {
            fields.title = { old: itemData.title, new: match.title };
        }

        // Date
        if (match.date && !itemData.date) {
            fields.date = { old: itemData.date, new: match.date };
        }

        // Place
        if (match.place && !itemData.place) {
            fields.place = { old: itemData.place, new: match.place };
        }

        // Publisher
        if (match.publisher && !itemData.publisher) {
            fields.publisher = { old: itemData.publisher, new: match.publisher };
        }

        // Pages
        if (match.pages && !itemData.pages) {
            fields.pages = { old: itemData.pages, new: match.pages };
        }

        // Volume
        if (match.volume && !itemData.volume) {
            fields.volume = { old: itemData.volume, new: match.volume };
        }

        // Issue
        if (match.issue && !itemData.issue) {
            fields.issue = { old: itemData.issue, new: match.issue };
        }

        // Series
        if (match.series && !itemData.series) {
            fields.series = { old: itemData.series, new: match.series };
        }

        // Series number
        if (match.seriesNumber && !itemData.seriesNumber) {
            fields.seriesNumber = { old: itemData.seriesNumber, new: match.seriesNumber };
        }

        // Edition
        if (match.edition && !itemData.edition) {
            fields.edition = { old: itemData.edition, new: match.edition };
        }

        // ISBN
        if (match.isbn && !itemData.isbn) {
            fields.ISBN = { old: itemData.isbn, new: match.isbn };
        }

        // DOI
        if (match.doi && !itemData.doi) {
            fields.DOI = { old: itemData.doi, new: match.doi };
        }

        // Container title (journal/book for articles)
        if (match.containerTitle || match.hostTitle) {
            let ct = match.containerTitle || match.hostTitle;
            if (itemData.itemType === "journalArticle" && !itemData.publicationTitle && ct) {
                fields.publicationTitle = { old: itemData.publicationTitle, new: ct };
            }
            if (itemData.itemType === "bookSection" && !itemData.bookTitle && ct) {
                fields.bookTitle = { old: itemData.bookTitle || "", new: ct };
            }
        }

        // Creators: check for incomplete names (abbreviated first names)
        let creatorChanges = null;
        if (match.creators && match.creators.length > 0) {
            creatorChanges = this._compareCreators(itemData.creators, match.creators);
        }

        return { fields, creators: creatorChanges, source };
    },

    /**
     * Build minimal changes when no catalog results found (only short title)
     */
    async _buildChangesFromNothing(item, itemData) {
        let fields = {};
        let apiKey = Zotero.Prefs.get("extensions.bibfix.claudeApiKey", true);
        let autoShortTitle = Zotero.Prefs.get("extensions.bibfix.autoShortTitle", true);

        if (apiKey && autoShortTitle && !itemData.shortTitle) {
            let shortTitle = await BibFixClaude.generateShortTitle(itemData);
            if (shortTitle) {
                fields.shortTitle = { old: "", new: shortTitle };
            }
        }

        return { fields, creators: null, source: "Claude AI" };
    },

    /**
     * Compare creator lists and find improvements
     * (e.g., abbreviated first names → full first names)
     */
    _compareCreators(existing, found) {
        if (!found || found.length === 0) return null;

        let changes = [];
        let existingByLast = {};
        for (let c of existing) {
            existingByLast[c.lastName.toLowerCase()] = c;
        }

        for (let fc of found) {
            let key = fc.lastName.toLowerCase();
            let ec = existingByLast[key];
            if (ec) {
                // Check if found name is more complete
                if (fc.firstName && ec.firstName &&
                    fc.firstName.length > ec.firstName.length &&
                    !ec.firstName.includes(".") === false) {
                    // Found name has abbreviated first name that is now expanded
                    changes.push({
                        old: `${ec.lastName}, ${ec.firstName}`,
                        new: `${fc.lastName}, ${fc.firstName}`,
                        creatorType: fc.creatorType || ec.creatorType,
                    });
                }
                // Check if creator type differs (author vs editor)
                if (fc.creatorType !== ec.creatorType) {
                    changes.push({
                        old: `${ec.lastName}, ${ec.firstName} (${ec.creatorType})`,
                        new: `${fc.lastName}, ${fc.firstName} (${fc.creatorType})`,
                        creatorType: fc.creatorType,
                    });
                }
            } else if (fc.lastName) {
                // Creator not in existing list → add
                changes.push({
                    old: "(fehlt)",
                    new: `${fc.lastName}, ${fc.firstName} (${fc.creatorType})`,
                    creatorType: fc.creatorType,
                });
            }
        }

        return changes.length > 0 ? changes : null;
    },

    // ─── Preview Dialog ───────────────────────────────────────────

    /**
     * Show a preview dialog with all proposed changes
     */
    _showPreviewDialog(allChanges, window) {
        let doc = window.document;

        // Build HTML content for the dialog
        let html = this._buildPreviewHTML(allChanges);

        // Open dialog
        let dialog = window.openDialog(
            this.rootURI + "content/preview.xhtml",
            "bibfix-preview",
            "chrome,centerscreen,resizable,dialog=yes,modal=yes",
            { html, changes: allChanges, bibfix: this }
        );
    },

    /**
     * Build HTML preview of all changes
     */
    _buildPreviewHTML(allChanges) {
        let parts = [];

        for (let { item, changes } of allChanges) {
            let title = item.getField("title");
            parts.push(`<div class="bibfix-item">
                <h3>${this._escapeHTML(title)}</h3>
                <p class="source">Quelle: ${this._escapeHTML(changes.source)}</p>`);

            // Field changes
            for (let [field, change] of Object.entries(changes.fields)) {
                let label = this._fieldLabel(field);
                parts.push(`<div class="bibfix-change">
                    <label><input type="checkbox" checked data-item-id="${item.id}" data-field="${field}"/>
                    <strong>${label}:</strong></label>
                    <div class="old">${this._escapeHTML(change.old) || "<em>(leer)</em>"}</div>
                    <div class="arrow">→</div>
                    <div class="new">${this._escapeHTML(change.new)}</div>
                </div>`);
            }

            // Creator changes
            if (changes.creators) {
                for (let cc of changes.creators) {
                    parts.push(`<div class="bibfix-change">
                        <label><input type="checkbox" checked data-item-id="${item.id}" data-field="creator"/>
                        <strong>Autor/Hrsg.:</strong></label>
                        <div class="old">${this._escapeHTML(cc.old)}</div>
                        <div class="arrow">→</div>
                        <div class="new">${this._escapeHTML(cc.new)}</div>
                    </div>`);
                }
            }

            parts.push(`</div><hr/>`);
        }

        return parts.join("\n");
    },

    /**
     * Apply selected changes to items
     */
    async applyChanges(allChanges, selectedFields) {
        await Zotero.DB.executeTransaction(async () => {
            for (let { item, changes } of allChanges) {
                let itemID = item.id;

                for (let [field, change] of Object.entries(changes.fields)) {
                    let key = `${itemID}:${field}`;
                    if (!selectedFields || selectedFields.has(key)) {
                        try {
                            item.setField(field, change.new);
                            Zotero.debug(`[BibFix] Set ${field} = "${change.new}" for item ${itemID}`);
                        } catch (e) {
                            Zotero.debug(`[BibFix] Could not set ${field}: ${e.message}`);
                        }
                    }
                }

                // Apply creator changes
                if (changes.creators) {
                    let key = `${itemID}:creator`;
                    if (!selectedFields || selectedFields.has(key)) {
                        this._applyCreatorChanges(item, changes.creators);
                    }
                }

                await item.save();
            }
        });

        Zotero.debug("[BibFix] All changes applied.");
    },

    /**
     * Apply creator changes to an item
     */
    _applyCreatorChanges(item, creatorChanges) {
        let existingCreators = item.getCreators();
        let updatedCreators = [...existingCreators];

        for (let cc of creatorChanges) {
            if (cc.old === "(fehlt)") {
                // Add new creator
                let parts = cc.new.match(/^(.+),\s*(.+?)\s*\((\w+)\)$/);
                if (parts) {
                    updatedCreators.push({
                        lastName: parts[1],
                        firstName: parts[2],
                        creatorType: Zotero.CreatorTypes.getID(parts[3]),
                    });
                }
            } else {
                // Update existing creator
                let newParts = cc.new.match(/^(.+),\s*(.+?)(?:\s*\((\w+)\))?$/);
                if (newParts) {
                    let idx = updatedCreators.findIndex(c =>
                        c.lastName.toLowerCase() === newParts[1].toLowerCase().trim()
                    );
                    if (idx >= 0) {
                        updatedCreators[idx] = {
                            ...updatedCreators[idx],
                            firstName: newParts[2].trim(),
                            lastName: newParts[1].trim(),
                        };
                        if (newParts[3]) {
                            updatedCreators[idx].creatorType = Zotero.CreatorTypes.getID(newParts[3]);
                        }
                    }
                }
            }
        }

        item.setCreators(updatedCreators);
    },

    // ─── Helpers ──────────────────────────────────────────────────

    _fieldLabel(field) {
        let labels = {
            title: "Titel",
            shortTitle: "Kurztitel",
            date: "Datum/Jahr",
            place: "Ort",
            publisher: "Verlag",
            pages: "Seiten",
            volume: "Band",
            issue: "Heft",
            series: "Reihe",
            seriesNumber: "Reihennummer",
            edition: "Auflage",
            ISBN: "ISBN",
            DOI: "DOI",
            publicationTitle: "Zeitschrift",
            bookTitle: "Sammelband-Titel",
            numPages: "Seitenzahl",
        };
        return labels[field] || field;
    },

    _escapeHTML(str) {
        if (!str) return "";
        return str.replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    },
};
