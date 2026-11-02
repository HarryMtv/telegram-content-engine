import { describe, expect, it } from "vitest";
import Fastify from "fastify";

describe("HTTP /ingest Authentication (Tasks 1.1, Security Hardening)", () => {
  function createTestApp(ingestToken: string) {
    const app = Fastify();
    app.post("/ingest", async (req, reply) => {
      const auth = req.headers.authorization ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      if (!token || token !== ingestToken) {
        return reply.code(401).send({ error: "Unauthorized: invalid INGEST_TOKEN" });
      }
      return reply.code(200).send({ ok: true });
    });
    return app;
  }

  it("запрос без Authorization заголовка возвращает 401", async () => {
    const app = createTestApp("dev-ingest-token");
    const response = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { text: "тестовый пост" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Unauthorized: invalid INGEST_TOKEN" });
  });

  it("запрос с неверным токеном возвращает 401", async () => {
    const app = createTestApp("dev-ingest-token");
    const response = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: "Bearer wrong-token" },
      payload: { text: "тестовый пост" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Unauthorized: invalid INGEST_TOKEN" });
  });

  it("запрос с верным токеном в dev режиме (dev-ingest-token) успешно авторизуется (200)", async () => {
    const app = createTestApp("dev-ingest-token");
    const response = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: "Bearer dev-ingest-token" },
      payload: { text: "тестовый пост" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("запрос с верным production токеном успешно авторизуется (200)", async () => {
    const app = createTestApp("custom-secure-prod-token-12345678");
    const response = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: "Bearer custom-secure-prod-token-12345678" },
      payload: { text: "тестовый пост" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});
