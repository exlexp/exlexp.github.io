interface TrustedTypesPolicyFactoryLike {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): unknown;
}

export function installSameOriginTrustedTypesPolicy(): void {
  const factory = (globalThis as unknown as { trustedTypes?: TrustedTypesPolicyFactoryLike }).trustedTypes;
  if (!factory) return;
  try {
    factory.createPolicy('default', {
      createScriptURL(value: string): string {
        const url = new URL(value, location.origin);
        if (url.origin !== location.origin) throw new TypeError('Cross-origin script URL rejected');
        return url.href;
      },
    });
  } catch {
    // React StrictMode and hot reload may evaluate this module after the policy already exists.
  }
}
