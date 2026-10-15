# @starterpg/js

Dependency-free JavaScript and TypeScript client for a
[StarterPG](https://www.starterpg.com) project. It uses the platform `fetch`
and `WebSocket` APIs and includes TypeScript declarations.

## Install

```sh
npm install @starterpg/js
```

Node.js 18 or newer is supported for HTTP APIs. The package also works in
modern browsers, Deno, and edge runtimes. Realtime subscriptions require a
runtime that provides a global `WebSocket` implementation.

## Use

```ts
import { createClient } from "@starterpg/js";

const db = createClient(process.env.PROJECT_URL!, process.env.API_KEY!);
const { data, error } = await db
  .from("todos")
  .select("id,task")
  .eq("done", false)
  .order("id");

if (error) throw new Error(error.message);
console.log(data);
```

Use a publishable key with an end-user access token when row-level security
should apply. Secret keys must only be used in trusted server-side code.

See the [StarterPG API documentation](https://www.starterpg.com/docs/api) for
REST, relationships, schema operations, storage, vector search, and other
client examples.

## Examples

- [`examples/quickstart.mjs`](https://github.com/StarterPG-dev/starterpg-js/blob/main/examples/quickstart.mjs)
  inserts and queries rows.
- [`examples/storage.mjs`](https://github.com/StarterPG-dev/starterpg-js/blob/main/examples/storage.mjs)
  creates a bucket, uploads a file, and obtains a signed download URL.

Set `STARTERPG_URL` and `STARTERPG_API_KEY`, then run an example with Node.js:

```sh
node examples/quickstart.mjs
```
