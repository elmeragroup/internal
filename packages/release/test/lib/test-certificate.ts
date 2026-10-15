import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { onTestFinished } from "vitest";

/** A throwaway PEM key and self-signed certificate for `127.0.0.1` and `localhost`. */
export type TestCertificate = {
  key: string;
  cert: string;
};

/**
 * Generates a P-256 key and a one-day self-signed certificate with `openssl`, which the
 * `ubuntu-latest` CI runners and macOS both ship. Generating it per run keeps private key material
 * out of the repository, where secret scanners would flag it.
 */
export function createTestCertificate(): TestCertificate {
  const directory = mkdtempSync(join(tmpdir(), "elmera-release-tls-"));
  try {
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdio: "pipe" }
    );
    return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Adds `certificate` to the default trust store that TLS connections without an explicit `ca` use,
 * which is how the production transport connects, until the current test finishes. Certificate
 * verification stays on: the server must still present this certificate for its address.
 */
export function trustUntilTestFinishes(certificate: TestCertificate): void {
  const previous = getCACertificates("default");
  setDefaultCACertificates([...previous, certificate.cert]);
  onTestFinished(() => {
    setDefaultCACertificates(previous);
  });
}
