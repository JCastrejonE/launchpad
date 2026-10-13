/**
 * Hostinger API client — the EXCLUSIVE provisioning path for client VPSes
 * (ADR-001). Docs: https://developers.hostinger.com (VPS API).
 *
 * Shapes below are verified against the live OpenAPI document served at
 * https://developers.hostinger.com/openapi/openapi.json (the docs site is a
 * Scalar reference rendered from that spec) — operation IDs
 * `VPS_getVirtualMachinesV1`, `VPS_getVirtualMachineDetailsV1`,
 * `VPS_purchaseNewVirtualMachineV1`, `VPS_restartVirtualMachineV1`,
 * `VPS_createSnapshotV1`, `VPS_createPublicKeyV1`, `VPS_attachPublicKeyV1`.
 * Field names are kept in the API's own snake_case —
 * the client sends/receives these objects on the wire as-is (no case mapping
 * layer), so the type must match the JSON exactly.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { classifyHttpStatus, HostingerApiError } from "./errors.js";
import { assertSandboxVps } from "./sandbox.js";

/**
 * Injectable fetch, so contract tests run with zero network access. Defaults
 * to the global `fetch` in production. Matches the shape the client uses — a
 * subset of the WHATWG fetch signature.
 */
export type FetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface HostingerConfig {
  apiToken: string; // from HOSTINGER_API_TOKEN env (Vault owner/hostinger is the phase-5 path)
  baseUrl?: string; // default https://developers.hostinger.com/api/vps/v1
  /** DNS API base (spec 0148 B). Default https://developers.hostinger.com/api/dns/v1. */
  dnsBaseUrl?: string;
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: FetchFn;
  /** Per-request timeout in ms (surfaces as a retryable timeout error). Default below. */
  timeoutMs?: number;
  /** Max retries on 429/5xx/network/timeout (bounded backoff). Default below. */
  maxRetries?: number;
  /**
   * Base delay (ms) for exponential backoff between retries (doubles each
   * attempt: base, base*2, base*4, ...). Default below. Tests inject a tiny
   * value to keep retry assertions fast without a real network wait.
   */
  retryBaseDelayMs?: number;
  /**
   * Overrides the sandbox allowlist path (see `sandbox.ts`) the DESTRUCTIVE
   * helpers (`restartVps`/`createSnapshot`/`attachSshKey`) check `id` against
   * before making a request. Tests only — production never sets this and gets
   * the real `infra/fleet-sandbox.json` (ADR-013 / spec 0014 plan step 2).
   */
  sandboxAllowlistPath?: string;
}

/** Default per-request timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Default retry bound for retryable failures. */
export const DEFAULT_MAX_RETRIES = 3;
/** Default base backoff delay (ms) between retries. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 200;

const DEFAULT_BASE_URL = "https://developers.hostinger.com/api/vps/v1";
const DEFAULT_DNS_BASE_URL = "https://developers.hostinger.com/api/dns/v1";

/** Resolves the effective VPS API base URL: explicit config wins, else the documented default. */
export function resolveBaseUrl(cfg: HostingerConfig): string {
  return cfg.baseUrl ?? DEFAULT_BASE_URL;
}

/** Resolves the effective DNS API base URL (spec 0148 B): explicit config wins, else the default. */
export function resolveDnsBaseUrl(cfg: HostingerConfig): string {
  return cfg.dnsBaseUrl ?? DEFAULT_DNS_BASE_URL;
}

/** Default TTL (seconds) for records written by `upsertDnsRecord` (Hostinger's zone default). */
export const DEFAULT_DNS_TTL = 14400;

/** One IP address bound to a virtual machine (`VPS.V1.IPAddress.IPAddressResource`). */
export interface VpsIpAddress {
  id: number;
  address: string;
  ptr: string | null;
}

/** OS template installed on a virtual machine (`VPS.V1.Template.TemplateResource`). */
export interface VpsTemplate {
  id: number;
  name: string;
  description: string;
  documentation: string | null;
}

