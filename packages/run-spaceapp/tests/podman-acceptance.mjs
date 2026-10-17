// Opt-in real-engine proof. This file is deliberately outside the unit-test glob.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { composeCommand, composeProjectName } from "../src/index.mjs";
import { RUNTIME_VERSION } from "../src/package-info.mjs";
import { probeEngineInfo } from "../src/prerequisites.mjs";

function options(args) {
  const result = { profile: "small", sourceVersion: RUNTIME_VERSION };
  const names = { "--profile": "profile", "--source-version": "sourceVersion", "--target-version": "targetVersion", "--state-file": "stateFile", "--cleanup": "cleanup" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--self-test") result.selfTest = true;
    else if (names[args[i]] && args[i + 1] && !args[i + 1].startsWith("--")) result[names[args[i]]] = args[++i];
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  assert(["small", "medium", "large"].includes(result.profile), "Expected --profile small|medium|large");
  for (const version of [result.sourceVersion, result.targetVersion].filter(Boolean)) {
    assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), "Expected a published runtime version");
  }
  if (result.stateFile) result.stateFile = resolve(result.stateFile);
  return result;
}

async function withCleanup(work, cleanup) {
  let failure;
  try { await work(); } catch (error) { failure = error; }
  try { await cleanup(); } catch (error) {
    if (failure) throw new AggregateError([failure, error], `${failure.message}; cleanup: ${error.message}`);
    throw error;
  }
  if (failure) throw failure;
}

let activeChild;
let interrupted = false;
function interrupt() {
  interrupted = true;
  if (activeChild?.pid) {
    try { process.kill(-activeChild.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

async function command(program, args, { env = process.env, input = "", allowFailure = false, cleanup = false, timeoutMs = 15 * 60_000 } = {}) {
  if (interrupted && !cleanup) throw new Error("Acceptance interrupted; cleaning up");
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    activeChild = child;
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") reject(error); }
    }, timeoutMs);
    child.stdout.on("data", (data) => { stdout = (stdout + data).slice(-1024 * 1024); });
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-1024 * 1024); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.once("error", (error) => { clearTimeout(timer); activeChild = null; reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      activeChild = null;
      if (code !== 0 && !allowFailure) {
        // Successful install output contains a setup token; never log its stdout.
        const safeError = stderr.replace(/^.*(?:setup.?token|password|secret|postgres(?:ql)?:\/\/).*$/gim, "[redacted]").slice(-12_000);
        reject(new Error(`${basename(program)} ${args[0]} failed (${signal ?? code}): ${safeError}`));
      } else resolvePromise({ code, stdout, stderr });
    });
  });
}

