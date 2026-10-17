import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { executeCommand, run } from "../src/cli.mjs";
import { createDefaultConfig, initializeInstallation, loadConfig } from "../src/index.mjs";

const GiB = 1024 ** 3;
const resources = { cpuCount: 8, totalMemoryBytes: 32 * GiB, freeDiskBytes: 100 * GiB };
function capture() {
  let text = "";
  const stream = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
  return { stream, text: () => text };
}
async function fixture(t, { dockerMissing = false, engineCpuCount = 8, engineMemoryBytes = 32 * GiB } = {}) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const stdout = capture(), stderr = capture();
  const execute = async (spec, io = {}) => {
    calls.push(spec);
    if (spec.command === "docker" && dockerMissing) return 127;
    let output = "";
    if (spec.args[0] === "--version") output = "podman version 5.7.0";
    if (spec.args[0] === "version") output = JSON.stringify({ Client: { Version: "5.7.0" }, Server: { Version: "5.7.0" } });
    if (spec.args[0] === "info") output = JSON.stringify({
      version: { Version: "5.7.0" },
      host: { arch: "amd64", cpus: engineCpuCount, memTotal: engineMemoryBytes, serviceIsRemote: false, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"], security: { rootless: true } },
      store: { graphRoot: "/", graphRootAllocated: 100 * GiB, graphRootUsed: GiB }
    });
    if (spec.args[0] === "machine" && spec.args[1] === "list") output = JSON.stringify([{ Name: "synthetic-vm", Default: true, Running: true, CPUs: engineCpuCount, Memory: engineMemoryBytes, DiskSize: 100 * GiB, VMType: "qemu" }]);
    if (spec.args[0] === "machine" && spec.args[1] === "ssh") output = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda4 104857600 1048576 103809024 1% /";
    if (spec.args[0] === "compose" && spec.args.includes("version")) output = "Docker Compose version v2.38.2";
    if (spec.args[0] === "compose" && spec.args[1] === "ls") output = "[]";
    if (spec.args[0] === "compose" && spec.args.includes("--help")) output = "--wait  Wait for services to be running|healthy --wait-timeout timeout";
    if (spec.args[0] === "image" && spec.args.includes("inspect")) output = spec.args.includes("{{.Id}}") ? "a".repeat(64) : "[]";
    if (spec.args[0] === "system" && spec.args[1] === "df") output = "[]";
    if (spec.args.includes("psql") && spec.args.some(arg => arg.includes("pg_database_size"))) output = "1024";
    if (spec.args.includes("pg_dump")) output = "synthetic database dump";
    if (output) io.stdout?.write(`${output}\n`);
    return 0;
  };
  let podmanPrerequisites = 0;
  const options = {
    env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" }, platform: "linux",
    stdin: Readable.from([]), stdout: stdout.stream, stderr: stderr.stream,
    execute, inspectResources: async () => resources, prepareDockerPath: async () => {},
    ensureDocker: async () => { throw new Error("Docker bootstrap must not run for Podman"); },
    ensurePodman: async () => { podmanPrerequisites++; return { code: 0, reexecuted: false }; },
    request: async (url) => new Response(JSON.stringify(url.endsWith("/readyz") ? { ok: true } : { setupRequired: false, expiresAt: null }), { status: 200 }),
    sleep: async () => {}
  };
  return { root, calls, options, stdout, stderr, podmanPrerequisites: () => podmanPrerequisites };
}
function installArgs(extra = [], answers = {}) {
  return ["install", "--profile", "small", "--no-open", "--non-interactive", "--answers",
    JSON.stringify({ confirm: true, telemetry: false, open: false, ...answers }), ...extra];
}

test("explicit Podman install persists engine and never bootstraps Docker", async (t) => {
  const f = await fixture(t);
  assert.equal(await run(installArgs(["--engine", "podman"]), f.options), 0, f.stderr.text());
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.equal(f.podmanPrerequisites(), 1);
  const lifecycle = f.calls.filter((spec) => spec.args.includes("compose") && !spec.args.includes("version") && !spec.args.includes("--help"));
  assert.ok(lifecycle.length > 0);
  assert.ok(lifecycle.every((spec) => spec.command === "podman"));
  assert.ok(lifecycle.every((spec) => spec.env?.PODMAN_COMPOSE_PROVIDER === "docker-compose"));
});

