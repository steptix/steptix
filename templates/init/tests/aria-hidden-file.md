---
tags: [live-integration, aria]
---

# Aria snapshot — hidden file input

Fixture for `aria-edge-cases.test.cjs`. Proof of identity on the Documents
page is a Choose file button whose `<input type="file">` is hidden. The file
`\attachments\logo.png` resolves against this file's folder.

## Config
- baseUrl: http://localhost:8787/

## Steps
1. Navigate to documents.html
2. Reject non-essential cookies in the cookie banner
3. Click "Clear all"
4. Use the Choose file button under "Proof of identity" to upload \attachments\logo.png, then click Upload
5. Assert that the uploaded documents table lists logo.png
