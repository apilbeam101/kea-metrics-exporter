import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildTestImage, docker, dockerAvailable, TEST_IMAGE } from "../../support/docker.ts";

const SENTINEL = `kea-hygiene-sentinel-${process.pid}`;

// Each file is named to match a .dockerignore pattern. If any of them reached
// the image, its sentinel would appear in a saved layer.
const PLANTED = [
  `.env.hygiene-${process.pid}`,
  `hygiene-${process.pid}.pem`,
  `kea-password-hygiene-${process.pid}.txt`,
  join("scratch", `hygiene-${process.pid}.env`),
];

describe("docker image hygiene", { skip: !dockerAvailable() && "docker is not available" }, () => {
  const tarPath = join(process.cwd(), ".test-tmp", `image-${process.pid}.tar`);

  before(() => {
    mkdirSync(join(process.cwd(), ".test-tmp"), { recursive: true });
    mkdirSync(join(process.cwd(), "scratch"), { recursive: true });
    for (const file of PLANTED) writeFileSync(join(process.cwd(), file), `${SENTINEL}\n`);
    try {
      buildTestImage();
    } finally {
      for (const file of PLANTED) rmSync(join(process.cwd(), file), { force: true });
    }
    docker(["save", "-o", tarPath, TEST_IMAGE]);
  });

  after(() => rmSync(tarPath, { force: true }));

  it("contains no planted secret from the build context", () => {
    assert.equal(readFileSync(tarPath).includes(SENTINEL), false);
  });

  it("contains no source, tests, docs, scratch or key material", () => {
    const listing = docker([
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      TEST_IMAGE,
      "-c",
      "find /app -path /app/node_modules -prune -o -print",
    ]);
    for (const forbidden of [
      "/app/src",
      "/app/test",
      "/app/docs",
      "/app/scratch",
      ".pem",
      ".env",
    ]) {
      assert.equal(listing.includes(forbidden), false, forbidden);
    }
    assert.ok(listing.includes("/app/dist/index.js"));
  });

  it("runs as the fixed non-root user", () => {
    assert.equal(docker(["run", "--rm", "--entrypoint", "id", TEST_IMAGE, "-u"]).trim(), "10001");
  });
});
