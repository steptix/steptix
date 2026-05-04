// Rung 1 — bare function. Filename becomes the tool name (`uuid`).
// Returned value is captured as the single output `{{uuid}}`.
import crypto from 'node:crypto';

export default () => crypto.randomUUID();
