// Multi-tool file via named exports. Each export key serves as the tool
// name — no `tool('name', ...)` repetition needed.
import { tool } from 'steptix/tools';

export const slugify = tool<{ s: string }>(({ s }) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
);

export const upper = tool<{ s: string }>(({ s }) => s.toUpperCase());
