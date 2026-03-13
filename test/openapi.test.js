"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildProjectFromOpenApi,
  normalizeKeyStr,
  selectOperations,
  pickBaseServer,
  mergeProject,
} = require("../src/openapi");

function spec(paths = {}, extra = {}) {
  return {
    openapi: "3.0.3",
    info: { title: "Test API", version: "1.0.0" },
    servers: [{ url: "https://api.example.com/v1" }],
    paths,
    ...extra,
  };
}

function rawOp(method, path, operationId, extraOperation = {}, parameters = []) {
  return {
    method: method.toUpperCase(),
    path,
    operation: { operationId, ...extraOperation },
    parameters,
  };
}

function baseDoc(calls = [], workflows = []) {
  return { version: "2", project: { meta: {}, calls, workflows } };
}

function genCall(id, tag = "openapi-sync") {
  return {
    id,
    meta: { name: id, description: null, tags: [tag] },
    request: { method: "GET", url: { scheme: "https", hostname: "example.com", port: null, path: "/" }, body: null },
  };
}

function genWorkflow(id, callIds, tag = "openapi-sync") {
  return {
    id,
    meta: { name: id, description: null, tags: [tag] },
    workflow: { call_ids: callIds, stop_on_failure: true },
  };
}

describe("normalizeKeyStr", () => {
  test("output matches key_str pattern", () => {
    const inputs = ["get-/pets", "POST /users/{id}", "delete-/a/b/c", "PATCH /long/path"];
    for (const input of inputs) {
      const id = normalizeKeyStr(input);
      assert.match(id, /^[-a-z0-9_~]+$/, `bad chars for \"${input}\": got \"${id}\"`);
      assert.ok(id.length >= 3, `ID too short for \"${input}\"`);
      assert.ok(id.length <= 400, `ID too long for \"${input}\"`);
    }
  });

  test("is deterministic", () => {
    const a = normalizeKeyStr("get-/pets/{petId}");
    const b = normalizeKeyStr("get-/pets/{petId}");
    assert.equal(a, b);
  });

  test("different inputs produce different IDs", () => {
    assert.notEqual(normalizeKeyStr("get-/pets"), normalizeKeyStr("post-/pets"));
    assert.notEqual(normalizeKeyStr("get-/pets"), normalizeKeyStr("get-/cats"));
  });

  test("very short slug is padded with id- prefix", () => {
    const id = normalizeKeyStr("x");
    assert.ok(id.startsWith("id-"));
    assert.ok(id.length >= 3);
  });

  test("special characters are slugified", () => {
    const id = normalizeKeyStr("GET /users/{id}/posts?include=comments");
    assert.match(id, /^[-a-z0-9_~]+$/);
  });
});

describe("buildProjectFromOpenApi - validation", () => {
  test("throws if document is null", () => {
    assert.throws(() => buildProjectFromOpenApi(null, {}), /must be an object/);
  });

  test("throws if document is a string", () => {
    assert.throws(() => buildProjectFromOpenApi("string", {}), /must be an object/);
  });

  test("throws if neither openapi nor swagger key is present", () => {
    assert.throws(() => buildProjectFromOpenApi({ paths: {} }, {}), /'openapi' or 'swagger'/);
  });

  test("throws if paths is missing", () => {
    assert.throws(() => buildProjectFromOpenApi({ openapi: "3.0.3" }, {}), /valid 'paths' object/);
  });

  test("throws if mapping document is not an object", () => {
    assert.throws(
      () => buildProjectFromOpenApi({ openapi: "3.0.3", paths: {} }, "invalid"),
      /mapping document must be an object/
    );
  });

  test("throws when mapping include is not an array", () => {
    assert.throws(
      () => buildProjectFromOpenApi({ openapi: "3.0.3", paths: {} }, { include: "GET /pets" }),
      /mapping include must be an array when provided/
    );
  });

  test("throws when mapping operations is not an array", () => {
    assert.throws(
      () => buildProjectFromOpenApi({ openapi: "3.0.3", paths: {} }, { operations: {} }),
      /mapping operations must be an array when provided/
    );
  });

  test("throws when mapping defaults is not an object", () => {
    assert.throws(
      () => buildProjectFromOpenApi({ openapi: "3.0.3", paths: {} }, { defaults: [] }),
      /mapping defaults must be an object when provided/
    );
  });

  test("accepts swagger 2.0 document", () => {
    const result = buildProjectFromOpenApi({ swagger: "2.0", host: "api.example.com", paths: {} }, {});
    assert.equal(result.summary.selectedOperations, 0);
  });

  test("empty paths object produces zero calls", () => {
    const result = buildProjectFromOpenApi(spec({}), {});
    assert.equal(result.summary.selectedOperations, 0);
    assert.equal(result.document.project.calls.length, 0);
  });
});

