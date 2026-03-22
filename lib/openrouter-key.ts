import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getOpenRouterHeaders, getServerConfig, KEY_ROTATION_MS } from "@/lib/env";

type RuntimeKeyState = {
  key: string;
  hash: string;
  createdAt: string;
  rotatedAt: string;
  source: "static" | "managed";
};

const runtimeStatePath = path.join(process.cwd(), ".runtime", "openrouter-key.json");

let rotationPromise: Promise<RuntimeKeyState> | null = null;

function getNowIso() {
  return new Date().toISOString();
}

async function ensureRuntimeDir() {
  await mkdir(path.dirname(runtimeStatePath), { recursive: true });
}

async function readRuntimeState() {
  try {
    const raw = await readFile(runtimeStatePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<RuntimeKeyState>;

    if (typeof parsed.key !== "string" || !parsed.key.trim()) {
      return null;
    }

    return {
      key: parsed.key,
      hash: typeof parsed.hash === "string" ? parsed.hash : "",
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : getNowIso(),
      rotatedAt: typeof parsed.rotatedAt === "string" ? parsed.rotatedAt : getNowIso(),
      source: parsed.source === "managed" ? "managed" : "static",
    } satisfies RuntimeKeyState;
  } catch {
    return null;
  }
}

async function writeRuntimeState(state: RuntimeKeyState) {
  await ensureRuntimeDir();
  await writeFile(runtimeStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function shouldRotate(state: RuntimeKeyState | null) {
  if (!state) {
    return true;
  }

  const rotatedAt = new Date(state.rotatedAt).getTime();

  if (!Number.isFinite(rotatedAt)) {
    return true;
  }

  return Date.now() - rotatedAt >= KEY_ROTATION_MS;
}

function getRotationExpiryIso() {
  return new Date(Date.now() + KEY_ROTATION_MS + 60 * 60 * 1000).toISOString();
}

async function createManagedKey() {
  const config = getServerConfig();
  const response = await fetch(`${config.openRouterBaseUrl}/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterManagementKey}`,
      "Content-Type": "application/json",
      ...getOpenRouterHeaders(config),
    },
    body: JSON.stringify({
      name: `Scout Query ${new Date().toISOString()}`,
      expires_at: getRotationExpiryIso(),
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = (await response.json()) as {
    key?: unknown;
    data?: {
      hash?: unknown;
    };
  };
  const key = typeof payload.key === "string" ? payload.key : "";
  const hash = typeof payload.data?.hash === "string" ? payload.data.hash : "";

  if (!key || !hash) {
    throw new Error("OpenRouter management API returned an incomplete key payload.");
  }

  return { key, hash };
}

async function deleteManagedKey(hash: string) {
  if (!hash) {
    return;
  }

  const config = getServerConfig();
  const response = await fetch(`${config.openRouterBaseUrl}/keys/${encodeURIComponent(hash)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${config.openRouterManagementKey}`,
      ...getOpenRouterHeaders(config),
    },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function getBootstrapState() {
  const config = getServerConfig();

  if (!config.openRouterKey) {
    throw new Error("OPENROUTER_API_KEY is required.");
  }

  const state: RuntimeKeyState = {
    key: config.openRouterKey,
    hash: config.openRouterKeyHash,
    createdAt: getNowIso(),
    rotatedAt: getNowIso(),
    source: "static",
  };

  await writeRuntimeState(state);
  return state;
}

async function rotateRuntimeKey(currentState: RuntimeKeyState | null) {
  const config = getServerConfig();

  if (!config.openRouterManagementKey) {
    if (currentState) {
      return currentState;
    }

    return getBootstrapState();
  }

  const previousState = currentState ?? (await readRuntimeState()) ?? (await getBootstrapState());
  const nextKey = await createManagedKey();
  const nextState: RuntimeKeyState = {
    key: nextKey.key,
    hash: nextKey.hash,
    createdAt: previousState.createdAt,
    rotatedAt: getNowIso(),
    source: "managed",
  };

  await writeRuntimeState(nextState);

  if (previousState.hash && previousState.hash !== nextState.hash) {
    try {
      await deleteManagedKey(previousState.hash);
    } catch {
      // Keep serving with the new key even if cleanup of the old key fails.
    }
  }

  return nextState;
}

export async function getOpenRouterRuntimeKey() {
  const config = getServerConfig();

  if (!config.openRouterKey && !config.openRouterManagementKey) {
    throw new Error("Add OPENROUTER_API_KEY, or use OPENROUTER_MANAGEMENT_API_KEY with a bootstrap key.");
  }

  const currentState = (await readRuntimeState()) ?? (config.openRouterKey ? await getBootstrapState() : null);

  if (!config.openRouterManagementKey) {
    return currentState?.key || config.openRouterKey;
  }

  if (currentState && !shouldRotate(currentState)) {
    return currentState.key;
  }

  if (!rotationPromise) {
    rotationPromise = rotateRuntimeKey(currentState).finally(() => {
      rotationPromise = null;
    });
  }

  const nextState = await rotationPromise;
  return nextState.key;
}

export async function getOpenRouterRuntimeStatus() {
  const state = await readRuntimeState();
  const config = getServerConfig();

  return {
    rotationEnabled: config.openRouterManagementKey.length > 0,
    rotatedAt: state?.rotatedAt ?? null,
    source: state?.source ?? (config.openRouterKey ? "static" : "missing"),
    nextRotationAt: state?.rotatedAt ? new Date(new Date(state.rotatedAt).getTime() + KEY_ROTATION_MS).toISOString() : null,
    hasInitialHash: Boolean(config.openRouterKeyHash),
  };
}
