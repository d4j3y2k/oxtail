// Project-scope path helpers shared by the list/read tools (server.ts) and
// peer target resolution (resolve-target.ts). Scope is project-root as the
// unit (see AGENTS.md): sessions in one root see each other, nested git repos
// are separate projects, cross-project there is no visibility.

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";

export type ProjectRootLookup = {
  root: string;
  foundGit: boolean;
};

export function findProjectRoot(start: string): ProjectRootLookup {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, ".git"))) return { root: dir, foundGit: true };
    const parent = dirname(dir);
    if (parent === dir) return { root: start, foundGit: false };
    dir = parent;
  }
}

export function inferProjectRoot(start: string): string {
  return findProjectRoot(start).root;
}

export function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function isDescendantOrEqual(child: string, root: string): boolean {
  if (child === root) return true;
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(rootWithSep);
}

export function pathBelongsToProjectScope(path: string, resolvedRoot: string): boolean {
  const resolvedPath = safeRealpath(path);
  if (!isDescendantOrEqual(resolvedPath, resolvedRoot)) return false;

  const project = findProjectRoot(resolvedPath);
  if (!project.foundGit) return true;

  // A nested repository under the requested root is a separate project. The
  // descendant check above is necessary for subdirectories of the same repo,
  // but by itself it leaks nested project sessions across the project boundary.
  return safeRealpath(project.root) === resolvedRoot;
}

export const UUID_RE = /^[0-9a-f-]{36}$/;
