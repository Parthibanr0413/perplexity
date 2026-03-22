import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getOpenRouterHeaders, getServerConfig, KEY_ROTATION_MS } from "@/lib/env";

type RuntimeKeyState = {
  key: string;
  hash: string;
  createdAt: string;
  rotatedAt: string;
  source: "static" | "managed";
};

function getRuntimeStatePath() {
  const customPath = process.env.OPENROUTER_RUNTIME_STATE_PATH?.trim();

  if (customPath) {
    return customPath;
  }

  const customDir = process.env.OPENROUTER_RUNTIME_DIR?.trim();

  if (customDir) {
    return path.join(customDir, "openrouter-key.json");
  }

  if (process.env.VERCEL || process.env.LAMBDA_TASK_ROOT) {
    return path.join(os.tmpdir(), "scout-query", "openrouter-key.json");
  }

  return path.join(process.cwd(), ".runtime", "openrouter-key.json");
}

const runtimeStatePath = getRuntimeStatePath();

let rotationPromise: Promise<RuntimeKeyState> | null = null;
let memoryState: RuntimeKeyState | null = null;

function getNowIso() {
  return new Date().toISOString();
}

function isRecoverableStorageError(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  const code = String(error.code);
  return code === "EROFS" || code === "EPERM" || code === "EACCES";
}

async function ensureRuntimeDir() {
  await mkdir(path.dirname(runtimeStatePath), { recursive: true });
}

async function readRuntimeState() {
  if (memoryState) {
    return memoryState;
  }

  try {
    const raw = await readFile(runtimeStatePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<RuntimeKeyState>;

    if (typeof parsed.key !== "string" || !parsed.key.trim()) {
      return null;
    }

    memoryState = {
      key: parsed.key,
      hash: typeof parsed.hash === "string" ? parsed.hash : "",
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : getNowIso(),
      rotatedAt: typeof parsed.rotatedAt === "string" ? parsed.rotatedAt : getNowIso(),
      source: parsed.source === "managed" ? "managed" : "static",
    } satisfies RuntimeKeyState;

    return memoryState;
  } catch {
    return memoryState;
  }
}

async function writeRuntimeState(state: RuntimeKeyState) {
  memoryState = state;

  try {
    await ensureRuntimeDir();
    await writeFile(runtimeStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (error) {
    if (isRecoverableStorageError(error)) {
      return;
    }

    throw error;
  }
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

async function syncStaticRuntimeState(currentState: RuntimeKeyState | null) {
  const config = getServerConfig();

  if (!config.openRouterKey) {
    throw new Error("OPENROUTER_API_KEY is required.");
  }

  if (
    currentState &&
    currentState.source === "static" &&
    currentState.key === config.openRouterKey &&
    currentState.hash === config.openRouterKeyHash
  ) {
    return currentState;
  }

  const nowIso = getNowIso();
  const nextState: RuntimeKeyState = {
    key: config.openRouterKey,
    hash: config.openRouterKeyHash,
    createdAt: currentState?.createdAt ?? nowIso,
    rotatedAt: nowIso,
    source: "static",
  };

  await writeRuntimeState(nextState);
  return nextState;
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

  const currentState = await readRuntimeState();

  if (!config.openRouterManagementKey) {
    const syncedState = await syncStaticRuntimeState(currentState);
    return syncedState.key;
  }

  const effectiveState = currentState ?? (config.openRouterKey ? await getBootstrapState() : null);

  if (effectiveState && !shouldRotate(effectiveState)) {
    return effectiveState.key;
  }

  if (!rotationPromise) {
    rotationPromise = rotateRuntimeKey(effectiveState).finally(() => {
      rotationPromise = null;
    });
  }

  const nextState = await rotationPromise;
  return nextState.key;
}

export async function getOpenRouterRuntimeStatus() {
  const state = await readRuntimeState();
  const config = getServerConfig();

  if (!config.openRouterManagementKey) {
    return {
      rotationEnabled: false,
      rotatedAt: state?.source === "static" ? state.rotatedAt : null,
      source: config.openRouterKey ? "static" : "missing",
      nextRotationAt: null,
      hasInitialHash: Boolean(config.openRouterKeyHash),
    };
  }

  return {
    rotationEnabled: true,
    rotatedAt: state?.rotatedAt ?? null,
    source: state?.source ?? (config.openRouterKey ? "static" : "missing"),
    nextRotationAt: state?.rotatedAt ? new Date(new Date(state.rotatedAt).getTime() + KEY_ROTATION_MS).toISOString() : null,
    hasInitialHash: Boolean(config.openRouterKeyHash),
  };
}
