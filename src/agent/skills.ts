/**
 * Agent skills (docs/specs/SPEC-use-agent.md §7): instructions in the open
 * Agent Skills format — a folder holding a `SKILL.md` whose frontmatter has
 * `name` and `description`. Not Steptix skills, the step macros `[skill: …]`
 * calls.
 *
 * Project only: never `~/.agents`, `~/.claude` or anywhere else on the
 * machine, so a test behaves the same on every machine.
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

export interface AgentSkill {
  name: string;
  description: string;
  /** Absolute path of the `SKILL.md`. */
  path: string;
}

export interface SkillDiscovery {
  skills: AgentSkill[];
  /** One line per `SKILL.md` that was skipped, and why. */
  warnings: string[];
}

/**
 * Every skill one level under `dir`: `<dir>/<folder>/SKILL.md`. A missing
 * folder is no skills, and says nothing (§7, "None at all").
 */
export function discoverSkills(dir: string): SkillDiscovery {
  const out: SkillDiscovery = { skills: [], warnings: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const seen = new Set<string>();
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    let data: Record<string, unknown>;
    try {
      data = matter(fs.readFileSync(file, 'utf8')).data as Record<string, unknown>;
    } catch (err) {
      out.warnings.push(`${file}: its frontmatter could not be read (${err instanceof Error ? err.message : String(err)}); skipped.`);
      continue;
    }
    const name = typeof data['name'] === 'string' && data['name'].trim() !== '' ? data['name'].trim() : e.name;
    const description = typeof data['description'] === 'string' ? data['description'].trim() : '';
    if (description === '') {
      out.warnings.push(`${file}: no description in its frontmatter, so the agent could not tell when to use it; skipped.`);
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      out.warnings.push(`${file}: a second skill named "${name}"; skipped.`);
      continue;
    }
    seen.add(name.toLowerCase());
    out.skills.push({ name, description, path: file });
  }
  return out;
}

/** The body of a skill, frontmatter removed. */
export function loadSkillBody(skill: AgentSkill): string {
  return matter(fs.readFileSync(skill.path, 'utf8')).content.trim();
}

/** The skill named `name`, case-insensitively. */
export function findSkill(skills: readonly AgentSkill[], name: string): AgentSkill | undefined {
  const wanted = name.trim().toLowerCase();
  return skills.find((s) => s.name.toLowerCase() === wanted);
}
