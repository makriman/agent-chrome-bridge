import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function artifactsDir(repoRoot) {
  return join(repoRoot, "artifacts");
}

export function isInsideDir(parent, candidate) {
  const root = resolve(parent);
  const target = resolve(candidate);
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function assertRelativePath(requested) {
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw) {
    throw new Error("A relative path inside artifacts/ is required.");
  }
  if (raw.includes("\0")) {
    throw new Error("Path contains a null byte.");
  }
  if (isAbsolute(raw) || raw.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new Error("Absolute paths are not allowed. Use a path inside artifacts/.");
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    throw new Error("URI paths are not allowed. Use a path inside artifacts/.");
  }
  return raw;
}

export function confinePath(baseDir, requested, allowedDir = baseDir) {
  const raw = assertRelativePath(requested);
  const base = resolve(baseDir);
  const allowed = resolve(allowedDir);
  if (!isInsideDir(base, allowed) && allowed !== base) {
    throw new Error("Allowed directory must stay inside the base directory.");
  }
  const resolved = resolve(base, raw);
  if (resolved === allowed || !isInsideDir(allowed, resolved)) {
    throw new Error("Path escapes the allowed artifacts directory.");
  }
  return resolved;
}

export function confineArtifactsPath(repoRoot, requested) {
  return confinePath(repoRoot, requested, artifactsDir(repoRoot));
}

async function assertRealpathInside(allowedDir, candidate) {
  let rootReal;
  try {
    rootReal = await realpath(allowedDir);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  let candidateReal;
  try {
    candidateReal = await realpath(candidate);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!isInsideDir(rootReal, candidateReal)) {
    throw new Error(`Path escapes the allowed directory (${rootReal}).`);
  }
}

export async function confineArtifactsFile(repoRoot, requested) {
  const target = confineArtifactsPath(repoRoot, requested);
  const allowed = artifactsDir(repoRoot);
  await mkdir(dirname(target), { recursive: true });
  await assertRealpathInside(allowed, dirname(target));
  await assertRealpathInside(allowed, target);
  return target;
}

export async function confineArtifactsDir(repoRoot, requested) {
  const target = confineArtifactsPath(repoRoot, requested);
  const allowed = artifactsDir(repoRoot);
  await mkdir(target, { recursive: true });
  await assertRealpathInside(allowed, target);
  return target;
}

export async function assertArtifactsRealpath(repoRoot, absolutePath) {
  const allowed = artifactsDir(repoRoot);
  if (!isInsideDir(allowed, absolutePath)) {
    throw new Error("Path escapes the allowed artifacts directory.");
  }
  await mkdir(absolutePath, { recursive: true });
  await assertRealpathInside(allowed, absolutePath);
  return absolutePath;
}
