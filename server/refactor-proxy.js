const http = require("node:http");

const port = Number(process.env.PORT || 8787);
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const maxPromptBytes = Number(process.env.MAX_PROMPT_BYTES || 750000);
const requestsPerHour = Number(process.env.RATE_LIMIT_PER_HOUR || 60);
const fallbackModels = (process.env.GEMINI_FALLBACK_MODELS || "gemini-2.5-flash-lite,gemini-2.0-flash")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const rateWindowMs = 60 * 60 * 1000;
const hitsByClient = new Map();

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      sendJson(response, 204, {});
      return;
    }

    if (request.method !== "POST" || request.url !== "/v1/refactor") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    if (!geminiApiKey) {
      sendJson(response, 500, { error: "GEMINI_API_KEY is not configured on the server." });
      return;
    }

    if (!allowRequest(clientKey(request))) {
      sendJson(response, 429, { error: "Rate limit exceeded. Try again later." });
      return;
    }

    const body = await readJsonBody(request, maxPromptBytes);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const model = normalizeModel(typeof body.model === "string" ? body.model : "");

    if (!prompt) {
      sendJson(response, 400, { error: "Missing prompt." });
      return;
    }

    const result = await requestGeminiWithFallbacks(model, prompt);
    sendJson(response, 200, { content: result.content || "", model: result.model });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown proxy error."
    });
  }
});

server.listen(port, () => {
  console.log(`CodeZero AI proxy listening on http://localhost:${port}/v1/refactor`);
});

function normalizeModel(model) {
  const trimmed = model.trim();
  if (!trimmed || trimmed.startsWith("gpt-") || trimmed.startsWith("o1-") || trimmed.startsWith("o3-") || trimmed.startsWith("o4-")) {
    return "gemini-2.5-flash";
  }
  return trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
}

async function requestGeminiWithFallbacks(primaryModel, prompt) {
  const models = uniqueStrings([primaryModel, ...fallbackModels]);
  const errors = [];

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const aiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [{ text: prompt }]
              }
            ],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.2
            }
          })
        }
      );

      if (aiResponse.ok) {
        const data = await aiResponse.json();
        const content = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim();
        return { content, model };
      }

      const details = await safeReadText(aiResponse);
      errors.push(`Model ${model} failed with ${aiResponse.status}: ${details}`);

      if (!isRetryableAiStatus(aiResponse.status)) {
        break;
      }

      await delay(600 * (attempt + 1));
    }
  }

  throw new Error(`Gemini request failed after retries. ${errors.join(" ")}`);
}

function isRetryableAiStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clientKey(request) {
  return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function allowRequest(key) {
  const now = Date.now();
  const bucket = hitsByClient.get(key) || [];
  const recent = bucket.filter((time) => now - time < rateWindowMs);
  if (recent.length >= requestsPerHour) {
    hitsByClient.set(key, recent);
    return false;
  }
  recent.push(now);
  hitsByClient.set(key, recent);
  return true;
}

function readJsonBody(request, limitBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("Request body too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    request.on("error", reject);
  });
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  });

  if (statusCode === 204) {
    response.end();
    return;
  }

  response.end(JSON.stringify(payload));
}