describe("operation extraction", () => {
  test("all seven HTTP methods are extracted", () => {
    const paths = {
      "/r": {
        get: { operationId: "a", responses: {} },
        post: { operationId: "b", responses: {} },
        put: { operationId: "c", responses: {} },
        patch: { operationId: "d", responses: {} },
        delete: { operationId: "e", responses: {} },
        head: { operationId: "f", responses: {} },
        options: { operationId: "g", responses: {} },
      },
    };
    assert.equal(buildProjectFromOpenApi(spec(paths), {}).summary.selectedOperations, 7);
  });

  test("non-HTTP path item keys are ignored", () => {
    const paths = {
      "/pets": {
        summary: "ignored",
        description: "ignored",
        parameters: [{ name: "q", in: "query", required: false }],
        get: { operationId: "listPets", responses: {} },
      },
    };
    assert.equal(buildProjectFromOpenApi(spec(paths), {}).summary.selectedOperations, 1);
  });

  test("generated call IDs are sorted", () => {
    const paths = {
      "/z": { get: { operationId: "zGet", responses: {} } },
      "/a": {
        post: { operationId: "aPost", responses: {} },
        get: { operationId: "aGet", responses: {} },
      },
    };
    const ids = buildProjectFromOpenApi(spec(paths), {}).summary.generatedCallIds;
    assert.deepEqual(ids, [...ids].sort());
  });

  test("path-level parameters are inherited", () => {
    const paths = {
      "/pets/{petId}": {
        parameters: [{ name: "petId", in: "path", required: true, example: "abc" }],
        get: { operationId: "getPet", responses: {} },
      },
    };
    const call = buildProjectFromOpenApi(spec(paths), {}).document.project.calls[0];
    assert.equal(call.request.url.path, "/v1/pets/abc");
  });

  test("operation-level parameter overrides path-level parameter", () => {
    const paths = {
      "/pets/{petId}": {
        parameters: [{ name: "petId", in: "path", required: true, example: "path-level" }],
        get: {
          operationId: "getPet",
          parameters: [{ name: "petId", in: "path", required: true, example: "op-level" }],
          responses: {},
        },
      },
    };
    const call = buildProjectFromOpenApi(spec(paths), {}).document.project.calls[0];
    assert.equal(call.request.url.path, "/v1/pets/op-level");
  });

  test("component parameter refs are resolved", () => {
    const s = spec(
      {
        "/pets": {
          get: {
            operationId: "listPets",
            parameters: [{ $ref: "#/components/parameters/LimitParam" }],
            responses: {},
          },
        },
      },
      {
        components: {
          parameters: {
            LimitParam: { name: "limit", in: "query", required: false, example: 50 },
          },
        },
      }
    );
    const call = buildProjectFromOpenApi(s, {}).document.project.calls[0];
    assert.equal(call.request.parameters.limit, "50");
  });
});