async function cleanupState(stateFile) {
  let state;
  try { state = JSON.parse(await readFile(stateFile, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const { root, project } = state;
  assert.equal(dirname(root), homedir(), "Cleanup accepts only a fresh home-owned acceptance directory");
  assert(basename(root).startsWith(".spaceapp-podman-acceptance-"));
  assert.equal(composeProjectName(join(root, "installation")), project);
  assert.equal((await stat(root)).uid, process.getuid());
  const podman = (args) => command("podman", args, { cleanup: true, timeoutMs: 60_000 });
  const failures = [];
  // Compose labels scope every removal to this fresh installation, including after partial startup.
  for (const [kind, list, remove] of [
    ["containers", ["ps", "-aq"], ["rm", "--force"]],
    ["volumes", ["volume", "ls", "-q"], ["volume", "rm"]],
    ["networks", ["network", "ls", "-q"], ["network", "rm"]]
  ]) {
    try {
      const find = [...list, "--filter", `label=com.docker.compose.project=${project}`];
      const names = (await podman(find)).stdout.trim().split(/\s+/).filter(Boolean);
      assert(names.every((name) => /^[a-zA-Z0-9_.-]+$/.test(name)), `Invalid ${kind} from Podman`);
      if (names.length) await podman([...remove, ...names]);
      assert.equal((await podman(find)).stdout.trim(), "", `Project ${kind} remain`);
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, `Cleanup failed; retry with --cleanup ${stateFile}`);
  await rm(root, { recursive: true, force: true });
  await rm(stateFile, { force: true });
}

async function portAvailable() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(4911, "127.0.0.1", resolvePromise);
  });
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

async function readiness() {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Acceptance interrupted");
    try {
      const response = await fetch("http://127.0.0.1:4911/readyz", { signal: AbortSignal.timeout(5000) });
      const body = await response.json();
      if (response.ok && body.ok === true) {
        assert((await fetch("http://127.0.0.1:4911/", { signal: AbortSignal.timeout(5000) })).ok, "Web app must answer");
        return;
      }
    } catch {}
    await delay(1000);
  }
  throw new Error("/readyz did not report ok within ten minutes");
}

function kernelFactText(value) {
  return typeof value === "string" ? value.replaceAll(String.fromCharCode(0), "").trim() : null;
}

function workspaceInspectFacts(data, workspace) {
  const text = (value) => typeof value === "string" && /^[a-zA-Z0-9_:,.=/-]{0,512}$/.test(value) ? value : null;
  const mappings = (value) => Array.isArray(value) ? value.filter(item => typeof item === "string" && /^\d+:\d+:\d+$/.test(item)).slice(0, 8) : null;
  const mount = data.mounts?.find(item => item.Destination === workspace.containerPath);
  return {
    usernsMode: text(data.userns), user: text(data.user), processLabel: text(data.processLabel), mountLabel: text(data.mountLabel),
    uidMap: mappings(data.idMappings?.UidMap), gidMap: mappings(data.idMappings?.GidMap),
    mount: mount ? {
      sourceMatches: mount.Source === workspace.hostPath, type: text(mount.Type), rw: typeof mount.RW === "boolean" ? mount.RW : null,
      options: Array.isArray(mount.Options) ? mount.Options.filter(item => ["z", "Z", "rw", "ro", "rprivate", "private", "rbind", "bind", "nosuid", "nodev", "noexec"].includes(item)) : []
    } : null
  };
}

async function workspaceDiagnostics(root, installation, workspace, env) {
  const name = basename(workspace.hostPath);
  assert.equal(dirname(root), homedir());
  assert(basename(root).startsWith(".spaceapp-podman-acceptance-"));
  assert.equal(dirname(workspace.hostPath), root);
  assert(["rw", "ro"].includes(name));
  assert.equal(workspace.containerPath, `/workspaces/${name}`);
  const probe = (program, args) => command(program, args, { env, allowFailure: true, cleanup: true, timeoutMs: 10_000 });
  const ids = (await probe("podman", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${composeProjectName(installation)}`, "--filter", "label=com.docker.compose.service=spaceapp-cli"])).stdout.trim().split(/\s+/);
  assert.equal(ids.length, 1);
  assert(/^[a-f0-9]{12,64}$/.test(ids[0]));
  // Select inspect fields at the engine boundary; never request Config.Env or a full inspect dump.
  const format = '{"userns":{{json .HostConfig.UsernsMode}},"user":{{json .Config.User}},"idMappings":{{json .HostConfig.IDMappings}},"processLabel":{{json .ProcessLabel}},"mountLabel":{{json .MountLabel}},"mounts":{{json .Mounts}}}';
  const inspected = await probe("podman", ["inspect", "--format", format, ids[0]]);
  assert.equal(inspected.code, 0);
  const hostPaths = [dirname(homedir()), homedir(), root, workspace.hostPath, join(workspace.hostPath, "input")];
  const hostNames = ["homeParent", "home", "fixtureRoot", "workspace", "input"];
  const host = [];
  for (const path of hostPaths) {
    const entry = await stat(path);
    host.push({ name: hostNames[host.length], uid: entry.uid, gid: entry.gid, mode: (entry.mode & 0o7777).toString(8) });
  }
  let hostLabels = null;
  if (process.platform === "linux") {
    const labels = await probe("stat", ["--format=%C", "--", ...hostPaths]);
    if (labels.code === 0) hostLabels = labels.stdout.trim().split("\n").map(label => /^[a-zA-Z0-9_:,.?-]{1,512}$/.test(label) ? label : null);
  }
  const paths = [["root", "/"], ["parent", dirname(workspace.containerPath)], ["workspace", workspace.containerPath], ["input", join(workspace.containerPath, "input")]];
  const script = `const fs=require('node:fs');const read=p=>{try{return fs.readFileSync(p,'utf8').trim()}catch{return null}};const paths=${JSON.stringify(paths)}.map(([name,path])=>{try{const s=fs.statSync(path);let accessible=true;try{fs.accessSync(path,fs.constants.R_OK|(s.isDirectory()?fs.constants.X_OK:0))}catch{accessible=false}return{name,uid:s.uid,gid:s.gid,mode:(s.mode&0o7777).toString(8),accessible}}catch(e){return{name,error:e.code}}});console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),uidMap:read('/proc/self/uid_map'),gidMap:read('/proc/self/gid_map'),processLabel:read('/proc/self/attr/current'),paths}));`;
  const executed = await probe("podman", ["exec", "--user", "10001:10001", ids[0], "node", "-e", script]);
  assert.equal(executed.code, 0);
  const container = JSON.parse(executed.stdout);
  container.processLabel = kernelFactText(container.processLabel);
  assert(Number.isSafeInteger(container.uid) && Number.isSafeInteger(container.gid));
  for (const key of ["uidMap", "gidMap"]) assert(container[key] === null || /^[\d\s]{1,1024}$/.test(container[key]));
  assert(container.processLabel === null || /^[a-zA-Z0-9_:,. ()/-]{0,512}$/.test(container.processLabel));
  assert(Array.isArray(container.paths) && container.paths.length === paths.length);
  const record = { mode: "WORKSPACE_DIAGNOSTICS", fixture: name, hostUid: process.getuid(), hostGid: process.getgid(), host, hostLabels,
    inspect: workspaceInspectFacts(JSON.parse(inspected.stdout), workspace), container };
  const output = JSON.stringify(record);
  assert(output.length <= 12_000);
  process.stdout.write(`${output}\n`);
}

async function acceptance(opts) {
  assert(["linux", "darwin"].includes(process.platform), "Run on Linux or macOS");
  assert.notEqual(process.getuid(), 0, "Run as an unprivileged user");
  await portAvailable(); // Never stop an existing listener to make this proof fit.
  const facts = JSON.parse((await command("podman", ["info", "--format", "json"])).stdout);
  assert.equal(facts.host?.security?.rootless, true, "Rootless Podman is required");
  assert(/^v?2$/.test(String(facts.host?.cgroupVersion)), "cgroup v2 is required");
  assert(Number.parseInt(facts.version?.Version, 10) >= 5, "Podman >=5 is required");
  const env = { ...process.env, PODMAN_COMPOSE_PROVIDER: "docker-compose", SPACEAPP_TELEMETRY: "0" };
  const provider = (await command("docker-compose", ["version", "--short"], { env })).stdout.trim();
  const parts = provider.replace(/^v/, "").split(".").map(Number);
  assert(parts[0] > 2 || parts[0] === 2 && (parts[1] > 24 || parts[1] === 24 && parts[2] >= 4), "docker-compose >=2.24.4 is required");
  const engineInfo = await probeEngineInfo({ engine: "podman", execute: async (spec, io = {}) => {
    const result = await command(spec.command, spec.args, { env: { ...env, ...spec.env }, allowFailure: true, timeoutMs: spec.timeoutMs });
    io.stdout?.write(result.stdout);
    io.stderr?.write(result.stderr);
    return result.code ?? 1;
  } });
  const diskFloor = { small: 6.5, medium: 8, large: 11 }[opts.profile] * 1024 ** 3;
  assert(engineInfo.checks.every((check) => check.ok), `Unsupported Podman prerequisites: ${engineInfo.checks.filter((check) => !check.ok).map((check) => check.name).join(", ")}`);
  assert(Number.isFinite(engineInfo.freeDiskBytes) && engineInfo.freeDiskBytes >= diskFloor, "Insufficient or unknown free engine disk; no acceptance state was created");
  const root = await mkdtemp(join(homedir(), ".spaceapp-podman-acceptance-"));
  const installation = join(root, "installation");
  const stateFile = opts.stateFile ?? `${root}.json`;
  try {
    await writeFile(stateFile, JSON.stringify({ root, project: composeProjectName(installation) }), { mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const passed = [];
  let appliedLimits;
  const phase = async (name, work) => { process.stdout.write(`Podman acceptance: ${name}\n`); await work(); passed.push(name); };
  await withCleanup(async () => {
    env.SPACEAPP_HOME = installation;
    const answers = JSON.stringify({ confirm: true, profile: opts.profile, engine: "podman", access: "isolated", companions: false, telemetry: false, open: false });
    const cli = (args, { version = opts.sourceVersion, input } = {}) => {
      const script = `import {run} from ${JSON.stringify(new URL("../src/cli.mjs", import.meta.url).href)}; try { process.exitCode = await run(process.argv.slice(1), {runtimeVersion:${JSON.stringify(version)}}); } catch(error) { console.error(error.message); process.exitCode=1; }`;
      return command(process.execPath, ["--input-type=module", "-e", script, ...args, ...(input ? [] : ["--non-interactive"]), "--answers", answers], { env, input });
    };
    const config = async () => JSON.parse(await readFile(join(installation, "config.json"), "utf8"));
    const compose = async (args) => {
      const conf = await config();
      const spec = composeCommand("status", installation, { ...conf, engine: "podman" });
      return command(spec.command, [...spec.args.slice(0, -1), ...args], { env });
    };
    const core = (script) => compose(["exec", "-T", "--user", "10001:10001", "spaceapp-core", "node", "-e", script]);
    await phase("install", async () => {
      await cli(["install", "--engine", "podman", "--profile", opts.profile, "--no-open"]);
      assert.equal((await config()).engine, "podman");
      await readiness();
    });
    await phase("resource limits", async () => {
      const result = await core("const fs=require('node:fs'),assert=require('node:assert/strict');const cpu=fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim().split(/\\s+/).map(Number);const memory=Number(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim());assert.equal(cpu.length,2);assert(cpu.every(n=>Number.isFinite(n)&&n>0));assert(Number.isFinite(memory)&&memory>0);console.log(JSON.stringify({cpuQuota:cpu[0],cpuPeriod:cpu[1],memoryBytes:memory}));");
      appliedLimits = JSON.parse(result.stdout);
    });
    await phase("workspaces", async () => {
      for (const name of ["rw", "ro"]) {
        const path = join(root, name);
        await mkdir(path, { mode: 0o700 });
        await writeFile(join(path, "input"), "acceptance", { mode: 0o600 });
        await cli(["workspace", "add", path, ...(name === "ro" ? ["--read-only"] : [])]);
      }
      await cli(["up"]);
      await readiness();
      for (const workspace of (await config()).workspaces) {
        const read = `const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(fs.readFileSync(${JSON.stringify(join(workspace.containerPath, "input"))},'utf8'),'acceptance');`;
        const write = `fs.writeFileSync(${JSON.stringify(join(workspace.containerPath, "output"))},'written');`;
        try {
          await compose(["exec", "-T", "--user", "10001:10001", "spaceapp-cli", "node", "-e", read + (workspace.readOnly ? `assert.throws(()=>{${write}},e=>e.code==='EROFS'||e.code==='EACCES');` : write)]);
        } catch (error) {
          try { if (!interrupted) await workspaceDiagnostics(root, installation, workspace, env); }
          catch { process.stdout.write('WORKSPACE_DIAGNOSTICS_UNAVAILABLE\n'); }
          throw error;
        }
        assert.equal((await stat(join(workspace.hostPath, "input"))).uid, process.getuid());
        if (!workspace.readOnly) {
          const output = await stat(join(workspace.hostPath, "output"));
          assert.equal(output.uid, process.getuid());
          assert.equal(output.gid, process.getgid());
        }
      }
    });
    await phase("backup and restore", async () => {
      await core("require('node:fs').writeFileSync('/var/lib/spaceapp/acceptance-marker','before')");
      await cli(["backup"]);
      const backup = (await readdir(join(installation, "backups"))).sort().at(-1);
      const directory = join(installation, "backups", backup);
      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      assert.equal(manifest.format, "spaceapp-portable-backup");
      for (const name of ["database.dump", "data.tar.gz", "memory.tar.gz"]) {
        const contents = await readFile(join(directory, name));
        assert.equal(createHash("sha256").update(contents).digest("hex"), manifest.files[name].sha256);
        assert.equal(contents.length, manifest.files[name].size);
        assert.equal((await stat(join(directory, name))).uid, process.getuid());
      }
      await core("require('node:fs').writeFileSync('/var/lib/spaceapp/acceptance-marker','after')");
      await cli(["restore"], { input: "RESTORE\n" });
      await readiness();
      await core("require('node:assert/strict').equal(require('node:fs').readFileSync('/var/lib/spaceapp/acceptance-marker','utf8'),'before')");
    });
    await phase("lifecycle and diagnostics", async () => {
      for (const args of [["status"], ["logs"], ["doctor"], ["doctor", "--fix"], ["provider", "install", "claude"], ["down"], ["up"], ["repair"]]) await cli(args);
      await readiness();
      await cli(["support-bundle", "--out", join(root, "support.json")]);
      const bundle = JSON.parse(await readFile(join(root, "support.json"), "utf8"));
      assert.equal(bundle.installation.config.engine, "podman");
      assert.equal(bundle.engine.engine, "podman");
      assert.equal(bundle.engine.rootless, true);
      assert.equal(bundle.engine.cgroupVersion, "v2");
      assert.equal(bundle.engine.cpuLimitDelegated, true);
      assert.equal(bundle.engine.memoryLimitDelegated, true);
      assert.equal((await config()).engine, "podman");
    });
    if (opts.targetVersion) await phase("update checkpoint and rollback", async () => {
      await cli(["update", opts.targetVersion], { version: opts.targetVersion });
      assert.equal((await config()).version, opts.targetVersion);
      assert.equal((await config()).previousVersion, opts.sourceVersion);
      assert((await readdir(join(installation, "checkpoints"))).length > 0, "Update must create a checkpoint");
      await readiness();
      await cli(["rollback"], { version: opts.targetVersion });
      assert.equal((await config()).version, opts.sourceVersion);
      assert.equal((await config()).engine, "podman");
      await readiness();
    });
    await phase("uninstall and purge", async () => {
      await cli(["uninstall"]);
      await cli(["up"]);
      await readiness();
      await cli(["uninstall", "--purge-data"], { input: "DELETE\n" });
      const project = composeProjectName(installation);
      assert.equal((await command("podman", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`])).stdout.trim(), "");
      assert.equal((await command("podman", ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`])).stdout.trim(), "");
    });
  }, () => cleanupState(stateFile));
  process.stdout.write(`${JSON.stringify({ mode: "REAL_PODMAN", passed: true, cleaned: true, profile: opts.profile, sourceVersion: opts.sourceVersion, targetVersion: opts.targetVersion ?? null, engineInfo, appliedLimits, provider, phases: passed })}\n`);
}

async function selfTest() {
  assert.equal(options(["--profile", "medium"]).profile, "medium");
  assert.throws(() => options(["--profile", "tiny"]));
  assert.throws(() => options(["--source-version", "bad;version"]));
  const events = [];
  await assert.rejects(withCleanup(async () => { events.push("work"); throw new Error("injected failure"); }, async () => events.push("cleanup")), /injected failure/);
  assert.deepEqual(events, ["work", "cleanup"]);
  await withCleanup(async () => events.push("success"), async () => events.push("cleanup"));
  assert.deepEqual(events, ["work", "cleanup", "success", "cleanup"]);
  await assert.rejects(withCleanup(async () => { throw new Error("work failed"); }, async () => { throw new Error("cleanup failed"); }), AggregateError);
  const workspace = { hostPath: "/fresh/rw", containerPath: "/workspaces/rw" };
  const diagnostic = workspaceInspectFacts({ userns: "private", user: "0:0", idMappings: { UidMap: ["10001:0:1", "unsafe"] },
    mounts: [{ Destination: workspace.containerPath, Source: workspace.hostPath, RW: true, Type: "bind", Options: ["z", "PASSWORD_SHOULD_NOT_LEAK"] }],
    Env: ["PASSWORD_SHOULD_NOT_LEAK"], other: "PASSWORD_SHOULD_NOT_LEAK" }, workspace);
  assert.equal(diagnostic.mount.sourceMatches, true);
  assert.deepEqual(diagnostic.uidMap, ["10001:0:1"]);
  assert.deepEqual(diagnostic.mount.options, ["z"]);
  assert(!JSON.stringify(diagnostic).includes("PASSWORD_SHOULD_NOT_LEAK"));
  assert.equal(kernelFactText(`system_u:system_r:container_t:s0${String.fromCharCode(0)}\n`), "system_u:system_r:container_t:s0");
  process.stdout.write('SELF_TEST_ONLY: argument validation, failure cleanup and diagnostic sanitization passed; no engine was contacted.\n');
}

try {
  const opts = options(process.argv.slice(2));
  if (opts.selfTest) await selfTest();
  else {
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    if (opts.cleanup) await cleanupState(resolve(opts.cleanup));
    else await acceptance(opts);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
