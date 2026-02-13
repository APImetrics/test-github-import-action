# APIm Import Action

Uploads an APImetrics import document to the APImetrics API. The action can render a `ytt` template, validate against the APImetrics JSON Schema, and then upload.

## Inputs

- `file`: Path to a YAML or JSON file in the repo.
- `template`: Path to a ytt template file or directory.
- `template_values`: Path to a ytt values file (optional).
- `token`: Bearer token for APImetrics API. (required)
- `validate_schema`: `true` or `false` (default: `true`).
- `schema_url`: Override schema URL.
- `endpoint`: Override API endpoint (default: `https://client.apimetrics.io/api/2/import`).
- `ytt_version`: ytt version to download (default: `v0.48.0`).
- `ytt_args`: Extra args to pass to ytt.

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

## Notes

- The action downloads `ytt` when `template` is provided.
- YAML input is converted to JSON before upload.

## Build (bundle dependencies)

This repo uses `@vercel/ncc` to bundle dependencies into `dist/index.js`.

```bash
npm install
npm run build
```

Commit the updated `dist/index.js` after rebuilding.
