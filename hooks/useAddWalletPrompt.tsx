/**
 * `useAddWalletPrompt` — the dock every "add a wallet for this chain"
 * CTA goes through.
 *
 * The point is that a surface should not have to know how wallets get
 * added. Without this, each one grew its own `Namespace | null` state, its
 * own `AddWalletSheet` mount, and its own reset wiring — three surfaces
 * had already diverged, and a fourth would have copied whichever it found
 * first. Now a surface costs two lines:
 *
 *   const { promptFor, sheet } = useAddWalletPrompt();
 *   …
 *   <Pressable onPress={() => promptFor("sui")} />
 *   {sheet}
 *
 * and if the add-wallet flow ever changes (a Google option lands on
 * `AddWalletSheet`, the sheet is replaced, the pre-aim behaviour is
 * revisited) every consumer inherits it with no edit.
 *
 * Nothing is returned about the *added* wallet on purpose. Every consumer
 * reads `useWallet().wallets`, which is React-Query backed, so the
 * surface re-renders with the new wallet on its own — a success callback
 * would just be a second, racier path to the same state.
 */

import { useCallback, useMemo, useState } from "react";
import { GetWalletSheet } from "@/components/wallet/create/GetWalletSheet";
import type { Namespace } from "@/services/chains/types";

export type AddWalletPrompt = {
  /** Open the add-wallet sheet pre-aimed at `namespace`. */
  promptFor: (namespace: Namespace) => void;
  /** Close it without adding anything. */
  dismiss: () => void;
  /** Render this somewhere in the consumer's tree. */
  sheet: React.ReactNode;
  /** The namespace currently being prompted for, if any. */
  pendingNamespace: Namespace | null;
};

export function useAddWalletPrompt(): AddWalletPrompt {
  const [pendingNamespace, setPendingNamespace] = useState<Namespace | null>(
    null,
  );
  /**
   * Mount lazily, then keep it mounted.
   *
   * Eager mounting cost real work: some hosts render one of these per item
   * (the agent chat has an opportunity card per tool call), and each sheet
   * drags in the Google flow's three modals plus a `configureGoogleSignIn`
   * effect — all invisible and all unused until someone taps.
   *
   * Unmounting again on close would be worse though: the sheet animates out
   * on `visible: false`, and tearing it down in the same frame would cut
   * that off. So this latches on first use and stays.
   */
  const [everOpened, setEverOpened] = useState(false);

  const promptFor = useCallback((namespace: Namespace) => {
    setEverOpened(true);
    setPendingNamespace(namespace);
  }, []);

  const dismiss = useCallback(() => setPendingNamespace(null), []);

  const sheet = useMemo(
    () =>
      everOpened ? (
        <GetWalletSheet
          visible={pendingNamespace !== null}
          namespace={pendingNamespace ?? undefined}
          onClose={dismiss}
          // The consumer re-renders off `useWallet().wallets` anyway, so
          // closing is the only thing left to do here.
          onWalletAdded={dismiss}
        />
      ) : null,
    [everOpened, pendingNamespace, dismiss],
  );

  return { promptFor, dismiss, sheet, pendingNamespace };
}
