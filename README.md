# AMR - GLASS App

## Setup

Install dependencies:

```
$ yarn install
```

## Development

Start the development server:

```
$ PORT=8081 REACT_APP_DHIS2_BASE_URL="http://localhost:8080" yarn start
```

Now in your browser, go to `http://localhost:8081`.

Notes:

-   Requests to DHIS2 will be transparently proxied (see `config/dhis2-proxy.js`, plugged into `vite.config.ts`) from `http://localhost:8081/dhis2/path` to `http://localhost:8080/path` to avoid CORS and cross-domain problems.

-   The optional environment variable `DHIS2_AUTH=USERNAME:PASSWORD` (or a token in `DHIS2_TOKEN`) forces some credentials to be used by the proxy. This variable is usually not set, so the app has the same user logged in at `REACT_APP_DHIS2_BASE_URL`. Secrets must not start with `REACT_APP_`, because the old Create React App build copied every `REACT_APP_*` variable into the built app, where anyone can read it (Vite only copies `VITE_*` variables, and the app uses none). The old `REACT_APP_DHIS2_AUTH` / `REACT_APP_DHIS2_TOKEN*` names are deprecated: they are still read, with a warning, so rename them in your `.env.local` (git-ignored; `.env` is tracked, never put secrets in it).

-   The optional environment variable `REACT_APP_PROXY_LOG_LEVEL` can be helpful to debug the proxyfied requests (accepts: "warn" | "debug" | "info" | "error" | "silent")

-   Create a file `.env.local` (copy it from `.env`) to customize environment variables so you can simply run `yarn start`.

## Tests

### Unit tests (Vitest)

```
$ yarn test
```

### Browser tests (Playwright)

The tests in `e2e/` run a built app (`build/`, or the folder in `E2E_BUILD_DIR`) in Microsoft Edge (`E2E_BROWSER_CHANNEL` picks another installed browser), against the DHIS2 instance in `.env.local`. They need Node 20 or newer.

```
$ yarn build-folder
$ yarn e2e        # read-only: a tour of every page, compared with screenshots of a reference build
$ yarn e2e:dev    # also uploads, imports and deletes test files in every module; DEV only
```

-   **Page tour.** Every page is opened through the side menu and must load without an uncaught error and look like the reference build. Record the reference screenshots once from a trusted build with `E2E_BUILD_DIR=<reference build> yarn e2e --update-snapshots` (they stay in `e2e/.snapshots`, not in git). Writes to DHIS2 are refused during the tour.
-   **Upload tests** (`*.upload.spec.ts`) only run with `yarn e2e:dev` and refuse any instance other than DEV. They use the previous calendar year in the Republic of Korea (Uganda for EGASP, whose data must come from clinics), which must hold no other data for that module and year. Files are generated from code-only seeds (`e2e/fixtures/seeds`) with made-up identifiers, ages and dates. Large files are imported and deleted by running one cycle of the async-uploads and async-deletions servers from source; the run stops if those queues hold anything that is not a test upload.
-   **Accuracy.** After each import, what DHIS2 stores is compared with the file, value by value, and with a golden file in `e2e/golden` that records what a trusted build wrote. Only rewrite golden files (`E2E_UPDATE_GOLDEN=1 yarn e2e:dev`) on a build whose output has been checked.
-   Failed tests keep a trace (`npx playwright show-trace <zip>`) and the HTML report is in `e2e/.report`. Traces include a DHIS2 session cookie for the test user: keep them within the team.

## Build app ZIP

```
$ yarn build
```

## AMC data consumption recalculations

The app provides a server-side AMC recalculations script that runs in the background. The script requires the Node version in `.nvmrc` (v24).

1. Build and generates glass-dev-amc-recalculate-server.zip file:

```
$ yarn build-amc-recalculate
```

2. Unzip glass-dev-amc-recalculate-server.zip and executed it like this:

```
$ cd glass-dev-amc-recalculate-server
$ node index.js --url "http[s]://HOST:PORT" --auth USERNAME:PASSWORD
```

To just run the script manually for development:

```
$ yarn start-amc-recalculate --url "http[s]://HOST:PORT" --auth USERNAME:PASSWORD
```

`cliAMC.ts` is the scheduled entry point: it only does work when the DataStore key
`glass/amc-recalculation` has `recalculate: true`, and clears the flag when it finishes.

### Running a recalculation from a local machine

`cliAMCEnv.ts` runs the same pipeline but reads the connection from the environment
(`REACT_APP_DHIS2_BASE_URL` plus `DHIS2_TOKEN_PROD` / `DHIS2_TOKEN_PREPROD` /
`DHIS2_TOKEN_TRAINING` / `DHIS2_TOKEN` / `DHIS2_AUTH`) and logs to the console instead of the DHIS2 logs program.

```
# PowerShell
$env:DOTENV_CONFIG_PATH=".env.local"
npx ts-node -P src/scripts/tsconfig.json src/scripts/cliAMCEnv.ts `
    --force --calculate --debug --checkpoint amc-recalc.checkpoint
