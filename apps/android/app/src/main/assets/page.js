// Runs at document start in the site's pages only (WebViewCompat.addDocumentStartJavaScript, restricted to the site's
// origin). `YesImBotApp` is the app's message listener, also restricted to that origin.
(() => {
  const post = (message) => YesImBotApp.postMessage(JSON.stringify(message));

  // The status and navigation bars take the page's background, and dark icons on a light page.
  const theme = () => {
    if (!document.body) return;
    const dark = getComputedStyle(document.documentElement).colorScheme === "dark";
    post({ type: "theme", background: getComputedStyle(document.body).backgroundColor, dark });
  };
  addEventListener("DOMContentLoaded", () => {
    theme();
    new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", theme);
  });

  // A WebView cannot save a file the page made itself (a `blob:` or `data:` link with `download`, such as an exported
  // character card): read it here and hand it to the app, which saves it to 下载.
  addEventListener(
    "click",
    (event) => {
      const link = event.target instanceof Element ? event.target.closest("a[href][download]") : null;
      if (!link || !/^(blob|data):/.test(link.href)) return;
      event.preventDefault();
      const name = link.download;
      fetch(link.href)
        .then((response) => response.blob())
        .then(
          (blob) =>
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            }),
        )
        .then(
          (data) => post({ type: "save", name, data }),
          () => post({ type: "save", name, data: "" }),
        );
    },
    true,
  );
})();
