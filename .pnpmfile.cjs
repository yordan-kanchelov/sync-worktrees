// The project compiles with TypeScript 7, the native (Go) compiler, which ships
// no JavaScript compiler API. typescript-eslint's type-aware rules need that API
// and only support TypeScript <= 6, which they declare as a peer dependency.
// pnpm resolves that peer from this project's own `typescript` devDependency,
// i.e. TypeScript 7, and neither `pnpm.overrides` nor `pnpm.packageExtensions`
// can redirect a peer to a different version.
//
// This hook turns the peer into a private dependency of the linter packages so
// `pnpm lint` type-checks with TypeScript 6 while `tsc` keeps using TypeScript 7.
// pnpm records this file's checksum in pnpm-lock.yaml, so `--frozen-lockfile`
// installs stay reproducible.
const LINTER_TYPESCRIPT_VERSION = "6.0.3";

const LINTER_PACKAGES = new Set([
  "typescript-eslint",
  "@typescript-eslint/eslint-plugin",
  "@typescript-eslint/parser",
  "@typescript-eslint/project-service",
  "@typescript-eslint/tsconfig-utils",
  "@typescript-eslint/type-utils",
  "@typescript-eslint/typescript-estree",
  "@typescript-eslint/utils",
  "ts-api-utils",
]);

function readPackage(pkg) {
  if (LINTER_PACKAGES.has(pkg.name) && pkg.peerDependencies?.typescript) {
    delete pkg.peerDependencies.typescript;
    pkg.dependencies = { ...pkg.dependencies, typescript: LINTER_TYPESCRIPT_VERSION };
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
