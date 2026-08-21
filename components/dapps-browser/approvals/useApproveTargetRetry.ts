import { useEffect, useState } from "react";
import { erc20Abi, type PublicClient } from "viem";
import { probeAssetInterface } from "@/services/chains/evm/erc165";
import type { ApproveTargetResolution } from "@/services/chains/evm/payloads";

/**
 * Second attempt at typing an `approve` target, run from the sheet.
 *
 * `EvmAdapter.resolveApproveTarget` already does this, but it runs inside the
 * request path on the gas-estimate deadline and returns `undefined` the
 * moment the probe is slow. That timeout is correct there — a dApp waiting on
 * `eth_sendTransaction` should not block on an ERC-165 round trip — but it
 * means a merely-slow RPC downgrades the sheet to "we could not confirm what
 * kind of contract this is", and with it the amount to raw base units. The
 * user then has to type `6000000` to approve six.
 *
 * A sheet has no such deadline. It is already on screen and can fill in
 * progressively, so the same probe gets a second run with room to finish.
 *
 * `kind` still comes from the same `probeAssetInterface` the adapter calls,
 * and stays `unknown` when that is the honest answer — only the token
 * registry asserts ERC-20 positively, and a wallet that invents a second
 * type-detection rule on the signing screen has two answers that can
 * disagree.
 *
 * `decimals` is resolved separately, and that separation is the point.
 * Most ERC-20s implement no ERC-165 at all, so the probe answers `unknown`
 * for perfectly ordinary tokens; gating the `decimals()` read behind a
 * positive ERC-20 verdict meant it almost never ran, which is what left the
 * amount stuck in raw base units. Reading it whenever the target is *not* an
 * NFT is both safer and far more useful: ERC-721 and ERC-1155 must implement
 * ERC-165, so a negative there positively excludes the case where the second
 * argument is a token id rather than an amount, and scaling would be wrong.
 *
 * Returns `undefined` fields until (and unless) the retry produces something.
 * The caller keeps the adapter's answer whenever it has one.
 */
export function useApproveTargetRetry(
  client: PublicClient | null,
  address: `0x${string}` | undefined,
  enabled: boolean,
): { target?: ApproveTargetResolution; decimals?: number } {
  const [resolved, setResolved] = useState<{
    target?: ApproveTargetResolution;
    decimals?: number;
  }>({});

  useEffect(() => {
    if (!enabled || !client || !address) {
      setResolved({});
      return;
    }
    let alive = true;
    (async () => {
      try {
        const kind = await probeAssetInterface(client, address);
        if (!alive) return;
        // An NFT's second `approve` argument is a token id. Scaling it would
        // be meaningless, so stop here rather than reading a `decimals()`
        // some NFT contract happens to expose.
        if (kind === "erc721" || kind === "erc1155") {
          setResolved({ target: { kind } });
          return;
        }
        const [decimals, totalSupply] = await Promise.all([
          client
            .readContract({ address, abi: erc20Abi, functionName: "decimals" })
            .catch(() => undefined),
          client
            .readContract({
              address,
              abi: erc20Abi,
              functionName: "totalSupply",
            })
            .catch(() => undefined),
        ]);
        if (!alive) return;
        // A nonsense `decimals()` from a hostile token must not become a
        // scaling factor: out-of-range values are dropped.
        const scale =
          typeof decimals === "number" && decimals >= 0 && decimals <= 36
            ? decimals
            : undefined;
        setResolved({
          decimals: scale,
          // `kind` is reported only when the probe actually said so. A
          // successful `decimals()` read is good evidence, not proof, and the
          // risk banner's wording depends on this staying honest.
          target:
            kind === "erc20"
              ? {
                  kind,
                  decimals: scale,
                  totalSupply:
                    typeof totalSupply === "bigint" ? totalSupply : undefined,
                }
              : undefined,
        });
      } catch {
        // Indeterminate stays indeterminate. The sheet already renders that
        // honestly; this retry can only ever add information.
        if (alive) setResolved({});
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, address, enabled]);

  return resolved;
}
