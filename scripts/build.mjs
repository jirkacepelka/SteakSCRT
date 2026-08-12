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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = join(ROOT, "artifacts");
const TOKEN_DIR = join(ROOT, "contracts", "lst-token");

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

/**
 * Run the optimizer over one cargo project.
 *
 * `dir` is mounted at /contract. The image builds with
 * `cargo build --release --lib --locked`, runs `wasm-opt -Oz` over every cdylib it
 * produced, and gzips the results into ./optimized-wasm.
 *
 * Named volumes keep the registry and target caches across runs; without them every build
 * re-downloads and re-compiles the full dependency tree. The cache volume is per-project
 * because the workspace and the vendored token pin different dependency versions.
 */
function runOptimizer(dir, cacheKey) {
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${dir}:/contract`,
      "-v",
      `secret_lst_cache_${cacheKey}:/contract/target`,
      "-v",
      "secret_lst_registry:/usr/local/cargo/registry",
      OPTIMIZER_IMAGE,
    ],
    { stdio: "inherit" },
  );
}

/** Move whatever the optimizer staged in `dir` into artifacts/. */
function collect(dir) {
  const staging = join(dir, "optimized-wasm");
  let produced = [];
  try {
    produced = readdirSync(staging).filter((f) => f.endsWith(".wasm.gz"));
  } catch {
    return [];
  }

  for (const file of produced) {
    const dest = join(ARTIFACTS, file);
    renameSync(join(staging, file), dest);
    const kb = (statSync(dest).size / 1024).toFixed(1);
    console.log(`  artifacts/${file}  (${kb} KiB)`);
  }

  rmSync(staging, { recursive: true, force: true });
  return produced;
}

function build() {
  mkdirSync(ARTIFACTS, { recursive: true });

  console.log(`Building contracts with ${OPTIMIZER_IMAGE} ...`);
  runOptimizer(ROOT, "workspace");
  const produced = collect(ROOT);

  // The derivative token is the upstream SNIP-20 reference implementation, unmodified.
  // It is a separate cargo project with its own pinned dependencies, so it gets its own
  // optimizer run rather than being pulled into this workspace.
  if (existsSync(join(TOKEN_DIR, "Cargo.toml"))) {
    console.log("Building the derivative token (vendored SNIP-20) ...");
    runOptimizer(TOKEN_DIR, "token");
    produced.push(...collect(TOKEN_DIR));
  } else {
    console.warn(
      [
        "",
        "Skipping the derivative token: contracts/lst-token is empty.",
        "Initialise the submodule with `git submodule update --init --recursive`.",
      ].join("\n"),
    );
  }

  if (produced.length === 0) {
    console.error(
      [
        "The optimizer produced no .wasm.gz files.",
        "",
        "The usual cause is that no workspace member is a cdylib: only crates with",
        '`crate-type = ["cdylib", "rlib"]` compile to wasm. Check the build output above.',
      ].join("\n"),
    );
    process.exit(1);
  }
}

assertDockerRunning();
build();
