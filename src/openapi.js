"use strict";

const crypto = require("crypto");

const HTTP_METHODS = new Set(["get", "head", "post", "put", "delete", "patch", "options"]);

function buildProjectFromOpenApi(openapiDoc, mappingDoc, options = {}) {
  if (!openapiDoc || typeof openapiDoc !== "object") {
    throw new Error("OpenAPI document must be an object.");
  }

  if (!openapiDoc.openapi && !openapiDoc.swagger) {
    throw new Error("OpenAPI document must include either 'openapi' or 'swagger'.");
  }

  if (mappingDoc && typeof mappingDoc !== "object") {
    throw new Error("OpenAPI mapping document must be an object.");
  }

  if (mappingDoc && mappingDoc.include !== undefined && !Array.isArray(mappingDoc.include)) {
    throw new Error("OpenAPI mapping include must be an array when provided.");
  }

  if (mappingDoc && mappingDoc.exclude !== undefined && !Array.isArray(mappingDoc.exclude)) {
    throw new Error("OpenAPI mapping exclude must be an array when provided.");
  }

  if (mappingDoc && mappingDoc.operations !== undefined && !Array.isArray(mappingDoc.operations)) {
    throw new Error("OpenAPI mapping operations must be an array when provided.");
  }

  if (
    mappingDoc &&
    mappingDoc.defaults !== undefined &&
    (!mappingDoc.defaults || typeof mappingDoc.defaults !== "object" || Array.isArray(mappingDoc.defaults))
  ) {
    throw new Error("OpenAPI mapping defaults must be an object when provided.");
  }

  const generatedTag = options.generatedTag || "openapi-sync";
  const cleanupGenerated = options.cleanupGenerated !== false;
  const baseProjectDocument = normalizeBaseProject(options.baseProjectDocument);

  const operations = extractOperations(openapiDoc, mappingDoc || {});
  const baseServer = pickBaseServer(openapiDoc, mappingDoc || {});

  const generatedCalls = operations.map((op) => mapOperationToCall(op, baseServer, mappingDoc || {}, generatedTag));
  const generatedCallIds = generatedCalls.map((item) => item.id);

  const generatedWorkflow = buildGeneratedWorkflow(generatedCallIds, mappingDoc || {}, generatedTag);
  const mergedProject = mergeProject(baseProjectDocument, generatedCalls, generatedWorkflow, {
    generatedTag,
    cleanupGenerated,
  });

  const summary = {
    selectedOperations: operations.length,
    generatedCalls: generatedCalls.length,
    generatedCallIds,
    workflowId: generatedWorkflow.id,
  };

  return { document: mergedProject, summary };
}

function normalizeBaseProject(baseDoc) {
  const source = baseDoc && typeof baseDoc === "object" ? structuredClone(baseDoc) : {};

  if (!source.version) {
    source.version = "2";
  }

  if (!source.project || typeof source.project !== "object") {
    source.project = {};
  }

  if (!Array.isArray(source.project.calls)) {
    source.project.calls = [];
  }

  if (!Array.isArray(source.project.workflows)) {
    source.project.workflows = [];
  }

  if (!source.project.meta || typeof source.project.meta !== "object") {
    source.project.meta = {};
  }

  return source;
}

function extractOperations(openapiDoc, mappingDoc) {
  const paths = openapiDoc.paths;
  if (!paths || typeof paths !== "object") {
    throw new Error("OpenAPI document does not include a valid 'paths' object.");
  }

  const rawOperations = [];

  for (const [routePath, pathItemRaw] of Object.entries(paths)) {
    const pathItem = dereference(pathItemRaw, openapiDoc);
    if (!pathItem || typeof pathItem !== "object") continue;

    const inheritedParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const [method, operationRaw] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (!operationRaw || typeof operationRaw !== "object") continue;

      const operation = dereference(operationRaw, openapiDoc);
      const operationParameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      const mergedParameters = mergeParameters(inheritedParameters, operationParameters, openapiDoc);

      rawOperations.push({
        method: method.toUpperCase(),
        path: routePath,
        operation,
        parameters: mergedParameters,
      });
    }
  }

  const selected = selectOperations(rawOperations, mappingDoc);

  return selected.sort((a, b) => {
    const aKey = `${a.method} ${a.path}`;
    const bKey = `${b.method} ${b.path}`;
    return aKey.localeCompare(bKey);
  });
}

function mergeParameters(pathParameters, operationParameters, rootDoc) {
  const merged = new Map();

  for (const param of pathParameters) {
    const resolved = dereference(param, rootDoc);
    if (!resolved) continue;
    merged.set(parameterIdentity(resolved), resolved);
  }

  for (const param of operationParameters) {
    const resolved = dereference(param, rootDoc);
    if (!resolved) continue;
    merged.set(parameterIdentity(resolved), resolved);
  }

  return Array.from(merged.values());
}

