/**
 * Reads what the WebView compatibility shim found and patched.
 *
 * The shim itself is `public/compat.js`, a blocking classic script loaded from index.html
 * before the module bundle. It has to be outside the bundle to be guaranteed to run first;
 * see the comment at the top of that file. This module is only the typed reader the UI uses.
 */

interface CompatReport {
  /** `label -> the engine has this API natively`, sampled before anything was patched. */
  native: Record<string, boolean>;
  /** Labels of the APIs that were missing and had to be shimmed. */
  shimmed: string[];
}

const report = (globalThis as unknown as { __septonaCompat?: CompatReport }).__septonaCompat;

/**
 * APIs this engine lacked natively. Empty on a current WebView.
 *
 * If the shim script failed to load this is empty too, which would be misleading on its
 * own — `COMPAT_SHIM_LOADED` distinguishes the two cases and the diagnostics screen reports
 * it, because a missing shim is itself a fault worth seeing.
 */
export const SHIMMED_APIS: string[] = report?.shimmed ?? [];

/** False when `compat.js` did not run at all. */
export const COMPAT_SHIM_LOADED = !!report;

/** True when the engine natively supports everything the shim checks for. */
export const ENGINE_IS_CURRENT = COMPAT_SHIM_LOADED && SHIMMED_APIS.length === 0;
