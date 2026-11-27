import { renderToString } from "@vue/server-renderer";
import { createSSRApp, h } from "vue";

import OAuthProgress from "./src/pages/OAuthProgress.vue";
import PublicDocument from "./src/pages/PublicDocument.vue";
import about from "./src/public-content/about.html?raw";
import meta from "./src/public-content/meta.json";
import privacy from "./src/public-content/privacy.html?raw";
import terms from "./src/public-content/terms.html?raw";
import { THEME_STORAGE_KEY } from "./src/theme";
export async function renderDocuments(css: string) {
  const documents: Record<string, string> = {};
  const theme = `try{const v=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(v==="light"||v==="dark")document.documentElement.setAttribute("data-theme",v)}catch{}`;
  for (const page of ["about", "privacy", "terms"] as const) {
    const body = await renderToString(createSSRApp({ render: () => h(PublicDocument, { page, body: { about, privacy, terms }[page] }) }));
    documents[page] =
      `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${meta[page].description}"><title>${meta[page].title} · YesImBot</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="${css}"><script>${theme}</script></head><body>${body}</body></html>`;
  }
  const callback = await renderToString(createSSRApp(OAuthProgress));
  documents["google-callback"] =
    `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 Google</title><link rel="stylesheet" href="${css}"></head><body>${callback}<!-- OAUTH_CALLBACK_SCRIPT --></body></html>`;
  return documents;
}
