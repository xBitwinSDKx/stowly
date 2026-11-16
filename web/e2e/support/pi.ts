/**
 * Was ein Raspberry Pi beim Koppeln schickt (docs/sync-protokoll.md, 11.8), ohne Pi.
 *
 * Den Zertifikatsantrag erzeugt auf dem Pi openssl; hier übernimmt das `cryptography` aus der
 * Umgebung des Servers (dasselbe Python, das die Tests ohnehin brauchen). Der Schlüssel bleibt im
 * Prozess und wird nirgends gespeichert.
 */
import { spawnSync } from "node:child_process";

import { pythonPath } from "./server";

const CSR_SCRIPT = [
  "import sys",
  "from cryptography import x509",
  "from cryptography.hazmat.primitives import hashes, serialization",
  "from cryptography.hazmat.primitives.asymmetric import ec",
  "from cryptography.x509.oid import NameOID",
  "key = ec.generate_private_key(ec.SECP256R1())",
  "name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, sys.argv[1])])",
  "csr = x509.CertificateSigningRequestBuilder().subject_name(name).sign(key, hashes.SHA256())",
  "sys.stdout.write(csr.public_bytes(serialization.Encoding.PEM).decode())",
].join("\n");

/** Ein Zertifikatsantrag (PEM) mit einem frischen Schlüssel auf P-256. */
export function makeCsr(hostname = "stowly-pi"): string {
  const result = spawnSync(pythonPath(), ["-I", "-c", CSR_SCRIPT, hostname], { encoding: "utf-8", windowsHide: true });
  if (result.status !== 0 || !result.stdout.includes("BEGIN CERTIFICATE REQUEST")) {
    throw new Error(`Der Zertifikatsantrag ließ sich nicht erzeugen: ${result.stderr}`);
  }
  return result.stdout;
}