function parameterIdentity(parameter) {
  return `${parameter.in || ""}:${parameter.name || ""}`;
}

function selectOperations(operations, mappingDoc) {
  const includeSelectors = Array.isArray(mappingDoc.include) ? mappingDoc.include : [];
  const excludeSelectors = Array.isArray(mappingDoc.exclude) ? mappingDoc.exclude : [];
  const operationOverrides = Array.isArray(mappingDoc.operations) ? mappingDoc.operations : [];

  return operations.filter((op) => {
    const override = findOperationOverride(op, operationOverrides);
    if (override && override.include === false) {
      return false;
    }

    const includeMatch =
      includeSelectors.length === 0 || includeSelectors.some((selector) => selectorMatches(op, selector));
    if (!includeMatch) {
      return false;
    }

    const excluded = excludeSelectors.some((selector) => selectorMatches(op, selector));
    return !excluded;
  });
}

function selectorMatches(op, selector) {
  if (typeof selector === "string") {
    const trimmed = selector.trim();
    if (!trimmed) return false;

    if (trimmed.includes(" ")) {
      const [methodPart, ...pathParts] = trimmed.split(" ");
      const joinedPath = pathParts.join(" ").trim();
      return methodPart.toUpperCase() === op.method && joinedPath === op.path;
    }

    return trimmed === (op.operation.operationId || "");
  }

  if (!selector || typeof selector !== "object") {
    return false;
  }

  if (selector.operationId && selector.operationId !== (op.operation.operationId || "")) {
    return false;
  }

  if (selector.method && selector.method.toUpperCase() !== op.method) {
    return false;
  }

  if (selector.path && selector.path !== op.path) {
    return false;
  }

  return Boolean(selector.operationId || selector.method || selector.path);
}

function findOperationOverride(op, operationOverrides) {
  return operationOverrides.find((candidate) => selectorMatches(op, candidate)) || null;
}

function mapOperationToCall(op, baseServer, mappingDoc, generatedTag) {
  const operationOverrides = Array.isArray(mappingDoc.operations) ? mappingDoc.operations : [];
  const override = findOperationOverride(op, operationOverrides) || {};

  const idBase = `${op.method.toLowerCase()}-${op.path}`;
  const callId = normalizeKeyStr(override.id || override.call_id || idBase);

  const operationName =
    override.name ||
    (override.call && override.call.name) ||
    op.operation.summary ||
    op.operation.operationId ||
    `${op.method} ${op.path}`;

  const operationDescription =
    override.description ||
    (override.call && override.call.description) ||
    op.operation.description ||
    null;

  const tags = uniqueStrings([
    ...(Array.isArray(mappingDoc.default_tags) ? mappingDoc.default_tags : []),
    ...(Array.isArray(op.operation.tags) ? op.operation.tags : []),
    ...(Array.isArray(override.tags) ? override.tags : []),
    generatedTag,
  ]);

  const request = buildRequest(op, baseServer, mappingDoc, override);

  return {
    id: callId,
    meta: {
      name: String(operationName).slice(0, 400),
      description: operationDescription ? String(operationDescription).slice(0, 1500) : null,
      tags,
    },
    request,
  };
}

function buildRequest(op, baseServer, mappingDoc, override) {
  const defaults = mappingDoc.defaults && typeof mappingDoc.defaults === "object" ? mappingDoc.defaults : {};
  const requestOverride = override.request && typeof override.request === "object" ? override.request : {};

  const paramValues = collectParameterValues(op, defaults, requestOverride);
  const urlPath = interpolatePath(op.path, paramValues.path);

  const headers = { ...(defaults.headers || {}), ...(requestOverride.headers || {}), ...paramValues.headers };
  const parameters = { ...(defaults.query || {}), ...(requestOverride.parameters || {}), ...paramValues.query };

  const body = chooseBodyValue(op, defaults, requestOverride);

  const request = {
    method: requestOverride.method || op.method,
    url: {
      scheme: baseServer.scheme,
      hostname: baseServer.hostname,
      port: baseServer.port,
      path: joinPaths(baseServer.pathPrefix, urlPath),
    },
  };

  if (Object.keys(headers).length > 0) {
    request.headers = stringifyObjectValues(headers);
  }

  if (Object.keys(parameters).length > 0) {
    request.parameters = stringifyObjectValues(parameters);
  }

  if (body !== null && body !== undefined && body !== "") {
    request.body = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  } else {
    request.body = null;
  }

  if (requestOverride.auth_id !== undefined) {
    request.auth_id = requestOverride.auth_id;
  }

  if (requestOverride.token_id !== undefined) {
    request.token_id = requestOverride.token_id;
  }

  return request;
}

