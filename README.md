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

-   Requests to DHIS2 will be transparently proxied (see `src/setupProxy.js`) from `http://localhost:8081/dhis2/path` to `http://localhost:8080/path` to avoid CORS and cross-domain problems.

-   The optional environment variable `REACT_APP_DHIS2_AUTH=USERNAME:PASSWORD` forces some credentials to be used by the proxy. This variable is usually not set, so the app has the same user logged in at `REACT_APP_DHIS2_BASE_URL`.

-   The optional environment variable `REACT_APP_PROXY_LOG_LEVEL` can be helpful to debug the proxyfied requests (accepts: "warn" | "debug" | "info" | "error" | "silent")

-   Create a file `.env.local` (copy it from `.env`) to customize environment variables so you can simply run `yarn start`.

-   [why-did-you-render](https://github.com/welldone-software/why-did-you-render) is installed, but it does not work when using standard react scripts (`yarn start`). Instead, use `yarn start-profiling` to debug re-renders with WDYR. Note that hot reloading does not work out-of-the-box with [craco](https://github.com/gsoft-inc/craco).

## Tests

### Unit tests

```
$ yarn test
```

### Integration tests (Cypress)

Create the required users for testing (`cypress/support/App.ts`) in your instance and run:

```
$ export CYPRESS_EXTERNAL_API="http://localhost:8080"
$ export CYPRESS_ROOT_URL=http://localhost:8081

# non-interactive
$ yarn cy:e2e:run

# interactive UI
$ yarn cy:e2e:open
```

## Build app ZIP

```
$ yarn build
```

## AMC data consumption recalculations

The app provides a server-side AMC recalculations script that runs in the background. The script requires Node v10+.

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
(`REACT_APP_DHIS2_BASE_URL` plus `REACT_APP_DHIS2_TOKEN_PROD` / `REACT_APP_DHIS2_TOKEN` /
`REACT_APP_DHIS2_AUTH`) and logs to the console instead of the DHIS2 logs program.

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

## AMR AGG data validation and reset scripts

Due to 'Import Ignore' errors, there could be data corruption AMR Aggregate module.

1. Run the following script, to detect if there are any errors. Ensure you have the URL and Auth credentails in your .env file and change the .env value based on your environment.

```
$ source .env && ts-node src/scripts/amr_agg_data_validation.ts --url $REACT_APP_DHIS2_BASE_URL --auth $REACT_APP_DHIS2_AUTH
```

2. Run the following script (with the period and org unit as parameters), to create a json with all valaues to be deleted. Import the json created using Import/Export app with "Delete" option selected.

```
$ source .env && ts-node src/scripts/amr_agg_data_reset.ts  --url $REACT_APP_DHIS2_BASE_URL --auth $REACT_APP_DHIS2_AUTH
```

## Some development tips

### Structure

-   `i18n/`: Contains literal translations (gettext format)
-   `public/`: Main app folder with a `index.html`, exposes the APP, contains the feedback-tool.
-   `src/pages`: Main React components.
-   `src/domain`: Domain layer of the app (clean architecture)
-   `src/data`: Data of the app (clean architecture)
-   `src/components`: Reusable React components.
-   `src/types`: `.d.ts` file types for modules without TS definitions.
-   `src/utils`: Misc utilities.
-   `src/locales`: Auto-generated, do not update or add to the version control.
-   `cypress/integration/`: Cypress integration tests.

### i18n

```
$ yarn localize
```

### App context

The file `src/contexts/app-context.ts` holds some general context so typical infrastructure objects (`api`, `d2`, ...) are readily available. Add your own global objects if necessary.

### Scripts

Check the example script, entry `"script-example"`in `package.json`->scripts and `src/scripts/example.ts`.
