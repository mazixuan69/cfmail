type Env = {
  MAIL_KV: KVNamespace;
  ADMIN_TOKEN?: string;
  RESEND_API_KEY?: string;
};

type UserRecord = {
  address: string;
  token: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
};

type EmailMeta = {
  id: string;
  mailbox: string;
  from: string;
  to: string;
  subject: string | null;
  messageId: string | null;
  receivedAt: string;
  rawSize: number;
};

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;
const UNASSIGNED_MAILBOX = "unassigned";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (path.startsWith("/admin")) {
      const admin = await requireAdmin(request, env);
      if (!admin.ok) return admin.response;
      return handleAdmin(request, env, url, path, method);
    }

    if (path.startsWith("/emails") || path.startsWith("/outgoing-emails")) {
      const user = await requireUser(request, env);
      if (!user.ok) return user.response;
      return handleUser(request, env, url, path, method, user.address);
    }

    return json({ error: "not_found" }, 404);
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    const toAddress = normalizeAddress(message.to);
    const mailbox = await resolveMailbox(toAddress, env);
    const msgId = crypto.randomUUID();
    const receivedAt = new Date().toISOString();

    const subject = message.headers.get("subject");
    const messageId = message.headers.get("message-id");
    const meta: EmailMeta = {
      id: msgId,
      mailbox,
      from: normalizeAddress(message.from),
      to: toAddress,
      subject,
      messageId,
      receivedAt,
      rawSize: message.rawSize,
    };

    const msgKey = keyMsg(mailbox, msgId);
    const metaKey = keyMeta(mailbox, msgId);

    const rawBuffer = await streamToArrayBuffer(message.raw);
    const putMsg = env.MAIL_KV.put(msgKey, rawBuffer, {
      expirationTtl: DEFAULT_TTL_SECONDS,
    });
    const putMeta = env.MAIL_KV.put(metaKey, JSON.stringify(meta), {
      expirationTtl: DEFAULT_TTL_SECONDS,
    });

    ctx.waitUntil(Promise.all([putMsg, putMeta]));
  },
};

async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
  path: string,
  method: string,
): Promise<Response> {
  if (path === "/admin/users" && method === "POST") {
    const body = await readJson(request);
    if (!body || typeof body.address !== "string") {
      return json({ error: "invalid_body", message: "address required" }, 400);
    }
    const address = normalizeAddress(body.address);
    const existing = await env.MAIL_KV.get(keyUser(address));
    if (existing) {
      return json({ error: "already_exists" }, 409);
    }
    const token = generateToken();
    const now = new Date().toISOString();
    const user: UserRecord = {
      address,
      token,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await env.MAIL_KV.put(keyUser(address), JSON.stringify(user));
    await env.MAIL_KV.put(keyToken(token), address);
    return json({ user }, 201);
  }

  if (path === "/admin/users" && method === "GET") {
    const list = await listUsers(env, url);
    return json(list, 200);
  }

  const userMatch = path.match(/^\/admin\/users\/([^/]+)$/);
  if (userMatch) {
    const address = normalizeAddress(decodeURIComponent(userMatch[1]));
    if (method === "PATCH") {
      const body = await readJson(request);
      if (!body || (body.status !== "active" && body.status !== "disabled")) {
        return json({ error: "invalid_body", message: "status required" }, 400);
      }
      const user = await getUser(env, address);
      if (!user) return json({ error: "not_found" }, 404);
      user.status = body.status;
      user.updatedAt = new Date().toISOString();
      await env.MAIL_KV.put(keyUser(address), JSON.stringify(user));
      return json({ user }, 200);
    }

    if (method === "DELETE") {
      const user = await getUser(env, address);
      if (!user) return json({ error: "not_found" }, 404);
      await env.MAIL_KV.delete(keyUser(address));
      await env.MAIL_KV.delete(keyToken(user.token));
      return new Response(null, { status: 204 });
    }
  }

  const rotateMatch = path.match(/^\/admin\/users\/([^/]+)\/rotate-token$/);
  if (rotateMatch && method === "POST") {
    const address = normalizeAddress(decodeURIComponent(rotateMatch[1]));
    const user = await getUser(env, address);
    if (!user) return json({ error: "not_found" }, 404);
    await env.MAIL_KV.delete(keyToken(user.token));
    const token = generateToken();
    user.token = token;
    user.updatedAt = new Date().toISOString();
    await env.MAIL_KV.put(keyUser(address), JSON.stringify(user));
    await env.MAIL_KV.put(keyToken(token), address);
    return json({ user }, 200);
  }

  if (path === "/admin/emails" && method === "GET") {
    const mailbox = normalizeMailbox(url.searchParams.get("mailbox")) || UNASSIGNED_MAILBOX;
    return listEmails(env, url, mailbox);
  }

  const adminEmailMatch = path.match(/^\/admin\/emails\/([^/]+)(\/raw)?$/);
  if (adminEmailMatch) {
    const id = decodeURIComponent(adminEmailMatch[1]);
    const isRaw = !!adminEmailMatch[2];
    const mailbox = normalizeMailbox(url.searchParams.get("mailbox")) || UNASSIGNED_MAILBOX;
    if (method === "GET") {
      if (isRaw) return getEmailRaw(env, mailbox, id);
      return getEmailMeta(env, mailbox, id);
    }
    if (method === "DELETE" && !isRaw) {
      return deleteEmail(env, mailbox, id);
    }
  }

  return json({ error: "not_found" }, 404);
}

async function handleUser(
  request: Request,
  env: Env,
  url: URL,
  path: string,
  method: string,
  mailbox: string,
): Promise<Response> {
  if (path === "/emails" && method === "GET") {
    return listEmails(env, url, mailbox);
  }

  const emailMatch = path.match(/^\/emails\/([^/]+)(\/raw)?$/);
  if (emailMatch) {
    const id = decodeURIComponent(emailMatch[1]);
    const isRaw = !!emailMatch[2];
    if (method === "GET") {
      if (isRaw) return getEmailRaw(env, mailbox, id);
      return getEmailMeta(env, mailbox, id);
    }
    if (method === "DELETE" && !isRaw) {
      return deleteEmail(env, mailbox, id);
    }
  }

  if (path === "/outgoing-emails" && method === "POST") {
    const body = await readJson(request);
    if (!body || typeof body !== "object") {
      return json({ error: "invalid_body" }, 400);
    }
    if (!env.RESEND_API_KEY) {
      return json({ error: "resend_not_configured" }, 400);
    }
    if (!body.from) body.from = mailbox;
    if (!body.to || !body.subject || (!body.text && !body.html)) {
      return json(
        {
          error: "invalid_body",
          message: "to, subject, and text or html required",
        },
        400,
      );
    }
    const resendResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const respText = await resendResp.text();
    return new Response(respText, {
      status: resendResp.status,
      headers: {
        "Content-Type": resendResp.headers.get("Content-Type") || "application/json",
      },
    });
  }

  return json({ error: "not_found" }, 404);
}

async function listEmails(env: Env, url: URL, mailbox: string): Promise<Response> {
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 50);
  const cursor = url.searchParams.get("cursor") || undefined;
  const prefix = keyMetaPrefix(mailbox);
  const res = await env.MAIL_KV.list({ prefix, limit, cursor });
  const items = await Promise.all(
    res.keys.map(async (k) => {
      const raw = await env.MAIL_KV.get(k.name);
      return raw ? (JSON.parse(raw) as EmailMeta) : null;
    }),
  );
  const emails = items.filter((i): i is EmailMeta => i !== null);
  return json(
    {
      mailbox,
      emails,
      cursor: res.cursor,
      list_complete: res.list_complete,
    },
    200,
  );
}