```

`yarn amc-recalculate-local <flags>` runs the same thing, but on Windows `yarn` executes scripts
through `bash` and will pick `C:\WINDOWS\system32\bash.exe` — the WSL launcher — if that comes first
on PATH, failing with `WSL_E_DEFAULT_DISTRO_NOT_FOUND` before the script ever starts. This repo's
scripts genuinely need a POSIX shell (`build-folder` uses `rm -rf` and `cp`), so the fix is to point
yarn at Git Bash once per machine:

```
yarn config set script-shell "C:\Program Files\Git\bin\bash.exe"
```

The `npx` form above sidesteps the shell entirely and always works. `npm run amc-recalculate-local --
<flags>` also works (npm uses `cmd.exe`).

Flags:

- `--calculate` — create calculated events that do not exist yet, not just update existing ones.
  **Use it.** Without it, a row whose ATC code the new version remapped cannot be rewritten, and the
  run will log that it is skipping the deletion of its stored event rather than losing it.
- `--force` — run even when `recalculate` is false, and leave the flag untouched.
- `--all` — recalculate every org unit that actually holds AMC product-level or substance-level
  source data, resolved by probing the data rather than trusting the DataStore list. Nothing in the
  app maintains that list, so it drifts: on the WHO instance it names 218 org units of which only 97
  hold data, while omitting Kosovo (`NEPywTBN52g`), which has ~20k product register entities.
  Combine with `--from-year` / `--to-year` (defaults: 2016, the AMC module's `startPeriod`, to the
  current year). The probe is count-only, ~2-3 minutes for 265 countries at `--concurrency 6`.
- `--orgUnits ID,ID` / `--periods 2023,2024` — override the scope explicitly.
- `--checkpoint FILE` — record completed org unit/period pairs. Rerunning with the same file skips
  what already succeeded, so an interrupted run resumes and a partly-failed run retries only the
  failures.
- `--delay MS` — pause between pairs to keep request pressure off a busy server (default 0).
- `--dry-run` — resolve and print the scope, then exit without reading or writing tracker data.
- `--plan` — **rehearsal**. Runs the whole pipeline for real (every read, the DDD/ATC arithmetic, the
  matcher, the create/update/delete classification) but intercepts every write and reports what
  *would* change. Use it before any real run: if the plan shows unexpected deletes, stop. A healthy
  plan against already-recalculated data is "all update, no delete", and the update count should
  equal the number of calculated events already stored for that org unit and period.

Both entry points share `src/scripts/commands/amcRecalculate.ts`; failures are isolated per org
unit/period pair and summarised at the end rather than aborting the run.

### The audit report

Every run (including `--plan`) writes `AMC_recalculation_<timestamp>.csv` to the working directory —
override with `--audit <path>`. One row per org unit/period, appended synchronously as each pair
finishes, so a run killed with Ctrl+C still leaves a complete record of what it did:

```
orgUnitId,period,outcome,durationSeconds,hadProductData,hadSubstanceData,
productUpdated,productCreated,productDeleted,
substanceUpdated,substanceCreated,substanceDeleted,totalWritten,reason
```

`outcome` is PROCESSED, NO_DATA or FAILED. The closing summary totals it up and warns about anything
that needs a human: deletions, pairs holding both levels, and failed pairs. Sort by
`substanceDeleted` / `productDeleted` first — those are the only destructive column.

### What the run logs

Per org unit/period you get counts, not UID lists: `... : 1474 events`. Event ids are only spelled
out for **deletions**, which are destructive and need an audit trail. Watch for these lines:

- `could not be recalculated so they will be deleted` — the only destructive path;
- `NOT deleting N unmatched events` — deletion was suppressed, see the two guards above;
- `matched their stored event only after applying the ATC change table` — rows the new ATC version
  remapped, which a naive matcher would have deleted instead of updated;
- `FAILED orgUnit=... period=...` — an isolated pair failure; the run continues and lists them all
  at the end.

`--debug` adds chunk-level import progress. It is not needed for per-pair progress, which is always
printed as `(n/total) orgUnit=... period=...`.

### Both levels writing the same program

Product level and substance level both aggregate into the Calculated Consumption Data program
(`eUmWZeKZNrg`), and each treats calculated events it did not match as stale. Product level runs
first for each pair, so when an org unit/period holds data at BOTH levels the substance pass is told
to leave unmatched events alone — otherwise it would delete the product pass's output. The run warns
and lists such pairs; verify them by hand, because the two levels can also collide on the same
(atc, route, salt, combination, sector, level, status) key, and nothing decides how to combine them.
No country currently reports at both levels for the same period.

### AMC metadata ids

All AMC program, stage and tracked-entity-attribute ids live in
`src/domain/entities/data-entry/amc/amcProgramIds.ts`. Import from there rather than redeclaring:
they were previously spread over seven files, with stage `q8cl5qllyjd` and program `eUmWZeKZNrg`
each carrying several different names.

## AMR AGG orphaned data: find, verify, audit labels, delete

AMR aggregate values belong in DHIS2 only if the file of an upload at IMPORTED, VALIDATED or COMPLETED puts them there. An upload still at UPLOADED was never imported as far as the app shows, so it owns nothing. `yarn amr-agg-orphans` checks this, documents every finding, and removes only what does not belong.

**Instance.** `--instance preprod` or `--instance prod` targets that server with `DHIS2_TOKEN_PREPROD` / `DHIS2_TOKEN_PROD` from `.env.local`. The other credentials are ignored for that run. Without `--instance`, it uses `REACT_APP_DHIS2_BASE_URL` and the first token in `.env.local`, then `.env`. Outputs go to `amr-agg-orphan-deletions/` (git-ignored: pass `--outDir` to keep backups and reports somewhere durable). `find`, `verify` and `labels` check the whole database by default. Narrow them with `--years 2024` (or `2016-2025`), `--fileType RIS|SAMPLE|BOTH`, `--orgUnits IRQ,...` and `--batchIds DS1,...`; `--concurrency` sets how many are read at once (default 4).

1. `find` (read-only, fast): batches with values stored but no imported upload. Reads no files, so these are candidates only.

```
$ yarn amr-agg-orphans find --instance preprod
```

2. `verify` (read-only): compares every batch, value by value, with its imported upload's file, read and mapped by the app's own import code. The report `amr_agg_verify_*_report.md` opens with two tables: **Safe to delete** (what `delete` would remove, and why) and **Needs a person** (what is wrong, and the next step). The evidence for each finding follows. `amr_agg_verify_*.csv` has one row per batch, and `amr_agg_verify_*_values.csv` every value that differs, including values whose attribute option combo is not a batch combo (UNKNOWN_BATCH_COMBO).

```
$ yarn amr-agg-orphans verify --instance preprod --years 2024 --orgUnits IRQ
```

3. `labels` (read-only audit): every live upload whose file's rows name another country, year or batch than the upload itself. For each, it shows where that data is stored, whether it is stored twice or overlaps another upload's cells, and how to fix it. The import stores each value where its row says, and the app's delete re-reads the file, so such an upload's delete removes the wrong values.

```
$ yarn amr-agg-orphans labels --instance preprod
```

4. `delete`: for one batch, or every row of a find/verify CSV (from a verify CSV only the Safe to delete rows), it works out the verdict again and deletes only:

    - a whole batch that no imported upload's file accounts for (ORPHAN), or
    - the values of a submitted batch that no imported upload's file has, under any batch or year label (LEFTOVER_VALUES).

    Nothing is deleted while an UPLOADED upload of that country/year/file type, or the values themselves, are less than 14 days old (an import may be under way); for one batch, `--waitDays 0` lifts that wait once you have confirmed no import is running. Everything else is refused. It backs up the values (re-importable with CREATE_AND_UPDATE), dry-runs the delete with a count check, and checks that no upload record or value changed since the check. Without `--commit` it stops there. With `--commit` (plus `--confirmInstance`) it deletes through the same API call the app uses, then verifies the batch again. Every target, refused and failed ones included, is recorded in `deletion-log.jsonl`, with its evidence in `deletion-report.md`.

```
$ yarn amr-agg-orphans delete --instance preprod --orgUnit IRQ --period 2024 --batchId DS1 --fileType RIS
$ yarn amr-agg-orphans delete --instance preprod --file amr-agg-orphan-deletions/amr_agg_verify_....csv --commit --confirmInstance portal-uat.who.int/dhis2-indiv
```

The older `yarn amr-agg-data-validation-ris` reads the upload list from the datastore, which stopped being updated when uploads moved to the uploads program. Its results are out of date. `yarn amr-agg-data-reset-ris` / `-sample` (kept as a fallback) write every value of a country/year/batch to a JSON for an Import/Export delete. They do not check uploads or files.

## Some development tips

### Structure

-   `i18n/`: Contains literal translations (gettext format)
-   `public/`: Main app folder with a `index.html`, exposes the APP, contains the feedback-tool.
-   `src/webapp/pages`: Main React components.
-   `src/domain`: Domain layer of the app (clean architecture)
-   `src/data`: Data of the app (clean architecture)
-   `src/webapp/components`: Reusable React components.
-   `src/types`: `.d.ts` file types for modules without TS definitions.
-   `src/utils`: Misc utilities.
-   `src/locales`: Auto-generated, do not update or add to the version control.
-   `e2e/`: Playwright browser tests.

### i18n

```
$ yarn localize
```

### App context

The file `src/webapp/contexts/app-context.ts` holds some general context so typical infrastructure objects (`api`, `d2`, ...) are readily available. Add your own global objects if necessary.

### Scripts

Check the example script, entry `"script-example"`in `package.json`->scripts and `src/scripts/commands/example.ts`.
