/* CrossRef API – international journals, DOI resolution */

var BibFixCrossRef = {
    BASE_URL: "https://api.crossref.org",

    /**
     * Look up metadata by DOI
     */
    async searchByDOI(doi) {
        if (!doi) return null;
        doi = doi.trim();
        let url = `${this.BASE_URL}/works/${encodeURIComponent(doi)}`;

        Zotero.debug(`[BibFix CrossRef] DOI lookup: ${doi}`);

        try {
            let response = await Zotero.HTTP.request("GET", url, {
                headers: {
                    "Accept": "application/json",
                    "User-Agent": "BibFix-Zotero-Plugin/0.1 (mailto:bibfix@example.org)",
                },
                timeout: 15000,
                responseType: "json",
            });
            let work = response.response.message;
            return [this._mapWork(work)];
        } catch (e) {
            Zotero.debug(`[BibFix CrossRef] DOI lookup error: ${e.message}`);
            return null;
        }
    },

    /**
     * Search by title (and optionally author)
     */
    async searchByTitleAuthor(title, author) {
        if (!title) return null;

        let params = new URLSearchParams();
        params.set("query.bibliographic", title);
        if (author) {
            params.set("query.author", author.split(",")[0].trim());
        }
        params.set("rows", "5");

        let url = `${this.BASE_URL}/works?${params.toString()}`;

        Zotero.debug(`[BibFix CrossRef] Title search: ${title}`);

        try {
            let response = await Zotero.HTTP.request("GET", url, {
                headers: {
                    "Accept": "application/json",
                    "User-Agent": "BibFix-Zotero-Plugin/0.1 (mailto:bibfix@example.org)",
                },
                timeout: 15000,
                responseType: "json",
            });
            let items = response.response.message.items || [];
            return items.map(w => this._mapWork(w));
        } catch (e) {
            Zotero.debug(`[BibFix CrossRef] Search error: ${e.message}`);
            return null;
        }
    },

    /**
     * Search by ISSN (for journal identification)
     */
    async searchByISSN(issn) {
        if (!issn) return null;
        let url = `${this.BASE_URL}/journals/${encodeURIComponent(issn)}`;
        try {
            let response = await Zotero.HTTP.request("GET", url, {
                headers: { "Accept": "application/json" },
                timeout: 10000,
                responseType: "json",
            });
            return response.response.message;
        } catch (e) {
            return null;
        }
    },

    /**
     * Map CrossRef work to our internal format
     */
    _mapWork(work) {
        let creators = [];

        // Authors
        if (work.author) {
            for (let a of work.author) {
                creators.push({
                    firstName: a.given || "",
                    lastName: a.family || "",
                    creatorType: "author",
                });
            }
        }

        // Editors
        if (work.editor) {
            for (let e of work.editor) {
                creators.push({
                    firstName: e.given || "",
                    lastName: e.family || "",
                    creatorType: "editor",
                });
            }
        }

        // Title: CrossRef sometimes returns arrays
        let title = Array.isArray(work.title) ? work.title[0] : (work.title || "");
        let subtitle = work.subtitle ? (Array.isArray(work.subtitle) ? work.subtitle[0] : work.subtitle) : "";
        let fullTitle = subtitle ? `${title}. ${subtitle}` : title;

        // Container title (journal or book)
        let containerTitle = Array.isArray(work["container-title"])
            ? work["container-title"][0]
            : (work["container-title"] || "");

        // Date
        let dateParts = null;
        if (work.issued && work.issued["date-parts"] && work.issued["date-parts"][0]) {
            dateParts = work.issued["date-parts"][0];
        } else if (work.published && work.published["date-parts"] && work.published["date-parts"][0]) {
            dateParts = work.published["date-parts"][0];
        }
        let date = dateParts ? String(dateParts[0]) : "";

        // Pages
        let pages = work.page || "";

        // Volume, Issue
        let volume = work.volume || "";
        let issue = work.issue || "";

        // DOI
        let doi = work.DOI || "";

        // ISBN
        let isbn = "";
        if (work.ISBN && work.ISBN.length > 0) {
            isbn = work.ISBN[0];
        }

        // Publisher and place
        let publisher = work.publisher || "";
        let place = work["publisher-location"] || "";

        return {
            source: "CrossRef",
            title: fullTitle,
            creators,
            date,
            place,
            publisher,
            series: "",
            seriesNumber: "",
            edition: work.edition || "",
            isbn,
            doi,
            pages,
            volume,
            issue,
            containerTitle,
            hostTitle: containerTitle,
            type: work.type || "",
        };
    },
};
