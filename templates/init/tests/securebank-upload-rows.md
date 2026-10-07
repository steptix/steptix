---
tags: [upload, rows]
---

# SecureBank document upload, one file at a time

Drives the Documents page of the fixture app (`fixtures/test-app`, port 8787)
with a section that loops over a data table (stories/data-driven-rows.md,
part B). The table under `### Upload each statement` makes step 4 run that
section's body once per row, in the same browser, so step 6 can count the
three rows the loop left behind.

Unlike `securebank-matrix.md`, whose table sits under `## Steps` and starts
every row in a fresh browser, this is the "sign in once, then try each
thing" shape: steps 1–3 run once, the section runs three times, steps 5–6
run once. The page's status line carries a size suffix (`Uploaded logo.png
(87 B)`), hence "starts with".

No row is meant to fail: a failed iteration ends the run there, which is
part B's rule. All three files live under `tests/attachments/` and are
allowed types.

Choosing the file and clicking Upload are two steps, not one. A step that
says "upload, then click Upload" needs a second turn, and gets one only if
the model's answer to the first says so. When it does not, the step passes
having chosen the file and never clicked, and the assertion reads the
previous iteration's status line (`Uploaded logo.png` on row 2).

The cookie banner is remembered in `localStorage`, so step 2 has a banner to
reject on a fresh browser and none on a re-run in the same one — which is
what Run This Row on the section table does. Hence the `If`.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to documents.html
2. If the cookie banner is shown, then Reject non-essential cookies in the cookie banner
3. Click "Clear all"
4. Upload each statement
5. Count the rows in the uploaded documents table [as: document_count]
6. Assert that {{document_count}} equals 3

### Upload each statement
| file                       | status                 |
|----------------------------|------------------------|
| \attachments\logo.png      | Uploaded logo.png      |
| \attachments\statement.pdf | Uploaded statement.pdf |
| \attachments\receipt-1.png | Uploaded receipt-1.png |
1. Choose the file {{file}} in the statement file field
2. Click the Upload button in the statement card
3. Assert that the status message starts with "{{status}}"