function collectParameterValues(op, defaults, requestOverride) {
  const result = {
    path: {},
    query: {},
    headers: {},
  };

  for (const parameter of op.parameters) {
    const name = parameter.name;
    if (!name || typeof name !== "string") continue;

    const inType = parameter.in;
    if (!["path", "query", "header"].includes(inType)) continue;

    const explicitSection =
      inType === "path"
        ? requestOverride.path
        : inType === "query"
          ? requestOverride.parameters
          : requestOverride.headers;

    const explicitDefaultSection =
      inType === "path"
        ? defaults.path
        : inType === "query"
          ? defaults.query
          : defaults.headers;

    const explicitValue =
      explicitSection && Object.prototype.hasOwnProperty.call(explicitSection, name)
        ? explicitSection[name]
        : undefined;

    const defaultValue =
      explicitDefaultSection && Object.prototype.hasOwnProperty.call(explicitDefaultSection, name)
        ? explicitDefaultSection[name]
        : undefined;

    const chosen =
      explicitValue !== undefined
        ? explicitValue
        : defaultValue !== undefined
          ? defaultValue
          : chooseParameterExample(parameter);

    const finalValue =
      chosen !== undefined && chosen !== null && chosen !== ""
        ? chosen
        : parameter.required
          ? `{{ ${toVariableName(name)} }}`
          : "";

    if (finalValue === "" && !parameter.required) {
      continue;
    }

    result[inType][name] = finalValue;
  }

  return result;
}

function chooseParameterExample(parameter) {
  if (parameter.example !== undefined) {
    return parameter.example;
  }

  if (parameter.examples && typeof parameter.examples === "object") {
    for (const example of Object.values(parameter.examples)) {
      const resolved = dereferenceExample(example);
      if (resolved !== undefined) return resolved;
    }
  }

  if (parameter.schema && parameter.schema.example !== undefined) {
    return parameter.schema.example;
  }

  return undefined;
}

function chooseBodyValue(op, defaults, requestOverride) {
  if (requestOverride.body !== undefined) {
    return requestOverride.body;
  }

  if (defaults.body !== undefined) {
    return defaults.body;
  }

  const requestBody = op.operation.requestBody;
  if (!requestBody || typeof requestBody !== "object") {
    return null;
  }

  const content = requestBody.content;
  if (!content || typeof content !== "object") {
    return null;
  }

  const preferred =
    content["application/json"] || content["application/*+json"] || Object.values(content)[0] || null;

  if (!preferred || typeof preferred !== "object") {
    return null;
  }

  if (preferred.example !== undefined) {
    return preferred.example;
  }

  if (preferred.examples && typeof preferred.examples === "object") {
    for (const value of Object.values(preferred.examples)) {
      const example = dereferenceExample(value);
      if (example !== undefined) return example;
    }
  }

  if (preferred.schema && preferred.schema.example !== undefined) {
    return preferred.schema.example;
  }

  if (requestBody.required) {
    return "{{ body }}";
  }

  return null;
}

function dereferenceExample(value) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) {
    return value.value;
  }
  return undefined;
}

function pickBaseServer(openapiDoc, mappingDoc) {
  const override = mappingDoc.server_url;
  if (override && typeof override === "string") {
    return parseServerUrl(override);
  }

  const servers = Array.isArray(openapiDoc.servers) ? openapiDoc.servers : [];
  if (servers.length > 0 && servers[0] && typeof servers[0].url === "string") {
    return parseServerUrl(servers[0].url);
  }

  if (openapiDoc.host) {
    const scheme = Array.isArray(openapiDoc.schemes) && openapiDoc.schemes.length > 0 ? openapiDoc.schemes[0] : "https";
    const basePath = typeof openapiDoc.basePath === "string" ? openapiDoc.basePath : "";
    return parseServerUrl(`${scheme}://${openapiDoc.host}${basePath}`);
  }

  return parseServerUrl("https://example.invalid");
}

function parseServerUrl(urlValue) {
  const sanitized = String(urlValue).replace(/\{([^}]+)\}/g, "placeholder");
  let parsed;
  try {
    parsed = new URL(sanitized);
  } catch {
    parsed = new URL("https://example.invalid");
  }

  const pathPrefix = parsed.pathname === "/" ? "" : parsed.pathname;

  return {
    scheme: parsed.protocol.replace(":", "") || "https",
    hostname: parsed.hostname || "example.invalid",
    port: parsed.port ? Number(parsed.port) : null,
    pathPrefix,
  };
}