/** Full state enum per `VPS.V1.VirtualMachine.VirtualMachineResource.state`. */
export type VpsState =
  | "running"
  | "starting"
  | "stopping"
  | "stopped"
  | "creating"
  | "initial"
  | "error"
  | "suspending"
  | "unsuspending"
  | "suspended"
  | "destroying"
  | "destroyed"
  | "recreating"
  | "restoring"
  | "recovery"
  | "stopping_recovery";

/**
 * `VPS.V1.VirtualMachine.VirtualMachineResource` — returned by `listVps`,
 * `getVps`, and embedded in `createVps`'s response. `listVps` is a plain
 * array with no pagination envelope (confirmed against the OpenAPI spec: the
 * `get` operation on `/virtual-machines` takes no query parameters).
 */
export interface VpsInstance {
  id: number;
  firewall_group_id: number | null;
  subscription_id: string | null;
  data_center_id: number | null;
  plan: string | null;
  hostname: string;
  state: VpsState;
  actions_lock: "unlocked" | "locked";
  cpus: number;
  memory: number; // megabytes
  disk: number; // megabytes
  bandwidth: number; // megabytes/month
  ns1: string | null;
  ns2: string | null;
  ipv4: VpsIpAddress[] | null;
  ipv6: VpsIpAddress[] | null;
  template: VpsTemplate | null;
  created_at: string; // ISO 8601
}

/** Inline SSH key material for `CreateVpsSetup.public_key` (no pre-registered key ID needed). */
export interface CreateVpsPublicKey {
  name: string;
  key: string;
}

/**
 * `VPS.V1.PublicKey.PublicKeyResource` — a public key registered on the
 * ACCOUNT (not tied to any one VM yet). Returned by `POST /public-keys`
 * (`VPS_createPublicKeyV1`) and listed by `GET /public-keys`.
 */
export interface VpsPublicKey {
  id: number;
  name: string;
  key: string;
}

/** `VPS.V1.VirtualMachine.SetupRequest` — nested under `CreateVpsRequest.setup`. */
export interface CreateVpsSetup {
  template_id: number;
  data_center_id: number;
  post_install_script_id?: number;
  /** Min length 12 per the API; a random password is generated if omitted (never returned). */
  password?: string;
  /** Overrides the default `srv<id>.hstgr.cloud` hostname. */
  hostname?: string;
  install_monarx?: boolean;
  enable_backups?: boolean;
  ns1?: string;
  ns2?: string;
  public_key?: CreateVpsPublicKey;
}

/**
 * `VPS.V1.VirtualMachine.PurchaseRequest` — the real `createVps` request body.
 * NOTE: this endpoint is "purchase and set up a new virtual machine"
 * (`VPS_purchaseNewVirtualMachineV1`); there is no raw cloud-init/user-data
 * field in the public API — provisioning is template + post-install-script +
 * SSH key, not free-form user data.
 */
export interface CreateVpsRequest {
  /** Catalog price item ID, e.g. "hostingercom-vps-kvm2-usd-1m". */
  item_id: string;
  /** Defaults to the account's default payment method if omitted. */
  payment_method_id?: number;
  setup: CreateVpsSetup;
  coupons?: string[];
}

/** `Billing.V1.Order.OrderBillingAddressResource`. */
export interface VpsOrderBillingAddress {
  first_name: string;
  last_name: string;
  company: string | null;
  address_1: string | null;
  address_2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
  email: string;
}

/** `Billing.V1.Order.OrderResource`. */
export interface VpsOrder {
  id: number;
  subscription_id: string;
  status:
    | "completed"
    | "pending"
    | "processing"
    | "failed"
    | "refunded"
    | "cancelled"
    | "awaiting_payment"
    | "payment_initiated"
    | "fraud_refund";
  currency: string;
  subtotal: number; // cents, excl. VAT
  total: number; // cents, incl. VAT
  billing_address: VpsOrderBillingAddress;
  created_at: string;
  updated_at: string;
}

