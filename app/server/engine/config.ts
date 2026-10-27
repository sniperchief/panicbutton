// Pinned Hideki v2 network configuration, carried over from experiments/exp0
// (verified there against the SDK, the docs and live eth_getCode reads).
// No NETWORK switch and no fallbacks.

import { SOMNIA_HIDEKI_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";

export const HIDEKI = {
  chainId: 50383,
  rpcUrl: "https://api.hideki2.infra.testnet.somnia.network",
  wsRpcUrl: "wss://api.hideki2.infra.testnet.somnia.network/ws",
  indexerUrl: "https://hideki-dev.smk.somnia.host/v1/graphql",
  marginBank: "0x478769E1177C0773c43A593DCCc4Ad15F15F1394",
  operatorRegistry: "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a",
  usdso: "0xed7993A74dAe1e6656B704A424DcD8711aAf4F72",
} as const;

/** Throws if the SDK's bundled chain/addresses disagree with the pinned values. */
export function assertSdkMatchesPins(): void {
  const problems: string[] = [];
  if (hidekiTestnet.id !== HIDEKI.chainId) problems.push(`sdk chain id ${hidekiTestnet.id}`);
  if (hidekiTestnet.rpcUrls.default.http[0] !== HIDEKI.rpcUrl) problems.push("sdk http rpc differs");
  if (hidekiTestnet.rpcUrls.default.webSocket?.[0] !== HIDEKI.wsRpcUrl) problems.push("sdk ws rpc differs");
  if (SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank?.toLowerCase() !== HIDEKI.marginBank.toLowerCase()) {
    problems.push(`sdk marginBank ${SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank}`);
  }
  if (problems.length) throw new Error(`pinned Hideki config disagrees with SDK: ${problems.join("; ")}`);
}

/** Engine limits. Everything that bounds risk lives here, not in the UI. */
export interface EngineSettings {
  /** Default IOC slippage from the touch, bps. */
  defaultSlippageBps: number;
  /** Server-enforced ceiling; requests above it are rejected. */
  maxSlippageBps: number;
  /** A prepared close must be confirmed within this window. */
  quoteTtlMs: number;
  /** No receipt within this window = outcome UNKNOWN, and Close All halts. */
  receiptTimeoutMs: number;
  /** Indexer cross-check budget after a verified close. Informational only. */
  indexerWaitMs: number;
  /** Gas limit sent with every close (the SDK's perp default). */
  orderGas: bigint;
  /** Book levels read per side when checking depth. */
  bookLevels: bigint;
}

export const DEFAULT_SETTINGS: EngineSettings = {
  defaultSlippageBps: 50,
  maxSlippageBps: 300,
  quoteTtlMs: 60_000,
  receiptTimeoutMs: 120_000,
  indexerWaitMs: 15_000,
  orderGas: 10_000_000n,
  bookLevels: 20n,
};