function interpolatePath(routePath, pathValues) {
  return routePath.replace(/\{([^}]+)\}/g, (_, rawName) => {
    const name = String(rawName);
    const replacement = pathValues[name];
    if (replacement === undefined || replacement === null || replacement === "") {
      return `{{ ${toVariableName(name)} }}`;
    }
    return String(replacement);
  });
}

function joinPaths(prefix, suffix) {
  const left = prefix || "";
  const right = suffix || "";
  if (!left && !right) return "/";
  if (!left) return right.startsWith("/") ? right : `/${right}`;
  if (!right) return left;
  return `${left.replace(/\/$/, "")}/${right.replace(/^\//, "")}`;
}

function buildGeneratedWorkflow(callIds, mappingDoc, generatedTag) {
  const workflowConfig = mappingDoc.workflow && typeof mappingDoc.workflow === "object" ? mappingDoc.workflow : {};
  const id = normalizeKeyStr(workflowConfig.id || "openapi-sync-workflow");
  const name = workflowConfig.name || "OpenAPI Sync Workflow";
  const tags = uniqueStrings([...(Array.isArray(workflowConfig.tags) ? workflowConfig.tags : []), generatedTag]);

  return {
    id,
    meta: {
      name: String(name).slice(0, 400),
      description: workflowConfig.description ? String(workflowConfig.description).slice(0, 1500) : null,
      tags,
    },
    workflow: {
      call_ids: callIds,
      stop_on_failure: workflowConfig.stop_on_failure !== false,
    },
  };
}

function mergeProject(baseDocument, generatedCalls, generatedWorkflow, options) {
  const output = structuredClone(baseDocument);
  const generatedTag = options.generatedTag;
  const cleanupGenerated = options.cleanupGenerated;

  const byId = new Map();

  for (const call of output.project.calls) {
    if (!call || typeof call !== "object" || !call.id) continue;
    byId.set(call.id, call);
  }

  for (const generated of generatedCalls) {
    byId.set(generated.id, generated);
  }

  let mergedCalls = Array.from(byId.values());

  if (cleanupGenerated) {
    const activeGenerated = new Set(generatedCalls.map((item) => item.id));
    mergedCalls = mergedCalls.filter((item) => {
      if (!item || typeof item !== "object") return false;
      if (!item.id) return false;
      const tags = item.meta && Array.isArray(item.meta.tags) ? item.meta.tags : [];
      const isGenerated = tags.includes(generatedTag);
      if (!isGenerated) return true;
      return activeGenerated.has(item.id);
    });
  }

  mergedCalls.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  output.project.calls = mergedCalls;

  const workflowById = new Map();
  for (const workflow of output.project.workflows) {
    if (!workflow || typeof workflow !== "object" || !workflow.id) continue;
    workflowById.set(workflow.id, workflow);
  }

  workflowById.set(generatedWorkflow.id, generatedWorkflow);

  let mergedWorkflows = Array.from(workflowById.values());

  if (cleanupGenerated) {
    mergedWorkflows = mergedWorkflows.filter((workflow) => {
      if (!workflow || typeof workflow !== "object" || !workflow.id) return false;
      if (workflow.id === generatedWorkflow.id) return true;
      const tags = workflow.meta && Array.isArray(workflow.meta.tags) ? workflow.meta.tags : [];
      return !tags.includes(generatedTag);
    });
  }

  mergedWorkflows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  output.project.workflows = mergedWorkflows;

  return output;
}

function normalizeKeyStr(input) {
  const source = String(input || "").toLowerCase();
  const slug = source.replace(/[^a-z0-9_~\-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const base = slug.length >= 3 ? slug : `id-${slug || "item"}`;
  const hash = crypto.createHash("sha1").update(String(input || "item")).digest("hex").slice(0, 8);
  const candidate = `${base}-${hash}`.slice(0, 400);
  return candidate;
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();

  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }

  return out;
}

function stringifyObjectValues(input) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

function toVariableName(input) {
  const compact = String(input || "")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!compact) return "value";
  if (/^[0-9]/.test(compact)) return `var_${compact}`;
  return compact;
}

function dereference(node, rootDoc) {
  if (!node || typeof node !== "object") {
    return node;
  }

  if (!node.$ref || typeof node.$ref !== "string") {
    return node;
  }

  if (!node.$ref.startsWith("#/")) {
    return node;
  }

  const resolved = resolvePointer(rootDoc, node.$ref);
  if (resolved === undefined) {
    return node;
  }

  if (resolved && typeof resolved === "object") {
    const { $ref: _ignored, ...rest } = node;
    return { ...resolved, ...rest };
  }

  return resolved;
}

function resolvePointer(root, pointer) {
  const parts = pointer
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

module.exports = {
  buildProjectFromOpenApi,
  normalizeKeyStr,
  selectOperations,
  pickBaseServer,
  mergeProject,
};
