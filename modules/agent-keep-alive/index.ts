/**
 * `AgentKeepAlive`: holds an OS "keep me running" assertion so the JS thread
 * driving an in-flight Takumi Agent turn (the SSE stream) survives the app
 * being backgrounded. Android runs a `dataSync` foreground service (with a
 * low-priority "Takumi Agent" notification); iOS holds a finite
 * `beginBackgroundTask` window (~30s, Apple's ceiling).
 *
 * Both calls are best-effort. Android 12+ refuses a foreground-service start
 * from the background, and the module is absent entirely in builds that
 * predate it, so callers get `false` rather than an error and the turn simply
 * runs unprotected. See hooks/useAgentBackgroundKeepAlive.ts for the policy.
 */

import { requireOptionalNativeModule } from "expo-modules-core";

interface AgentKeepAliveNative {
  /** `reason` is the notification body on Android; ignored on iOS. */
  start(reason: string): boolean;
  stop(): void;
}

const native =
  requireOptionalNativeModule<AgentKeepAliveNative>("AgentKeepAlive");

/** `true` when the OS accepted the assertion. */
export function startAgentKeepAlive(reason: string): boolean {
  try {
    return native?.start(reason) === true;
  } catch (err) {
    if (__DEV__) console.warn("[agent-keep-alive] start failed", err);
    return false;
  }
}

export function stopAgentKeepAlive(): void {
  try {
    native?.stop();
  } catch (err) {
    if (__DEV__) console.warn("[agent-keep-alive] stop failed", err);
  }
}

export const isAgentKeepAliveAvailable = native != null;
