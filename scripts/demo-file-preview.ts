/** The demo has no files; these checks need one real text response rather than its folder fallback. */
export const demoFilePreviewScript = (name: string, text: string): string => `<script>(${((name: string, text: string) => {
  const demoFetch = window.fetch;
  window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const path = url.searchParams.get("path") ?? "";
    if (path === name || path.endsWith(`/${name}`)) {
      if (url.pathname.endsWith("/fs/stat")) return Promise.resolve(Response.json({
        path, name, kind: "text", mime: "text/markdown", size: text.length,
      }));
      if (url.pathname.endsWith("/fs/file")) return Promise.resolve(new Response(text, { headers: { "content-type": "text/markdown" } }));
    }
    return demoFetch(input, init);
  }, { preconnect: demoFetch.preconnect });
}).toString()})(${JSON.stringify(name)}, ${JSON.stringify(text)});</script>`;

/** A short README, for the checks that only need a Markdown file to open. */
export const DEMO_FILE_PREVIEW_SCRIPT = demoFilePreviewScript("README.md", "# File preview\n\nA readable demo fixture.\n");
