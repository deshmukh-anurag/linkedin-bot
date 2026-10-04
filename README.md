# LinkedIn profile collector

JavaScript / Node.js 24 + Playwright + Google Sheets + SQLite.

The bot only collects LinkedIn profile information and fills Google Sheets. It makes **no Gemini, Codex, or other LLM calls**, performs no external company research and does not generate or send messages. You can use local Codex separately for research and writing.

## Workflow

```text
.env keywords → LinkedIn People Search → check SQLite
→ skip previously saved profiles → extract new profile details
→ save pending_sheet → publish Sheet row + link → mark done
```

`done` means successfully added to the Sheet, not contacted. There is no manual status marking. A failed Sheet write retries from the saved profile without reopening it. Previously collected profiles are skipped across keywords and connection degrees. Search result cards may appear again, but the profile itself is not revisited.

## Setup and commands

Configure `.env`:

```dotenv
LINKEDIN_SEARCH_KEYWORDS=founder,co-founder,CTO
LINKEDIN_CONNECTION_DEGREE=1
PROFILES_PER_RUN=15
MAX_SEARCH_PAGES=5
MAX_PROFILES_PER_RUN=50
GOOGLE_SHEET_ID=your_spreadsheet_id
GOOGLE_SHEET_TAB=Outreach
GOOGLE_APPLICATION_CREDENTIALS=./credentials.google.json
STATE_DIR=./.runtime
HEADLESS=false
DISPLAY=:99
```

The provided spreadsheet ID is already configured in this workspace. Enable Google Sheets API, save your service-account credentials locally and share the spreadsheet with its `client_email` as **Editor**. Do not make the Sheet public. No resume file or model API key is required. Any old Gemini key in the private `.env` is ignored; it is not sent anywhere.

```bash
npm install
npx playwright install chromium   # only if no installed executable is configured
npm run doctor
npm run sheets:init
npm run login                    # only when LinkedIn session is missing/expired
npm run collect
npm run sync                     # retry pending writes; no browser needed
npm run status
```

Headed mode is the default. The saved browser session lives in `.runtime/browser-state.json`. Login opens a browser on the configured display; after signing in, Ctrl+C saves the session and closes that window.

`PROFILES_PER_RUN=15` targets 15 new saved profiles, subject to matches, failures and scan budgets. `DRAFTS_PER_RUN` is recognized as a legacy fallback only. The old `drafts` command has been replaced by `collect`.

## Sheet contents

The bot fills:

- Name, Profile URL and visible Headline.
- About: separate About section text when available.
- Recent Post and Recent Post URL: first readable post shown in the profile activity or an observed owner-specific Posts page. This may be a pinned/reposted item; chronological freshness is not guaranteed. Private/missing content stays blank.
- Optional extraction failures do not discard the profile. Diagnostic details remain local in SQLite.
- Profile Text: captured text from the profile's primary content, bounded to 22,000 characters. It is not a verified or exhaustive resume.
- Companies (profile) and Company Links: visible company links from the profile. They can include past employers; they are not independently verified current-company information. Empty fields mean the page did not expose that information.
- Matched Keywords, Action Type, recipient-specific messaging/invitation URL, Send link, State and Added At.

**Final Message remains blank for new profiles.** Fill it yourself or through your separate local Codex workflow. The bot preserves manually edited messages. Existing generated drafts in older SQLite records remain available; no new ones are generated.

The Send hyperlink uses the current Final Message when available. It opens LinkedIn; you click the actual Send button yourself. An empty Final Message opens an empty composer. DM prefill was observed working on desktop LinkedIn, but it is not a guaranteed public API. If only a profile link is available, the profile opens instead. Invitation notes may require manual copy/paste. Use a browser signed into the intended account.

No Apps Script, email setup or approval/status trigger is needed. The Sheet uses 18 columns (A:R). Older 17/21-column profile tabs migrate automatically: DM Draft, Connection Note and Extraction Notes are removed when present, while retained cells and formulas shift together. Final Message is J, Send is K and Messaging URL is O. Conflicting headers or occupied new columns are not overwritten. Completed profiles are not revisited. SQLite history remains intact.

## SQLite: no server, URL or key

SQLite runs inside Node.js using `node:sqlite`. The app creates `.runtime/state.sqlite` automatically on its first workflow command. It needs **no API key, connection URL, subscription or separate database installation**. Only local filesystem permissions are needed.

The database stores discovered profiles, extracted details, pending Sheet writes, completion state, edited Final Message backups and errors. Keep this file to retain duplicate protection; deleting it loses that history. Back up while the app is stopped, or include its WAL files. A process lock prevents overlapping commands on the same database.

`pending_sheet` is saved before publishing. `done` is set only after the Sheet row and link are written successfully. If an append succeeded but the response was lost, the next sync finds the Record ID rather than blindly appending again. Per-profile extraction failures continue, even across multiple failed profiles. Login, verification/access blocks, invalid Sheet schema and global connection/setup errors can still stop the run with progress saved.

## Verification and private files

```bash
npm test
npm run check
```

Tests cover profile collection without an LLM, failed-write recovery, completion/deduplication, raw profile fields, blank/manual message columns, safe links and read-only browser extraction. Live Sheet access requires Google credentials and Editor permission.

`.env`, Google credentials, browser cookies and SQLite files are private/gitignored. Google credentials authenticate Sheets only; they are unrelated to SQLite. Existing candidate/resume files are no longer read by the collector.