test("answers can select Podman even when Docker is installed", async (t) => {
  const f = await fixture(t);
  assert.equal(await run(installArgs([], { engine: "podman" }), f.options), 0, f.stderr.text());
  assert.equal((await loadConfig(f.root)).engine, "podman");
});

test("noninteractive fresh install selects available Podman instead of installing absent Docker", async (t) => {
  const f = await fixture(t, { dockerMissing: true });
  assert.equal(await run(installArgs(), f.options), 0, f.stderr.text());
  assert.equal((await loadConfig(f.root)).engine, "podman");
});

test("a legacy Docker installation refuses an engine switch before commands or config repair", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { version: "1.1.5" });
  const before = await readFile(join(f.root, "config.json"), "utf8");
  await assert.rejects(run(installArgs(["--engine", "podman"]), f.options), /switch|different engine|migration/i);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), before);
  assert.equal(f.calls.length, 0);
});

test("Podman host-root is refused before creating installation state", async (t) => {
  const f = await fixture(t);
  const root = join(f.root, "uncreated");
  await assert.rejects(run(installArgs(["--engine", "podman", "--access", "host-root"]), {
    ...f.options, env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" }
  }), /Podman.*host-root|host-root.*Podman/i);
  await assert.rejects(stat(root), { code: "ENOENT" });
  assert.equal(f.calls.length, 0);
});

test("stored Podman engine controls lifecycle commands without a repeated flag", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { engine: "podman", version: "1.1.5", profile: "small" });
  for (const command of ["up", "down", "status", "logs", "backup"]) {
    assert.equal(await run([command], { ...f.options, stdin: Readable.from([]) }), 0);
  }
  assert.equal(f.calls.length, 5);
  assert.ok(f.calls.every((spec) => spec.command === "podman" && spec.args.includes(join(f.root, "compose.engine.yml"))));
});


test("fresh selection retains a working Docker engine", async (t) => {
  const f = await fixture(t);
  let dockerPrerequisites = 0;
  assert.equal(await run(installArgs(), { ...f.options, ensureDocker: async () => { dockerPrerequisites++; return { code: 0 }; } }), 0, f.stderr.text());
  assert.equal((await loadConfig(f.root)).engine ?? "docker", "docker");
  assert.equal(dockerPrerequisites, 1);
  assert.equal(f.podmanPrerequisites(), 0);
});

test("Podman Windows and invalid engine answers fail before probes or state writes", async (t) => {
  const f = await fixture(t);
  for (const [args, platform, pattern] of [
    [installArgs(["--engine=podman"]), "win32", /Podman.*Windows|Windows.*Podman/i],
    [installArgs([], {engine: "sh"}), "linux", /engine.*docker.*podman/i],
    [installArgs([], {engine: null}), "linux", /engine.*docker.*podman/i]
  ]) {
    await assert.rejects(run(args, { ...f.options, platform }), pattern);
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(stat(join(f.root, "config.json")), { code: "ENOENT" });
});

test("switch refusal precedes repair of incomplete legacy configuration", async (t) => {
  const f = await fixture(t);
  const raw = '{"version":"1.1.5"}';
  await writeFile(join(f.root, "config.json"), raw);
  await assert.rejects(run(installArgs([], {engine:"podman"}), f.options), /switch|migration/i);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), raw);
  assert.equal(f.calls.length, 0);
});

test("Podman local-images skips pull and disables startup downloads", async (t) => {
  const f = await fixture(t);
  assert.equal(await run(installArgs(["--engine=podman", "--local-images"]), f.options), 0, f.stderr.text());
  assert.ok(!f.calls.some(spec => spec.args.at(-1) === "pull"));
  const up = f.calls.find(spec => spec.args.includes("up") && !spec.args.includes("--help"));
  assert.equal(up.command, "podman");
  assert.ok(up.args.includes("never"));
});

