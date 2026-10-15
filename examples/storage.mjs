import { readFile } from "node:fs/promises";

import { createClient } from "@starterpg/js";

const projectUrl = process.env.STARTERPG_URL;
const apiKey = process.env.STARTERPG_API_KEY;
if (!projectUrl || !apiKey) {
  throw new Error("Set STARTERPG_URL and STARTERPG_API_KEY");
}

const db = createClient(projectUrl, apiKey);
const bucket = "documents";
const path = "examples/hello.txt";

const created = await db.storage.createBucket(bucket);
if (created.error && created.status !== 409) {
  throw new Error(created.error.message);
}

const file = await readFile(new URL("./hello.txt", import.meta.url));
const uploaded = await db.storage.upload(path, file, {
  bucket,
  contentType: "text/plain",
});
if (uploaded.error) throw new Error(uploaded.error.message);

const download = await db.storage.download(path, bucket);
if (download.error) throw new Error(download.error.message);

console.log(download.data.url);
