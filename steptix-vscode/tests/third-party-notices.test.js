import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  packageRootOf,
  bundledPackageRoots,
  describePackages,
  isAllowedLicense,
  renderNotices,
} from "../scripts/third-party-notices.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/third-party-notices.mjs", import.meta.url));

const made = [];
after(() => {
  for (const dir of made) {
    // Unlink junctions first so the recursive delete cannot follow them.
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
    }
    // maxRetries: on Windows antivirus or the indexer can still hold a file a
    // child just wrote (THIRD-PARTY-NOTICES.txt), and `force` does not cover
    // EBUSY/EPERM — a throw here would fail the file for a cleanup reason.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * A fake extension tree: node_modules packages plus a bundle map in
 * dist/assets whose sources point at them the way Vite and esbuild write
 * them — relative to the map file.
 */
function fixture({ packages, sources }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steptix-notices-"));
  made.push(root);
  for (const p of packages) {
    const dir = path.join(root, "node_modules", ...p.name.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: p.name, version: p.version ?? "1.0.0", license: p.license ?? "MIT" }),
    );
    for (const [file, text] of Object.entries(p.files ?? { LICENSE: `${p.name} licence text` })) {
      fs.writeFileSync(path.join(dir, file), text);
    }
  }
  const assets = path.join(root, "dist", "assets");
  fs.mkdirSync(assets, { recursive: true });
  const mapFile = path.join(assets, "index.js.map");
  fs.writeFileSync(mapFile, JSON.stringify({ version: 3, sources }));
  fs.writeFileSync(path.join(assets, "index.js"), "/* bundle */");
  return { root, mapFile, dist: path.join(root, "dist") };
}

function runScript(scriptPath, dist) {
  return spawnSync(process.execPath, [scriptPath, dist], { encoding: "utf8" });
}

test("a source under node_modules maps to its package root; scoped and nested too", () => {
  const sep = path.sep;
  assert.equal(packageRootOf(`a${sep}node_modules${sep}react${sep}index.js`), `a${sep}node_modules${sep}react`);
  assert.equal(
    packageRootOf(`a${sep}node_modules${sep}@scope${sep}pkg${sep}lib${sep}x.js`),
    `a${sep}node_modules${sep}@scope${sep}pkg`,
  );
  assert.equal(
    packageRootOf(`a${sep}node_modules${sep}outer${sep}node_modules${sep}inner${sep}x.js`),
    `a${sep}node_modules${sep}outer${sep}node_modules${sep}inner`,
  );
  assert.equal(packageRootOf(`a${sep}runner-core${sep}src${sep}x.ts`), null);
});

test("lists every bundled package once, with its licence text, and skips our own code", () => {
  const { mapFile } = fixture({
    packages: [
      { name: "react", version: "18.3.1" },
      { name: "@scope/util", version: "2.0.0", license: "ISC" },
      { name: "steptix-runner-core" },
    ],
    sources: [
      "../../node_modules/react/index.js",
      "../../node_modules/react/cjs/react.production.js",
      "../../node_modules/@scope/util/lib/a.js",
      "../../node_modules/steptix-runner-core/dist/errors.js",
      "../../src/main.tsx",
    ],
  });
  const packages = describePackages(bundledPackageRoots([mapFile]));
  assert.deepEqual(packages.map((p) => `${p.name}@${p.version} ${p.license}`), [
    "@scope/util@2.0.0 ISC",
    "react@18.3.1 MIT",
  ]);
  const text = renderNotices(packages);
  assert.match(text, /react 18\.3\.1 \(MIT\)/);
  assert.match(text, /react licence text/);
  assert.match(text, /@scope\/util licence text/);
  assert.doesNotMatch(text, /steptix-runner-core/);
});

test("a NOTICE file is carried after the LICENSE, as Apache-2.0 requires", () => {
  const { mapFile } = fixture({
    packages: [{
      name: "apache-lib",
      license: "Apache-2.0",
      files: { NOTICE: "notice text", LICENSE: "apache terms" },
    }],
    sources: ["../../node_modules/apache-lib/index.js"],
  });
  const [p] = describePackages(bundledPackageRoots([mapFile]));
  assert.deepEqual(p.texts.map((t) => t.file), ["LICENSE", "NOTICE"]);
});

test("a bundled package with no licence file stops the build", () => {
  const { mapFile } = fixture({
    packages: [{ name: "bare", files: {} }],
    sources: ["../../node_modules/bare/index.js"],
  });
  assert.throws(() => describePackages(bundledPackageRoots([mapFile])), /bare@1\.0\.0 has no LICENSE file/);
});

test("a licence outside the allowed list stops the build, naming it", () => {
  const { mapFile } = fixture({
    packages: [{ name: "copyleft", license: "GPL-3.0" }],
    sources: ["../../node_modules/copyleft/index.js"],
  });
  assert.throws(
    () => describePackages(bundledPackageRoots([mapFile])),
    /copyleft@1\.0\.0 is licensed "GPL-3\.0", which is not on the allowed list/,
  );
});

test("an OR expression passes when one alternative is allowed; AND and unknowns do not", () => {
  assert.equal(isAllowedLicense("(MIT OR Apache-2.0)"), true);
  assert.equal(isAllowedLicense("GPL-3.0 OR MIT"), true);
  assert.equal(isAllowedLicense("MIT AND GPL-3.0"), false);
  assert.equal(isAllowedLicense("SEE LICENSE IN LICENSE.txt"), false);
  assert.equal(isAllowedLicense("UNKNOWN"), false);
});

test("the script, run as a program, writes the notices into the dist it is given", () => {
  const { dist } = fixture({
    packages: [{ name: "react", version: "18.3.1" }],
    sources: ["../../node_modules/react/index.js"],
  });
  const r = runScript(SCRIPT, dist);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(dist, "THIRD-PARTY-NOTICES.txt"), "utf8"), /react 18\.3\.1 \(MIT\)/);
});

test("the script still runs when started through a junction or symlink to it", (t) => {
  // The ESM loader realpaths import.meta.url but argv keeps the typed path;
  // a naive comparison skipped the write and exited 0.
  const { root, dist } = fixture({
    packages: [{ name: "react" }],
    sources: ["../../node_modules/react/index.js"],
  });
  const link = path.join(root, "scripts-link");
  try {
    fs.symlinkSync(path.dirname(SCRIPT), link, "junction");
  } catch (err) {
    t.skip(`cannot create a link here: ${err.message}`);
    return;
  }
  const r = runScript(path.join(link, path.basename(SCRIPT)), dist);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dist, "THIRD-PARTY-NOTICES.txt")), "notices written");
});

test("a file in dist that no source map accounts for stops the build, naming it", () => {
  const { dist } = fixture({
    packages: [{ name: "react" }],
    sources: ["../../node_modules/react/index.js"],
  });
  fs.writeFileSync(path.join(dist, "assets", "codicon.ttf"), "font");
  const r = runScript(SCRIPT, dist);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no source map accounts for[\s\S]*codicon\.ttf/);
  assert.equal(fs.existsSync(path.join(dist, "THIRD-PARTY-NOTICES.txt")), false);
});
