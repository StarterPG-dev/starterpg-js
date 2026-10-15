/**
 * @starterpg/js — the client for a starterpg.com project.
 *
 * The HTTP client is dependency-free and works in browsers, Node 18+, Deno and
 * edge runtimes. Realtime also requires a global `WebSocket` implementation.
 *
 *   const db = createClient(PROJECT_URL, API_KEY);
 *   const { data } = await db.from("todos").select("*").eq("done", false);
 *
 * Use a publishable key with an end-user token when row-level security should
 * apply. Secret keys are server-side credentials.
 */

export interface StarterpgResponse<T> {
  data: T | null;
  error: StarterpgError | null;
  count: number | null;
  status: number;
}

export interface StarterpgError {
  message: string;
  code?: string;
  detail?: string;
  hint?: string;
}

export interface ClientOptions {
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Realtime gateway URL; defaults to the project URL with ws(s):// */
  realtimeUrl?: string;
}

export interface SchemaColumn {
  name: string;
  type: string;
  nullable?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  default?: unknown;
  references?: { table: string; column: string; onDelete?: string };
}

export interface StorageBucketOptions {
  public?: boolean;
  fileSizeLimit?: number;
  allowedMime?: string[];
}

export type SchemaOperation =
  | { kind: "create_table"; schema?: string; name: string; columns: SchemaColumn[] }
  | { kind: "drop_table"; schema?: string; name: string; cascade?: boolean }
  | { kind: "rename_table"; schema?: string; from: string; to: string }
  | { kind: "add_column"; schema?: string; table: string; column: SchemaColumn }
  | { kind: "drop_column"; schema?: string; table: string; column: string }
  | { kind: "rename_column"; schema?: string; table: string; from: string; to: string }
  | { kind: "create_index"; schema?: string; table: string; columns: string[]; unique?: boolean }
  | { kind: "drop_index"; schema?: string; name: string };

class QueryBuilder<T = Record<string, unknown>> implements PromiseLike<StarterpgResponse<T[]>> {
  private readonly filters: string[] = [];
  private selectList = "*";
  private orderBy?: string;
  private limitValue?: number;
  private offsetValue?: number;
  private wantsCount = false;
  private method: "GET" | "POST" | "PATCH" | "DELETE" = "GET";
  private body?: unknown;
  private prefer: string[] = [];
  private single = false;
  private conflictTarget?: string;

  constructor(
    private readonly client: StarterpgClient,
    private readonly table: string,
  ) {}

  select(columns = "*"): this {
    this.selectList = columns;
    return this;
  }

  /** Ask for the total row count; read it from `count` on the response. */
  count(): this {
    this.wantsCount = true;
    return this;
  }

  insert(values: unknown): this {
    this.method = "POST";
    this.body = values;
    return this;
  }

  /** Insert, or update the existing row on a primary-key conflict. */
  upsert(values: unknown, options: { onConflict?: string } = {}): this {
    this.method = "POST";
    this.body = values;
    this.prefer.push("resolution=merge-duplicates");
    this.conflictTarget = options.onConflict;
    return this;
  }

  update(values: unknown): this {
    this.method = "PATCH";
    this.body = values;
    return this;
  }

  delete(): this {
    this.method = "DELETE";
    return this;
  }

  /** Return the single matching row rather than an array; errors unless exactly one. */
  maybeSingle(): this {
    this.single = true;
    return this;
  }

