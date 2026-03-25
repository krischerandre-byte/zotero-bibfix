/* Deutsche Nationalbibliothek (DNB) SRU API */

var BibFixDNB = {
    BASE_URL: "https://services.dnb.de/sru/dnb",

    /**
     * Search DNB by ISBN
     */
    async searchByISBN(isbn) {
        isbn = isbn.replace(/[-\s]/g, "");
        let query = `num=${isbn}`;
        return this._search(query);
    },

    /**
     * Search DNB by title and author
     */
    async searchByTitleAuthor(title, author) {
        let parts = [];
        if (title) {
            let titleWords = title.replace(/[:.!?]/g, "").split(/\s+/).slice(0, 4).join(" ");
            parts.push(`tit="${titleWords}"`);
        }
        if (author) {
            let lastName = author.split(",")[0].trim();
            parts.push(`per="${lastName}"`);
        }
        if (parts.length === 0) return null;
        return this._search(parts.join(" and "));
    },

    /**
     * Execute SRU search
     */
    async _search(query) {
        let url = `${this.BASE_URL}?version=1.1&operation=searchRetrieve` +
            `&query=${encodeURIComponent(query)}` +
            `&maximumRecords=5&recordSchema=MARC21-xml`;

        Zotero.debug(`[BibFix DNB] Searching: ${url}`);

        try {
            let response = await Zotero.HTTP.request("GET", url, {
                timeout: 15000,
                responseType: "text",
            });
            return this._parseMARCXML(response.responseText);
        } catch (e) {
            Zotero.debug(`[BibFix DNB] Error: ${e.message}`);
            return null;
        }
    },

    /**
     * Parse MARCXML – same structure as K10plus, reuse logic
     */
    _parseMARCXML(xmlText) {
        // DNB uses the same MARCXML format, delegate to K10plus parser
        // but mark source as DNB
        let results = BibFixK10plus._parseMARCXML(xmlText);
        if (results) {
            results.forEach(r => r.source = "DNB");
        }
        return results;
    },
};
