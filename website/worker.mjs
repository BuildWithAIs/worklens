const security = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cache-Control": "no-cache",
};

export default {
  async fetch(request, env) {
    const headers = new Headers(security);
    if (!["GET", "HEAD"].includes(request.method)) {
      headers.set("Allow", "GET, HEAD");
      return new Response(null, { status: 405, headers });
    }
    try {
      const current = await env.SITE.get("current.json");
      if (!current) throw new Error("No release");
      const release = await current.json();
      if (
        !/^[a-f0-9]{40}$/.test(release.revision) ||
        !Array.isArray(release.files)
      ) {
        throw new Error("Invalid release");
      }
      let path;
      try {
        path = decodeURIComponent(new URL(request.url).pathname).slice(1);
      } catch {
        return new Response(null, { status: 400, headers });
      }
      const key = path || "index.html";
      const found =
        release.files.includes(key) &&
        !key.split("/").some((p) => p.startsWith(".") || p.startsWith("_"));
      const object = await env.SITE.get(
        `releases/${release.revision}/${found ? key : "404.html"}`,
      );
      if (!object) throw new Error("Missing release object");
      object.writeHttpMetadata(headers);
      // Bucket object metadata cannot relax the fixed serving policy.
      for (const [name, value] of Object.entries(security))
        headers.set(name, value);
      headers.set("ETag", object.httpEtag);
      headers.set("X-WorkLens-Release", release.revision);
      if (
        found &&
        request.headers
          .get("If-None-Match")
          ?.split(",")
          .some((tag) =>
            [object.httpEtag, `W/${object.httpEtag}`, "*"].includes(tag.trim()),
          )
      ) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(request.method === "HEAD" ? null : object.body, {
        status: found ? 200 : 404,
        headers,
      });
    } catch {
      headers.set("Cache-Control", "no-store");
      return new Response(
        request.method === "HEAD" ? null : "Website temporarily unavailable",
        { status: 503, headers },
      );
    }
  },
};