describe("selectOperations", () => {
  const ops = [
    rawOp("GET", "/pets", "listPets"),
    rawOp("POST", "/pets", "createPet"),
    rawOp("DELETE", "/pets/{id}", "deletePet"),
  ];

  test("no filters returns all operations", () => {
    assert.equal(selectOperations(ops, {}).length, 3);
  });

  test("include by method/path string", () => {
    const selected = selectOperations(ops, { include: ["GET /pets"] });
    assert.equal(selected.length, 1);
    assert.equal(selected[0].operation.operationId, "listPets");
  });

  test("include by operationId string", () => {
    const selected = selectOperations(ops, { include: ["createPet"] });
    assert.equal(selected.length, 1);
    assert.equal(selected[0].operation.operationId, "createPet");
  });

  test("include by object operationId", () => {
    const selected = selectOperations(ops, { include: [{ operationId: "deletePet" }] });
    assert.equal(selected.length, 1);
    assert.equal(selected[0].operation.operationId, "deletePet");
  });

  test("include by object method", () => {
    const selected = selectOperations(ops, { include: [{ method: "GET" }] });
    assert.equal(selected.length, 1);
    assert.equal(selected[0].method, "GET");
  });

  test("include by object path", () => {
    const selected = selectOperations(ops, { include: [{ path: "/pets" }] });
    assert.equal(selected.length, 2);
  });

  test("multiple include selectors are OR", () => {
    const selected = selectOperations(ops, { include: ["GET /pets", "createPet"] });
    assert.equal(selected.length, 2);
  });

  test("exclude by method/path string", () => {
    const selected = selectOperations(ops, { exclude: ["DELETE /pets/{id}"] });
    assert.equal(selected.length, 2);
    assert.ok(!selected.find((o) => o.operation.operationId === "deletePet"));
  });

  test("exclude by operationId string", () => {
    const selected = selectOperations(ops, { exclude: ["listPets"] });
    assert.ok(!selected.find((o) => o.operation.operationId === "listPets"));
  });

  test("include and overlapping exclude favors exclude", () => {
    const selected = selectOperations(ops, {
      include: ["GET /pets", "POST /pets"],
      exclude: ["POST /pets"],
    });
    assert.equal(selected.length, 1);
    assert.equal(selected[0].operation.operationId, "listPets");
  });

  test("operations include=false suppresses operation", () => {
    const selected = selectOperations(ops, {
      operations: [{ operationId: "createPet", include: false }],
    });
    assert.ok(!selected.find((o) => o.operation.operationId === "createPet"));
  });

  test("unknown selector matches nothing", () => {
    const selected = selectOperations(ops, { include: [{ operationId: "nonExistent" }] });
    assert.equal(selected.length, 0);
  });
});