/** `Billing.V1.Order.VirtualMachineOrderResource` — the real `createVps` response. */
export interface CreateVpsResponse {
  order: VpsOrder;
  virtual_machine: VpsInstance;
}

/**
 * `VPS.V1.Action.ActionResource` — the real response for `restartVps` and
 * `createSnapshot`: both are async actions on Hostinger's side, not bare
 * acks, so they surface an action id/state rather than `void`.
 */
export interface VpsAction {
  id: number;
  name: string;
  state: "success" | "error" | "delayed" | "sent" | "created";
  created_at: string;
  updated_at: string;
}

/**
 * One value inside a DNS record set. For an A record `content` is the IPv4
 * address; the Hostinger DNS API groups values by (name, type) under `records`.
 */
export interface DnsRecordValue {
  content: string;
}

/**
 * A DNS record set for one (`name`, `type`) pair — the shape
 * `GET /api/dns/v1/zones/{domain}` returns and `PUT` accepts. `name` is the
 * subdomain relative to the zone (`"@"` for the apex); `content` values live in
 * `records`. Verified against the Hostinger DNS v1 API (`DNS_getRecordsV1` /
 * `DNS_updateRecordsV1`).
 */
export interface DnsRecordSet {
  name: string;
  type: string; // "A", "CNAME", "TXT", ...
  ttl: number;
  records: DnsRecordValue[];
}

/** Input for `upsertDnsRecord` — one A record `<name>.<domain>` → `content`. */
export interface UpsertDnsRecordInput {
  /** Zone apex, e.g. "example.com". */
  domain: string;
  /** Subdomain relative to the zone, e.g. "<slug>" or "<slug>.odoo". */
  name: string;
  /** IPv4 the A record should resolve to (the sandbox VPS IP for spec 0148). */
  content: string;
  /** TTL seconds; defaults to `DEFAULT_DNS_TTL`. */
  ttl?: number;
}

/** Whether `upsertDnsRecord` wrote the record or found it already correct. */
export type DnsUpsertOutcome = "created" | "unchanged";

/** Result of `upsertDnsRecord`, derived from the zone read-back (not the PUT status). */
export interface DnsUpsertResult {
  domain: string;
  name: string;
  type: "A";
  content: string;
  outcome: DnsUpsertOutcome;
}

export class HostingerClient {
  private readonly baseUrl: string;
  private readonly dnsBaseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly sandboxAllowlistPath?: string;

  constructor(private readonly cfg: HostingerConfig) {
    this.baseUrl = resolveBaseUrl(cfg);
    this.dnsBaseUrl = resolveDnsBaseUrl(cfg);
    this.fetchFn = cfg.fetch ?? (globalThis.fetch as FetchFn);
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = cfg.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = cfg.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.sandboxAllowlistPath = cfg.sandboxAllowlistPath;
  }

  /**
   * Bounded retry/backoff around a single `attemptRequest`. Retries only
   * failures classified as retryable (429/5xx/network/timeout — see
   * errors.ts), up to `maxRetries` additional attempts, with exponential
   * backoff (`retryBaseDelayMs * 2^attempt`). Non-retryable failures (other
   * 4xx, auth, not_found) throw on the first attempt. All five methods route
   * through here.
   */
  private async request<T>(
    method: string,
    pathname: string,
    init?: { body?: unknown; query?: Record<string, string | number>; baseUrl?: string },
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attemptRequest<T>(method, pathname, init);
      } catch (err) {
        const canRetry =
          err instanceof HostingerApiError && err.retryable && attempt < this.maxRetries;
        if (!canRetry) throw err;
        await this.delay(this.retryBaseDelayMs * 2 ** attempt);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return sleep(ms);
  }

