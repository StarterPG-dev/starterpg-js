import assert from "node:assert/strict";
import test from "node:test";

import { createClient } from "../dist/index.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

test("query builder sends encoded filters, shaping, auth, and count", async () => {
  let captured;
  const client = createClient("https://example.test/", "project-key", {
    fetch: async (url, init) => {
      captured = { url, init };
      return jsonResponse([{ id: 1 }], {
        headers: { "content-range": "0-0/7" },
      });
    },
  });
  client.setAuth("user-token");

  const result = await client
    .from("todo items")
    .select("id,name")
    .eq("done", false)
    .in("id", [1, 2])
    .order("created at", { ascending: false, nullsFirst: true })
    .range(5, 9)
    .count();

  assert.equal(
    captured.url,
    "https://example.test/rest/todo%20items"
      + "?done=eq.false&id=in.(1,2)&select=id%2Cname"
      + "&order=created%20at.desc.nullsfirst&limit=5&offset=5&count=exact",
  );
  assert.equal(captured.init.method, "GET");
  assert.equal(captured.init.headers.apikey, "project-key");
  assert.equal(captured.init.headers.authorization, "Bearer user-token");
  assert.equal(result.count, 7);
  assert.deepEqual(result.data, [{ id: 1 }]);
});

test("storage helpers cover bucket management and signed upload confirmation", async () => {
  const requests = [];
  const client = createClient("https://example.test", "project-key", {
    fetch: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({});
    },
  });

  await client.storage.createBucket("user files", {
    public: false,
    fileSizeLimit: 1024,
    allowedMime: ["text/plain"],
  });
  await client.storage.updateBucket("user files", { public: true });
  await client.storage.list({
    bucket: "user files",
    prefix: "reports/2026",
    limit: 25,
    offset: 50,
  });
  await client.storage.signedUploadUrl("reports/one.txt", {
    bucket: "user files",
    contentType: "text/plain",
  });
  await client.storage.confirmUpload("reports/one.txt", {
    bucket: "user files",
    size: 12,
    mimeType: "text/plain",
  });
  await client.storage.deleteBucket("user files", { force: true });

  assert.equal(requests[0].url, "https://example.test/storage/buckets");
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    name: "user files",
    public: false,
    fileSizeLimit: 1024,
    allowedMime: ["text/plain"],
  });
  assert.equal(
    requests[1].url,
    "https://example.test/storage/buckets?name=user%20files",
  );
  assert.equal(requests[1].init.method, "PATCH");
  assert.equal(
    requests[2].url,
    "https://example.test/storage/objects"
      + "?bucket=user+files&prefix=reports%2F2026&limit=25&offset=50",
  );
  assert.deepEqual(JSON.parse(requests[3].init.body), {
    action: "upload",
    path: "reports/one.txt",
    bucket: "user files",
    contentType: "text/plain",
  });
  assert.equal(requests[4].url, "https://example.test/storage/objects");
  assert.deepEqual(JSON.parse(requests[4].init.body), {
    path: "reports/one.txt",
    bucket: "user files",
    size: 12,
    mimeType: "text/plain",
  });
  assert.equal(
    requests[5].url,
    "https://example.test/storage/buckets?name=user+files&force=true",
  );
  assert.equal(requests[5].init.method, "DELETE");
});

test("request returns structured API and transport errors", async () => {
  const apiClient = createClient("https://example.test", "project-key", {
    fetch: async () =>
      jsonResponse(
        { error: "Invalid filter", code: "22023", detail: "Bad value" },
        { status: 400 },
      ),
  });

  const apiResult = await apiClient.from("todos").select();
  assert.equal(apiResult.status, 400);
  assert.equal(apiResult.data, null);
  assert.deepEqual(apiResult.error, {
    message: "Invalid filter",
    code: "22023",
    detail: "Bad value",
  });

  const networkClient = createClient("https://example.test", "project-key", {
    fetch: async () => {
      throw new Error("connection refused");
    },
  });
  const networkResult = await networkClient.rpc("health");
  assert.equal(networkResult.status, 0);
  assert.equal(networkResult.error?.message, "connection refused");
});
