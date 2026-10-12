import { X509Certificate } from "node:crypto";
import tls from "node:tls";

// PEM text is re-serialized by Node, so compare certificates, not strings.
const fingerprint = (pem: string) => {
  try {
    return new X509Certificate(pem).fingerprint256;
  } catch {
    return pem;
  }
};

type CertificateApi = Pick<
  typeof tls,
  "getCACertificates" | "setDefaultCACertificates"
>;

/**
 * Trusts root certificates from the operating system, such as an enterprise
 * CA for a self-hosted Jira or Confluence site, in addition to Node's bundled
 * roots. Chromium already uses this store; Node's fetch does not by default.
 * Certificate verification stays enabled. NODE_USE_SYSTEM_CA=0 opts out.
 * Returns the number of roots added.
 */
export function trustSystemCertificates(
  api: CertificateApi = tls,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.NODE_USE_SYSTEM_CA === "0") return 0;
  // Node-based child processes, such as local MCP servers, read this at startup.
  env.NODE_USE_SYSTEM_CA ??= "1";
  try {
    const current = api.getCACertificates("default");
    const known = new Set(current.map(fingerprint));
    const added = api.getCACertificates("system").filter((certificate) => {
      const key = fingerprint(certificate);
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
    if (added.length) api.setDefaultCACertificates([...current, ...added]);
    return added.length;
  } catch {
    // An unreadable system store must not block startup; bundled roots remain.
    return 0;
  }
}
