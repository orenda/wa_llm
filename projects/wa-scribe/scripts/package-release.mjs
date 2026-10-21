import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { crc32 } from "node:zlib";

const distDir = process.argv[2] ?? "dist";
const outFile = process.argv[3] ?? "release/wa-scribe.zip";

function fail(message) {
  console.error(`package-release: ${message}`);
  process.exit(1);
}

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files.sort();
}

function u16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
}

let names;
try {
  names = walk(distDir);
} catch {
  fail(`${distDir} is missing. Run npm run build first. This script does not publish.`);
}

const manifestPath = names.find((path) => relative(distDir, path) === "manifest.json");
if (!manifestPath && !names.some((path) => relative(distDir, path).replaceAll("\\", "/") === "local-dist/main.mjs")) {
  fail("manifest.json or local-dist/main.mjs is missing. Build the extension or local app first. This script does not publish.");
}

const refused = names.find((path) => {
  const name = relative(distDir, path).replaceAll("\\", "/");
  return name.endsWith(".pem") || name.includes("client_secret") || name.endsWith(".env");
});
if (refused) fail(`refused to pack ${relative(distDir, refused)}`);

const manifest = manifestPath ? readFileSync(manifestPath, "utf8") : "";
if (manifest.includes("client_secret")) fail("manifest contains client_secret");

const stamp = new Date();
const time = (stamp.getHours() << 11) | (stamp.getMinutes() << 5) | Math.floor(stamp.getSeconds() / 2);
const date = ((Math.max(stamp.getFullYear(), 1980) - 1980) << 9) | ((stamp.getMonth() + 1) << 5) | stamp.getDate();
const locals = [];
const centrals = [];
let offset = 0;

for (const path of names) {
  const name = Buffer.from(relative(distDir, path).replaceAll("\\", "/"));
  const data = readFileSync(path);
  const sum = crc32(data) >>> 0;
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(time),
    u16(date),
    u32(sum),
    u32(data.length),
    u32(data.length),
    u16(name.length),
    u16(0),
    name,
    data,
  ]);
  locals.push(local);
  centrals.push(Buffer.concat([
    u32(0x02014b50),
    u16((3 << 8) | 20),
    u16(20),
    u16(0),
    u16(0),
    u16(time),
    u16(date),
    u32(sum),
    u32(data.length),
    u32(data.length),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32((statSync(path).mode & 0xffff) << 16),
    u32(offset),
    name,
  ]));
  offset += local.length;
}

const directory = Buffer.concat(centrals);
const end = Buffer.concat([
  u32(0x06054b50),
  u16(0),
  u16(0),
  u16(names.length),
  u16(names.length),
  u32(directory.length),
  u32(offset),
  u16(0),
]);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, Buffer.concat([...locals, directory, end]));
console.log(`packed ${names.length} files into ${outFile}; not published`);