async function getEmailMeta(env: Env, mailbox: string, id: string): Promise<Response> {
  const meta = await env.MAIL_KV.get(keyMeta(mailbox, id));
  if (!meta) return json({ error: "not_found" }, 404);
  return json(JSON.parse(meta), 200);
}

async function getEmailRaw(env: Env, mailbox: string, id: string): Promise<Response> {
  const raw = await env.MAIL_KV.get(keyMsg(mailbox, id), "arrayBuffer");
  if (!raw) return json({ error: "not_found" }, 404);
  return new Response(raw, {
    status: 200,
    headers: {
      "Content-Type": "message/rfc822",
    },
  });
}

async function deleteEmail(env: Env, mailbox: string, id: string): Promise<Response> {
  await env.MAIL_KV.delete(keyMsg(mailbox, id));
  await env.MAIL_KV.delete(keyMeta(mailbox, id));
  return new Response(null, { status: 204 });
}

async function requireAdmin(
  request: Request,
  env: Env,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const token = getBearerToken(request);
  if (!env.ADMIN_TOKEN || !token || token !== env.ADMIN_TOKEN) {
    return { ok: false, response: json({ error: "unauthorized" }, 401) };
  }
  return { ok: true };
}

async function requireUser(
  request: Request,
  env: Env,
): Promise<{ ok: true; address: string } | { ok: false; response: Response }> {
  const token = getBearerToken(request);
  if (!token) return { ok: false, response: json({ error: "unauthorized" }, 401) };
  const address = await env.MAIL_KV.get(keyToken(token));
  if (!address) return { ok: false, response: json({ error: "unauthorized" }, 401) };
  const user = await getUser(env, address);
  if (!user || user.status !== "active") {
    return { ok: false, response: json({ error: "forbidden" }, 403) };
  }
  return { ok: true, address: user.address };
}

async function resolveMailbox(address: string, env: Env): Promise<string> {
  if (!address) return UNASSIGNED_MAILBOX;
  const user = await getUser(env, address);
  if (!user || user.status !== "active") return UNASSIGNED_MAILBOX;
  return user.address;
}

function getBearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function normalizeAddress(value: string | null): string {
  if (!value) return "";
  const trimmed = value.trim();
  const match = trimmed.match(/<([^>]+)>/);
  return (match ? match[1] : trimmed).toLowerCase();
}

function normalizeMailbox(value: string | null): string | null {
  if (!value) return null;
  return value.trim().toLowerCase();
}

function keyUser(address: string): string {
  return `user:${address}`;
}

function keyToken(token: string): string {
  return `token:${token}`;
}

function keyMsg(mailbox: string, id: string): string {
  return `msg:${mailbox}:${id}`;
}

function keyMeta(mailbox: string, id: string): string {
  return `meta:${mailbox}:${id}`;
}

function keyMetaPrefix(mailbox: string): string {
  return `meta:${mailbox}:`;
}

async function getUser(env: Env, address: string): Promise<UserRecord | null> {
  const raw = await env.MAIL_KV.get(keyUser(address));
  return raw ? (JSON.parse(raw) as UserRecord) : null;
}

async function listUsers(env: Env, url: URL): Promise<unknown> {
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 50);
  const cursor = url.searchParams.get("cursor") || undefined;
  const res = await env.MAIL_KV.list({ prefix: "user:", limit, cursor });
  const items = await Promise.all(
    res.keys.map(async (k) => {
      const raw = await env.MAIL_KV.get(k.name);
      return raw ? (JSON.parse(raw) as UserRecord) : null;
    }),
  );
  const users = items.filter((i): i is UserRecord => i !== null);
  return { users, cursor: res.cursor, list_complete: res.list_complete };
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function clampInt(
  value: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = value ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function readJson(request: Request): Promise<any | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function streamToArrayBuffer(stream: ReadableStream): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