  /**
   * Single request attempt: Bearer auth, JSON parse, timeout via
   * AbortController, status→typed-error mapping (see errors.ts). The token is
   * set only in the Authorization header and must never be placed in a thrown
   * message. `request` above wraps this in bounded retry/backoff.
   */
  private async attemptRequest<T>(
    method: string,
    pathname: string,
    init?: { body?: unknown; query?: Record<string, string | number>; baseUrl?: string },
  ): Promise<T> {
    const url = new URL(pathname.replace(/^\//, ""), `${init?.baseUrl ?? this.baseUrl}/`);
    if (init?.query) {
      for (const [key, value] of Object.entries(init.query)) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.apiToken}`,
      Accept: "application/json",
    };
    const body = init?.body !== undefined ? JSON.stringify(init.body) : undefined;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(url.toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      const isAbort = cause instanceof Error && cause.name === "AbortError";
      if (isAbort) {
        throw new HostingerApiError(
          "timeout",
          `Hostinger API request timed out after ${this.timeoutMs}ms`,
          { retryable: true, cause },
        );
      }
      throw new HostingerApiError("network", "Hostinger API request failed (network error)", {
        retryable: true,
        cause,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = undefined; // non-JSON body (e.g. an upstream gateway error page)
      }
    }

    if (response.ok) {
      return parsed as T;
    }

    const { kind, retryable } = classifyHttpStatus(response.status);
    let message = `Hostinger API request failed with status ${response.status}`;
    if (parsed && typeof parsed === "object") {
      const candidate = (parsed as { message?: unknown }).message;
      if (typeof candidate === "string") message = candidate;
    }
    throw new HostingerApiError(kind, message, { status: response.status, retryable });
  }

  /**
   * GET /virtual-machines. Verified against the OpenAPI spec: the response is
   * a bare array (`VirtualMachineCollection`) with no pagination envelope or
   * query parameters — nothing to paginate here today.
   */
  async listVps(): Promise<VpsInstance[]> {
    return this.request<VpsInstance[]>("GET", "virtual-machines");
  }

  /** GET /virtual-machines/{id}. */
  async getVps(id: number): Promise<VpsInstance> {
    return this.request<VpsInstance>("GET", `virtual-machines/${id}`);
  }

  /**
   * POST /virtual-machines ("purchase and set up a new virtual machine").
   * Returns both the billing order and the created instance, per the API's
   * `VirtualMachineOrderResource` — not a bare `VpsInstance`.
   */
  async createVps(req: CreateVpsRequest): Promise<CreateVpsResponse> {
    return this.request<CreateVpsResponse>("POST", "virtual-machines", { body: req });
  }

  /**
   * POST /virtual-machines/{id}/restart. Returns the async `ActionResource`
   * Hostinger creates for the restart, not a bare ack.
   *
   * DESTRUCTIVE: refuses a non-sandbox-allowlisted `id` before making the
   * request (ADR-013 / spec 0014 plan step 2 — see `sandbox.ts`). Read-only
   * calls (`getVps`/`listVps`) stay unrestricted.
   */
  async restartVps(id: number): Promise<VpsAction> {
    assertSandboxVps(id, "restartVps", this.sandboxAllowlistPath);
    return this.request<VpsAction>("POST", `virtual-machines/${id}/restart`);
  }

  /**
   * POST /virtual-machines/{id}/snapshot. Overwrites any existing snapshot
   * (per the API docs). Returns the async `ActionResource`, not a bare ack.
   *
   * DESTRUCTIVE: refuses a non-sandbox-allowlisted `id` before making the
   * request (ADR-013 / spec 0014 plan step 2 — see `sandbox.ts`).
   */
  async createSnapshot(id: number): Promise<VpsAction> {
    assertSandboxVps(id, "createSnapshot", this.sandboxAllowlistPath);
    return this.request<VpsAction>("POST", `virtual-machines/${id}/snapshot`);
  }

  /**
   * Attaches an SSH public key to an EXISTING, running VM so the fleet can SSH
   * in from zero (0012's finding: `ensureSshKeyAccess`'s ssh-append path needs
   * the very access it exists to create).
   *
   * Verified against the live OpenAPI doc: there is no single "attach raw key
   * material to a VM" endpoint. Key attach is account-scoped in two steps —
   * this method wraps both so the caller-facing shape (id + key material in,
   * one `VpsAction` out) matches what `ensureSshKeyAccess` needs:
   *   1. `POST /public-keys` (`VPS_createPublicKeyV1`) registers the key
   *      material on the ACCOUNT (not yet attached to any VM), returning a
   *      `VpsPublicKey` with an id.
   *   2. `POST /public-keys/attach/{virtualMachineId}` (`VPS_attachPublicKeyV1`)
   *      attaches a set of already-registered key IDs to the VM, returning the
   *      same async `ActionResource` shape as `restartVps`/`createSnapshot`.
   * Both calls work against a running VM — no residual manual step here.
   *
   * DESTRUCTIVE: refuses a non-sandbox-allowlisted `id` before making either
   * request (ADR-013 / spec 0014 plan step 2 — see `sandbox.ts`).
   */
  async attachSshKey(id: number, key: CreateVpsPublicKey): Promise<VpsAction> {
    assertSandboxVps(id, "attachSshKey", this.sandboxAllowlistPath);
    const registered = await this.request<VpsPublicKey>("POST", "public-keys", { body: key });
    return this.request<VpsAction>("POST", `public-keys/attach/${id}`, {
      body: { ids: [registered.id] },
    });
  }

  /**
   * GET /api/dns/v1/zones/{domain} — the authoritative record sets for a zone
   * (spec 0148 B). Read-only; uses the DNS base, not the VPS base. The response
   * is a bare array of `DnsRecordSet` (one entry per name+type).
   */
  async getDnsRecords(domain: string): Promise<DnsRecordSet[]> {
    return this.request<DnsRecordSet[]>("GET", `zones/${encodeURIComponent(domain)}`, {
      baseUrl: this.dnsBaseUrl,
    });
  }

  /**
   * Idempotently ensure an A record `<name>.<domain>` → `content` (spec 0148 B).
   *
   * SAFETY — never overwrites a live customer's DNS. The decision is driven by a
   * zone read (`getDnsRecords`), not by any write's status code:
   *  - an A record for this name already resolving to a **different** target
   *    (e.g. `client-b`/`client-b-odoo` → 203.0.113.30) → refuse with a `conflict`
   *    error, never overwrite;
   *  - already resolving to `content` → no-op (`unchanged`), no write;
   *  - absent → write it (`overwrite: false`, so nothing else in the zone is
   *    touched) and report `created`.
   *
   * Idempotency is thus enforced here (a second identical call re-reads, finds
   * the record, and writes nothing) rather than relying on the API deduping.
   */
  async upsertDnsRecord(input: UpsertDnsRecordInput): Promise<DnsUpsertResult> {
    const { domain, name, content } = input;
    const ttl = input.ttl ?? DEFAULT_DNS_TTL;

    const existing = (await this.getDnsRecords(domain))
      .filter((set) => set.type === "A" && set.name === name)
      .flatMap((set) => set.records.map((r) => r.content));

    const conflicting = existing.filter((c) => c !== content);
    if (conflicting.length > 0) {
      throw new HostingerApiError(
        "conflict",
        `refusing to overwrite DNS A record ${name}.${domain}: already resolves to ` +
          `${conflicting.join(", ")}, not ${content} — a slug colliding with an existing ` +
          `record pointing elsewhere must be reported, never overwritten`,
        { retryable: false },
      );
    }

    if (existing.includes(content)) {
      return { domain, name, type: "A", content, outcome: "unchanged" };
    }

    await this.request("PUT", `zones/${encodeURIComponent(domain)}`, {
      baseUrl: this.dnsBaseUrl,
      body: {
        overwrite: false,
        zone: [{ name, type: "A", ttl, records: [{ content }] }],
      },
    });
    return { domain, name, type: "A", content, outcome: "created" };
  }
}
