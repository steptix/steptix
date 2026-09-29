import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  packageRootOf,
  bundledPackageRoots,
  describePackages,
  renderNotices,
} from "../scripts/third-party-notices.mjs";

/**
 * A fake extension tree: node_modules packages plus a bundle map in
 * dist/assets whose sources point at them the way Vite and esbuild write
 * them — relative to the map file.
 */
function fixture({ packages, sources }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steptix-notices-"));
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
  return { root, mapFile };
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