test("doctor and support bundle report sanitized Podman facts", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { engine: "podman", version: "1.1.5", profile: "small" });
  assert.equal(await run(["doctor"], f.options), 0, f.stderr.text());
  assert.match(f.stdout.text(), /Podman.*5\.7\.0/);
  assert.match(f.stdout.text(), /Podman rootless.*Rootless/);
  assert.match(f.stdout.text(), /Podman cgroup.*v2/);
  assert.match(f.stdout.text(), /Podman CPU delegation.*available/);
  assert.match(f.stdout.text(), /Podman memory delegation.*available/);
  const destination = join(f.root, "support.json");
  assert.equal(await run(["support-bundle", "--out", destination], f.options), 0);
  const bundle = JSON.parse(await readFile(destination, "utf8"));
  assert.equal(bundle.engine.engine, "podman");
  assert.equal(bundle.engine.rootless, true);
  assert.equal(bundle.engine.cgroupVersion, "v2");
  assert.equal(bundle.engine.cpuLimitDelegated, true);
  assert.equal(bundle.engine.memoryLimitDelegated, true);
  assert.equal(bundle.engine.version, "5.7.0");
  assert.ok(!JSON.stringify(bundle).includes("/synthetic/podman"));
  assert.ok(!f.calls.some(spec => spec.command === "docker"));
});

test("doctor retains a valid stored Podman engine when unrelated configuration needs repair", async (t) => {
  const f = await fixture(t);
  const raw = JSON.stringify({ ...createDefaultConfig({ engine: "podman", version: "1.1.5", profile: "small" }),
    schemaVersion: 3, companionsEnabled: "false" });
  await writeFile(join(f.root, "config.json"), raw);
  assert.equal(await run(["doctor"], f.options), 1);
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every(spec => spec.command === "podman"));
  assert.match(f.stderr.text(), /FAIL Configuration:.*doctor --fix/);
  assert.match(f.stdout.text(), /Podman 5\.7\.0; rootless; cgroup v2; CPU delegation available; memory delegation available/);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), raw);
  assert.equal(f.podmanPrerequisites(), 0);
});

test("doctor refuses an unknown stored engine before executing commands", async (t) => {
  const f = await fixture(t);
  const raw = JSON.stringify({ ...createDefaultConfig({ version: "1.1.5", profile: "small" }), engine: "sh" });
  await writeFile(join(f.root, "config.json"), raw);
  await assert.rejects(run(["doctor"], f.options), /engine.*docker.*podman/i);
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), raw);
});

test("failed fresh Podman startup diagnoses and stops the attempted engine", async (t) => {
  const f = await fixture(t);
  const execute = async (spec, io) => {
    if (spec.args.includes("up") && !spec.args.includes("--help")) { f.calls.push(spec); return 9; }
    return f.options.execute(spec, io);
  };
  assert.equal(await run(installArgs(["--engine=podman"]), { ...f.options, execute }), 9);
  const runtime = f.calls.filter(spec => spec.args.includes("compose") && !spec.args.includes("version") && !spec.args.includes("--help"));
  assert.ok(runtime.some(spec => spec.args.includes("down")));
  assert.ok(runtime.some(spec => spec.args.includes("logs")));
  assert.ok(runtime.every(spec => spec.command === "podman"));
  await assert.rejects(stat(join(f.root, "config.json")), { code: "ENOENT" });
});

test("Podman update checkpoints the engine override and recovery retains the engine", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { engine: "podman", version: "1.1.5", profile: "small" });
  const execute = async (spec, io) => {
    if (spec.args.includes("up") && !spec.args.includes("--help") && !spec.args.includes("--wait")) { f.calls.push(spec); return 9; }
    return f.options.execute(spec, io);
  };
  assert.equal(await run(["update", "1.1.6", "--non-interactive", "--answers", '{"confirm":true}'], { ...f.options, execute }), 1);
  const checkpoints = await readdir(join(f.root, "checkpoints"));
  assert.equal(checkpoints.length, 1);
  const checkpoint = join(f.root, "checkpoints", checkpoints[0]);
  const manifest = JSON.parse(await readFile(join(checkpoint, "manifest.json"), "utf8"));
  assert.ok(manifest.files.some(file => file.path === "compose.engine.yml"));
  const recovery = JSON.parse(await readFile(join(checkpoint, "recovery.json"), "utf8"));
  assert.equal(recovery.databasePreserved, true);
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.ok(f.calls.every(spec => spec.command === "podman"));
});

test("Podman provider, credentials and owner commands retain engine", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { engine: "podman", version: "1.1.5", profile: "small" });
  for (const [args, input] of [
    [["provider", "install", "opencode"], ""],
    [["credentials", "set", "codex"], "synthetic-test-key\n"],
    [["owner", "reset-password"], "synthetic-test-password\n"],
    [["owner", "rotate-setup-token"], ""]
  ]) {
    assert.equal(await run(args, { ...f.options, stdin: Readable.from([input]) }), 0);
  }
  assert.ok(f.calls.length >= 4);
  assert.ok(f.calls.every(spec => spec.command === "podman"));
});

