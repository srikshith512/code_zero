import { readFile } from "node:fs/promises";
import { join } from "node:path";

type PackageJson = {
  publisher?: string;
  repository?: {
    type?: string;
    url?: string;
  };
  contributes?: {
    configuration?: {
      properties?: {
        "codezero.hostedAiEndpoint"?: {
          default?: string;
        };
      };
    };
  };
};

type RefactorResponse = {
  content?: string;
  text?: string;
  items?: unknown;
  fullReplacement?: unknown;
};

async function main(): Promise<void> {
  const packageJson = await readPackageJson();
  const endpoint = packageJson.contributes?.configuration?.properties?.["codezero.hostedAiEndpoint"]?.default;

  assert(packageJson.publisher === "codezero-ai", 'package.json publisher must be "codezero-ai".');
  assert(!!packageJson.repository?.url, "package.json repository.url is missing.");
  assert(!!endpoint, "codezero.hostedAiEndpoint default is missing.");
  assert(endpoint.startsWith("https://"), "codezero.hostedAiEndpoint must use HTTPS for publishing.");

  console.log(`Testing hosted endpoint: ${endpoint}`);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gemini-2.5-flash",
      prompt: 'Return JSON only: {"items":[],"fullReplacement":null}'
    })
  });

  assert(response.ok, `Hosted endpoint failed with ${response.status}: ${await response.text()}`);

  const payload = (await response.json()) as RefactorResponse;
  const modelText = typeof payload.content === "string"
    ? payload.content
    : typeof payload.text === "string"
      ? payload.text
      : JSON.stringify(payload);

  const parsed = JSON.parse(modelText) as {
    items?: unknown;
    fullReplacement?: unknown;
  };

  assert(Array.isArray(parsed.items), "AI response JSON must include an items array.");
  assert("fullReplacement" in parsed, "AI response JSON must include fullReplacement.");

  console.log("Hosted AI endpoint smoke test passed.");
}

async function readPackageJson(): Promise<PackageJson> {
  const text = await readFile(join(process.cwd(), "package.json"), "utf8");
  return JSON.parse(text) as PackageJson;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
