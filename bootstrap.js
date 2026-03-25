/**
 * BibFix – Zotero Plugin for Bibliographic Metadata Optimization
 * Bootstrap following the pattern of zotero-format-metadata / make-it-red
 */

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
    // Load API modules
    Services.scriptloader.loadSubScript(rootURI + "content/scripts/k10plus.js");
    Services.scriptloader.loadSubScript(rootURI + "content/scripts/dnb.js");
    Services.scriptloader.loadSubScript(rootURI + "content/scripts/crossref.js");
    Services.scriptloader.loadSubScript(rootURI + "content/scripts/claude.js");
    Services.scriptloader.loadSubScript(rootURI + "content/scripts/bibfix.js");

    BibFix.init({ id, version, rootURI });
    BibFix.addToAllWindows();

    Zotero.PreferencePanes.register({
        pluginID: "bibfix@zotero-plugin.org",
        src: rootURI + "prefs.xhtml",
        label: "BibFix",
    });
}

function onMainWindowLoad({ window }, reason) {
    BibFix?.addToWindow(window);
}

function onMainWindowUnload({ window }, reason) {
    BibFix?.removeFromWindow(window);
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
    if (reason === APP_SHUTDOWN) {
        return;
    }
    BibFix?.removeFromAllWindows();
    BibFix = undefined;
}

function uninstall(data, reason) {}