describe("request value synthesis", () => {
  test("query param uses operation example", () => {
    const paths = {
      "/search": {
        get: {
          operationId: "search",
          parameters: [{ name: "q", in: "query", required: false, example: "hello" }],
          responses: {},
        },
      },
    };
    const call = buildProjectFromOpenApi(spec(paths), {}).document.project.calls[0];
    assert.equal(call.request.parameters.q, "hello");
  });

  test("query param falls back to schema.example", () => {
    const paths = {
      "/search": {
        get: {
          operationId: "search",
          parameters: [{ name: "q", in: "query", required: false, schema: { type: "string", example: "world" } }],
          responses: {},
        },
      },
    };
    const call = buildProjectFromOpenApi(spec(paths), {}).document.project.calls[0];
    assert.equal(call.request.parameters.q, "world");
  });

  test("query param uses examples map", () => {
    const paths = {
      "/search": {
        get: {
          operationId: "search",
          parameters: [{
            name: "q", in: "query", required: false,
            examples: { ex1: { value: "from-examples-obj" } },
          }],
          responses: {},
        },
      },
    };
    const call = buildProjectFromOpenApi(spec(paths), {}).document.project.calls[0];
    assert.equal(call.request.parameters.q, "from-examples-obj");
  });

  test("required query param with no example gets placeholder", () => {
    const paths = {
      "/auth": {
        get: {
          operationId: "auth",
          parameters: [{ name: "api_key", in: "query", required: true }],
          responses: {},
        },
      },
    };
    const call = buildProjectFromOpenApi(spec(paths), {}).document.project.calls[0];
    assert.equal(call.request.parameters.api_key, "{{ api_key }}");
  });

  test("optional query param with no example is omitted", () => {
    const paths = {
      "/search": {
        get: {
          operationId: "search",
          parameters: [{ name: "optional", in: "query", required: false }],
          responses: {},
        },
      },
    };
    const call = buildProjectFromOpenApi(spec(paths), {}).document.project.calls[0];
    const params = call.request.parameters || {};
    assert.ok(!Object.prototype.hasOwnProperty.call(params, "optional"));
  });

  test("path param interpolates into URL", () => {
    const paths = {
      "/users/{userId}": {
        get: {
          operationId: "getUser",
          parameters: [{ name: "userId", in: "path", required: true, example: "user42" }],
          responses: {},
        },
      },
    };
    const call = buildProjectFromOpenApi(spec(paths), {}).document.project.calls[0];
    assert.equal(call.request.url.path, "/v1/users/user42");
  });

  test("required path param with no example gets placeholder", () => {
    const paths = {
      "/items/{id}": {
        get: {
          operationId: "getItem",
          parameters: [{ name: "id", in: "path", required: true }],
          responses: {},
        },
      },
    };
    const call = buildProjectFromOpenApi(spec(paths), {}).document.project.calls[0];
    assert.equal(call.request.url.path, "/v1/items/{{ id }}");
  });

  test("body uses requestBody example", () => {
    const paths = {
      "/pets": {
        post: {
          operationId: "createPet",
          requestBody: {
            required: true,
            content: { "application/json": { example: { name: "Fido", type: "dog" } } },
          },
          responses: {},
        },
      },
    };
    const call = buildProjectFromOpenApi(spec(paths), {}).document.project.calls[0];
    assert.deepEqual(JSON.parse(call.request.body), { name: "Fido", type: "dog" });
  });

  test("body is placeholder when requestBody required and no example", () => {
    const paths = {
      "/pets": {
        post: {
          operationId: "createPet",
          requestBody: { required: true, content: { "application/json": {} } },
          responses: {},
        },
      },
    };
    const call = buildProjectFromOpenApi(spec(paths), {}).document.project.calls[0];
    assert.equal(call.request.body, "{{ body }}");
  });

  test("body is null when requestBody not required and no example", () => {
    const paths = {
      "/pets": {
        post: {
          operationId: "createPet",
          requestBody: { required: false, content: { "application/json": {} } },
          responses: {},
        },
      },
    };
    const call = buildProjectFromOpenApi(spec(paths), {}).document.project.calls[0];
    assert.equal(call.request.body, null);
  });

  test("auth_id and token_id from mapping override are attached", () => {
    const paths = { "/secure": { get: { operationId: "secure", responses: {} } } };
    const mapping = {
      operations: [{ operationId: "secure", request: { auth_id: "my-auth", token_id: "my-token" } }],
    };
    const req = buildProjectFromOpenApi(spec(paths), mapping).document.project.calls[0].request;
    assert.equal(req.auth_id, "my-auth");
    assert.equal(req.token_id, "my-token");
  });

  test("defaults.headers apply to all calls", () => {
    const paths = {
      "/a": { get: { operationId: "a", responses: {} } },
      "/b": { get: { operationId: "b", responses: {} } },
    };
    const result = buildProjectFromOpenApi(spec(paths), { defaults: { headers: { "X-Common": "yes" } } });
    for (const call of result.document.project.calls) {
      assert.equal(call.request.headers["X-Common"], "yes");
    }
  });

  test("operation header override beats defaults", () => {
    const paths = { "/a": { get: { operationId: "a", responses: {} } } };
    const mapping = {
      defaults: { headers: { "X-Header": "default" } },
      operations: [{ operationId: "a", request: { headers: { "X-Header": "override" } } }],
    };
    const call = buildProjectFromOpenApi(spec(paths), mapping).document.project.calls[0];
    assert.equal(call.request.headers["X-Header"], "override");
  });

  test("defaults.query applies to calls", () => {
    const paths = { "/a": { get: { operationId: "a", responses: {} } } };
    const result = buildProjectFromOpenApi(spec(paths), { defaults: { query: { region: "us-east" } } });
    assert.equal(result.document.project.calls[0].request.parameters.region, "us-east");
  });
});

