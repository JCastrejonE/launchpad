/**
 * The tenant's own Odoo, over JSON-RPC.
 *
 * `common.version` needs no authentication, which is the whole reason this file
 * holds no credentials: a public-facing container should not carry the admin
 * password, and the acceptance ("render data FROM that Odoo") is satisfied
 * without one.
 *
 * Every failure THROWS. The page is the proof that this front reached that
 * Odoo; swallowing an error and rendering a friendly placeholder would make a
 * broken deploy look healthy, which is the one outcome that must be impossible.
 */
export interface OdooVersion {
  server_version: string;
  server_serie: string;
  protocol_version: number;
}

export function odooUrl(): string {
  const url = process.env.ODOO_URL;
  if (!url) throw new Error("ODOO_URL no está configurado en el contenedor del front.");
  return url.replace(/\/+$/, "");
}

export async function fetchOdooVersion(): Promise<OdooVersion> {
  const base = odooUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/jsonrpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { service: "common", method: "version", args: [] },
        id: 1,
      }),
      cache: "no-store",
    });
  } catch (cause) {
    throw new Error(`No se pudo contactar a Odoo en ${base}: ${(cause as Error).message}`);
  }
  if (!res.ok) throw new Error(`Odoo en ${base} respondió HTTP ${res.status}.`);

  const body = (await res.json()) as { result?: OdooVersion; error?: { data?: { message?: string } } };
  if (body.error) {
    throw new Error(`Odoo en ${base} devolvió un error: ${body.error.data?.message ?? "desconocido"}`);
  }
  if (!body.result?.server_version) {
    throw new Error(`Respuesta inesperada de Odoo en ${base}: sin server_version.`);
  }
  return body.result;
}
