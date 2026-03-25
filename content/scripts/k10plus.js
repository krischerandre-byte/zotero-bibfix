/* K10plus/GVK SRU API – Gemeinsamer Verbundkatalog */

var BibFixK10plus = {
    BASE_URL: "https://sru.k10plus.de/opac-de-627",

    /**
     * Search K10plus by ISBN
     */
    async searchByISBN(isbn) {
        isbn = isbn.replace(/[-\s]/g, "");
        let query = `pica.isb=${isbn}`;
        return this._search(query);
    },

    /**
     * Search K10plus by title and author
     */
    async searchByTitleAuthor(title, author) {
        let parts = [];
        if (title) {
            // Use first significant words of the title
            let titleWords = title.replace(/[:.!?]/g, "").split(/\s+/).slice(0, 5).join(" ");
            parts.push(`pica.tit="${titleWords}"`);
        }
        if (author) {
            // Use last name only
            let lastName = author.split(",")[0].trim();
            parts.push(`pica.per="${lastName}"`);
        }
        if (parts.length === 0) return null;
        return this._search(parts.join(" and "));
    },

    /**
     * Search K10plus by DOI
     */
    async searchByDOI(doi) {
        let query = `pica.doi="${doi}"`;
        return this._search(query);
    },

    /**
     * Execute SRU search and parse MARCXML response
     */
    async _search(query) {
        let url = `${this.BASE_URL}?version=1.1&operation=searchRetrieve` +
            `&query=${encodeURIComponent(query)}` +
            `&maximumRecords=5&recordSchema=marcxml`;

        Zotero.debug(`[BibFix K10plus] Searching: ${url}`);

        try {
            let response = await Zotero.HTTP.request("GET", url, {
                timeout: 15000,
                responseType: "text",
            });
            return this._parseMARCXML(response.responseText);
        } catch (e) {
            Zotero.debug(`[BibFix K10plus] Error: ${e.message}`);
            return null;
        }
    },

    /**
     * Parse MARCXML response into structured metadata
     */
    _parseMARCXML(xmlText) {
        let parser = new DOMParser();
        let doc = parser.parseFromString(xmlText, "text/xml");

        let ns = {
            srw: "http://www.loc.gov/zing/srw/",
            marc: "http://www.loc.gov/MARC21/slim",
        };

        // Use XPath with namespace resolver
        let nsResolver = (prefix) => ns[prefix] || null;

        let records = doc.evaluate(
            "//srw:records/srw:record/srw:recordData/marc:record",
            doc, nsResolver, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
        );

        if (records.snapshotLength === 0) return null;

        let results = [];
        for (let i = 0; i < records.snapshotLength; i++) {
            let record = records.snapshotItem(i);
            results.push(this._extractFields(record, ns.marc));
        }
        return results;
    },

    /**
     * Extract bibliographic fields from a single MARC record
     */
    _extractFields(record, marcNS) {
        let getSubfield = (tag, code) => {
            let fields = record.getElementsByTagNameNS(marcNS, "datafield");
            for (let f of fields) {
                if (f.getAttribute("tag") === tag) {
                    let subs = f.getElementsByTagNameNS(marcNS, "subfield");
                    for (let s of subs) {
                        if (s.getAttribute("code") === code) {
                            return s.textContent.trim();
                        }
                    }
                }
            }
            return "";
        };

        let getAllSubfields = (tag, code) => {
            let results = [];
            let fields = record.getElementsByTagNameNS(marcNS, "datafield");
            for (let f of fields) {
                if (f.getAttribute("tag") === tag) {
                    let subs = f.getElementsByTagNameNS(marcNS, "subfield");
                    for (let s of subs) {
                        if (s.getAttribute("code") === code) {
                            results.push(s.textContent.trim());
                        }
                    }
                }
            }
            return results;
        };

        let getCreators = (tag, creatorType) => {
            let creators = [];
            let fields = record.getElementsByTagNameNS(marcNS, "datafield");
            for (let f of fields) {
                if (f.getAttribute("tag") === tag) {
                    let subs = f.getElementsByTagNameNS(marcNS, "subfield");
                    let name = "";
                    let relator = "";
                    for (let s of subs) {
                        if (s.getAttribute("code") === "a") name = s.textContent.trim();
                        if (s.getAttribute("code") === "4" || s.getAttribute("code") === "e")
                            relator = s.textContent.trim().toLowerCase();
                    }
                    if (name) {
                        let parts = name.split(",").map(s => s.trim());
                        let type = creatorType;
                        if (relator.includes("hrsg") || relator.includes("edt") || relator === "ed")
                            type = "editor";
                        creators.push({
                            lastName: parts[0] || "",
                            firstName: parts[1] || "",
                            creatorType: type,
                        });
                    }
                }
            }
            return creators;
        };

        // Build title with subtitle
        let title = getSubfield("245", "a").replace(/[\s/:]+$/, "");
        let subtitle = getSubfield("245", "b").replace(/[\s/:]+$/, "");
        let fullTitle = subtitle ? `${title}. ${subtitle}` : title;

        // Place and publisher from 264 (preferred) or 260
        let place = getSubfield("264", "a") || getSubfield("260", "a");
        place = place.replace(/[\s:;,]+$/, "");
        let publisher = getSubfield("264", "b") || getSubfield("260", "b");
        publisher = publisher.replace(/[\s:;,]+$/, "");
        let dateRaw = getSubfield("264", "c") || getSubfield("260", "c");
        let date = dateRaw.replace(/[^\d]/g, "").slice(0, 4);

        // Series
        let series = getSubfield("490", "a").replace(/[\s;,]+$/, "");
        let seriesNumber = getSubfield("490", "v");

        // Edition
        let edition = getSubfield("250", "a");

        // ISBN
        let isbn = getSubfield("020", "a").split(/\s/)[0];

        // DOI
        let doi = getSubfield("024", "a");
        if (!doi) {
            // Try 856$u for DOI URLs
            let url856 = getSubfield("856", "u");
            if (url856 && url856.includes("doi.org")) {
                doi = url856.replace(/.*doi\.org\//, "");
            }
        }

        // Pages (300$a for physical description)
        let pages = getSubfield("300", "a");

        // Creators: 100 = main author, 700 = additional
        let creators = [
            ...getCreators("100", "author"),
            ...getCreators("700", "author"),
        ];

        // Host item (773) for articles/chapters
        let hostTitle = getSubfield("773", "t");
        let hostPages = getSubfield("773", "g");

        return {
            source: "K10plus",
            title: fullTitle,
            creators,
            date,
            place,
            publisher,
            series,
            seriesNumber,
            edition,
            isbn,
            doi,
            pages,
            hostTitle,
            hostPages,
            _raw: {
                title245a: getSubfield("245", "a"),
                title245b: getSubfield("245", "b"),
            },
        };
    },
};
