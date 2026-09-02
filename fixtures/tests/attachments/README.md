# Attachments

Sample files for upload steps (stories/file-upload-steps.md). A step path like
`attachmentslogo.png` resolves against the folder of the test file that
uses it, so these live beside the tests.

| File | What it is for |
|---|---|
| `logo.png` | a tiny 16×16 PNG, the everyday single-file upload |
| `statement.pdf` | a one-line PDF for the "statement" field |
| `receipt-1.png`, `receipt-2.png` | two distinct PNGs for a multi-file upload |
| `notes.txt` | a plain-text file, also on the allow-list |
| `malware.exe` | plain text with a disallowed extension — the server rejects it by name |

Files over the 1 MB limit are generated at test time, not committed.
