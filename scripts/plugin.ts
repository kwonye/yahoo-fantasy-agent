import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
export const pluginFiles = [
  "plugin.json",
  "mcp.json",
  ".codex-plugin",
  ".mcp.json",
  "skills",
  "LICENSE",
  "PLUGIN.md",
];
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function filesIn(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), `Symlink in plugin: ${entry.name}`);
    const path = join(directory, entry.name);
    paths.push(...(entry.isDirectory() ? await filesIn(path) : [path]));
  }
  return paths;
}
export async function validatePlugin(directory = root): Promise<string> {
  const manifest = await readJson(join(directory, "plugin.json"));
  const mcp = await readJson(join(directory, "mcp.json"));
  const native = await readJson(join(directory, ".codex-plugin/plugin.json"));
  const nativeMcp = await readJson(join(directory, ".mcp.json"));
  const ajv = new Ajv2020({ strict: false });
  for (const [name, value] of [
    ["plugin", manifest],
    ["mcp", mcp],
  ] as const) {
    const schema = await readJson(
      join(root, `tests/fixtures/plugin-schemas/${name}.schema.json`),
    );
    assert(ajv.validate(schema, value), `${name} schema: ${ajv.errorsText()}`);
  }
  assert(
    manifest.name === "yahoo-fantasy-agent" && native.name === manifest.name,
    "Plugin identities must match",
  );
  assert(
    typeof manifest.version === "string" &&
      /^\d+\.\d+\.\d+$/.test(manifest.version),
    "Plugin version must be stable semver",
  );
  assert(
    native.version === manifest.version,
    "Codex and portable versions differ",
  );
  const specifier = `@kwonye/yahoo-fantasy-mcp@${manifest.version}`;
  for (const config of [mcp, nativeMcp]) {
    const servers = config.mcpServers as Record<
      string,
      Record<string, unknown>
    >;
    assert(
      Object.keys(servers).length === 1,
      "Plugin must configure exactly one published MCP connection",
    );
    const server = servers["yahoo-fantasy"]!;
    assert(
      server.command === "npx" &&
        JSON.stringify(server.args) === JSON.stringify(["--yes", specifier]),
      "MCP must run the matching published package through npx; no source fallback",
    );
  }
  assert(
    native.skills === "./skills/" && native.mcpServers === "./.mcp.json",
    "Invalid Codex component discovery",
  );
  const interfaceData = native.interface as Record<string, unknown>;
  for (const field of [
    "displayName",
    "shortDescription",
    "longDescription",
    "developerName",
    "category",
  ])
    assert(
      typeof interfaceData[field] === "string" && interfaceData[field],
      `Missing interface.${field}`,
    );
  const skillRoot = join(directory, "skills");
  const skills = await readdir(skillRoot, { withFileTypes: true });
  assert(skills.length > 0, "Plugin has no skills");
  for (const skill of skills) {
    assert(skill.isDirectory(), "Skills must be immediate directories");
    const text = await readFile(
      join(skillRoot, skill.name, "SKILL.md"),
      "utf8",
    );
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert(frontmatter, `Missing frontmatter in ${skill.name}`);
    const metadata = parse(frontmatter[1]!) as Record<string, unknown>;
    assert(
      metadata.name === skill.name &&
        typeof metadata.description === "string" &&
        metadata.description.length > 0,
      "Invalid skill metadata",
    );
  }
  for (const path of await filesIn(skillRoot)) {
    if (!path.endsWith(".md")) continue;
    const text = await readFile(path, "utf8");
    assert(!text.includes("[TODO:"), "Unfinished skill placeholder");
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1]!;
      if (/^https?:/.test(target) || target.startsWith("#")) continue;
      const actual = await realpath(
        resolve(dirname(path), target.split("#")[0]!),
      );
      assert(
        !relative(await realpath(directory), actual).startsWith(".."),
        `Reference escapes plugin: ${target}`,
      );
    }
    for (const match of text.matchAll(
      /@kwonye\/yahoo-fantasy-mcp@(\d+\.\d+\.\d+)/g,
    ))
      assert(match[1] === manifest.version, "Skill package version is stale");
  }
  return manifest.version;
}
export async function packPlugin(
  destination = join(root, "artifacts"),
): Promise<string> {
  const version = await validatePlugin();
  const temporary = await mkdtemp(join(tmpdir(), "yahoo-plugin-"));
  const folder = join(temporary, "yahoo-fantasy-agent");
  await mkdir(folder);
  for (const name of pluginFiles)
    await cp(join(root, name), join(folder, name), {
      recursive: true,
      dereference: false,
    });
  await validatePlugin(folder);
  const files = await filesIn(folder);
  assert(
    files.every(
      (p) => !/\.(ts|js|mjs|env)$/.test(p) && !p.includes("node_modules"),
    ),
    "Executable source or secrets in plugin archive",
  );
  await mkdir(destination, { recursive: true });
  const archive = resolve(destination, `yahoo-fantasy-agent-${version}.tar.gz`);
  execFileSync("tar", [
    "-czf",
    archive,
    "-C",
    temporary,
    "yahoo-fantasy-agent",
  ]);
  return archive;
}
export async function setVersion(version: string): Promise<void> {
  assert(/^\d+\.\d+\.\d+$/.test(version), "Use a stable semver version");
  execFileSync(
    "npm",
    [
      "version",
      version,
      "--no-git-tag-version",
      "--allow-same-version",
      "--ignore-scripts",
    ],
    { cwd: root, stdio: "inherit" },
  );
  for (const name of ["plugin.json", ".codex-plugin/plugin.json"]) {
    const data = await readJson(join(root, name));
    data.version = version;
    await writeFile(join(root, name), JSON.stringify(data, null, 2) + "\n");
  }
  for (const path of [
    join(root, "mcp.json"),
    join(root, ".mcp.json"),
    join(root, "README.md"),
    join(root, "PLUGIN.md"),
    ...(await filesIn(join(root, "skills"))),
  ]) {
    const content = await readFile(path, "utf8");
    await writeFile(
      path,
      content.replaceAll(
        /@kwonye\/yahoo-fantasy-mcp@\d+\.\d+\.\d+/g,
        `@kwonye/yahoo-fantasy-mcp@${version}`,
      ),
    );
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const command = process.argv[2] ?? "validate";
  if (command === "version") await setVersion(process.argv[3] ?? "");
  else if (command === "pack") console.log(await packPlugin());
  else if (command === "validate") {
    const version = await validatePlugin();
    const pkg = await readJson(join(root, "package.json"));
    assert(pkg.version === version, "npm and plugin versions differ");
    console.log(`Plugin ${version} validated; published MCP launcher only`);
  } else throw new Error(`Unknown plugin command: ${command}`);
}
