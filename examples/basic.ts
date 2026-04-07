import { Agent, Thread, Tool, stringToUserMessage, z, type RunContext } from "../src/index.js";

class CalculatorTool extends Tool<typeof CalculatorTool.schema> {
  name = "calculator";
  description = "Perform simple math operations";
  static schema = z.object({
    operation: z.enum(["add", "multiply"]),
    a: z.number(),
    b: z.number(),
  });
  schema = CalculatorTool.schema;

  async handle(
    args: z.output<typeof CalculatorTool.schema>,
    _run: RunContext,
  ): Promise<{ result: number }> {
    const result = args.operation === "add" ? args.a + args.b : args.a * args.b;
    return { result };
  }
}

const agent = new Agent({
  name: "math_agent",
  instructions: "You are a helpful math assistant. Use the calculator tool for calculations.",
  tools: [new CalculatorTool()],
});

const thread = new Thread({
  agent,
  model: "gpt-4o-mini",
  messages: [stringToUserMessage("What is 15 + 27?")],
});

const result = await thread.runToCompletion();
console.log(JSON.stringify(result, null, 2));
