---
tags: [upload]
---

# SecureBank Document Upload

Drives the Documents page of the fixture app (`fixtures/test-app`, port 8787)
with file-upload steps. A step path like `\attachments\logo.png` resolves
against this file's folder, so the files are in `tests/attachments/`.

This is the acceptance test for [stories/upload-action.md](../../../stories/upload-action.md).
It exercises all three uploaders on the Documents page: a plain file field, a
styled button whose input is hidden, and a multi-file field — plus a rejected
file type and a path that arrives through a `{{parameter}}` written with
backslashes.

## Parameters
- statement: \attachments\statement.pdf

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to documents.html
2. Reject non-essential cookies in the cookie banner
3. Click "Clear all"
4. Upload file \attachments\logo.png as the statement, then click Upload
5. Assert that the status message says "Uploaded logo.png"
6. Use the Choose file button under "Proof of identity" to upload \attachments\statement.pdf, then click Upload
7. Assert that the uploaded documents table lists statement.pdf
8. Attach \attachments\receipt-1.png and \attachments\receipt-2.png as receipts, then click "Upload all"
9. Assert that the status message says "Uploaded 2 files"
10. Count the rows in the uploaded documents table [as: document_count]
11. Assert that {{document_count}} equals 4
12. Upload file \attachments\malware.exe as the statement, then click Upload
13. Assert that the status message says "malware.exe is not an allowed file type"
14. Upload file {{statement}} as the statement, then click Upload
