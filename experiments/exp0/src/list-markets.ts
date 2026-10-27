// Read-only: list Hideki perp markets with the fields the experiment sizes against.
// Usage: npx tsx src/list-markets.ts [--raw SYMBOL]

import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import { HIDEKI } from "./config.js";

async function main() {
  const rawFor = process.argv[2] === "--raw" ? process.argv[3] : undefined;
  const exchange = new SomniaMarkets({
    chain: hidekiTestnet,
    wsRpcUrl: HIDEKI.wsRpcUrl,
    indexerUrl: HIDEKI.indexerUrl,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  });
  try {
    const markets = await exchange.loadMarkets();
    const perps = Object.values(markets).filter((m) => m.type === "swap");
    for (const m of perps) {
      const i = m.info as Record<string, unknown>;
      if (rawFor && m.symbol.split("/")[0] === rawFor.toUpperCase()) {
        console.log(JSON.stringify(i, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      }
      console.log(
        [
          m.symbol.padEnd(22),
          `active=${m.active}`,
          `pool=${i.poolAddress}`,
          `baseDec=${i.baseDecimals}`,
          `quoteDec=${i.quoteDecimals}`,
          `tick=${i.tickSize}`,
          `lot=${i.lotSize}`,
          `minQty=${i.minQuantity}`,
          `mark=${i.markPrice}`,
        ].join(" "),
      );
    }
    console.log(`\n${perps.length} perp markets`);
  } finally {
    await Promise.race([Promise.resolve(exchange.close?.()), new Promise((r) => setTimeout(r, 3000))]);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
