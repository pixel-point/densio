export function resolveModuleDefault<T>(value: T): T;
export function resolveModuleDefault<T>(value: { default: T }): T;
export function resolveModuleDefault<T>(value: T | { default: T }): T {
  let resolved: unknown = value;

  while (
    resolved &&
    typeof resolved === "object" &&
    "default" in resolved &&
    (resolved as { default?: unknown }).default !== undefined
  ) {
    resolved = (resolved as { default: unknown }).default;
  }

  return resolved as T;
}
