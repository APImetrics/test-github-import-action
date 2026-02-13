/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ 81:
/***/ ((module) => {

module.exports = require("child_process");

/***/ }),

/***/ 147:
/***/ ((module) => {

module.exports = require("fs");

/***/ }),

/***/ 37:
/***/ ((module) => {

module.exports = require("os");

/***/ }),

/***/ 17:
/***/ ((module) => {

module.exports = require("path");

/***/ }),

/***/ 837:
/***/ ((module) => {

module.exports = require("util");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId](module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
// This entry need to be wrapped in an IIFE because it need to be isolated against other modules in the chunk.
(() => {


const fs = __nccwpck_require__(147);
const fsp = fs.promises;
const path = __nccwpck_require__(17);
const os = __nccwpck_require__(37);
const { execFile } = __nccwpck_require__(81);
const { promisify } = __nccwpck_require__(837);

const execFileAsync = promisify(execFile);

function getInput(name, options = {}) {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const value = process.env[key];
  if (options.required && (!value || value.trim() === "")) {
    throw new Error(`Missing required input: ${name}`);
  }
  return value || "";
}

function parseBoolean(value, defaultValue) {
  if (value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureModule(moduleName, version) {
  try {
    return require(moduleName);
  } catch {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "apim-action-"));
    const pkg = version ? `${moduleName}@${version}` : moduleName;
    await execFileAsync("npm", ["install", "--silent", "--no-fund", "--no-audit", pkg], {
      cwd: tempDir,
      env: process.env,
    });
    const modulePath = path.join(tempDir, "node_modules", moduleName);
    return require(modulePath);
  }
}

function resolveYttAsset(version) {
  const platform = os.platform();
  const arch = os.arch();

  let osName;
  if (platform === "darwin") {
    osName = "darwin";
  } else if (platform === "linux") {
    osName = "linux";
  } else {
    throw new Error(`Unsupported OS for ytt: ${platform}`);
  }

  let archName;
  if (arch === "x64") {
    archName = "amd64";
  } else if (arch === "arm64") {
    archName = "arm64";
  } else {
    throw new Error(`Unsupported architecture for ytt: ${arch}`);
  }

  const fileName = `ytt-${osName}-${archName}`;
  const url = `https://github.com/carvel-dev/ytt/releases/download/${version}/${fileName}`;
  return { url, fileName };
}

async function ensureYtt(version) {
  if (fileExists("ytt")) {
    return path.resolve("ytt");
  }

  const { url, fileName } = resolveYttAsset(version);
  const downloadDir = await fsp.mkdtemp(path.join(os.tmpdir(), "apim-ytt-"));
  const targetPath = path.join(downloadDir, fileName);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ytt: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(targetPath, buffer);
  await fsp.chmod(targetPath, 0o755);

  return targetPath;
}

async function renderWithYtt(templatePath, valuesPath, yttArgs, yttVersion) {
  const yttBin = await ensureYtt(yttVersion);
  const args = ["-f", templatePath];

  if (valuesPath) {
    args.push("-f", valuesPath);
  }

  if (yttArgs) {
    const extraArgs = yttArgs.split(" ").filter((item) => item.trim() !== "");
    args.push(...extraArgs);
  }

  const { stdout, stderr } = await execFileAsync(yttBin, args, {
    maxBuffer: 10 * 1024 * 1024,
  });

  if (stderr && stderr.trim() !== "") {
    console.log(stderr.trim());
  }

  return stdout;
}

async function loadDocument(raw, fileHint) {
  const trimmed = raw.trim();
  const isJson = (fileHint && fileHint.endsWith(".json")) || trimmed.startsWith("{");

  if (isJson) {
    return { data: JSON.parse(raw), format: "json" };
  }

  const yaml = await ensureModule("js-yaml", "4.1.0");
  return { data: yaml.load(raw), format: "yaml" };
}

async function validateSchema(document, schemaUrl) {
  const response = await fetch(schemaUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch schema: ${response.status} ${response.statusText}`);
  }
  const schema = await response.json();

  const AjvDraft04 = await ensureModule("ajv-draft-04", "1.0.0");
  const addFormats = await ensureModule("ajv-formats", "2.1.1");
  const ajv = new AjvDraft04({ allErrors: true, strict: false });
  addFormats(ajv);

  const validate = ajv.compile(schema);
  const valid = validate(document);
  if (!valid) {
    const details = ajv.errorsText(validate.errors, { separator: "\n" });
    throw new Error(`Schema validation failed:\n${details}`);
  }
}

async function uploadDocument(document, token) {
  const response = await fetch("https://client.apimetrics.io/api/2/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(document),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Upload failed: ${response.status} ${response.statusText}\n${body}`);
  }

  return response.text();
}

async function run() {
  const fileInput = getInput("file");
  const templateInput = getInput("template");
  const valuesInput = getInput("template_values");
  const token = getInput("token", { required: true });
  const validate = parseBoolean(getInput("validate_schema"), true);
  const schemaUrl = getInput("schema_url") || "https://client.apimetrics.io/api/2/import/schema.json";
  const yttVersion = getInput("ytt_version") || "v0.48.0";
  const yttArgs = getInput("ytt_args");

  if (!templateInput && !fileInput) {
    throw new Error("Provide either 'file' or 'template'.");
  }

  let rawContent = "";
  let sourceHint = fileInput;

  if (templateInput) {
    rawContent = await renderWithYtt(templateInput, valuesInput, yttArgs, yttVersion);
    sourceHint = templateInput;
  } else {
    rawContent = await fsp.readFile(fileInput, "utf8");
  }

  const { data } = await loadDocument(rawContent, sourceHint);

  if (validate) {
    await validateSchema(data, schemaUrl);
  }

  const resultText = await uploadDocument(data, token);
  if (resultText && resultText.trim() !== "") {
    console.log(resultText.trim());
  } else {
    console.log("Upload complete.");
  }
}

run().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

})();

module.exports = __webpack_exports__;
/******/ })()
;