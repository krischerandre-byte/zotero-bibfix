/**
 * BibFix – Zotero Plugin for Bibliographic Metadata Optimization
 * Bootstrap following the exact pattern of zotero-format-metadata (Linter)
 */

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  const ctx = {
    rootURI,
  };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(`${rootURI}/content/scripts/bibfix.js`, ctx);
  await Zotero.BibFix.hooks.onStartup();
}

async function onMainWindowLoad({ window }, reason) {
  Zotero.BibFix?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  Zotero.BibFix?.hooks.onMainWindowUnload(window);
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }
  Zotero.BibFix?.hooks.onShutdown();
}

function uninstall(data, reason) {}