test("factory reset preserves the Podman engine", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, { engine: "podman", version: "1.1.5", profile: "small" });
  assert.equal(await run(["factory-reset"], { ...f.options, stdin: Readable.from(["FACTORY-RESET\n"]) }), 0);
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.ok(f.calls.every(spec => spec.command === "podman"));
});

test("Podman provider environment accepts only the pinned literal", async () => {
  await assert.rejects(executeCommand({ command: "podman", args: ["--version"], env: { PODMAN_COMPOSE_PROVIDER: "/tmp/arbitrary-command" } }), /untrusted.*environment/i);
});


for (const [memoryGiB, engineCpuCount, expectedProfile] of [[3, 4, "small"], [5, 4, "medium"], [7, 8, "large"], [7, 4, "medium"]]) {
  test(`macOS auto sizing respects ${engineCpuCount} VM CPUs and ${memoryGiB} GiB engine memory`, async (t) => {
    const f = await fixture(t, {engineCpuCount, engineMemoryBytes: memoryGiB * GiB});
    let prerequisiteProfile;
    assert.equal(await run(installArgs(["--engine=podman", "--profile=auto"]), {
      ...f.options, platform: "darwin", ensurePodman: async ({profile}) => { prerequisiteProfile = profile; return {code: 0}; }
    }), 0, f.stderr.text());
    assert.equal(prerequisiteProfile, "auto");
    assert.equal((await loadConfig(f.root)).profile, expectedProfile);
    assert.ok(!f.calls.some(spec => spec.command === "docker"));
  });
}

test("standalone Podman doctor fails insufficient VM allocation", async (t) => {
  const f = await fixture(t, {engineCpuCount: 4, engineMemoryBytes: 3 * GiB});
  await initializeInstallation(f.root, {engine: "podman", version: "1.1.5", profile: "large"});
  assert.equal(await run(["doctor"], {...f.options, platform: "darwin"}), 1);
  assert.match(f.stderr.text(), /FAIL Podman memory.*3 GiB allocated.*7 GiB required/);
  assert.match(f.stderr.text(), /FAIL Podman CPU.*4 allocated.*8 required/);
  assert.match(f.stderr.text(), /podman machine set --cpus.*--memory.*--disk-size/);
});

test("a successful Podman upgrade and rollback preserve engine and checkpoint files", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, {engine: "podman", version: "1.1.5", profile: "small"});
  assert.equal(await run(["update", "1.1.6", "--non-interactive", "--answers", '{"confirm":true}'], f.options), 0, f.stderr.text());
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.equal((await loadConfig(f.root)).version, "1.1.6");
  const [checkpointId] = await readdir(join(f.root, "checkpoints"));
  assert.ok(await stat(join(f.root, "checkpoints", checkpointId, "verified.json")));
  assert.ok(await stat(join(f.root, "checkpoints", checkpointId, "compose.engine.yml")));
  assert.equal(await run(["rollback", "--non-interactive", "--answers", '{"confirm":true}'], {...f.options, stdin: Readable.from([])}), 0);
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.equal((await loadConfig(f.root)).version, "1.1.5");
  assert.ok(f.calls.every(spec => spec.command === "podman"));
});

test("Podman doctor fix, repair and reinstall retain engine", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, {engine: "podman", version: "1.1.5", profile: "small"});
  for (const args of [["doctor", "--fix"], ["repair"], ["reinstall"]]) {
    assert.equal(await run([...args, "--non-interactive", "--answers", '{"confirm":true}'], {...f.options, stdin: Readable.from([])}), 0, f.stderr.text());
  }
  assert.equal((await loadConfig(f.root)).engine, "podman");
  assert.equal(f.podmanPrerequisites(), 2);
  assert.ok(f.calls.every(spec => spec.command === "podman"));
});

