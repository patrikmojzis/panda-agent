import type {JsonObject} from "../../lib/json.js";
import type {CommandDescriptor} from "./types.js";

function argumentRequirement(argument: CommandDescriptor["arguments"][number]): string {
  return argument.required ? "required" : "optional";
}

function formatArgumentMetadata(argument: CommandDescriptor["arguments"][number]): string {
  const metadata = [argumentRequirement(argument)];
  if (argument.repeatable === true) {
    metadata.push("repeatable");
  }
  if (argument.defaultValue !== undefined) {
    metadata.push(`default: ${String(argument.defaultValue)}`);
  }
  if (argument.minimum !== undefined || argument.maximum !== undefined) {
    metadata.push(`range: ${argument.minimum ?? "-∞"}..${argument.maximum ?? "∞"}`);
  }
  if (argument.valueSources?.length) {
    metadata.push(`sources: ${argument.valueSources.join(", ")}`);
  }
  if (argument.requires?.length) {
    metadata.push(`requires: ${argument.requires.map((name) => `--${name}`).join(", ")}`);
  }
  if (argument.conflictsWith?.length) {
    metadata.push(`conflicts: ${argument.conflictsWith.map((name) => `--${name}`).join(", ")}`);
  }
  return `[${metadata.join("; ")}]`;
}

function formatPositionalArgument(argument: CommandDescriptor["arguments"][number]): string {
  const valueName = argument.valueName ?? argument.name;
  return `  <${valueName}>  ${argument.description} ${formatArgumentMetadata(argument)}`;
}

function formatOption(argument: CommandDescriptor["arguments"][number]): string {
  const enumValues = argument.enumValues?.length ? ` (${argument.enumValues.join("|")})` : "";
  const valueName = argument.valueName ?? argument.valueType;
  const valueLabel = argument.valueType === "boolean" ? "" : ` <${valueName}>`;
  return `  --${argument.name}${valueLabel}  ${argument.description} ${formatArgumentMetadata(argument)}${enumValues}`;
}

export function formatCommandHelp(descriptor: CommandDescriptor): string {
  const parts = [
    descriptor.summary,
    "",
    `Usage: ${descriptor.usage}`,
    "",
    descriptor.description,
  ];

  const positionalArguments = descriptor.arguments.filter((argument) => argument.kind === "positional");
  const options = descriptor.arguments.filter((argument) => argument.kind !== "positional");

  if (positionalArguments.length > 0) {
    parts.push("", "Arguments:", ...positionalArguments.map(formatPositionalArgument));
  }

  if (options.length > 0) {
    parts.push("", "Options:", ...options.map(formatOption));
  }

  if (descriptor.examples.length > 0) {
    parts.push(
      "",
      "Examples:",
      ...descriptor.examples.map((example) => `  # ${example.description}\n  ${example.command}`),
    );
  }

  return `${parts.join("\n")}\n`;
}

export function commandDescriptorToJson(
  descriptor: CommandDescriptor,
  options: {includeSchemaCatalog?: boolean} = {},
): JsonObject {
  return {
    name: descriptor.name,
    summary: descriptor.summary,
    description: descriptor.description,
    usage: descriptor.usage,
    inputModes: [...descriptor.inputModes],
    outputModes: [...descriptor.outputModes],
    arguments: descriptor.arguments.map((argument) => ({
      name: argument.name,
      description: argument.description,
      required: argument.required === true,
      ...(argument.kind ? {kind: argument.kind} : {}),
      valueType: argument.valueType,
      ...(argument.valueName ? {valueName: argument.valueName} : {}),
      ...(argument.enumValues ? {enumValues: [...argument.enumValues]} : {}),
      ...(argument.valueSources ? {valueSources: [...argument.valueSources]} : {}),
      ...(argument.repeatable === true ? {repeatable: true} : {}),
      ...(argument.conflictsWith ? {conflictsWith: [...argument.conflictsWith]} : {}),
      ...(argument.requires ? {requires: [...argument.requires]} : {}),
      ...(argument.defaultValue !== undefined ? {defaultValue: argument.defaultValue} : {}),
      ...(argument.minimum !== undefined ? {minimum: argument.minimum} : {}),
      ...(argument.maximum !== undefined ? {maximum: argument.maximum} : {}),
    })),
    examples: descriptor.examples.map((example) => ({
      description: example.description,
      command: example.command,
    })),
    ...(descriptor.requiredCapabilities ? {requiredCapabilities: [...descriptor.requiredCapabilities]} : {}),
    ...(descriptor.resultShape ? {resultShape: descriptor.resultShape} : {}),
    ...(options.includeSchemaCatalog && descriptor.schemaCatalog ? {schemaCatalog: descriptor.schemaCatalog} : {}),
  };
}
