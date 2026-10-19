import { afterEach, expect, test } from "bun:test";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test.each(["always", "never"])(
  "CLI sends formatted diagnostics to stderr: color=%s",
  async (color) => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../src/cli.ts", import.meta.url).pathname,
        "run",
        "--log-level",
        "error",
        "--log-detail",
        "low",
        "--color",
        color,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Supply --url and --goal");
    expect(stderr.includes("\x1b[")).toBe(color === "always");
  },
);

async function startCli(watch: boolean, modelUrl = "http://127.0.0.1:1/v1") {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = reservation.port!;
  await reservation.stop(true);
  const directory = `${Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp"}/jev-cli-${crypto.randomUUID()}`;
  await Bun.write(`${directory}/.env`, "");
  cleanup.push(() => Bun.$`rm -rf ${directory}`.quiet());
  const child = Bun.spawn(
    [
      process.execPath,
      ...(watch ? ["--watch"] : []),
      new URL("../src/cli.ts", import.meta.url).pathname,
      "serve",
      "--port",
      String(port),
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        BROWSER_CDP_URL: "",
        TYPESAFE_BASE_URL: modelUrl,
        TYPESAFE_MODEL: "test",
        TYPESAFE_API_KEY: "",
        TEXT_MODEL_BASE_URL: modelUrl,
        TEXT_MODEL: "test",
        TEXT_MODEL_API_KEY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  cleanup.push(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  });
  const reader = child.stdout.getReader();
  const ready = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(ready.value)).toContain("Jev Browser Agent:");
  return { child, port, url: `http://127.0.0.1:${port}` };
}

test.each([
  [false, "SIGINT"],
  [true, "SIGINT"],
  [false, "SIGTERM"],
  [true, "SIGTERM"],
] as const)(
  "CLI exits and releases its port: watch=%j, %s",
  async (watch, signal) => {
    const { child, port } = await startCli(watch);
    child.kill(signal);
    expect(await child.exited).toBe(0);
    const replacement = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => new Response(),
    });
    await replacement.stop(true);
  },
  7000,
);

test.each([false, true])(
  "shutdown during a stalled model request: force=%j",
  async (force) => {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const model = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch() {
        started.resolve();
        return response.promise;
      },
    });
    cleanup.push(async () => {
      response.resolve(Response.json({}));
      await model.stop(true);
    });
    const { child, url } = await startCli(
      true,
      `http://127.0.0.1:${model.port}/v1`,
    );
    const html = await (await fetch(url)).text();
    const token = html.match(/name="demo-token" content="([^"]+)"/)![1]!;
    const post = (path: string, body: unknown = {}) =>
      fetch(`${url}/api/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Demo-Token": token },
        body: JSON.stringify(body),
      });
    expect(
      (
        await post("reset", {
          scenario: "travel",
          goal: "Find a stay in Lisbon",
        })
      ).status,
    ).toBe(200);
    const events = await fetch(`${url}/api/events`);
    const streamEnded = events.text();
    const pending = post("predict").catch(() => undefined);
    await started.promise;
    const before = performance.now();
    child.kill("SIGINT");
    if (force) {
      const reader = child.stderr.getReader();
      let stopping = "";
      while (!stopping.includes("Stopping the server")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stopping += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      expect(stopping).toContain("Stopping the server");
      child.kill("SIGINT");
    }
    expect(await child.exited).toBe(force ? 130 : 0);
    expect(performance.now() - before).toBeLessThan(force ? 2000 : 5000);
    expect(await streamEnded).toContain("event: state");
    await pending;
  },
  12_000,
);
