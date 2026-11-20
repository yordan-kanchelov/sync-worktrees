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
