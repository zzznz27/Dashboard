# World Map data: reference

## Integration record (`src/catalogue/integrations/<ID>.json`)

```json
{
  "id": "I001.SVC01",
  "link": "https://example.com/wiki/integrations/I001",
  "release": "Release 1",
  "workload": "FIN01",
  "source": ["ERP"],
  "target": ["Bank"],
  "dataFlow": "Supplier payment files",
  "pattern": "MFT",
  "sourceProtocol": "File (Blob Storage)",
  "targetProtocol": "File (SFTP)",
  "frequency": "Daily",
  "epic": { "id": "1001", "url": "https://example.com/work-items/1001" },
  "notes": "",
  "links": [{ "text": "Design spec", "url": "https://example.com/wiki/integrations/I001/spec" }]
}
```

Keep the fields in this order. The file name must be the ID plus `.json`.

| Field | Rules |
|---|---|
| `id` | Letters, digits, `.`, `_`, `-`. The sample uses `I` + 3 digits + `.SVC` + 2 digits (e.g. `I004.SVC01`); other forms such as `HR.PAY.SVC05` or `CRM-MKT-01` work too. Follow the form the catalogue already uses. Must be unique. |
| `link` | Optional. The integration's design page; a full https URL. Leave it out when there isn't one. |
| `release` | Reuse a value in use where possible (in the sample: `Release 1`, `Release 2`). May be `""`. |
| `workload` | Reuse a value in use where possible (in the sample: `FIN01`, `FIN02`, `CST01`, `CST02`, `HR01`, `HR02`, `OPS01`, `OPS02`, `ITS01`, `DAT01`). May be `""`. |
| `source`, `target` | Lists of system names or aliases from `systems.json`. Usually one each. `[]` is allowed while unknown; the map then can't draw it, and the build warns. |
| `dataFlow` | Short noun phrase for the data. |
| `pattern` | A value from `src/config/vocab.json` → `pattern`. It sets the line style: solid = publish-subscribe/API, dashed = file/MFT, dotted = OOTB/dual-write. A pattern with `"twoWay": true` gets its own line with arrows at both ends. |
| `sourceProtocol`, `targetProtocol` | A value from `vocab.json` → `protocol`. |
| `frequency` | A value from `vocab.json` → `frequency`. It sets the dot speed: fast, medium or slow. |
| `epic` | The epic or work item: `{ "id": "1001", "url": "https://example.com/work-items/1001" }` (url optional), or `null`. |
| `notes` | Free text, may be `""`. |
| `links` | Optional list of `{ "text", "url" }` (https), shown under the notes. |

Special values for pattern, protocols and frequency:
- `TBC`: not known yet. The map flags it as a data gap.
- `N/A`: doesn't apply.
- A trailing `?` (e.g. `Daily?`): unconfirmed. The map shows ⚠.
- `TBC` inside a value (e.g. `File (TBC)`): partly known.

## `systems.json` and `domains.json`

```json
{ "systems": [ { "name": "Bank", "aliases": ["Banking Portal"], "domain": "Finance", "type": "External" } ] }
{ "domains": [ { "name": "Finance", "description": "Ledger, payables, receivables, banking and expenses" } ] }
```

- Names and aliases are matched ignoring case, spaces and punctuation, and must be unique across all systems.
- `type` is `Internal` (a platform the organisation runs) or `External` (a vendor or partner system).
- `domain` must be in `domains.json`.
- Domain order sets the colours: add new ones at the end. The map has 8 colours.

## `npm run check`: errors and warnings

**Errors** fail the check and the pipeline, so the live map is never replaced by a broken one:

| Code | Meaning | Fix |
|---|---|---|
| `UNKNOWN_SYSTEM` | A source/target isn't in `systems.json` | Add the system, or add the name as an alias |
| `UNKNOWN_VALUE` | A pattern/protocol/frequency isn't in `vocab.json` | Use a listed value, or add the new one (ask first) |
| `UNKNOWN_DOMAIN` | A system's domain isn't in `domains.json` | Fix it, or add the domain at the end |
| `DUPLICATE_ID` / `DUPLICATE_ALIAS` / `DUPLICATE_DOMAIN` | Something is defined twice | Remove or rename the duplicate |
| `FILE_NAME` | The file isn't named after its `id` | Rename the file |
| `BAD_FILE` | Something in `src/catalogue/integrations/` that isn't a lower-case `.json` record (e.g. `I001.SVC01.JSON`, a `.txt`, a folder) | Rename it to `<ID>.json`, or move it out |
| `BAD_ID` | The ID has characters other than letters, digits, `.`, `_`, `-`, or starts with a name Windows reserves (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`9`, `LPT1`-`9`) | Fix the ID (and the file name) |
| `BAD_LINK` | A link isn't a full https URL (spaces and `( ) \| [ ]` and backticks must be percent-encoded), or a `links` entry has no `text`, or its text has a line break or ` \| ` | Use the full https URL, or leave it out; give each link one line of text |
| `BAD_VALUE` / `UNKNOWN_FIELD` / `BAD_JSON` | Wrong type (e.g. a number or a list where text in quotes belongs), a misspelt field, a `$comment` inside a record or entry, broken JSON (in `src/catalogue/` or `src/config/`), a domain called `Unassigned`, or a name with no letters or digits | Fix the file |
| `MISSING_FIELD` (in `domains.json` / `systems.json`) | The file has no `domains` / `systems` list, often a misspelt key; nothing else is checked until it's fixed | Fix the key |
| `BAD_VOCAB` | `src/config/vocab.json` is inconsistent: a pattern group or frequency speed the map doesn't know, or one spelling mapped to two values | Fix `vocab.json` (ask first) |

**Warnings** are allowed: `MISSING_FIELD` (no source or target yet, so the line can't be drawn), `SAME_SYSTEM` (a system is both source and target, often under two names, so no line is drawn to itself) and `TOO_MANY_DOMAINS`. **Data gaps** (`TBC`, `?`) are listed in the build report for the catalogue owners.

## Never needed for a data change

`src/web/**`, `src/config/presets/*`, `src/config/site.json` and `infra/**`. If a request seems to need one of these, it isn't a data change: say so and check with the user.