describe("pickBaseServer", () => {
  test("mapping server_url takes precedence", () => {
    const server = pickBaseServer(
      spec({}, { servers: [{ url: "https://other.example.com" }] }),
      { server_url: "https://override.example.com/api" }
    );
    assert.equal(server.hostname, "override.example.com");
    assert.equal(server.pathPrefix, "/api");
  });

  test("uses first servers entry", () => {
    const server = pickBaseServer(spec({}, { servers: [{ url: "https://api.example.com/v2" }] }), {});
    assert.equal(server.hostname, "api.example.com");
    assert.equal(server.pathPrefix, "/v2");
    assert.equal(server.scheme, "https");
  });

  test("swagger 2 host and basePath are used", () => {
    const server = pickBaseServer({ swagger: "2.0", host: "api.example.com", basePath: "/v1", paths: {} }, {});
    assert.equal(server.hostname, "api.example.com");
    assert.equal(server.pathPrefix, "/v1");
  });

  test("http scheme is parsed", () => {
    const server = pickBaseServer(spec({}, { servers: [{ url: "http://insecure.example.com" }] }), {});
    assert.equal(server.scheme, "http");
  });

  test("port is extracted when present", () => {
    const server = pickBaseServer(spec({}, { servers: [{ url: "https://api.example.com:8443/v1" }] }), {});
    assert.equal(server.port, 8443);
  });

  test("port is null when absent", () => {
    const server = pickBaseServer(spec({}), {});
    assert.equal(server.port, null);
  });

  test("pathPrefix empty when no base path", () => {
    const server = pickBaseServer(spec({}, { servers: [{ url: "https://api.example.com" }] }), {});
    assert.equal(server.pathPrefix, "");
  });

  test("URL template variables do not throw", () => {
    const server = pickBaseServer(spec({}, { servers: [{ url: "https://{tenant}.example.com/v1" }] }), {});
    assert.equal(server.pathPrefix, "/v1");
  });
});