  /** Skip the response body entirely — cheaper for fire-and-forget writes. */
  minimal(): this {
    this.prefer.push("return=minimal");
    return this;
  }

  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}): this {
    const direction = options.ascending === false ? "desc" : "asc";
    const nulls =
      options.nullsFirst === undefined
        ? ""
        : options.nullsFirst
          ? ".nullsfirst"
          : ".nullslast";
    this.orderBy = `${column}.${direction}${nulls}`;
    return this;
  }

  limit(value: number): this {
    this.limitValue = value;
    return this;
  }

  range(from: number, to: number): this {
    this.offsetValue = from;
    this.limitValue = to - from + 1;
    return this;
  }

  // --- filters -------------------------------------------------------------

  private filter(column: string, operator: string, value: unknown): this {
    this.filters.push(`${encodeURIComponent(column)}=${operator}.${encodeURIComponent(String(value))}`);
    return this;
  }

  eq(column: string, value: unknown) { return this.filter(column, "eq", value); }
  neq(column: string, value: unknown) { return this.filter(column, "neq", value); }
  gt(column: string, value: unknown) { return this.filter(column, "gt", value); }
  gte(column: string, value: unknown) { return this.filter(column, "gte", value); }
  lt(column: string, value: unknown) { return this.filter(column, "lt", value); }
  lte(column: string, value: unknown) { return this.filter(column, "lte", value); }
  like(column: string, pattern: string) { return this.filter(column, "like", pattern); }
  ilike(column: string, pattern: string) { return this.filter(column, "ilike", pattern); }
  contains(column: string, value: unknown) { return this.filter(column, "cs", value); }
  overlaps(column: string, value: unknown) { return this.filter(column, "ov", value); }
  textSearch(column: string, query: string) { return this.filter(column, "fts", query); }

  is(column: string, value: null | boolean) {
    return this.filter(column, "is", value === null ? "null" : String(value));
  }

  not(column: string, operator: string, value: unknown) {
    return this.filter(column, `not.${operator}`, value);
  }

  in(column: string, values: unknown[]) {
    this.filters.push(
      `${encodeURIComponent(column)}=in.(${values.map((v) => encodeURIComponent(String(v))).join(",")})`,
    );
    return this;
  }

  /** `or("done.is.true,priority.gte.3")` */
  or(conditions: string) {
    this.filters.push(`or=(${conditions})`);
    return this;
  }

  private buildUrl(): string {
    const params = [...this.filters];
    if (this.selectList !== "*") params.push(`select=${encodeURIComponent(this.selectList)}`);
    if (this.orderBy) params.push(`order=${encodeURIComponent(this.orderBy)}`);
    if (this.limitValue !== undefined) params.push(`limit=${this.limitValue}`);
    if (this.offsetValue !== undefined) params.push(`offset=${this.offsetValue}`);
    if (this.wantsCount) params.push("count=exact");
    if (this.conflictTarget) params.push(`on_conflict=${encodeURIComponent(this.conflictTarget)}`);

    const query = params.length ? `?${params.join("&")}` : "";
    return `${this.client.url}/rest/${encodeURIComponent(this.table)}${query}`;
  }

  /**
   * Thenable, so a builder can be awaited directly without a terminal method —
   * `await db.from("todos").select()` reads better than `.execute()`.
   */
  then<R1 = StarterpgResponse<T[]>, R2 = never>(
    onfulfilled?: ((value: StarterpgResponse<T[]>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<StarterpgResponse<T[]>> {
    const headers: Record<string, string> = { ...this.client.headers };
    if (this.body !== undefined) headers["content-type"] = "application/json";
    if (this.prefer.length) headers["prefer"] = this.prefer.join(", ");
    if (this.single) headers["accept"] = "application/vnd.pgrst.object+json";

    return this.client.request<T[]>(this.buildUrl(), {
      method: this.method,
      headers,
      body: this.body === undefined ? undefined : JSON.stringify(this.body),
    });
  }
}

class SchemaApi {
  constructor(private readonly client: StarterpgClient) {}

  inspect() {
    return this.client.request<{ tables: unknown[] }>(`${this.client.url}/schema`, {
      method: "GET",
      headers: { ...this.client.headers },
    });
  }

  change(operation: SchemaOperation, options: { preview?: boolean } = {}) {
    const query = options.preview ? "?preview=true" : "";
    return this.client.request<{ sql: string; executed: boolean }>(
      `${this.client.url}/schema${query}`,
      {
        method: "POST",
        headers: { ...this.client.headers, "content-type": "application/json" },
        body: JSON.stringify(operation),
      },
    );
  }

  createTable(name: string, columns: SchemaColumn[], options: { preview?: boolean } = {}) {
    return this.change({ kind: "create_table", name, columns }, options);
  }

  usage() {
    return this.client.request<{ tables: unknown[]; updatedAt: string }>(
      `${this.client.url}/schema/usage`,
      { method: "GET", headers: { ...this.client.headers } },
    );
  }

  changes() {
    return this.client.request<{ changes: unknown[] }>(`${this.client.url}/schema/changes`, {
      method: "GET",
      headers: { ...this.client.headers },
    });
  }

  migrations() {
    return this.client.request<{ migrations: unknown[] }>(
      `${this.client.url}/schema/migrations`,
      { method: "GET", headers: { ...this.client.headers } },
    );
  }

  applyMigration(id: string, operations: SchemaOperation[], options: { name?: string } = {}) {
    return this.client.request<{ migration: unknown; applied: boolean }>(
      `${this.client.url}/schema/migrations`,
      {
        method: "POST",
        headers: { ...this.client.headers, "content-type": "application/json" },
        body: JSON.stringify({ id, name: options.name, operations }),
      },
    );
  }

  templates() {
    return this.client.request<{ templates: unknown[] }>(`${this.client.url}/schema/templates`, {
      method: "GET",
      headers: { ...this.client.headers },
    });
  }

  applyTemplate(template: "blank" | "saas" | "blog" | "ecommerce" | "vector-search") {
    return this.client.request<{ template: string; tables: string[]; applied: boolean }>(
      `${this.client.url}/schema/templates`,
      {
        method: "POST",
        headers: { ...this.client.headers, "content-type": "application/json" },
        body: JSON.stringify({ template }),
      },
    );
  }
}

export class StarterpgClient {
  readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly url: string,
    readonly apiKey: string,
    private readonly options: ClientOptions = {},
  ) {
    this.url = url.replace(/\/$/, "");
    this.headers = { apikey: apiKey, ...options.headers };
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Attach an end-user access token to subsequent calls. */
  setAuth(accessToken: string | null): void {
    if (accessToken) this.headers.authorization = `Bearer ${accessToken}`;
    else delete this.headers.authorization;
  }

  from<T = Record<string, unknown>>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this, table);
  }

  /** Call a Postgres function. */
  async rpc<T = unknown>(
    fn: string,
    args: Record<string, unknown> = {},
  ): Promise<StarterpgResponse<T>> {
    return this.request<T>(`${this.url}/rpc/${encodeURIComponent(fn)}`, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
  }

  readonly auth = new AuthApi(this);
  readonly storage = new StorageApi(this);
  readonly schema = new SchemaApi(this);

  /**
   * One place where every HTTP response becomes `{ data, error }`.
   *
   * Errors are returned rather than thrown: a failed query is an ordinary
   * outcome, and forcing try/catch around every call makes for worse code.
   */
  async request<T>(url: string, init: RequestInit): Promise<StarterpgResponse<T>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (cause) {
      return {
        data: null,
        error: { message: cause instanceof Error ? cause.message : "Network error" },
        count: null,
        status: 0,
      };
    }

    const count = parseCount(response.headers.get("content-range"));

    if (response.status === 204) {
      return { data: null, error: null, count, status: 204 };
    }

    const text = await response.text();
    const payload = text ? safeParse(text) : null;

    if (!response.ok) {
      const body = (payload ?? {}) as Record<string, string>;
      const error: StarterpgError = {
        message: body.error ?? `Request failed with ${response.status}`,
      };
      if (body.code) error.code = body.code;
      if (body.detail) error.detail = body.detail;
      if (body.hint) error.hint = body.hint;
      return {
        data: null,
        error,
        count,
        status: response.status,
      };
    }

    return { data: payload as T, error: null, count, status: response.status };
  }

  /**
   * Subscribe to changes on a table.
   *
   * Returns an unsubscribe function. Reconnects with exponential backoff, and
   * reports gaps: LISTEN/NOTIFY has no replay, so anything that happened while
   * disconnected is lost and the caller should refetch.
   */
  channel(options: {
    table?: string;
    onChange: (change: RealtimeChange) => void;
    onStatus?: (status: "open" | "closed" | "gap") => void;
  }): () => void {
    const base =
      this.options.realtimeUrl ?? this.url.replace(/^http/, "ws").replace(/\/api\/v1\/.*$/, "");
    const ref = this.url.split("/").pop() ?? "";

    let socket: WebSocket | null = null;
    let attempt = 0;
    let closed = false;
    let lastSeq: number | null = null;
    /**
     * Whether this channel has ever been connected.
     *
     * Every reconnect is a gap. The gateway may scale to zero when nobody is
     * subscribed, and its sequence counter restarts from zero with the new
     * process — so comparing sequence numbers across a reconnect proves
     * nothing. Trusting the fresh `SUBSCRIBED` seq would report "no gap" for a
     * window in which every event was dropped, which is worse than not
     * checking at all.
     */
    let everConnected = false;

    const connect = () => {
      if (closed) return;
      const params = new URLSearchParams({ ref, apikey: this.apiKey });
      if (options.table) params.set("table", options.table);

      socket = new WebSocket(`${base}?${params}`);

      socket.onopen = () => {
        attempt = 0;
        options.onStatus?.("open");
      };

      socket.onmessage = (event) => {
        const message = safeParse(String(event.data)) as
          | (RealtimeChange & { seq?: number })
          | { type: "SUBSCRIBED"; seq?: number }
          | null;
        if (!message) return;

        // Control frames carry the starting sequence; they are not changes.
        if (message.type === "SUBSCRIBED") {
          if (typeof message.seq === "number") lastSeq = message.seq;
          // A resubscribe means we were away, and LISTEN/NOTIFY kept nothing
          // for us while we were. Say so, so the caller refetches.
          if (everConnected) options.onStatus?.("gap");
          everConnected = true;
          return;
        }

        // A jump in the sequence means events were missed.
        if (
          typeof message.seq === "number" &&
          lastSeq !== null &&
          message.seq > lastSeq + 1
        ) {
          options.onStatus?.("gap");
        }
        if (typeof message.seq === "number") lastSeq = message.seq;

        options.onChange(message);
      };

      socket.onclose = () => {
        options.onStatus?.("closed");
        if (closed) return;
        // Capped exponential backoff, so a gateway restart is not a stampede.
        const delay = Math.min(1000 * 2 ** attempt++, 30_000);
        setTimeout(connect, delay);
      };

      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      closed = true;
      socket?.close();
    };
  }
}

