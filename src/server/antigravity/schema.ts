import "server-only";

// Port of CPA's Antigravity JSON Schema cleaning (internal/util/gemini_schema.go). The private
// backend accepts only a subset of JSON Schema; unsupported constraints become description hints.

type Schema = Record<string, unknown>;
type Options = {
  tool: boolean;
  // Models requiring validated tools need placeholders for empty objects.
  placeholder: boolean;
};

const PLACEHOLDER_DESCRIPTION = "Brief explanation of why you are calling this tool";
const HINT_CONSTRAINTS = [
  "minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum", "pattern", "minItems", "maxItems",
  "uniqueItems", "contains", "format", "default", "examples", "minimum", "maximum", "multipleOf",
];
const REMOVED_KEYWORDS = [
  "$schema", "$defs", "definitions", "const", "$ref", "$id", "id", "additionalProperties",
  "$anchor", "$vocabulary", "$dynamicRef", "$dynamicAnchor", "propertyNames", "patternProperties",
  "dependentRequired", "dependentSchemas", "dependencies", "if", "then", "else", "not",
  "$comment", "enumDescriptions", "enumTitles", "prefill", "deprecated", "encrypted", "discriminator",
  "readOnly", "writeOnly", "additionalItems", "unevaluatedProperties", "unevaluatedItems",
  "contentSchema", "contentMediaType", "contentEncoding", "allOf", "oneOf",
];

function isObject(value: unknown): value is Schema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hint(node: Schema, text: string) {
  const existing = typeof node.description === "string" ? node.description : "";
  if (!existing) node.description = text;
  else if (existing !== text && !existing.startsWith(text + " (") && !existing.includes(`(${text})`)) {
    node.description = `${existing} (${text})`;
  }
}

function scalar(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function resolveRefs(value: unknown, root: Schema, active: Set<string>): unknown {
  if (Array.isArray(value)) return value.map(item => resolveRefs(item, root, active));
  if (!isObject(value)) return value;
  const ref = typeof value.$ref === "string" ? value.$ref : "";
  if (ref.startsWith("#/") && !active.has(ref)) {
    let target: unknown = root;
    for (const key of ref.slice(2).split("/")) {
      target = isObject(target) ? target[key.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined;
    }
    if (isObject(target)) {
      const { $ref: _ref, ...siblings } = value;
      void _ref;
      const resolved = resolveRefs(structuredClone(target), root, new Set([...active, ref])) as Schema;
      return { ...resolved, ...resolveRefs(siblings, root, active) as Schema };
    }
  }
  const out: Schema = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = key === "properties" && isObject(child)
      ? Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, resolveRefs(schema, root, active)]))
      : resolveRefs(child, root, active);
  }
  return out;
}

function branchScore(branch: Schema) {
  const type = typeof branch.type === "string" ? branch.type : "";
  if (type === "object" || branch.properties) return 3;
  if (type === "array" || branch.items) return 2;
  return type && type !== "null" ? 1 : 0;
}

function branchType(branch: Schema) {
  if (typeof branch.type === "string") return branch.type;
  if (branch.properties) return "object";
  if (branch.items) return "array";
  return "";
}

function isNullBranch(branch: Schema) {
  return !branch.properties && !branch.items && (branch.type === "null" ||
    (Array.isArray(branch.type) && branch.type.length > 0 && branch.type.every(type => type === "null")));
}

