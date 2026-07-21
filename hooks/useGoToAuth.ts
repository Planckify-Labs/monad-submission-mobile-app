import { useFocusEffect } from "@react-navigation/native";
import { router } from "expo-router";
import { useCallback, useState } from "react";

/**
 * Shared "inline sign-in" navigation for screens whose primary action
 * needs a JWT. Instead of a surprise `router.replace("/auth")` fired the
 * moment a request 401s (the jarring global redirect removed in
 * `78ba999`), the caller relabels its own action button to a clear
 * "Sign In to …" CTA and routes the tap through here.
 *
 * Mirrors the pattern baked into the home ActivitySection / activities /
 * address-book sign-in buttons: flip `navigatingToAuth` so the button can
 * show a spinner, yield 100 ms so React commits + the GPU paints that
 * frame, THEN push `/auth`. Without the yield, mounting `/auth` on the
 * main thread swallows the tap and the user sees nothing happen for a
 * couple hundred ms.
 *
 * `useFocusEffect` resets the flag when the screen regains focus — i.e.
 * the user cancelled on `/auth` and came back — so the button doesn't
 * stay stuck on "Opening sign-in…".
 */
export function useGoToAuth() {
  const [navigatingToAuth, setNavigatingToAuth] = useState(false);

  const goToAuth = useCallback(async () => {
    if (navigatingToAuth) return;
    setNavigatingToAuth(true);
    await new Promise((r) => setTimeout(r, 100));
    router.push("/auth");
  }, [navigatingToAuth]);

  useFocusEffect(
    useCallback(() => {
      setNavigatingToAuth(false);
    }, []),
  );

  return { navigatingToAuth, goToAuth };
}
