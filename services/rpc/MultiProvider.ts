/**
 * Multi-provider RPC with failover, health monitoring,
 * rate limiting, and request deduplication.
 */

import * as SQLite from "expo-sqlite";
import { type Chain, createPublicClient, http, type PublicClient } from "viem";
import {
  findEvmChainById,
  getEvmSupportedChains,
} from "@/constants/configs/chainConfig";
import { chainRpcUrl, rpcFetchOptions } from "./proxyAuth";
import { initBucket, tryConsume } from "./rateLimiter";
import type {
  HealthStatus,
  RPCProviderConfig,
  RPCProviderState,
} from "./types";

// ─── Default provider configs ────────────────────────────────────────

const DEFAULT_PROVIDERS: RPCProviderConfig[] = [
  { name: "Default", url: "", chainId: 1, priority: 50, rateLimitRpm: 100 },
  { name: "Default", url: "", chainId: 137, priority: 50, rateLimitRpm: 100 },
  { name: "Default", url: "", chainId: 56, priority: 50, rateLimitRpm: 100 },
];

// ─── State ───────────────────────────────────────────────────────────

const providerStates = new Map<string, RPCProviderState>();
const dedupCache = new Map<string, { result: unknown; expiresAt: number }>();

let db: SQLite.SQLiteDatabase | null = null;

function getDb(): SQLite.SQLiteDatabase {
  if (!db) {
    db = SQLite.openDatabaseSync("rpc_providers.db");
    db.execSync(
      "CREATE TABLE IF NOT EXISTS custom_rpcs (" +
        "chain_id INTEGER NOT NULL, " +
        "name TEXT NOT NULL, " +
        "url TEXT NOT NULL, " +
        "priority INTEGER DEFAULT 0, " +
        "PRIMARY KEY (chain_id, url)" +
        ");",
    );
  }
  return db;
}

function stateKey(chainId: number, name: string): string {
  return `${chainId}:${name}`;
}

export function getProvidersForChain(chainId: number): RPCProviderState[] {
  const states: RPCProviderState[] = [];

  const database = getDb();
  const customRows = database.getAllSync<{
    chain_id: number;
    name: string;
    url: string;
    priority: number;
  }>("SELECT * FROM custom_rpcs WHERE chain_id = ?", [chainId]);

  for (const row of customRows) {
    const key = stateKey(chainId, row.name);
    if (!providerStates.has(key)) {
      providerStates.set(key, {
        ...row,
        chainId: row.chain_id,
        rateLimitRpm: 300,
        isCustom: true,
        healthStatus: "healthy",
        lastLatencyMs: 0,
        consecutiveHealthy: 3,
        lastCheckedAt: 0,
      });
    }
    states.push(providerStates.get(key)!);
  }

  for (const config of DEFAULT_PROVIDERS.filter((p) => p.chainId === chainId)) {
    const key = stateKey(chainId, config.name);
    if (!providerStates.has(key)) {
      providerStates.set(key, {
        ...config,
        healthStatus: "healthy",
        lastLatencyMs: 0,
        consecutiveHealthy: 3,
        lastCheckedAt: 0,
      });
      initBucket(key, config.rateLimitRpm);
    }
    states.push(providerStates.get(key)!);
  }

  return states.sort((a, b) => a.priority - b.priority);
}

export function addCustomRPC(chainId: number, name: string, url: string): void {
  const database = getDb();
  database.runSync(
    "INSERT OR REPLACE INTO custom_rpcs (chain_id, name, url, priority) VALUES (?, ?, ?, ?)",
    [chainId, name, url, 0],
  );

  const key = stateKey(chainId, name);
  providerStates.set(key, {
    name,
    url,
    chainId,
    priority: 0,
    rateLimitRpm: 300,
    isCustom: true,
    healthStatus: "healthy",
    lastLatencyMs: 0,
    consecutiveHealthy: 3,
    lastCheckedAt: 0,
  });
}

export function removeCustomRPC(chainId: number, url: string): void {
  const database = getDb();
  database.runSync("DELETE FROM custom_rpcs WHERE chain_id = ? AND url = ?", [
    chainId,
    url,
  ]);
}

export async function checkHealth(chainId: number): Promise<void> {
  const providers = getProvidersForChain(chainId);
  // TODO(task-05): EVM-only lookup — move under `EvmWalletKit`.
  const chain = findEvmChainById(chainId)?.chain;
  if (!chain) return;

  for (const provider of providers) {
    const key = stateKey(chainId, provider.name);
    const start = Date.now();

    try {
      const client = createClient(chain, provider.url || undefined);
      await Promise.race([
        client.getBlockNumber(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 5000),
        ),
      ]);

      const latency = Date.now() - start;
      provider.lastLatencyMs = latency;
      provider.lastCheckedAt = Date.now();

      if (latency > 5000) {
        provider.healthStatus = "degraded";
        provider.consecutiveHealthy = 0;
      } else {
        provider.consecutiveHealthy += 1;
        if (provider.consecutiveHealthy >= 3) {
          provider.healthStatus = "healthy";
        }
      }
    } catch {
      provider.consecutiveHealthy = 0;
      provider.lastCheckedAt = Date.now();
      provider.healthStatus =
        provider.healthStatus === "degraded" ? "down" : "degraded";
    }

    providerStates.set(key, provider);
  }
}

function createClient(chain: Chain, url?: string): PublicClient {
  // Explicit `url` wins (a specific provider row); otherwise fall back to the
  // chain's own endpoint. Either way the bearer is only attached when the target
  // is rpc-proxy — see services/rpc/proxyAuth.ts.
  const target = url || chainRpcUrl(chain);
  return createPublicClient({
    chain,
    transport: http(target || undefined, rpcFetchOptions(target)),
  });
}

export function getFailoverClient(chainId: number): PublicClient {
  // TODO(task-05): EVM-only lookup — move under `EvmWalletKit`.
  const chain = findEvmChainById(chainId)?.chain;
  const evmChains = getEvmSupportedChains();
  if (!chain) {
    return createPublicClient({
      chain: evmChains[0].chain,
      transport: http(),
    });
  }

  const providers = getProvidersForChain(chainId);

  for (const provider of providers) {
    if (provider.healthStatus === "down") continue;
    const key = stateKey(chainId, provider.name);
    if (!tryConsume(key)) continue;
    return createClient(chain, provider.url || undefined);
  }

  return createClient(chain, providers[0]?.url || undefined);
}

let healthInterval: ReturnType<typeof setInterval> | null = null;

export function startHealthMonitoring(): void {
  if (healthInterval) return;
  healthInterval = setInterval(() => {
    // TODO(task-05): move EVM-only RPC health-check under `EvmWalletKit`.
    for (const chain of getEvmSupportedChains()) {
      checkHealth(chain.chain.id).catch(() => {});
    }
  }, 60_000);
}

export function stopHealthMonitoring(): void {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}

export function getHealthSummary(): Array<{
  chainId: number;
  chainName: string;
  status: HealthStatus;
  latencyMs: number;
}> {
  // TODO(task-05): summarise non-EVM chains once their kits land.
  return getEvmSupportedChains().map((c) => {
    const providers = getProvidersForChain(c.chain.id);
    const primary = providers[0];
    return {
      chainId: c.chain.id,
      chainName: c.chain.name,
      status: primary?.healthStatus ?? "healthy",
      latencyMs: primary?.lastLatencyMs ?? 0,
    };
  });
}
