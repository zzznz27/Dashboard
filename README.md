# Integration World Map

A map of which systems integrate with which. Its data is the catalogue in this repo (`src/catalogue/`): one small
JSON file per integration, plus lists of systems and domains. The site is static, built from that data, and needs no
database.

This repo is a template. The catalogue it ships with is a fictional sample (16 systems, 6 domains, 24
integrations) so you can see the map working; replace it with your own (see [Make it yours](#make-it-yours)).
[DESIGN.md](docs/DESIGN.md) covers the visual rules, layouts, themes and animations.

## Run it locally

```sh
npm run dev
```

Or, in VS Code, press **F5** (*World Map: local preview*): it rebuilds the data, starts the preview and opens it
in your browser.

Then open <http://localhost:8080/>:
- Pick a theme in the header; it's remembered next time. Animations can be switched off under ⚙ (Map settings).
- Pick **Customise…** in the Theme list (or add `?lab=1`) for the design lab: mix layout, theme and animation, and save the mix as your own design. Saved designs stay in your browser, appear in the Theme list under *My designs*, and can be shared as a file. On the local preview the lab can also copy the mix as a preset file.
- Open `compare.html` to see two designs side by side.
- After editing records, press **Rebuild data** in the footer; it only appears on the local preview.

Designs are the JSON files in `src/config/presets/`. Edit one and refresh the browser.
The default design is `defaultPreset` in `src/config/site.json`.

Node 22 or later is needed, and PowerShell 7 (`pwsh`) for the Excel tool and its tests. Nothing else needs installing.

## The data

| File | Holds |
|---|---|
| `src/catalogue/integrations/<ID>.json` | One integration per file, named after its ID |
| `src/catalogue/systems.json` | Systems: name, aliases, domain, Internal/External |
| `src/catalogue/domains.json` | Domains, in order. The order sets the map colours. |
| `src/config/vocab.json` | Allowed pattern, protocol and schedule values |

```sh
npm run check       # validate the catalogue; writes nothing
npm run build:data  # src/web/data/integrations.json, out/build-report.md, and the generated wiki page in out/wiki/
npm test            # unit tests, including the catalogue check (the pipeline runs this, then the build)
```

Validation is strict. A record with an unknown system or value, a duplicate ID or a non-https link is an
error: the pipeline stops before deploying, so the live map is never replaced by a broken one. Gaps (`TBC`,
`Daily?`, no source yet) are allowed and listed in the build report.

If you keep a catalogue on an Azure DevOps wiki, the deploy pipeline can also rewrite a generated **World Map
Catalogue** page from this data after each merge to `main` (`publishWikiPage`, off by default; see
[infra/README.md](infra/README.md)). It's optional: the map itself never reads the wiki.

## Changing the data

**Add integrations as you find them: ask Claude.** In Claude Code, in this repo, say for example *"add an
integration to the map"*, or *"the ERP sends supplier remittances to the Supplier Portal daily over SFTP"*,
or paste a design-page link. The `worldmap-data` skill (`.claude/skills/worldmap-data/`):
- turns your description, the design page or a row of your wiki catalogue page into a record;
- asks only for what's missing;
- runs the check, shows you the result, and raises a pull request once you say yes.

It reads only the pages you point it to and the catalogue page set in `src/config/source.json`, and never copies
credentials, endpoints or keys into a record.

**Fill in missing details: the local preview.** Run `npm run dev` (or F5), open **Table**, tick *Missing details
only*, and use **Fill in** on a row. The form offers the catalogue's own systems and values; **Save** checks the
whole catalogue first and only then writes `src/catalogue/integrations/<ID>.json` and rebuilds the map. It's local only
(not on the live site): commit the changed files on a branch and raise a PR to publish them.

**Bulk edits: Excel.**

```sh
npm run excel -- export      # out/catalogue/: Integrations.csv, Systems.csv, Domains.csv
# edit in Excel: change cells, add rows at the bottom, delete rows to remove;
# save each file as "CSV UTF-8 (Comma delimited)"
npm run excel -- import      # checks all three files, then rewrites src/catalogue/
git diff -- src/catalogue    # review, then raise a PR as usual
```

**Importing from a wiki (optional).** If your catalogue already exists as a markdown table on an Azure DevOps wiki,
two scripts can bring it in, using the page paths and column names in `src/config/source.json` (`catalogue`,
`settings`):
- `src/scripts/migrate-from-wiki.mjs` does a one-off migration from saved copies of the pages. It refuses to
  overwrite existing records.
- `src/scripts/wiki-to-record.mjs` turns one row into a draft record. The `worldmap-data` skill uses it.

You don't need either if you start from the sample or from Excel.

## Make it yours

| What | Where |
|---|---|
| Your systems, domains and integrations, in place of the sample | `src/catalogue/`: by hand, with the Claude skill, from Excel, or migrated from a wiki. Keep `src/config/vocab.json` in step with the patterns, protocols and schedules you use. |
| Title, subtitle and default design | `src/config/site.json` (`title`, `subtitle`, `defaultPreset`) |
| Your repo's web URL, so the map can link to each record; the optional wiki pages | `src/config/source.json` (`store.repoUrl`; `generatedPage`, `wiki`, `catalogue`, `settings`). Leave the wiki URLs `null` if you don't use one. |
| Logos | Add files to `src/web/logos/`, map them to systems in `src/config/logos.json`, and record where each came from in `src/web/logos/SOURCES.md`. Check each brand's usage guidelines first: the map draws marks in white on the node. Without a logo, a node shows the system's initials. |
| Themes and designs (optional) | `src/web/styles/themes.css`, `THEMES` in `src/web/js/theme.js`, and `src/config/presets/`. See [DESIGN.md](docs/DESIGN.md) §9. |
| Hosting | The placeholders in `infra/`: resource names (they use `contoso`), tenant, subscription and service connection. See [infra/README.md](infra/README.md). |

## Hosting

Azure App Service (Linux) behind Entra ID sign-in. Bicep and pipelines are in `infra/`; see
[infra/README.md](infra/README.md) for what gets created and the one-time setup steps. The site is
served by `src/server/server.mjs`, a small Node server with no dependencies that sets the security headers.
