# APIm Import Action

Uploads an APImetrics import document to the APImetrics API. The action can render a `ytt` template, transform an OpenAPI spec into APIm import objects, validate against the APImetrics JSON Schema, and then upload.

## Release Notes

### 0.2.0

- Added OpenAPI sync mode with mapping-file driven generation.
- Added merge support against an existing APIm project document.
- Added dry-run mode and optional generated payload output file.
- Added sample OpenAPI, mapping, and base project fixtures.

## Inputs

- `file`: Path to a YAML or JSON file in the repo.
- `openapi_file`: Path to an OpenAPI spec (YAML/JSON). Enables OpenAPI sync mode.
- `openapi_mapping_file`: Path to mapping file that controls operation selection and request value overrides.
- `base_project_file`: Optional APIm import file to merge generated OpenAPI calls/workflows into.
- `template`: Path to a ytt template file or directory.
- `template_values`: Path to a ytt values file (optional).
- `token`: Bearer token for APImetrics API. (required unless `dry_run=true`)
- `validate_schema`: `true` or `false` (default: `true`).
- `schema_url`: Override schema URL.
- `endpoint`: Override API endpoint (default: `https://client.apimetrics.io/api/2/import/`).
- `ytt_version`: ytt version to download (default: `v0.48.0`).
- `ytt_args`: Extra args to pass to ytt.
- `generated_tag`: Tag to mark generated entities in OpenAPI sync mode (default: `openapi-sync`).
- `cleanup_generated`: Remove stale generated entities during OpenAPI merge (default: `true`).
- `dry_run`: Generate and validate only; skip upload (default: `false`).
- `output_file`: Optional path to write generated APIm import JSON.
- `debug`: `true` or `false` (default: `false`) to log endpoint + request summary.

Mode rules:

- `openapi_file` is exclusive with `file` and `template`.
- `openapi_mapping_file` and `base_project_file` require `openapi_file`.

## Usage

### Upload a static YAML or JSON file

```yaml
- name: Upload APImetrics definition
  uses: APImetrics/test-github-import-action@v1
  with:
    file: path/to/import.yaml
    token: ${{ secrets.APIM_TOKEN }}
```

### Render a ytt template first

```yaml
- name: Render + upload APImetrics definition
  uses: APImetrics/test-github-import-action@v1
  with:
    template: templates/import
    template_values: templates/values.yml
    token: ${{ secrets.APIM_TOKEN }}
```

### Disable schema validation

```yaml
- name: Upload without schema validation
  uses: APImetrics/test-github-import-action@v1
  with:
    file: path/to/import.yaml
    validate_schema: false
    token: ${{ secrets.APIM_TOKEN }}
```

### Sync from OpenAPI into APIm project

```yaml
- name: Sync APIm project from OpenAPI
  uses: APImetrics/test-github-import-action@v1
  with:
    openapi_file: api/openapi.yaml
    openapi_mapping_file: api/apim-mapping.yaml
    base_project_file: apim/project-base.yaml
    token: ${{ secrets.APIM_TOKEN }}
```

### OpenAPI mapping file example

```yaml
server_url: https://api.example.com/v1

include:
  - "GET /pets"
  - operationId: createPet

exclude:
  - "DELETE /pets/{petId}"

defaults:
  headers:
    x-api-key: "{{ apiKey }}"
  query:
    region: eu-west-1

operations:
  - operationId: getPet
    request:
      parameters:
        petId: "{{ petId }}"

workflow:
  id: openapi-sync-workflow
  name: OpenAPI Sync Workflow
```

### Dry-run OpenAPI sync and save generated payload

```yaml
- name: Validate OpenAPI sync without upload
  uses: APImetrics/test-github-import-action@v1
  with:
    openapi_file: api/openapi.yaml
    openapi_mapping_file: api/apim-mapping.yaml
    base_project_file: apim/project-base.yaml
    dry_run: true
    output_file: artifacts/apim-import.json
```

## Notes

- The action downloads `ytt` when `template` is provided.
- YAML input is converted to JSON before upload.
- In OpenAPI sync mode, request values are resolved with this precedence: mapping overrides, then OpenAPI examples, then placeholders such as `{{ varName }}` for unresolved required values.
- Generated entities are tagged (default `openapi-sync`) and merged by deterministic IDs so repeated runs stay stable.

## Build (bundle dependencies)

This repo uses `@vercel/ncc` to bundle dependencies into `dist/index.js`.

```bash
npm install
npm run build
```

Commit the updated `dist/index.js` after rebuilding.