test("Podman restore and uninstall retain engine through every Compose action", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, {engine: "podman", version: "1.1.5", profile: "small"});
  await mkdir(join(f.root, "backups", "spaceapp-backup-20260723T120000000Z"));
  assert.equal(await run(["restore"], {...f.options, stdin: Readable.from(["RESTORE\n"])}), 0);
  assert.equal(await run(["uninstall", "--non-interactive", "--answers", '{"confirm":true}'], {...f.options, stdin: Readable.from([])}), 0);
  assert.equal(await run(["uninstall", "--purge-data"], {...f.options, stdin: Readable.from(["DELETE\n"])}), 0);
  assert.ok(f.calls.some(spec => spec.args.includes("scripts/portable-restore.mjs")));
  assert.ok(f.calls.some(spec => spec.args.includes("--volumes")));
  assert.ok(f.calls.every(spec => spec.command === "podman"));
});

test("Podman engine cannot be switched to Docker through answers", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, {engine: "podman", version: "1.1.5", profile: "small"});
  const before = await readFile(join(f.root, "config.json"), "utf8");
  await assert.rejects(run(installArgs([], {engine:"docker"}), f.options), /switch|migration/i);
  assert.equal(await readFile(join(f.root, "config.json"), "utf8"), before);
  assert.equal(f.calls.length, 0);
});

test("Docker support facts retain unknown values without copying raw engine configuration", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, {version: "1.1.5", profile: "small"});
  const destination = join(f.root, "docker-support.json");
  assert.equal(await run(["support-bundle", "--out", destination], f.options), 0);
  const bundle = JSON.parse(await readFile(destination, "utf8"));
  assert.equal(bundle.engine.engine, "docker");
  assert.equal(bundle.engine.rootless, null);
  assert.equal(bundle.engine.cpuLimitDelegated, null);
  assert.equal(bundle.engine.memoryLimitDelegated, null);
  assert.equal(bundle.engine.version, null);
  assert.ok(!JSON.stringify(bundle.engine).includes("graphRoot"));
});


test("fresh interactive selection offers the installed Podman engine", async (t) => {
  const f = await fixture(t, {dockerMissing: true});
  const stdin = Readable.from(["\n"]);
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  assert.equal(await run(["install", "--no-open", "--answers", JSON.stringify({confirm:true, profile:"small", access:"isolated", companions:false, telemetry:false, open:false})], {
    ...f.options, stdin
  }), 0, f.stderr.text());
  assert.match(f.stdout.text(), /Docker is unavailable.*installed Podman/);
  assert.equal((await loadConfig(f.root)).engine, "podman");
});

test("explicit engine flag overrides a different answers engine", async (t) => {
  const f = await fixture(t);
  assert.equal(await run(installArgs(["--engine=podman"], {engine:"docker"}), f.options), 0, f.stderr.text());
  assert.equal((await loadConfig(f.root)).engine, "podman");
});

test("Podman doctor reports unknown delegation without claiming it is available", async (t) => {
  const f = await fixture(t);
  await initializeInstallation(f.root, {engine:"podman", version:"1.1.5", profile:"small"});
  const execute = async (spec, io = {}) => {
    if (spec.args[0] === "info") {
      f.calls.push(spec);
      io.stdout?.write(JSON.stringify({version:{Version:"5.7.0"}, host:{arch:"amd64", cpus:8, memTotal:32*GiB, serviceIsRemote:false, cgroupVersion:"v2", security:{rootless:true}}, store:{graphRoot:"/"}}));
      return 0;
    }
    return f.options.execute(spec, io);
  };
  assert.equal(await run(["doctor"], {...f.options, execute}), 1);
  assert.match(f.stdout.text(), /CPU delegation unknown; memory delegation unknown/);
  assert.match(f.stderr.text(), /CPU limits are not delegated/);
  assert.match(f.stderr.text(), /Memory limits are not delegated/);
});

test("automatic selection prepares the existing Docker CLI path before preferring Podman", async (t) => {
  const f = await fixture(t);
  let pathPrepared = false;
  let dockerPrerequisites = 0;
  const execute = async (spec, io) => spec.command === "docker" && !pathPrepared ? 127 : f.options.execute(spec, io);
  assert.equal(await run(installArgs(), { ...f.options, execute,
    prepareDockerPath: async () => { pathPrepared = true; },
    ensureDocker: async () => { dockerPrerequisites++; return {code:0}; }
  }), 0, f.stderr.text());
  assert.equal((await loadConfig(f.root)).engine, "docker");
  assert.equal(dockerPrerequisites, 1);
  assert.equal(f.podmanPrerequisites(), 0);
});
