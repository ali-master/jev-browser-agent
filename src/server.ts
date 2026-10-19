import { Agent } from "./agent.js";
import { Browser } from "./browser.js";
import { SettingsStore, object } from "./config.js";
import { MAX_STEPS } from "./questions.js";

const staticRoot = new URL("./static/", import.meta.url);
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
};
const files: Record<string, [string, string]> = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/style.css": ["style.css", "text/css"],
  "/fixture.html": ["fixture.html", "text/html"],
};

export function startServer(
  options: { port?: number; settings?: SettingsStore; cdpUrl?: string } = {},
) {
  const store = options.settings ?? new SettingsStore();
  const token = crypto.randomUUID();
  let agent: Agent | null = null;
  let busy = false;
  let shuttingDown = false;
  let revision = 0;
  let runId = crypto.randomUUID();
  let opening = 0;
  let textModel = "Not configured";
  let liveAvailable = false;
  let lastError: string | null = null;
  let latestFrame: { image: string; url: string; run_id: string; captured_at: number } | null =
    null;
  const frames = new Map<number, { image: string; url: string; title: string }>();
  const viewers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const subscriptions = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>();
  const encoder = new TextEncoder();
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
  const snapshot = () => ({
    ...(agent?.snapshot() ?? {
      page: null,
      status: "idle",
      history: [],
      decision: null,
      elements: [],
    }),
    ...(opening ? { activity: { kind: "opening", started_at: opening } } : {}),
    text_model: textModel,
    max_steps: agent?.maxSteps ?? MAX_STEPS,
    revision,
    run_id: runId,
    server_busy: busy,
    live_available: liveAvailable,
    error: lastError,
    frames: [...frames].map(([step, frame]) => ({
      step,
      url: frame.url,
      title: frame.title,
      image_url: `/api/frames/${runId}/${step}.jpg`,
    })),
  });
  const send = (
    viewer: ReadableStreamDefaultController<Uint8Array>,
    event: string,
    value: unknown,
  ) => {
    // Drop updates for slow viewers instead of queueing screenshots without a bound.
    if ((viewer.desiredSize ?? 0) <= 0) return;
    try {
      viewer.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
    } catch {
      subscriptions.get(viewer)?.();
    }
  };
  const broadcast = (event: string, value: unknown) => {
    for (const viewer of viewers) send(viewer, event, value);
  };
  const publishState = () => {
    if (agent && !agent.state.activity) {
      const step = agent.state.history.length;
      const page = agent.state.page;
      if (
        page.screenshot &&
        !frames.has(step) &&
        (step === 0 || agent.state.history.at(-1)?.page_changed !== null)
      )
        frames.set(step, { image: page.screenshot, url: page.url, title: page.title });
    }
    revision++;
    broadcast("state", snapshot());
  };
  const responseState = async () => {
    textModel = (await store.publicSettings()).text.model || "Not configured";
    return snapshot();
  };
  const stream = (request: Request) => {
    let dispose = () => {};
    let initialFrameSent = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          viewers.add(controller);
          send(controller, "state", snapshot());
          const heartbeat = setInterval(() => {
            send(controller, "state", snapshot());
          }, 3000);
          dispose = () => {
            clearInterval(heartbeat);
            viewers.delete(controller);
            subscriptions.delete(controller);
            request.signal.removeEventListener("abort", dispose);
          };
          subscriptions.set(controller, dispose);
          request.signal.addEventListener("abort", dispose, { once: true });
          if (request.signal.aborted) dispose();
        },
        pull(controller) {
          if (!initialFrameSent) {
            initialFrameSent = true;
            if (latestFrame) send(controller, "frame", latestFrame);
          }
        },
        cancel() {
          dispose();
        },
      }),
      { headers: { ...headers, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" } },
    );
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 8766,
    idleTimeout: 0,
    maxRequestBodySize: 32_768,
    async fetch(request) {
      const origin = `http://127.0.0.1:${server.port}`;
      if (
        request.headers.get("host") !== `127.0.0.1:${server.port}` ||
        (request.headers.has("origin") && request.headers.get("origin") !== origin)
      )
        return json({ error: "Local inspector requests only." }, 403);
      const path = new URL(request.url).pathname;
      try {
        if (request.method === "GET") {
          if (path === "/api/state") return json(await responseState());
          if (path === "/api/events") return stream(request);
          if (path.startsWith(`/api/frames/${runId}/`)) {
            const match = path.slice(`/api/frames/${runId}/`.length).match(/^(\d+)\.jpg$/);
            const frame = match ? frames.get(Number(match[1])) : undefined;
            return frame
              ? new Response(Buffer.from(frame.image, "base64"), {
                  headers: { ...headers, "Content-Type": "image/jpeg" },
                })
              : json({ error: "Frame not found." }, 404);
          }
          if (path === "/api/settings") return json(await store.publicSettings());
          const file = files[path];
          if (!file) return json({ error: "Not found." }, 404);
          const content = await Bun.file(new URL(file[0], staticRoot)).text();
          return new Response(path === "/" ? content.replace("__TOKEN__", token) : content, {
            headers: { ...headers, "Content-Type": `${file[1]}; charset=utf-8` },
          });
        }
        if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
        if (
          request.headers.get("x-demo-token") !== token ||
          !request.headers.get("content-type")?.startsWith("application/json")
        )
          return json({ error: "Local inspector requests only." }, 403);
        if (
          !["/api/settings", "/api/reset", "/api/predict", "/api/act", "/api/tick"].includes(path)
        )
          return json({ error: "Not found." }, 404);
        if (busy || shuttingDown) return json({ error: "A browser step is already running." }, 409);
        busy = true;
        lastError = null;
        try {
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return json({ error: "Invalid JSON request." }, 400);
          }
          if (!object(body)) return json({ error: "Expected a JSON object." }, 400);
          if (path === "/api/settings") {
            const settings = await store.save(body);
            if (agent && ["ready", "predicted"].includes(agent.state.status)) {
              agent.state.decision = null;
              agent.state.status = "ready";
            }
            return json(settings);
          }
          if (path === "/api/reset") {
            const goal = typeof body.goal === "string" ? body.goal.trim() : "";
            if (!goal || goal.length > 2000) throw new Error("Enter a goal of 1–2,000 characters.");
            const scenario = body.scenario ?? "custom";
            if (!["custom", "travel", "research"].includes(String(scenario)))
              throw new Error("Unknown demo scenario.");
            const url =
              scenario === "custom" ? body.url : `${origin}/fixture.html?scenario=${scenario}`;
            if (typeof url !== "string" || !url.trim())
              throw new Error("Enter a starting page URL.");
            const config = await store.read();
            if (!config.decision.model)
              throw new Error("Configure the decision model in Model settings first.");
            await agent?.close();
            agent = null;
            runId = crypto.randomUUID();
            frames.clear();
            latestFrame = null;
            liveAvailable = false;
            opening = Date.now();
            textModel = config.text.model || "Not configured";
            publishState();
            agent = await Agent.create(url, goal, {
              screenshots: true,
              settings: () => store.read(),
              cdpUrl: options.cdpUrl,
              onUpdate: publishState,
            });
            opening = 0;
            try {
              await (agent.browser as Browser).watchFrames((frame) => {
                latestFrame = { ...frame, run_id: runId, captured_at: Date.now() };
                broadcast("frame", latestFrame);
              });
              liveAvailable = true;
            } catch {
              // Browser snapshots remain available when this CDP server cannot stream.
            }
          } else {
            if (!agent) throw new Error("Start a task first.");
            await agent.command(path.slice(5) as "predict" | "act" | "tick", {
              fingerprint: typeof body.fingerprint === "string" ? body.fingerprint : undefined,
            });
          }
          return json(await responseState());
        } finally {
          busy = false;
          opening = 0;
          publishState();
        }
      } catch (error) {
        lastError =
          error instanceof Error
            ? error.message
            : "Local inspector failed. Start a fresh run to recover.";
        publishState();
        return json(
          {
            error: lastError,
          },
          400,
        );
      }
    },
  });
  return {
    server,
    url: `http://127.0.0.1:${server.port}`,
    async close() {
      shuttingDown = true;
      while (busy) await Bun.sleep(20);
      try {
        await agent?.close();
      } finally {
        for (const viewer of viewers) {
          try {
            viewer.close();
          } catch {}
        }
        for (const dispose of subscriptions.values()) dispose();
        await server.stop(true);
      }
    },
  };
}
