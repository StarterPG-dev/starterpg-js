import { createClient } from "@starterpg/js";

const projectUrl = process.env.STARTERPG_URL;
const apiKey = process.env.STARTERPG_API_KEY;
if (!projectUrl || !apiKey) {
  throw new Error("Set STARTERPG_URL and STARTERPG_API_KEY");
}

const db = createClient(projectUrl, apiKey);

const inserted = await db.from("todos").insert({
  task: "Try the StarterPG JavaScript SDK",
  done: false,
});
if (inserted.error) throw new Error(inserted.error.message);

const todos = await db
  .from("todos")
  .select("id,task,done")
  .eq("done", false)
  .order("id");
if (todos.error) throw new Error(todos.error.message);

console.log(todos.data);
