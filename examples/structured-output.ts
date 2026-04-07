import { Agent, Thread, stringToUserMessage, z } from "../src/index.js";

const SummarySchema = z.object({
  title: z.string(),
  bullets: z.array(z.string()).min(2),
});

const agent = new Agent({
  name: "summarizer",
  instructions: "Summarize the user's message and respond as JSON that matches the schema.",
  outputSchema: SummarySchema,
});

const thread = new Thread({
  agent,
  model: "gpt-4o-mini",
  messages: [stringToUserMessage("TypeScript migration is underway and the TUI is intentionally out of scope.")],
});

const result = await thread.runToCompletion();
console.log(JSON.stringify(result, null, 2));
