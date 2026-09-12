/**
 * WalletConnect codecs — every row of the §7.4 table round-trips through
 * the kits' `walletConnectCodec`, `connectRequest` never names a chain in
 * the transport, and an unapproved chain is a 4901 the transport
 * produces before the codec is consulted (checked here through the
 * pairing-URI validator + codec null paths).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import bs58 from "bs58";

import { bytesToBase64 } from "@/services/chains/solana/codec";
import {
  EVM_WC_METHODS,
  evmWalletConnectCodec,
} from "@/services/walletKit/evm/walletConnect";
import {
  firstSignatureBase58,
  solanaWalletConnectCodec,
} from "@/services/walletKit/solana/walletConnect";
import { stellarWalletConnectCodec } from "@/services/walletKit/stellar/walletConnect";
import { suiWalletConnectCodec } from "@/services/walletKit/sui/walletConnect";
import {
  isLinkModeEnvelope,
  parseRequestRedirect,
  validatePairingUri,
} from "./deeplinks.ts";

const SOL_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ctx = {
  accounts: [
    `${SOL_MAINNET}:mvines9iiHiQTysrwkJjGsqPkCPmEvyxAFdU1BkNK4E`,
    "sui:mainnet:0xabc",
    "eip155:1:0xdead",
  ],
};

describe("eip155 codec", () => {
  it("is the identity for served methods and refuses excluded ones", () => {
    const r = evmWalletConnectCodec.toChainRequest(
      "personal_sign",
      ["0x01", "0xdead"],
      "eip155:137",
      ctx,
    );
    assert.deepEqual(r, {
      method: "personal_sign",
      params: ["0x01", "0xdead"],
      chainOverride: 137,
    });
    assert.equal(
      evmWalletConnectCodec.toChainRequest("eth_sign", [], "eip155:1", ctx),
      null,
    );
    assert.equal(
      evmWalletConnectCodec.toChainRequest(
        "eth_sendRawTransaction",
        [],
        "eip155:1",
        ctx,
      ),
      null,
    );
    assert.equal(
      evmWalletConnectCodec.toChainRequest(
        "eth_signTransaction",
        [],
        "eip155:1",
        ctx,
      ),
      null,
    );
    assert.ok(!EVM_WC_METHODS.includes("eth_sign"));
    assert.equal(
      evmWalletConnectCodec.fromChainResult("personal_sign", "0xsig", []),
      "0xsig",
    );
    assert.deepEqual(evmWalletConnectCodec.connectRequest("eip155:1"), {
      method: "eth_requestAccounts",
      params: [],
    });
  });
});

describe("solana codec", () => {
  const msg = new TextEncoder().encode("hello");
  it("solana_signMessage: base58 in, base64 to the adapter, base58 signature out", () => {
    const r = solanaWalletConnectCodec.toChainRequest(
      "solana_signMessage",
      { message: bs58.encode(msg), pubkey: "P" },
      SOL_MAINNET,
      ctx,
    );
    assert.deepEqual(r, {
      method: "solana:signMessage",
      params: [{ address: "P", message: bytesToBase64(msg) }],
    });
    const sig = new Uint8Array(64).fill(7);
    assert.deepEqual(
      solanaWalletConnectCodec.fromChainResult(
        "solana_signMessage",
        { signature: bytesToBase64(sig) },
        {},
      ),
      {
        signature: bs58.encode(sig),
      },
    );
  });
  it("solana_signTransaction: base64 form only; result carries signature + transaction", () => {
    assert.deepEqual(
      solanaWalletConnectCodec.toChainRequest(
        "solana_signTransaction",
        { transaction: "AAAA" },
        SOL_MAINNET,
        ctx,
      ),
      {
        method: "solana:signTransaction",
        params: [{ transaction: "AAAA", chain: "solana:mainnet" }],
      },
    );
    // Deprecated feePayer/instructions shape is refused.
    assert.equal(
      solanaWalletConnectCodec.toChainRequest(
        "solana_signTransaction",
        { feePayer: "x", instructions: [] },
        SOL_MAINNET,
        ctx,
      ),
      null,
    );
    const sig = new Uint8Array(64).fill(9);
    const wire = new Uint8Array(1 + 64 + 10);
    wire[0] = 1;
    wire.set(sig, 1);
    const signed = bytesToBase64(wire);
    assert.deepEqual(
      solanaWalletConnectCodec.fromChainResult(
        "solana_signTransaction",
        [{ signedTransaction: signed }],
        {},
      ),
      {
        signature: bs58.encode(sig),
        transaction: signed,
      },
    );
    assert.equal(firstSignatureBase58(signed), bs58.encode(sig));
  });
  it("signAllTransactions / signAndSend / getAccounts", () => {
    assert.deepEqual(
      solanaWalletConnectCodec.toChainRequest(
        "solana_signAllTransactions",
        { transactions: ["A", "B"] },
        SOL_MAINNET,
        ctx,
      ),
      {
        method: "solana:signTransaction",
        params: [
          { transaction: "A", chain: "solana:mainnet" },
          { transaction: "B", chain: "solana:mainnet" },
        ],
      },
    );
    assert.deepEqual(
      solanaWalletConnectCodec.fromChainResult(
        "solana_signAllTransactions",
        [{ signedTransaction: "A1" }, { signedTransaction: "B1" }],
        {},
      ),
      {
        transactions: ["A1", "B1"],
      },
    );
    assert.deepEqual(
      solanaWalletConnectCodec.toChainRequest(
        "solana_signAndSendTransaction",
        { transaction: "T", sendOptions: { skipPreflight: true } },
        "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        ctx,
      ),
      {
        method: "solana:signAndSendTransaction",
        params: [
          {
            transaction: "T",
            chain: "solana:devnet",
            options: { skipPreflight: true },
          },
        ],
      },
    );
    assert.deepEqual(
      solanaWalletConnectCodec.fromChainResult(
        "solana_signAndSendTransaction",
        [{ signature: "5ig" }],
        {},
      ),
      { signature: "5ig" },
    );
    assert.deepEqual(
      solanaWalletConnectCodec.toChainRequest(
        "solana_getAccounts",
        {},
        SOL_MAINNET,
        ctx,
      ),
      {
        transportResult: [
          { pubkey: "mvines9iiHiQTysrwkJjGsqPkCPmEvyxAFdU1BkNK4E" },
        ],
      },
    );
    assert.equal(
      solanaWalletConnectCodec.toChainRequest(
        "solana_signMessage",
        {},
        "eip155:1",
        ctx,
      ),
      null,
    );
  });
});

describe("sui codec", () => {
  it("maps the three signing methods and getAccounts", () => {
    assert.deepEqual(
      suiWalletConnectCodec.toChainRequest(
        "sui_signTransaction",
        { transaction: "BCS", address: "0xabc" },
        "sui:mainnet",
        ctx,
      ),
      {
        method: "sui:signTransaction",
        params: [
          { transaction: "BCS", address: "0xabc", chain: "sui:mainnet" },
        ],
      },
    );
    assert.deepEqual(
      suiWalletConnectCodec.fromChainResult(
        "sui_signTransaction",
        { bytes: "BCS", signature: "S" },
        {},
      ),
      {
        signature: "S",
        transactionBytes: "BCS",
      },
    );
    assert.deepEqual(
      suiWalletConnectCodec.fromChainResult(
        "sui_signAndExecuteTransaction",
        { digest: "D" },
        {},
      ),
      { digest: "D" },
    );
    const pm = suiWalletConnectCodec.toChainRequest(
      "sui_signPersonalMessage",
      { message: "hi", address: "0xabc" },
      "sui:testnet",
      ctx,
    );
    assert.ok(pm && "method" in pm && pm.method === "sui:signPersonalMessage");
    assert.deepEqual(
      suiWalletConnectCodec.fromChainResult(
        "sui_signPersonalMessage",
        { bytes: "aGk=", signature: "S" },
        {},
      ),
      { signature: "S" },
    );
    assert.deepEqual(
      suiWalletConnectCodec.toChainRequest(
        "sui_getAccounts",
        {},
        "sui:mainnet",
        ctx,
      ),
      {
        transportResult: { accounts: ["sui:mainnet:0xabc"] },
      },
    );
    assert.equal(
      suiWalletConnectCodec.toChainRequest(
        "sui_signTransaction",
        {},
        "sui:nope",
        ctx,
      ),
      null,
    );
  });
});

describe("stellar codec", () => {
  it("maps signXDR / signAndSubmit / signMessage / signAuthEntry", () => {
    const r = stellarWalletConnectCodec.toChainRequest(
      "stellar_signXDR",
      { xdr: "X", account: "GABC" },
      "stellar:testnet",
      ctx,
    );
    assert.ok(r && "method" in r && r.method === "SUBMIT_TRANSACTION");
    if (r && "params" in r) {
      const p = r.params as {
        transactionXdr: string;
        networkPassphrase: string;
        submit?: boolean;
      };
      assert.equal(p.transactionXdr, "X");
      assert.match(p.networkPassphrase, /Test SDF Network/);
      assert.equal(p.submit, undefined);
    }
    const s = stellarWalletConnectCodec.toChainRequest(
      "stellar_signAndSubmitXDR",
      { xdr: "X" },
      "stellar:pubnet",
      ctx,
    );
    assert.ok(
      s && "params" in s && (s.params as { submit?: boolean }).submit === true,
    );
    assert.deepEqual(
      stellarWalletConnectCodec.fromChainResult(
        "stellar_signXDR",
        { signedTransaction: "SX", signerAddress: "G" },
        {},
      ),
      {
        signedXDR: "SX",
        signerAddress: "G",
      },
    );
    assert.deepEqual(
      stellarWalletConnectCodec.fromChainResult(
        "stellar_signAndSubmitXDR",
        { signedTransaction: "SX", signerAddress: "G", hash: "H" },
        {},
      ),
      {
        tx_hash: "H",
        signedXDR: "SX",
        successful: true,
      },
    );
    assert.ok(
      stellarWalletConnectCodec.toChainRequest(
        "stellar_signMessage",
        { message: "m" },
        "stellar:pubnet",
        ctx,
      ),
    );
    assert.ok(
      stellarWalletConnectCodec.toChainRequest(
        "stellar_signAuthEntry",
        { authEntryXdr: "E" },
        "stellar:pubnet",
        ctx,
      ),
    );
    assert.equal(
      stellarWalletConnectCodec.toChainRequest(
        "stellar_signXDR",
        { xdr: "X" },
        "stellar:mainnet",
        ctx,
      ),
      null,
    );
  });
});

describe("pairing URI validation", () => {
  const topic =
    "7f6e504bfad60b485450578e05678ed3e8e8c4751d3c6160be17160d63ec90f9";
  const q = (s: string) => new URLSearchParams(s);
  it("accepts a v2 irn pairing and rejects the rest", () => {
    assert.deepEqual(
      validatePairingUri(`${topic}@2`, q("relay-protocol=irn&symKey=abc")),
      { ok: true, topic },
    );
    assert.equal(
      validatePairingUri(`${topic}@1`, q("relay-protocol=irn&symKey=abc")).ok,
      false,
    );
    assert.equal(
      validatePairingUri(`${topic}@2`, q("relay-protocol=irn")).ok,
      false,
    );
    assert.equal(
      validatePairingUri(`${topic}@2`, q("relay-protocol=waku&symKey=abc")).ok,
      false,
    );
    assert.deepEqual(
      validatePairingUri(
        `${topic}@2`,
        q("relay-protocol=irn&symKey=abc&expiryTimestamp=1"),
      ),
      { ok: false, code: "expired" },
    );
  });
});

describe("Link Mode envelope detection (Phase 2b)", () => {
  it("recognises wc_ev + topic and nothing else", () => {
    assert.equal(
      isLinkModeEnvelope("https://takumipay.xyz/wc?wc_ev=abc&topic=def"),
      true,
    );
    assert.equal(
      isLinkModeEnvelope("https://takumipay.xyz/wc?topic=def&wc_ev=abc"),
      true,
    );
    assert.equal(
      isLinkModeEnvelope("https://takumipay.xyz/wc?uri=wc%3Aabc"),
      false,
    );
    assert.equal(
      isLinkModeEnvelope("wc:abc@2?relay-protocol=irn&symKey=x"),
      false,
    );
  });
});

describe("request redirect detection (`…/wc?requestId=&sessionTopic=`)", () => {
  const T = "c".repeat(64);
  it("recognises every carrier a dApp library uses for the wallet href", () => {
    for (const raw of [
      // href = our native scheme
      `takumiwallet://wc?requestId=1757600000000001&sessionTopic=${T}`,
      // href = our universal link (`https://takumipay.xyz/wc` + `/wc?…`)
      `https://takumipay.xyz/wc/wc?requestId=17&sessionTopic=${T}`,
      // href = a formatted pairing redirect
      `takumiwallet://wc?uri=wc%3A${T}%402%3Frelay-protocol%3Dirn%26symKey%3Dab/wc?requestId=3&sessionTopic=${T}`,
      // href = the raw pairing URI cut at `?` (RainbowKit)
      `wc:${T}@2/wc?requestId=1757600000000009&sessionTopic=${T.toUpperCase()}`,
    ]) {
      const r = parseRequestRedirect(raw);
      assert.ok(r, raw);
      assert.equal(r.topic, T);
      assert.match(r.requestId, /^\d+$/);
    }
  });
  it("ignores pairing URIs, Link Mode envelopes and partial shapes", () => {
    for (const raw of [
      `wc:${T}@2?relay-protocol=irn&symKey=${"b".repeat(64)}`,
      `https://takumipay.xyz/wc?wc_ev=abc&topic=${T}`,
      `takumiwallet://wc?requestId=1`,
      `takumiwallet://wc?sessionTopic=${T}`,
      `takumiwallet://wc?requestId=x&sessionTopic=${T}`,
      `takumiwallet://wc?requestId=1&sessionTopic=nothex`,
    ]) {
      assert.equal(parseRequestRedirect(raw), null, raw);
    }
  });
});
