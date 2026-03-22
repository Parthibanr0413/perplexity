import { getServerConfig, isOpenRouterRotationConfigured } from "@/lib/env";
import { FALLBACK_OPENROUTER_MODEL_OPTIONS } from "@/lib/openrouter-models";
import { getOpenRouterRuntimeStatus } from "@/lib/openrouter-key";

import { SimpleChat } from "@/components/simple-chat";

export default async function HomePage() {
  const config = getServerConfig();
  const rotationStatus = await getOpenRouterRuntimeStatus();

  return (
    <SimpleChat
      defaultModel={config.defaultOpenRouterModel}
      defaultSourceLimit={config.defaultSourceLimit}
      fallbackModelOptions={FALLBACK_OPENROUTER_MODEL_OPTIONS}
      hasChatKey={Boolean(config.openRouterKey) || rotationStatus.source === "managed"}
      hasInitialHash={rotationStatus.hasInitialHash}
      rotationEnabled={isOpenRouterRotationConfigured(config)}
      rotationSource={rotationStatus.source}
      rotatedAt={rotationStatus.rotatedAt}
      nextRotationAt={rotationStatus.nextRotationAt}
    />
  );
}
