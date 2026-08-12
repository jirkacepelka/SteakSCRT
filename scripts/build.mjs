#!/usr/bin/env node
/**
 * Builds the contracts into deployable `.wasm.gz` artifacts.
 *
 * Everything that ends up on-chain is compiled inside SCRT Labs' optimizer image, never
 * with the host toolchain. That is not ceremony:
 *
 *   Rust 1.82 turned on the `reference-types` and `multivalue` wasm proposals by default.
 *   Secret's wasm engine rejects both, so a contract built with a modern host toolchain
 *   uploads and then fails validation with a misleading "zero byte expected" error. The
 *   optimizer image pins a toolchain from before that change, which sidesteps the whole
 *   problem and makes the artifact byte-reproducible for auditors at the same time.
 *
 * The host toolchain is still used for `cargo test`, `clippy` and schema generation —
 * none of those produce wasm.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = join(ROOT, "artifacts");

/** Pinned deliberately: bumping this changes the bytecode hash of every contract. */
const OPTIMIZER_IMAGE = "ghcr.io/scrtlabs/secret-contract-optimizer:1.0.13";

function assertDockerRunning() {
  const probe = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    shell: false,
  });

  if (probe.error || probe.status !== 0) {
    console.error(
      [
        "Docker is not reachable.",
        "",
        "Contract wasm must be built inside the pinned optimizer image — building with",
        "the host toolchain produces a binary Secret's wasm engine will reject.",
        "",
        "Start Docker Desktop (or the docker daemon) and re-run `npm run build`.",
      ].join("\n"),
    );
    process.exit(1);
  }
}

function build() {
  mkdirSync(ARTIFACTS, { recursive: true });

  console.log(`Building contracts with ${OPTIMIZER_IMAGE} ...`);

  // The optimizer compiles every cdylib member of the workspace mounted at /contract,
  // runs wasm-opt -Oz over each, and gzips the result.
  //
  // Named volumes keep the registry and target caches across runs; without them every
  // build re-downloads and re-compiles the full dependency tree.
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${ROOT}:/contract`,
      "-v",
      "secret_lst_cache:/contract/target",
      "-v",
      "secret_lst_registry:/usr/local/cargo/registry",
      OPTIMIZER_IMAGE,
    ],
    { stdio: "inherit" },
  );

  const produced = readdirSync(ROOT).filter((f) => f.endsWith(".wasm.gz"));
  if (produced.length === 0) {
    console.error(
      "The optimizer produced no .wasm.gz files. Check the build output above.",
    );
    process.exit(1);
  }

  for (const file of produced) {
    renameSync(join(ROOT, file), join(ARTIFACTS, file));
    console.log(`  artifacts/${file}`);
  }

  const checksums = join(ROOT, "checksums.txt");
  if (existsSync(checksums)) {
    renameSync(checksums, join(ARTIFACTS, "checksums.txt"));
    console.log("  artifacts/checksums.txt");
  }
}

assertDockerRunning();
build();