export interface RealtimeChange {
  type: "INSERT" | "UPDATE" | "DELETE";
  schema: string;
  table: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
  /** True when the row exceeded the NOTIFY size cap — refetch it. */
  truncated?: boolean;
  seq?: number;
}

class AuthApi {
  constructor(private readonly client: StarterpgClient) {}

  signUp(credentials: { email: string; password: string; data?: object }) {
    return this.post("signup", credentials);
  }

  signIn(credentials: { email: string; password: string }) {
    return this.post("login", credentials);
  }

  refresh(refreshToken: string) {
    return this.post("refresh", { refresh_token: refreshToken });
  }

  signOut(options: { refreshToken?: string; global?: boolean } = {}) {
    return this.post("logout", {
      refresh_token: options.refreshToken,
      scope: options.global ? "global" : undefined,
    });
  }

  getUser() {
    return this.client.request<{ user: Record<string, unknown> }>(
      `${this.client.url}/auth/me`,
      { method: "GET", headers: this.client.headers },
    );
  }

  private post<T = Record<string, unknown>>(path: string, body: unknown) {
    return this.client.request<T>(`${this.client.url}/auth/${path}`, {
      method: "POST",
      headers: { ...this.client.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

class StorageApi {
  constructor(private readonly client: StarterpgClient) {}

  listBuckets() {
    return this.client.request<{ buckets: unknown[] }>(
      `${this.client.url}/storage/buckets`,
      { method: "GET", headers: this.client.headers },
    );
  }

  createBucket(name: string, options: StorageBucketOptions = {}) {
    return this.client.request<{ bucket: unknown }>(
      `${this.client.url}/storage/buckets`,
      {
        method: "POST",
        headers: { ...this.client.headers, "content-type": "application/json" },
        body: JSON.stringify({ name, ...options }),
      },
    );
  }

  updateBucket(name: string, options: StorageBucketOptions) {
    return this.client.request<{ bucket: unknown }>(
      `${this.client.url}/storage/buckets?name=${encodeURIComponent(name)}`,
      {
        method: "PATCH",
        headers: { ...this.client.headers, "content-type": "application/json" },
        body: JSON.stringify(options),
      },
    );
  }

  deleteBucket(name: string, options: { force?: boolean } = {}) {
    const params = new URLSearchParams({ name });
    if (options.force) params.set("force", "true");
    return this.client.request<{ deleted: boolean }>(
      `${this.client.url}/storage/buckets?${params}`,
      { method: "DELETE", headers: this.client.headers },
    );
  }

  list(options: {
    bucket?: string;
    prefix?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const params = new URLSearchParams();
    if (options.bucket) params.set("bucket", options.bucket);
    if (options.prefix) params.set("prefix", options.prefix);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    return this.client.request<{ objects: unknown[] }>(
      `${this.client.url}/storage/objects?${params}`,
      { method: "GET", headers: this.client.headers },
    );
  }

  /** Small files go straight through the API; see `signedUploadUrl` for large ones. */
  upload(path: string, file: Blob | ArrayBuffer | Uint8Array, options: { bucket?: string; contentType?: string } = {}) {
    const params = new URLSearchParams({ path });
    if (options.bucket) params.set("bucket", options.bucket);

    return this.client.request<{ object: unknown }>(
      `${this.client.url}/storage/objects?${params}`,
      {
        method: "PUT",
        headers: {
          ...this.client.headers,
          "content-type":
            options.contentType ??
            ((file instanceof Blob && file.type) || "application/octet-stream"),
        },
        body: file as BodyInit,
      },
    );
  }

  download(path: string, bucket?: string) {
    const params = new URLSearchParams({ path });
    if (bucket) params.set("bucket", bucket);
    return this.client.request<{ url: string; expiresAt: number }>(
      `${this.client.url}/storage/objects?${params}`,
      { method: "GET", headers: this.client.headers },
    );
  }

  signedUploadUrl(path: string, options: { bucket?: string; contentType?: string } = {}) {
    return this.client.request<{ url: string; method: string }>(
      `${this.client.url}/storage/sign`,
      {
        method: "POST",
        headers: { ...this.client.headers, "content-type": "application/json" },
        body: JSON.stringify({ action: "upload", path, ...options }),
      },
    );
  }

  confirmUpload(path: string, options: {
    bucket?: string;
    size?: number;
    mimeType?: string;
  } = {}) {
    return this.client.request<{ object: unknown }>(
      `${this.client.url}/storage/objects`,
      {
        method: "POST",
        headers: { ...this.client.headers, "content-type": "application/json" },
        body: JSON.stringify({ path, ...options }),
      },
    );
  }

  remove(path: string, bucket?: string) {
    const params = new URLSearchParams({ path });
    if (bucket) params.set("bucket", bucket);
    return this.client.request<{ deleted: boolean }>(
      `${this.client.url}/storage/objects?${params}`,
      { method: "DELETE", headers: this.client.headers },
    );
  }
}

export function createClient(
  url: string,
  apiKey: string,
  options?: ClientOptions,
): StarterpgClient {
  return new StarterpgClient(url, apiKey, options);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `0-24/1337` -> 1337 */
function parseCount(contentRange: string | null): number | null {
  if (!contentRange) return null;
  const total = contentRange.split("/")[1];
  const parsed = Number(total);
  return Number.isFinite(parsed) ? parsed : null;
}
