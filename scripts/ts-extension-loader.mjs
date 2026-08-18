/**
 * Node's native TypeScript stripping does not add file extensions during ESM
 * resolution. The app deliberately uses bundler-style extensionless imports,
 * so this test-only loader gives relative TypeScript imports the same lookup
 * behavior without changing production source specifiers.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (originalError) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    // Dotted module roles such as `xai.server` are still extensionless; only
    // actual runtime/source suffixes should suppress the TypeScript fallback.
    const hasExtension = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|node)$/i.test(specifier);
    if (
      originalError?.code !== "ERR_MODULE_NOT_FOUND" ||
      !isRelative ||
      hasExtension
    ) {
      throw originalError;
    }

    for (const extension of [".ts", ".tsx"]) {
      try {
        return await nextResolve(`${specifier}${extension}`, context);
      } catch (candidateError) {
        if (candidateError?.code !== "ERR_MODULE_NOT_FOUND") {
          throw candidateError;
        }
      }
    }
    throw originalError;
  }
}