describe("mergeProject", () => {
  const TAG = "openapi-sync";

  test("non-generated calls are preserved", () => {
    const manual = { id: "manual", meta: { name: "m", tags: ["custom"] }, request: { method: "GET", url: "https://x.com/", body: null } };
    const result = mergeProject(baseDoc([manual]), [genCall("gen-1")], genWorkflow("wf", ["gen-1"]), { generatedTag: TAG, cleanupGenerated: true });
    assert.ok(result.project.calls.find((c) => c.id === "manual"));
  });

  test("generated call is inserted", () => {
    const result = mergeProject(baseDoc(), [genCall("gen-1")], genWorkflow("wf", ["gen-1"]), { generatedTag: TAG, cleanupGenerated: true });
    assert.ok(result.project.calls.find((c) => c.id === "gen-1"));
  });

  test("existing generated call updates with no duplicate", () => {
    const old = { ...genCall("gen-1"), meta: { ...genCall("gen-1").meta, name: "Old Name" } };
    const updated = { ...genCall("gen-1"), meta: { ...genCall("gen-1").meta, name: "New Name" } };
    const result = mergeProject(baseDoc([old]), [updated], genWorkflow("wf", ["gen-1"]), { generatedTag: TAG, cleanupGenerated: true });
    const found = result.project.calls.filter((c) => c.id === "gen-1");
    assert.equal(found.length, 1);
    assert.equal(found[0].meta.name, "New Name");
  });

  test("stale generated call removed when cleanupGenerated=true", () => {
    const result = mergeProject(baseDoc([genCall("stale")]), [], genWorkflow("wf", []), { generatedTag: TAG, cleanupGenerated: true });
    assert.ok(!result.project.calls.find((c) => c.id === "stale"));
  });

  test("stale generated call kept when cleanupGenerated=false", () => {
    const result = mergeProject(baseDoc([genCall("stale")]), [], genWorkflow("wf", []), { generatedTag: TAG, cleanupGenerated: false });
    assert.ok(result.project.calls.find((c) => c.id === "stale"));
  });

  test("non-generated call not touched by cleanup", () => {
    const manual = { id: "manual", meta: { name: "m", tags: ["custom"] }, request: { method: "GET", url: "https://x.com/", body: null } };
    const result = mergeProject(baseDoc([manual]), [], genWorkflow("wf", []), { generatedTag: TAG, cleanupGenerated: true });
    assert.ok(result.project.calls.find((c) => c.id === "manual"));
  });

  test("resulting calls are sorted by id", () => {
    const result = mergeProject(baseDoc(), [genCall("zzz"), genCall("aaa")], genWorkflow("wf", []), { generatedTag: TAG, cleanupGenerated: true });
    const ids = result.project.calls.map((c) => c.id);
    assert.deepEqual(ids, [...ids].sort());
  });

  test("generated workflow is upserted", () => {
    const result = mergeProject(baseDoc(), [genCall("g")], genWorkflow("my-wf", ["g"]), { generatedTag: TAG, cleanupGenerated: true });
    const wf = result.project.workflows.find((w) => w.id === "my-wf");
    assert.ok(wf);
    assert.deepEqual(wf.workflow.call_ids, ["g"]);
  });

  test("generated workflow updates on second run", () => {
    const existing = genWorkflow("my-wf", ["old-call"]);
    const updated = genWorkflow("my-wf", ["new-call"]);
    const result = mergeProject(baseDoc([], [existing]), [], updated, { generatedTag: TAG, cleanupGenerated: true });
    const wf = result.project.workflows.find((w) => w.id === "my-wf");
    assert.deepEqual(wf.workflow.call_ids, ["new-call"]);
  });

  test("non-generated workflows are preserved", () => {
    const manualWf = { id: "manual-wf", meta: { name: "manual", tags: ["custom"] }, workflow: { call_ids: [], stop_on_failure: false } };
    const result = mergeProject(baseDoc([], [manualWf]), [], genWorkflow("gen-wf", []), { generatedTag: TAG, cleanupGenerated: true });
    assert.ok(result.project.workflows.find((w) => w.id === "manual-wf"));
  });

  test("base document is not mutated", () => {
    const base = baseDoc([genCall("c")]);
    const before = base.project.calls.length;
    mergeProject(base, [genCall("c2")], genWorkflow("wf", []), { generatedTag: TAG, cleanupGenerated: true });
    assert.equal(base.project.calls.length, before);
  });
});

describe("idempotency", () => {
  const paths = {
    "/pets": {
      get: {
        operationId: "listPets",
        parameters: [{ name: "limit", in: "query", required: false, example: 25 }],
        responses: {},
      },
    },
    "/pets/{id}": {
      get: {
        operationId: "getPet",
        parameters: [{ name: "id", in: "path", required: true, example: "1" }],
        responses: {},
      },
    },
  };

  test("identical runs produce same call IDs", () => {
    const s = spec(paths);
    assert.deepEqual(
      buildProjectFromOpenApi(s, {}).summary.generatedCallIds,
      buildProjectFromOpenApi(s, {}).summary.generatedCallIds
    );
  });

  test("identical runs produce equal documents", () => {
    const s = spec(paths);
    assert.deepEqual(
      buildProjectFromOpenApi(s, {}).document,
      buildProjectFromOpenApi(s, {}).document
    );
  });

  test("adding new operation keeps existing IDs", () => {
    const paths1 = { "/pets": { get: { operationId: "listPets", responses: {} } } };
    const paths2 = { ...paths1, "/dogs": { get: { operationId: "listDogs", responses: {} } } };
    const id1 = buildProjectFromOpenApi(spec(paths1), {}).summary.generatedCallIds[0];
    const ids2 = buildProjectFromOpenApi(spec(paths2), {}).summary.generatedCallIds;
    assert.ok(ids2.includes(id1), `expected \"${id1}\" to survive adding operations`);
  });
});