function cleanNode(input: Schema, options: Options, root: boolean): Schema {
  let node: Schema = { ...input };

  if ("const" in node && !("enum" in node)) node.enum = [node.const];
  if (Array.isArray(node.enum)) {
    node.enum = node.enum.map(value => typeof value === "string" ? value : JSON.stringify(value));
    const values = node.enum as string[];
    if (values.length > 1 && values.length <= 10) hint(node, "Allowed: " + values.join(", "));
    // Antigravity does not enforce enum on function arguments or boolean responses; keep only a hint.
    if (options.tool || node.type === "boolean") {
      if (values.length === 1) hint(node, "Allowed: " + values[0]);
      delete node.enum;
    }
  }
  // Response schemas keep additionalProperties: false, which Antigravity enforces natively.
  const closed = !options.tool && node.additionalProperties === false;
  if (node.additionalProperties === false && options.tool) hint(node, "No extra properties allowed");
  for (const key of HINT_CONSTRAINTS) {
    if (key in node) hint(node, `${key}: ${scalar(node[key])}`);
  }
  if ("not" in node) hint(node, "not: " + JSON.stringify(node.not));
  if (typeof node.$ref === "string") hint(node, "See: " + node.$ref.split("/").at(-1));

  for (const key of ["then", "else"]) {
    const branch = node[key];
    if (isObject(branch) && isObject(branch.properties)) {
      node.properties = { ...branch.properties, ...(isObject(node.properties) ? node.properties : {}) };
    }
  }
  if (Array.isArray(node.allOf)) {
    for (const branch of node.allOf.filter(isObject)) {
      for (const [key, value] of Object.entries(branch)) {
        if (key === "required" && Array.isArray(value)) {
          node.required = [...new Set([...(Array.isArray(node.required) ? node.required : []), ...value])];
        } else if (key === "properties" && isObject(value)) {
          node.properties = { ...value, ...(isObject(node.properties) ? node.properties : {}) };
        } else if (!["if", "then", "else", "allOf"].includes(key) && !(key in node)) {
          node[key] = value;
        }
      }
    }
  }

  for (const key of ["anyOf", "oneOf"]) {
    const branches = node[key];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const objects = branches.filter(isObject);
    const nonNull = objects.filter(branch => !isNullBranch(branch));
    const nullable = nonNull.length !== objects.length || node.nullable === true;
    delete node[key];
    if (nonNull.length >= 2) {
      node.anyOf = nonNull;
      if (nullable) { node.nullable = true; hint(node, "(nullable)"); }
      continue;
    }
    if (isObject(node.properties)) {
      for (const branch of nonNull) {
        if (isObject(branch.properties)) node.properties = { ...branch.properties, ...(node.properties as Schema) };
      }
      if (!node.type) node.type = "object";
      if (nullable) node.nullable = true;
      continue;
    }
    if (nonNull.length === 0) {
      if (nullable) node = { type: "null", ...(node.description ? { description: node.description } : {}) };
      continue;
    }
    const best = nonNull.reduce((winner, branch) => branchScore(branch) > branchScore(winner) ? branch : winner);
    const types = [...new Set(objects.map(branchType).filter(Boolean))];
    const description = typeof node.description === "string" ? node.description : "";
    node = { ...best };
    if (description) {
      node.description = typeof node.description === "string" && node.description
        ? `${description} (${node.description})` : description;
    }
    if (nullable) node.nullable = true;
    if (types.length > 1) hint(node, "Accepts: " + types.join(" | "));
    else if (nullable) hint(node, "(nullable)");
  }

  if (Array.isArray(node.type)) {
    const types = node.type.filter((type): type is string => typeof type === "string" && Boolean(type));
    const nonNull = types.filter(type => type !== "null");
    let first = nonNull[0] ?? "string";
    if (node.items && nonNull.includes("array")) first = "array";
    else if (node.properties && nonNull.includes("object")) first = "object";
    node.type = first;
    if (first !== "array") delete node.items;
    if (nonNull.length > 1) hint(node, "Accepts: " + nonNull.join(" | "));
    if (types.includes("null")) { node.nullable = true; hint(node, "(nullable)"); }
  }

  for (const key of [...REMOVED_KEYWORDS, ...HINT_CONSTRAINTS]) delete node[key];
  if (closed) node.additionalProperties = false;
  if (options.tool && !options.placeholder) delete node.title;
  for (const key of Object.keys(node)) if (key.startsWith("x-")) delete node[key];

  if (isObject(node.properties)) {
    node.properties = Object.fromEntries(Object.entries(node.properties)
      .map(([name, schema]) => [name, isObject(schema) ? cleanNode(schema, options, false) : schema]));
    if (node.type !== "object") node.type = "object";
  }
  if (Array.isArray(node.anyOf)) node.anyOf = node.anyOf.map(branch => cleanNode(branch as Schema, options, false));
  if (isObject(node.items)) node.items = cleanNode(node.items, options, false);
  if (node.items !== undefined && !node.type) node.type = "array";
  if (node.items !== undefined && node.type !== "array") delete node.items;
  if (node.type === "array" && node.items === undefined) node.items = { type: "string" };

  if (Array.isArray(node.required)) {
    const properties = isObject(node.properties) ? node.properties : null;
    const required = properties ? node.required.filter(name => typeof name === "string" && name in properties) : [];
    if (required.length) node.required = required;
    else delete node.required;
  }

  if (options.placeholder && node.type === "object" && !node.anyOf) {
    const properties = isObject(node.properties) ? node.properties : null;
    if (!properties || Object.keys(properties).length === 0) {
      node.properties = { reason: { type: "string", description: PLACEHOLDER_DESCRIPTION } };
      node.required = ["reason"];
    } else if (!root && !Array.isArray(node.required)) {
      if (!("_" in properties)) properties._ = { type: "boolean" };
      node.required = ["_"];
    }
  }
  return node;
}

export function cleanAntigravityToolSchema(schema: unknown, input: { validated: boolean }) {
  const root = isObject(schema) ? schema : { type: "object", properties: {} };
  const resolved = resolveRefs(root, root, new Set()) as Schema;
  return cleanNode(resolved, { tool: true, placeholder: input.validated }, true);
}

export function cleanAntigravityResponseSchema(schema: unknown) {
  if (!isObject(schema)) return schema;
  const resolved = resolveRefs(schema, schema, new Set()) as Schema;
  return cleanNode(resolved, { tool: false, placeholder: false }, true);
}
